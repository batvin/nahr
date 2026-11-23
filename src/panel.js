import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, uid, ensureDir } from './util.js';
import { INSTALLER_URL } from './manager.js';
import { encodeConnectCode, connectCommand } from './connect.js';
import { getState, save, update } from './store.js';
import { getLogs, subscribe, logger } from './log.js';
import { callAgent, runBench, stopBench, currentBench, lastBench, applyBench, subscribe as benchSubscribe } from './bench.js';
import net from 'node:net';

const log = logger('panel');
const WEB = path.join(ROOT, 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function send(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid JSON');
  }
}

function serveFile(res, file) {
  try {
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

async function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitHealth(port, token, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'x-nahr-token': token } });
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('agent did not start');
}

export class Panel {
  constructor({ port = 8080, host = '0.0.0.0' } = {}) {
    this.port = Number(port);
    this.host = host;
    this.children = new Map();
    this.sse = new Set();
    this.unsubLog = subscribe((entry) => this.pushEvent({ type: 'log', entry }));
    this.unsubBench = benchSubscribe(() => this.pushEvent({ type: 'bench', bench: currentBench() }));
  }

  pushEvent(event) {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.sse) {
      try {
        res.write(data);
      } catch {
        this.sse.delete(res);
      }
    }
  }

  async start() {
    ensureDir(path.join(ROOT, 'data'));
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.server.requestTimeout = 180000;
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.port = this.server.address().port;
        resolve();
      });
    });
    log.info(`panel ready at http://localhost:${this.port}/panel`);
    // Agents can restart (OOM, deploy, reboot). Bring enabled tunnels back
    // automatically instead of leaving a green tunnel that no longer exists.
    this.watchdog = setInterval(() => void this._healTunnels(), 15000);
    this.watchdog.unref?.();
    return this;
  }

  async _healTunnels() {
    if (this.healing) return;
    this.healing = true;
    try {
      for (const tunnel of getState().tunnels) {
        if (!tunnel.enabled) continue;
        const entry = getState().servers.find((s) => s.id === tunnel.entryId);
        if (!entry) continue;
        try {
          const reply = await callAgent(entry, '/tunnel/status', { id: `${tunnel.id}:entry` }, 2500);
          if (reply.status?.running) continue;
          log.warn(`tunnel ${tunnel.name} is down — restarting`);
          Object.assign(tunnel, await this.startTunnel(tunnel));
          save();
        } catch {
          /* agent unavailable: try on the next tick */
        }
      }
    } finally {
      this.healing = false;
    }
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (p.startsWith('/api/')) return await this.api(req, res, url);
      if (p === '/' || p === '/index.html') return serveFile(res, path.join(WEB, 'site', 'index.html'));
      if (p.startsWith('/docs')) return serveFile(res, path.join(WEB, 'site', 'docs.html'));
      if (p === '/panel' || p === '/panel/' || p === '/app.js' || p === '/styles.css' || p === '/favicon.svg') {
        const name = p.includes('.') ? path.basename(p) : p.endsWith('app.js') ? 'app.js' : 'index.html';
        const file = name === 'index.html' ? path.join(WEB, 'index.html') : path.join(WEB, name);
        return serveFile(res, file);
      }
      if (p === '/site.css') return serveFile(res, path.join(WEB, 'site', 'site.css'));
      return serveFile(res, path.join(WEB, p.replace(/^\//, '')));
    } catch (err) {
      log.error(`HTTP ${p}: ${err.stack || err.message}`);
      if (!res.headersSent) send(res, 400, { error: err.message });
    }
  }

  async api(req, res, url) {
    const p = url.pathname;
    const method = req.method;
    const state = getState();

    if (p === '/api/state' && method === 'GET') return send(res, 200, { state, bench: currentBench() || lastBench() });
    if (p === '/api/connect-code' && method === 'GET') {
      const panelPort = this.port || Number(url.searchParams.get('port') || 18080);
      const agent = url.searchParams.get('agent') || `http://${req.headers.host || `127.0.0.1:${panelPort}`}`;
      const code = encodeConnectCode({
        agent,
        panelLocal: `http://127.0.0.1:${panelPort}`,
        token: state.secret,
        name: url.searchParams.get('name') || '',
        ttlHours: Number(url.searchParams.get('ttl') || 24),
      });
      return send(res, 200, { code, command: connectCommand(code, INSTALLER_URL) });
    }
    if (p === '/api/settings' && method === 'POST') {
      const b = await body(req);
      update((s) => {
        s.settings = { ...s.settings, ...b };
      });
      return send(res, 200, { ok: true, settings: getState().settings });
    }

    if (p === '/api/servers' && method === 'GET') {
      const servers = await Promise.all(
        state.servers.map(async (s) => {
          try {
            const res2 = await fetch(`http://${s.host}:${s.agentPort}/health`, { headers: { 'x-nahr-token': s.token || state.secret }, signal: AbortSignal.timeout(2500) });
            const data = await res2.json();
            return { ...s, online: true, uptimeSec: data.uptimeSec };
          } catch {
            return { ...s, online: false };
          }
        }),
      );
      return send(res, 200, { servers });
    }
    if (p === '/api/servers' && method === 'POST') {
      const b = await body(req);
      const server = {
        id: b.id || uid('s-'),
        name: b.name || 'server',
        host: b.host,
        agentPort: Number(b.agentPort || 7700),
        token: b.token || state.secret,
        region: b.region || '',
        dialHost: b.dialHost || b.host,
        demo: !!b.demo,
      };
      if (!server.host) throw new Error('host required');
      update((s) => s.servers.push(server));
      return send(res, 200, { ok: true, server });
    }
    if (p.startsWith('/api/servers/') && method === 'DELETE') {
      const id = decodeURIComponent(p.split('/')[3]);
      update((s) => {
        s.servers = s.servers.filter((x) => x.id !== id);
        s.tunnels = s.tunnels.filter((t) => t.entryId !== id && t.exitId !== id);
      });
      return send(res, 200, { ok: true });
    }

    if (p === '/api/tunnels' && method === 'GET') {
      const tunnels = await Promise.all(
        state.tunnels.map(async (t) => {
          let status = null;
          if (t.enabled) {
            try {
              const entry = state.servers.find((s) => s.id === t.entryId);
              const exit = state.servers.find((s) => s.id === t.exitId);
              const [entryStatus, exitStatus] = await Promise.all([
                callAgent(entry, '/tunnel/status', { id: `${t.id}:entry` }, 3000).then((r) => r.status).catch(() => null),
                callAgent(exit, '/tunnel/status', { id: `${t.id}:exit` }, 3000).then((r) => r.status).catch(() => null),
              ]);
              status = entryStatus || exitStatus || { running: false };
              if (entryStatus && exitStatus) {
                status = { ...status, exitListenPort: exitStatus.listenPort, exitChannels: exitStatus.channels };
              }
            } catch {
              status = { running: false };
            }
          }
          return { ...t, status };
        }),
      );
      return send(res, 200, { tunnels });
    }
    if (p === '/api/tunnels' && method === 'POST') {
      const b = await body(req);
      const tunnel = {
        id: b.id || uid('t-'),
        name: b.name || 'tunnel',
        entryId: b.entryId,
        exitId: b.exitId,
        transport: b.transport || 'tcpmux',
        mode: b.mode || 'direct',
        profile: b.profile || 'balanced',
        listenPort: Number(b.listenPort || 0),
        socksPort: Number(b.socksPort || 1080),
        forwards: Array.isArray(b.forwards) ? b.forwards : [],
        enabled: false,
      };
      if (!tunnel.entryId || !tunnel.exitId) throw new Error('entry and exit are required');
      update((s) => s.tunnels.push(tunnel));
      return send(res, 200, { ok: true, tunnel });
    }
    if (p.startsWith('/api/tunnels/') && method === 'DELETE') {
      const id = decodeURIComponent(p.split('/')[3]);
      const tunnel = state.tunnels.find((t) => t.id === id);
      if (tunnel?.enabled) await this.stopTunnel(tunnel);
      update((s) => {
        s.tunnels = s.tunnels.filter((t) => t.id !== id);
      });
      return send(res, 200, { ok: true });
    }
    const tunnelAction = p.match(/^\/api\/tunnels\/([^/]+)\/(start|stop|update)$/);
    if (tunnelAction && method === 'POST') {
      const tunnel = state.tunnels.find((t) => t.id === tunnelAction[1]);
      if (!tunnel) throw new Error('tunnel not found');
      if (tunnelAction[2] === 'update') {
        const b = await body(req);
        if (tunnel.enabled) await this.stopTunnel(tunnel);
        Object.assign(tunnel, b);
        save();
        return send(res, 200, { ok: true, tunnel });
      }
      if (tunnelAction[2] === 'stop') {
        await this.stopTunnel(tunnel);
        tunnel.enabled = false;
        save();
        return send(res, 200, { ok: true });
      }
      const started = await this.startTunnel(tunnel);
      tunnel.enabled = true;
      Object.assign(tunnel, started);
      save();
      return send(res, 200, { ok: true, tunnel });
    }

    if (p === '/api/bench/start' && method === 'POST') {
      const b = await body(req);
      const settings = state.settings;
      void runBench({
        entryId: b.entryId,
        exitId: b.exitId,
        profile: b.profile || 'balanced',
        seconds: Number(b.seconds || settings.benchSeconds || 3),
        streams: Number(b.streams || settings.benchStreams || 4),
      }).catch((err) => log.error(`bench: ${err.message}`));
      return send(res, 200, { ok: true, id: currentBench()?.id });
    }
    if (p === '/api/bench/status' && method === 'GET') return send(res, 200, { bench: currentBench() || lastBench() });
    if (p === '/api/bench/stop' && method === 'POST') return send(res, 200, { ok: stopBench() });
    if (p === '/api/bench/apply' && method === 'POST') {
      const b = await body(req);
      return send(res, 200, { ok: true, tunnel: applyBench(b.id, b.key) });
    }
    if (p === '/api/bench/last' && method === 'GET') return send(res, 200, { bench: lastBench() });

    if (p === '/api/logs' && method === 'GET') return send(res, 200, { logs: getLogs({ limit: Number(url.searchParams.get('limit') || 200) }) });
    if (p === '/api/logs/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello', logs: getLogs({ limit: 60 }) })}\n\n`);
      this.sse.add(res);
      req.on('close', () => this.sse.delete(res));
      return;
    }

    if (p === '/api/demo/start' && method === 'POST') return send(res, 200, await this.startDemo());
    if (p === '/api/demo/stop' && method === 'POST') return send(res, 200, await this.stopDemo());

    return send(res, 404, { error: 'not found' });
  }

  async startTunnel(tunnel) {
    const state = getState();
    const entry = state.servers.find((s) => s.id === tunnel.entryId);
    const exit = state.servers.find((s) => s.id === tunnel.exitId);
    if (!entry || !exit) throw new Error('server missing');
    const common = {
      transport: tunnel.transport,
      token: state.secret,
      profile: tunnel.profile,
      path: '/tunnel',
      forwards: Array.isArray(tunnel.forwards) ? tunnel.forwards : [],
    };
    if (tunnel.mode === 'reverse') {
      const listening = await callAgent(entry, '/tunnel/start', {
        ...common,
        id: `${tunnel.id}:entry`,
        name: `${tunnel.name}-entry`,
        role: 'entry',
        mode: 'reverse',
        listenPort: tunnel.listenPort,
        socksPort: tunnel.socksPort,
      });
      const dialing = await callAgent(exit, '/tunnel/start', {
        ...common,
        id: `${tunnel.id}:exit`,
        name: `${tunnel.name}-exit`,
        role: 'exit',
        mode: 'reverse',
        listenPort: 0,
        remoteHost: entry.dialHost || entry.host,
        remotePort: listening.status.listenPort,
      });
      // The exit is a dialer in reverse mode, so it has no listening port.
      return { listenPort: listening.status.listenPort };
    }
    const listening = await callAgent(exit, '/tunnel/start', {
      ...common,
      id: `${tunnel.id}:exit`,
      name: `${tunnel.name}-exit`,
      role: 'exit',
      mode: 'direct',
      listenPort: tunnel.listenPort,
    });
    await callAgent(entry, '/tunnel/start', {
      ...common,
      id: `${tunnel.id}:entry`,
      name: `${tunnel.name}-entry`,
      role: 'entry',
      mode: 'direct',
      listenPort: 0,
      remoteHost: exit.dialHost || exit.host,
      remotePort: listening.status.listenPort,
      socksPort: tunnel.socksPort,
    });
    return { listenPort: listening.status.listenPort };
  }

  async stopTunnel(tunnel) {
    const state = getState();
    for (const id of [tunnel.entryId, tunnel.exitId]) {
      const server = state.servers.find((s) => s.id === id);
      if (!server) continue;
      await callAgent(server, '/tunnel/stop', { id: `${tunnel.id}:entry` }, 4000).catch(() => {});
      await callAgent(server, '/tunnel/stop', { id: `${tunnel.id}:exit` }, 4000).catch(() => {});
    }
  }

  async startDemo() {
    const state = getState();
    // `demo.running` is persisted, but child agents die with the panel process.
    // Only trust the flag if this panel instance actually owns live children.
    if (state.demo.running && this.children.size > 0) return { ok: true, demo: state.demo };
    const ids = ['demo-entry', 'demo-exit'];
    for (let i = 0; i < 2; i++) {
      const port = await freePort();
      const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'nahr.js'), 'agent', '--id', ids[i], '--name', i === 0 ? 'demo-entry' : 'demo-exit', '--port', String(port), '--host', '127.0.0.1'], {
        cwd: ROOT,
        env: { ...process.env, NAHR_QUIET: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk) => process.stdout.write(`[agent ${i}] ${chunk}`));
      child.stderr.on('data', (chunk) => process.stderr.write(`[agent ${i}] ${chunk}`));
      child.once('exit', () => {
        this.children.delete(ids[i]);
        if (this.children.size === 0) {
          update((s) => {
            if (s.demo?.running) s.demo = { running: false, agents: [] };
          });
        }
      });
      this.children.set(ids[i], child);
      await waitHealth(port, state.secret);
      update((s) => {
        s.servers = s.servers.filter((x) => x.id !== ids[i]);
        s.servers.push({
          id: ids[i],
          name: i === 0 ? 'ورودی آزمایشی' : 'خروجی آزمایشی',
          host: '127.0.0.1',
          agentPort: port,
          token: s.secret,
          dialHost: '127.0.0.1',
          region: 'local',
          demo: true,
        });
      });
    }
    update((s) => {
      s.tunnels = s.tunnels.filter((t) => !t.demo);
      const transports = ['tcpmux', 'tcp', 'ws', 'wss', 'udp'];
      transports.forEach((transport, i) => {
        s.tunnels.push({
          id: `demo-t-${transport}`,
          name: `تانل آزمایشی ${transport.toUpperCase()}`,
          entryId: 'demo-entry',
          exitId: 'demo-exit',
          transport,
          mode: 'direct',
          profile: 'balanced',
          listenPort: 0,
          socksPort: 11080 + i,
          enabled: false,
          demo: true,
        });
      });
      s.demo = { running: true, agents: ids };
    });
    const main = getState().tunnels.find((t) => t.transport === 'tcpmux' && t.demo);
    await this.startTunnel(main);
    main.enabled = true;
    save();
    log.info('demo is ready — 2 agents and 5 tunnels');
    return { ok: true, demo: getState().demo };
  }

  async stopDemo() {
    const state = getState();
    for (const tunnel of state.tunnels.filter((t) => t.demo && t.enabled)) await this.stopTunnel(tunnel);
    for (const child of this.children.values()) child.kill();
    this.children.clear();
    update((s) => {
      s.tunnels = s.tunnels.filter((t) => !t.demo);
      s.servers = s.servers.filter((server) => !server.demo);
      s.demo = { running: false, agents: [] };
    });
    return { ok: true };
  }

  async stop() {
    await this.stopDemo().catch(() => {});
    clearInterval(this.watchdog);
    this.unsubLog?.();
    this.unsubBench?.();
    if (this.server) await new Promise((r) => this.server.close(r));
  }
}
