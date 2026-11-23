import net from 'node:net';
import dgram from 'node:dgram';
import { Mux } from './mux.js';
import { decodeDest, encodeDest, normalizeDestHost, createSocks5Server } from './socks5.js';
import { dialChannel, listenChannel, PROFILES } from './transports.js';
import { logger } from './log.js';

/** One running entry or exit. Both ends use the same code; `role` changes what it listens on. */
export class TunnelRuntime {
  constructor(cfg, { token, cert } = {}) {
    this.cfg = cfg;
    this.token = token;
    this.cert = cert;
    this.log = logger(`tunnel:${cfg.name || cfg.id}`);
    this.profile = PROFILES[cfg.profile] || PROFILES.balanced;
    this.muxes = [];
    this.listener = null;
    this.socks = null;
    this.forwards = [];
    this.udpSockets = new Map();
    this.rr = 0;
    this.running = false;
    this.wantChannels = false;
    this.redialTimer = null;
    this.stats = { up: 0, down: 0, streams: 0, active: 0, channels: 0, startedAt: Date.now() };
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.log.info(`start ${this.cfg.role} · ${this.cfg.transport} · ${this.cfg.mode || 'direct'}`);
    try {
      if (this.cfg.role === 'exit') {
        // In reverse mode the entry listens and the exit dials into it. In
        // direct mode the exit is the listener. Both roles need one dialer.
        if (this.cfg.mode === 'reverse') await this._connectChannels();
        else await this._startListener();
      } else {
        this.socks = createSocks5Server({
          host: this.cfg.socksHost || '127.0.0.1',
          port: Number(this.cfg.socksPort || 1080),
          onConnect: (dest, _socket, initial) => this._openStream(dest, initial),
          onDatagram: (dest, data, sendBack) => this._sendDatagram(dest, data, sendBack),

        });
        if (this.cfg.mode === 'reverse') await this._startListener();
        else await this._connectChannels();
        await this._startForwards();
      }
    } catch (err) {
      await this.stop();
      throw err;
    }
    return this;
  }

  async _startListener() {
    this.listener = await listenChannel(this.cfg.transport, {
      port: Number(this.cfg.listenPort || 0),
      host: this.cfg.listenHost || '0.0.0.0',
      token: this.token,
      path: this.cfg.path || '/tunnel',
      cert: this.cert,
      profile: this.cfg.profile,
    });
    this.cfg.listenPort = this.listener.port;
    this.listener.on('connection', (channel) => {
      try {
        this._attachChannel(channel, false);
      } catch (err) {
        this.log.warn(`bad channel: ${err.message}`);
      }
    });
    this.listener.on('error', (err) => this.log.error(`listener: ${err.message}`));
    this.log.info(`listening on ${this.cfg.listenHost || '0.0.0.0'}:${this.listener.port}`);
  }

  /**
   * Explicit port forwards on the entry: local port -> fixed host:port on the
   * exit side. Unlike SOCKS5, the client does not choose the destination; this
   * is what you want for a single service such as V2Ray, RDP or a game server.
   */
  async _startForwards() {
    const rules = Array.isArray(this.cfg.forwards) ? this.cfg.forwards : [];
    for (const rule of rules) {
      const listenPort = Number(rule?.listenPort);
      const targetPort = Number(rule?.targetPort);
      if (!listenPort || !targetPort || rule?.enabled === false) continue;
      const listenHost = rule.listenHost || '127.0.0.1';
      const targetHost = rule.targetHost || '127.0.0.1';
      const server = net.createServer((socket) => {
        let stream;
        try {
          stream = this._openStream({ host: targetHost, port: targetPort });
        } catch {
          socket.destroy();
          return;
        }
        socket.pipe(stream);
        stream.pipe(socket);
        socket.on('error', () => stream.destroy());
        stream.on('error', () => socket.destroy());
        socket.on('close', () => stream.destroy());
        stream.on('close', () => socket.destroy());
      });
      await new Promise((resolve) => {
        const onListening = () => {
          server.removeListener('error', onError);
          resolve(true);
        };
        const onError = (err) => {
          server.removeListener('listening', onListening);
          this.log.warn(`forward ${listenHost}:${listenPort}: ${err.message}`);
          resolve(false);
        };
        server.once('listening', onListening);
        server.once('error', onError);
        server.listen(listenPort, listenHost);
      });
      if (!server.listening) continue;
      this.forwards.push({ server, rule: { listenHost, listenPort, targetHost, targetPort } });
      this.log.info(`forward ${listenHost}:${listenPort} → ${targetHost}:${targetPort}`);
    }
  }

  async _connectChannels() {
    this.wantChannels = true;
    const jobs = Array.from({ length: this.profile.connections }, () => this._dialOne());
    await Promise.allSettled(jobs);
    if (!this.muxes.length && this.wantChannels) this._scheduleRedial();
  }

  async _dialOne() {
    if (!this.wantChannels) return;
    try {
      const channel = await dialChannel(this.cfg.transport, {
        host: this.cfg.remoteHost,
        port: Number(this.cfg.remotePort),
        token: this.token,
        path: this.cfg.path || '/tunnel',
        profile: this.cfg.profile,
      });
      if (!this.wantChannels) {
        channel.destroy();
        return;
      }
      this._attachChannel(channel, true);
    } catch (err) {
      this.log.warn(`dial ${this.cfg.transport} to ${this.cfg.remoteHost}:${this.cfg.remotePort} failed: ${err.message}`);
    }
  }

  _scheduleRedial() {
    if (this.redialTimer || !this.wantChannels) return;
    this.redialTimer = setTimeout(async () => {
      this.redialTimer = null;
      if (!this.wantChannels) return;
      await this._dialOne();
      if (this.muxes.length < this.profile.connections) this._scheduleRedial();
    }, 2000);
    this.redialTimer.unref?.();
  }

  _attachChannel(channel, isDialer) {
    const mux = new Mux(channel, { isDialer, label: this.cfg.transport });
    const entry = { mux, channel };
    this.muxes.push(entry);
    this.stats.channels = this.muxes.length;
    mux.on('stream', (stream) => this._serveStream(stream));
    mux.on('datagram', (payload) => this._serveDatagram(payload));
    mux.on('error', (err) => {
      this.log.warn(`channel lost: ${err.message}`);
      const idx = this.muxes.indexOf(entry);
      if (idx >= 0) this.muxes.splice(idx, 1);
      this.stats.channels = this.muxes.length;
      if (isDialer && this.wantChannels) this._scheduleRedial();
    });
    return mux;
  }

  _pickMux() {
    if (!this.muxes.length) throw new Error('no tunnel channel available');
    const entry = this.muxes[this.rr % this.muxes.length];
    this.rr++;
    return entry.mux;
  }

  _openStream(dest, initial = Buffer.alloc(0)) {
    const stream = this._pickMux().openStream(Buffer.concat([encodeDest(dest), initial]));
    this.stats.streams++;
    this.stats.active++;
    let up = 0;
    let down = 0;
    stream.on('data', (chunk) => {
      down += chunk.length;
      this.stats.down += chunk.length;
    });
    // Count bytes written by wrapping write once (the caller pipes into the stream).
    const originalWrite = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || '');
      up += buf.length;
      this.stats.up += buf.length;
      return originalWrite(buf, ...rest);
    };
    stream.once('close', () => {
      this.stats.active = Math.max(0, this.stats.active - 1);
      void up;
    });
    return stream;
  }

  async _serveStream(stream) {
    let header = Buffer.alloc(0);
    let dest = null;
    try {
      dest = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('destination header timed out')), 8000);
        const cleanup = () => {
          clearTimeout(timer);
          stream.off('readable', onReadable);
        };
        const onReadable = () => {
          let chunk;
          while ((chunk = stream.read()) !== null) {
            header = Buffer.concat([header, chunk]);
            try {
              const parsed = decodeDest(header);
              cleanup();
              if (parsed.rest.length) stream.unshift(parsed.rest);
              resolve({ host: parsed.host, port: parsed.port });
              return;
            } catch (err) {
              if (header.length > 300) {
                cleanup();
                reject(err);
                return;
              }
            }
          }
        };
        stream.on('readable', onReadable);
        onReadable();
      });
      // A bracketed IPv6 literal from the SOCKS header is not a valid hostname.
      // Force IPv4 for domain names too: many exit servers resolve AAAA first and
      // then fail, which shows up as Instagram/HTTPS disconnects.
      const dialHost = normalizeDestHost(dest.host);
      const family = net.isIP(dialHost) === 6 ? 6 : 4;
      const target = net.connect({ host: dialHost, port: dest.port, family });
      await new Promise((resolve, reject) => {
        target.once('connect', resolve);
        target.once('error', reject);
        setTimeout(() => reject(new Error('target connect timed out')), 8000).unref?.();
      });
      target.setNoDelay(true);
      stream.pipe(target);
      target.pipe(stream);
      stream.on('error', () => target.destroy());
      target.on('error', () => stream.destroy());
    } catch (err) {
      this.log.warn(`stream to ${dest ? `${dest.host}:${dest.port}` : '?'} failed: ${err.message}`);
      stream.destroy();
    }
  }

  /** Entry: a SOCKS UDP packet goes through the tunnel to the exit. */
  _sendDatagram(dest, data, sendBack) {
    this.udpClientSend = sendBack;
    try {
      this._pickMux().sendDatagram(Buffer.concat([encodeDest(dest), data])).catch(() => {});
    } catch (err) {
      this.log.warn(`udp relay: ${err.message}`);
    }
  }

  /** Datagram arriving from the other side. */
  _serveDatagram(payload) {
    try {
      const source = decodeDest(payload);
      if (this.cfg.role === 'entry') {
        const socksHeader = Buffer.concat([Buffer.from([0, 0, 0]), encodeDest({ host: source.host, port: source.port }), source.rest]);
        this.udpClientSend?.(socksHeader);
        return;
      }
      const key = `${source.host}:${source.port}`;
      let socket = this.udpSockets.get(key);
      if (!socket) {
        socket = dgram.createSocket('udp4');
        socket.on('message', (reply, rinfo) => {
          const out = Buffer.concat([encodeDest({ host: rinfo.address, port: rinfo.port }), reply]);
          for (const entry of this.muxes) entry.mux.sendDatagram(out).catch(() => {});
        });
        this.udpSockets.set(key, socket);
      }
      socket.send(source.rest, source.port, source.host.replace(/^\[|\]$/g, ''));
    } catch (err) {
      this.log.warn(`bad datagram: ${err.message}`);
    }
  }

  status() {
    return {
      running: this.running,
      role: this.cfg.role,
      transport: this.cfg.transport,
      mode: this.cfg.mode || 'direct',
      listenPort: this.cfg.listenPort || null,
      socksPort: this.cfg.role === 'entry' ? this.cfg.socksPort : null,
      forwards: this.forwards.map(({ server, rule }) => ({ ...rule, listenPort: server.address()?.port || rule.listenPort })),
      ...this.stats,
      uptimeSec: Math.floor((Date.now() - this.stats.startedAt) / 1000),
    };
  }

  async stop() {
    this.running = false;
    this.wantChannels = false;
    if (this.redialTimer) clearTimeout(this.redialTimer);
    if (this.socks) this.socks.close();
    for (const { server } of this.forwards) {
      await new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
      });
    }
    this.forwards = [];
    if (this.listener) await this.listener.close();
    for (const entry of this.muxes) entry.channel.destroy();
    this.muxes = [];
    for (const socket of this.udpSockets.values()) socket.close();
    this.udpSockets.clear();
    this.log.info('stopped');
  }
}
