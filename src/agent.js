import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import selfsigned from 'selfsigned';
import { TunnelRuntime } from './tunnel.js';
import { listenChannel, dialChannel, TRANSPORTS } from './transports.js';
import { attachBenchResponder, runBench } from './benchproto.js';
import { Mux } from './mux.js';
import { logger } from './log.js';
import { DATA_DIR, ensureDir, uid } from './util.js';

const log = logger('agent');

function send(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid JSON body');
  }
}

/** The small HTTP control service that runs on every server. */
export class Agent {
  constructor({ id = 'local', name = 'local', port = 7700, token = '', host = '0.0.0.0' } = {}) {
    this.id = id;
    this.name = name;
    this.port = Number(port);
    this.host = host;
    this.token = token;
    this.tunnels = new Map();
    this.benchListeners = new Map();
    this.startedAt = Date.now();
    this.server = null;
  }

  cert() {
    const dir = path.join(DATA_DIR, 'certs');
    ensureDir(dir);
    const keyFile = path.join(dir, `${this.id}.key.pem`);
    const certFile = path.join(dir, `${this.id}.cert.pem`);
    try {
      return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
    } catch {
      const pems = selfsigned.generate([{ name: 'commonName', value: 'nahr.local' }, { name: 'organizationName', value: 'Nahr' }], { days: 3650, algorithm: 'sha256', keySize: 2048 });
      fs.writeFileSync(keyFile, pems.private);
      fs.writeFileSync(certFile, pems.cert);
      log.info(`generated self-signed certificate for ${this.id}`);
      return { key: pems.private, cert: pems.cert };
    }
  }

  async start() {
    this.server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/health') {
          send(res, 200, {
            ok: true,
            id: this.id,
            name: this.name,
            version: '0.1.0',
            uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
            transports: TRANSPORTS,
            tunnels: [...this.tunnels.values()].map((t) => t.status()),
          });
          return;
        }
        if (this.token && req.headers['x-nahr-token'] !== this.token) {
          send(res, 401, { error: 'unauthorized' });
          return;
        }
        const body = await readBody(req);
        await this.route(url.pathname, body, res);
      } catch (err) {
        log.warn(`${req.method} ${req.url}: ${err.message}`);
        if (!res.headersSent) send(res, 400, { error: err.message });
      }
    });
    this.server.requestTimeout = 180000;
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.port = this.server.address().port;
        resolve();
      });
    });
    log.info(`${this.name} listening on ${this.host}:${this.port}`);
    return this;
  }

  async route(pathname, body, res) {
    if (pathname === '/tunnel/start') {
      const existing = this.tunnels.get(body.id);
      if (existing) await existing.stop();
      const runtime = new TunnelRuntime(body, { token: body.token, cert: this.cert() });
      this.tunnels.set(body.id, runtime);
      await runtime.start();
      send(res, 200, { ok: true, status: runtime.status() });
      return;
    }
    if (pathname === '/tunnel/stop') {
      const runtime = this.tunnels.get(body.id);
      if (runtime) await runtime.stop();
      this.tunnels.delete(body.id);
      send(res, 200, { ok: true });
      return;
    }
    if (pathname === '/tunnel/status') {
      const runtime = this.tunnels.get(body.id);
      send(res, 200, { status: runtime ? runtime.status() : null });
      return;
    }
    if (pathname === '/bench/listen') {
      const id = body.id || uid('bench-');
      const listener = await listenChannel(body.transport, {
        port: Number(body.port || 0),
        host: this.host === '0.0.0.0' ? '0.0.0.0' : this.host,
        token: body.token,
        profile: body.profile,
        cert: this.cert(),
      });
      listener.on('connection', (channel) => {
        const mux = new Mux(channel, { isDialer: false });
        attachBenchResponder(mux);
      });
      const record = { listener, timer: null };
      record.timer = setTimeout(() => {
        void this.closeBench(id);
      }, Number(body.ttl || 120000));
      record.timer.unref?.();
      this.benchListeners.set(id, record);
      send(res, 200, { ok: true, id, port: listener.port });
      return;
    }
    if (pathname === '/bench/dial') {
      const channel = await dialChannel(body.transport, {
        host: body.host,
        port: Number(body.port),
        token: body.token,
        profile: body.profile,
        timeout: Number(body.timeout || 9000),
      });
      const result = await runBench(channel, {
        seconds: Number(body.seconds || 3),
        streams: Number(body.streams || 4),
        pings: Number(body.pings || 16),
        label: body.label || body.transport,
      });
      send(res, 200, { ok: true, result });
      return;
    }
    if (pathname === '/bench/close') {
      await this.closeBench(body.id);
      send(res, 200, { ok: true });
      return;
    }
    send(res, 404, { error: 'not found' });
  }

  async closeBench(id) {
    const record = this.benchListeners.get(id);
    if (!record) return;
    clearTimeout(record.timer);
    await record.listener.close();
    this.benchListeners.delete(id);
  }

  async stop() {
    for (const runtime of this.tunnels.values()) await runtime.stop();
    this.tunnels.clear();
    for (const id of [...this.benchListeners.keys()]) await this.closeBench(id);
    if (this.server) await new Promise((r) => this.server.close(r));
    log.info(`${this.name} stopped`);
  }
}
