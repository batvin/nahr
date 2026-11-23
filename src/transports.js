import net from 'node:net';
import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import { Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import selfsigned from 'selfsigned';
import { handshake, SealedStream, sealDatagram, openDatagram } from './secure.js';

export const TRANSPORTS = ['tcp', 'tcpmux', 'ws', 'wss', 'udp'];
export const TRANSPORT_INFO = {
  tcp: { label: 'TCP', note: 'یک اتصال TCP، ساده و سریع', udp: false },
  tcpmux: { label: 'TCP MUX', note: 'چند اتصال پایدار، بهترین حالت عمومی', udp: false },
  ws: { label: 'WS', note: 'WebSocket روی HTTP، مناسب CDN', udp: false },
  wss: { label: 'WSS', note: 'WebSocket روی TLS، شبیه HTTPS', udp: false },
  udp: { label: 'UDP', note: 'UDP مهر و موم شده با ARQ، مناسب مسیر پر اتلاف', udp: true },
};

export const PROFILES = {
  balanced: { label: 'متعادل', connections: 3, mtu: 1200, retryMs: 180, pingMs: 30000 },
  ultraspeed: { label: 'حداکثر سرعت', connections: 6, mtu: 1400, retryMs: 140, pingMs: 30000 },
  gaming: { label: 'بازی', connections: 2, mtu: 1000, retryMs: 90, pingMs: 10000 },
};

const MAGIC = Buffer.from('NAHU', 'ascii');
const F = { DATA: 1, ACK: 2, FIN: 4 };
const WINDOW = 64;

class WSStream extends Duplex {
  constructor(ws) {
    super({ highWaterMark: 256 * 1024 });
    this.ws = ws;
    this.waiting = null;
    this._onMessage = (data) => {
      if (!this.push(Buffer.from(data))) {
        try {
          ws._socket?.pause();
        } catch {
          /* ignore */
        }
      }
    };
    this._onClose = () => this.push(null);
    this._onError = (err) => this.destroy(err);
    ws.on('message', this._onMessage);
    ws.on('close', this._onClose);
    ws.on('error', this._onError);
  }

  _read() {
    try {
      this.ws._socket?.resume();
    } catch {
      /* ignore */
    }
    if (this.waiting && this.ws.bufferedAmount < 512 * 1024) {
      const done = this.waiting;
      this.waiting = null;
      done();
    }
  }

  _write(chunk, _enc, cb) {
    if (this.ws.readyState !== WebSocket.OPEN) return cb(new Error('websocket is closed'));
    let called = false;
    const done = (err) => {
      if (called) return;
      called = true;
      cb(err);
    };
    this.ws.send(chunk, { binary: true }, done);
    if (this.ws.bufferedAmount > 2 * 1024 * 1024) {
      this.waiting = done;
      this.ws.once('drain', () => this._read());
    }
  }

  _final(cb) {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
    cb();
  }

  _destroy(err, cb) {
    this.ws.off('message', this._onMessage);
    this.ws.off('close', this._onClose);
    this.ws.off('error', this._onError);
    try {
      this.ws.terminate();
    } catch {
      /* ignore */
    }
    cb(err);
  }
}

/** A reliable, encrypted byte stream over UDP datagrams. KCP-inspired, not wire-compatible with KCP. */
class UdpLink extends Duplex {
  constructor({ socket, remote, keys, role, mtu, retryMs, ownsSocket = false }) {
    super({ highWaterMark: 256 * 1024 });
    this.socket = socket;
    this.ownsSocket = ownsSocket;
    this.remote = remote;
    // Dial traffic is keyed c2s, exit traffic s2c. Every peer can decrypt both.
    this.sendKey = role === 'dial' ? keys.c2s : keys.s2c;
    this.decKeys = [keys.c2s, keys.s2c];
    this.role = role;
    this.mtu = mtu;
    this.retryMs = retryMs;
    this.seq = 1;
    this.expected = 1;
    this.unacked = new Map();
    this.inbox = new Map();
    this.pending = [];
    this.rto = retryMs * 3;
    this.srtt = null;
    this.finSent = false;
    this.finRecv = false;
    // `closed` is a read-only getter on Node streams, so use a private name.
    this.isClosed = false;
    this.lastSeen = Date.now();
    this.timer = setInterval(() => this._tick(), Math.max(20, Math.floor(retryMs / 3)));
    this.timer.unref?.();
  }

  /** Build a sealed frame. Inner layout: [seq u32][flags u8][payload]. */
  _frame(flags, seq, payload, direction = 'DATA') {
    const inner = Buffer.allocUnsafe(5 + payload.length);
    inner.writeUInt32BE(seq >>> 0, 0);
    inner[4] = flags;
    payload.copy(inner, 5);
    return Buffer.concat([MAGIC, sealDatagram(this.sendKey, direction, inner)]);
  }

  _sendPacket(flags, seq, payload, direction = 'DATA') {
    if (this.isClosed || this.socket.closed) return;
    try {
      this.socket.send(this._frame(flags, seq, payload, direction), this.remote.port, this.remote.host);
    } catch {
      /* next retry will handle it */
    }
  }

  _write(chunk, _enc, cb) {
    try {
      for (let offset = 0; offset < chunk.length; offset += this.mtu) {
        const part = chunk.subarray(offset, Math.min(offset + this.mtu, chunk.length));
        const seq = this.seq++;
        const wire = this._frame(F.DATA, seq, part);
        this.unacked.set(seq, { wire, at: Date.now() });
        this.socket.send(wire, this.remote.port, this.remote.host);
      }
      cb();
    } catch (err) {
      cb(err);
    }
  }

  _final(cb) {
    this.finSent = true;
    this._sendPacket(F.FIN, this.seq++, Buffer.alloc(0));
    cb();
  }

  _read() {
    const pending = this.pending;
    this.pending = [];
    for (let i = 0; i < pending.length; i++) {
      if (!this.push(pending[i])) {
        this.pending.push(...pending.slice(i));
        return;
      }
    }
  }

  _destroy(err, cb) {
    this.isClosed = true;
    clearInterval(this.timer);
    if (this.ownsSocket && !this.socket.closed) {
      try {
        this.socket.close();
      } catch {
        /* already closed */
      }
    }
    cb(err);
  }

  _tick() {
    if (this.isClosed) return;
    const now = Date.now();
    for (const [seq, item] of this.unacked) {
      if (now - item.at >= this.rto) {
        item.at = now;
        this.rto = Math.min(1000, Math.round(this.rto * 1.3));
        try {
          this.socket.send(item.wire, this.remote.port, this.remote.host);
        } catch {
          /* ignore */
        }
      }
    }
    if (now - this.lastSeen > 120000) this.destroy(new Error('udp peer silent'));
  }

  receive(wire) {
    if (this.isClosed || !wire.subarray(0, MAGIC.length).equals(MAGIC)) return;
    this.lastSeen = Date.now();
    let inner = null;
    for (const key of this.decKeys) {
      for (const direction of ['DATA', 'ACK']) {
        try {
          inner = openDatagram(key, direction, wire.subarray(MAGIC.length));
          break;
        } catch {
          /* try the next key / label */
        }
      }
      if (inner) break;
    }
    if (!inner || inner.length < 5) return;
    const seq = inner.readUInt32BE(0) >>> 0;
    const flags = inner[4];
    const payload = inner.subarray(5);

    if (flags & F.ACK) {
      if (payload.length >= 8) {
        const base = payload.readUInt32BE(0) >>> 0;
        const bitmap = payload.readUInt32BE(4) >>> 0;
        for (const [s, item] of this.unacked) {
          if (s < base || (s - base < 32 && ((bitmap >>> (s - base)) & 1))) {
            this.unacked.delete(s);
            const rtt = Date.now() - item.at;
            this.srtt = this.srtt == null ? rtt : Math.round(this.srtt * 0.8 + rtt * 0.2);
          }
        }
        if (this.unacked.size === 0) this.rto = this.retryMs * 2;
      }
      return;
    }

    // ACK immediately: recovery must not depend on application backpressure.
    this._sendAck();
    if (flags & F.FIN) {
      this.finRecv = true;
      if (!this.push(null)) this.pending.push(null);
      return;
    }
    if (!(flags & F.DATA)) return;
    if (seq === this.expected) {
      this.expected = (this.expected + 1) >>> 0;
      if (!this.push(Buffer.from(payload))) this.pending.push(Buffer.from(payload));
      let next;
      while ((next = this.inbox.get(this.expected))) {
        this.inbox.delete(this.expected);
        this.expected = (this.expected + 1) >>> 0;
        if (!this.push(Buffer.from(next))) this.pending.push(Buffer.from(next));
      }
    } else if (distance(seq, this.expected) < WINDOW) {
      this.inbox.set(seq, Buffer.from(payload));
    }
  }

  _sendAck() {
    const base = this.expected;
    const ack = Buffer.alloc(8);
    ack.writeUInt32BE(base >>> 0, 0);
    let bitmap = 0;
    for (const seq of this.inbox.keys()) {
      const d = seq - base;
      if (d > 0 && d < 32) bitmap |= 1 << d;
    }
    ack.writeUInt32BE(bitmap >>> 0, 4);
    this._sendPacket(F.ACK, 0, ack, 'ACK');
  }
}

function distance(a, b) {
  return (a - b) >>> 0;
}

function helloPacket(pub, proof) {
  return Buffer.concat([MAGIC, pub, proof]);
}

function parseHello(packet) {
  if (packet.length < 4 + 32 + 32 || !packet.subarray(0, 4).equals(MAGIC)) return null;
  return { pub: packet.subarray(4, 36), proof: packet.subarray(36, 68) };
}

function udpKeys(shared, token) {
  const salt = crypto.createHash('sha256').update(token).digest();
  return {
    c2s: Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from('nahr/client-to-server/v1'), 32)),
    s2c: Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from('nahr/server-to-client/v1'), 32)),
  };
}

function udpHandshakeMaterial(token) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { pub, privateKey, proof: crypto.createHmac('sha256', token).update(pub).digest(), token };
}

function finishUdpHandshake(material, remotePub) {
  const prefix = Buffer.from('302a300506032b656e032100', 'hex');
  const publicKey = crypto.createPublicKey({ key: Buffer.concat([prefix, remotePub]), format: 'der', type: 'spki' });
  const shared = crypto.diffieHellman({ privateKey: material.privateKey, publicKey });
  return udpKeys(shared, material.token);
}

/** Dial one logical channel. Returns a Duplex carrying encrypted bytes. */
export async function dialChannel(transport, opts) {
  const { host, port, token, path = '/tunnel', timeout = 9000, profile = 'balanced' } = opts;
  const prof = PROFILES[profile] || PROFILES.balanced;
  if (transport === 'tcp' || transport === 'tcpmux') {
    const raw = await connectTcp(host, port, timeout);
    const hs = await handshake(raw, token, 'dial', timeout);
    return new SealedStream(raw, hs.keys, 'dial', { initial: hs.leftover });
  }
  if (transport === 'ws' || transport === 'wss') {
    const scheme = transport === 'wss' ? 'wss' : 'ws';
    const url = `${scheme}://${host.includes(':') ? `[${host}]` : host}:${port}${path}`;
    const ws = new WebSocket(url, { rejectUnauthorized: false, perMessageDeflate: false, handshakeTimeout: timeout });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      setTimeout(() => reject(new Error('websocket dial timed out')), timeout).unref?.();
    });
    const raw = new WSStream(ws);
    const hs = await handshake(raw, token, 'dial', timeout);
    return new SealedStream(raw, hs.keys, 'dial', { initial: hs.leftover });
  }
  if (transport === 'udp') {
    return dialUdp({ host, port, token, timeout, mtu: prof.mtu, retryMs: prof.retryMs });
  }
  throw new Error(`unknown transport: ${transport}`);
}

function connectTcp(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('tcp dial timed out'));
    }, timeout);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function dialUdp({ host, port, token, timeout, mtu, retryMs }) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const material = udpHandshakeMaterial(token);
    const packet = helloPacket(material.pub, material.proof);
    let settled = false;
    let tries = 0;
    const send = () => {
      tries++;
      socket.send(packet, port, host);
    };
    const finish = (err, link) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearTimeout(timeoutTimer);
      socket.off('message', onMessage);
      if (err) {
        socket.close();
        reject(err);
      } else {
        resolve(link);
      }
    };
    const onMessage = (msg, rinfo) => {
      const peer = parseHello(msg);
      if (!peer) return;
      try {
        if (!crypto.timingSafeEqual(peer.proof, crypto.createHmac('sha256', token).update(peer.pub).digest())) {
          return finish(new Error('token mismatch'));
        }
      } catch {
        return;
      }
      const keys = finishUdpHandshake(material, peer.pub);
      const remote = { host: rinfo.address, port: rinfo.port };
      const link = new UdpLink({ socket, remote, keys, role: 'dial', mtu, retryMs, ownsSocket: true });
      socket.on('message', (m, r) => {
        if (r.address === remote.host && r.port === remote.port && !link.isClosed) link.receive(m);
      });
      finish(null, link);
    };
    const timer = setInterval(send, 400);
    const timeoutTimer = setTimeout(() => finish(new Error('udp handshake timed out')), timeout);
    socket.on('message', onMessage);
    socket.on('error', (err) => finish(err));
    send();
  });
}

/** Listen for channels. Returns an EventEmitter with 'connection' (Duplex), 'port', and close(). */
export async function listenChannel(transport, opts) {
  let { port, host = '0.0.0.0', token, path = '/tunnel', cert = null, profile = 'balanced' } = opts;
  const prof = PROFILES[profile] || PROFILES.balanced;
  const emitter = new EventEmitter();
  emitter.port = port;

  if (transport === 'tcp' || transport === 'tcpmux') {
    const server = net.createServer((raw) => {
      handshake(raw, token, 'listen')
        .then((hs) => emitter.emit('connection', new SealedStream(raw, hs.keys, 'listen', { initial: hs.leftover })))
        .catch(() => raw.destroy());
    });
    server.on('error', (err) => emitter.emit('error', err));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        emitter.port = server.address().port;
        resolve();
      });
    });
    emitter.close = () => new Promise((r) => server.close(r));
    return emitter;
  }

  if (transport === 'ws' || transport === 'wss') {
    if (!cert && transport === 'wss') {
      const pems = selfsigned.generate([{ name: 'commonName', value: 'nahr.local' }], { days: 3650, algorithm: 'sha256', keySize: 2048 });
      cert = { key: pems.private, cert: pems.cert };
    }
    const handler = (req, res) => {
      if (req.url?.split('?')[0] !== path) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>');
        return;
      }
      res.writeHead(426);
      res.end('Upgrade Required');
    };
    const server = transport === 'wss' ? https.createServer(cert, handler) : http.createServer(handler);
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 16 * 1024 * 1024 });
    server.on('upgrade', (req, socket, head) => {
      if (req.url?.split('?')[0] !== path) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const raw = new WSStream(ws);
        handshake(raw, token, 'listen')
          .then((hs) => emitter.emit('connection', new SealedStream(raw, hs.keys, 'listen', { initial: hs.leftover })))
          .catch(() => raw.destroy());
      });
    });
    server.on('error', (err) => emitter.emit('error', err));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        emitter.port = server.address().port;
        resolve();
      });
    });
    emitter.close = () =>
      new Promise((r) => {
        for (const client of wss.clients) client.terminate();
        server.close(r);
      });
    return emitter;
  }

  if (transport === 'udp') {
    const socket = dgram.createSocket('udp4');
    const links = new Map();
    emitter.port = port;
    socket.on('message', (msg, rinfo) => {
      const key = `${rinfo.address}:${rinfo.port}`;
      let link = links.get(key);
      if (!link) {
        const hello = parseHello(msg);
        if (!hello) return;
        let ok = false;
        try {
          ok = crypto.timingSafeEqual(hello.proof, crypto.createHmac('sha256', token).update(hello.pub).digest());
        } catch {
          ok = false;
        }
        if (!ok) return;
        const material = udpHandshakeMaterial(token);
        const keys = finishUdpHandshake(material, hello.pub);
        link = new UdpLink({ socket, remote: { host: rinfo.address, port: rinfo.port }, keys, role: 'listen', mtu: prof.mtu, retryMs: prof.retryMs });
        links.set(key, link);
        socket.send(helloPacket(material.pub, material.proof), rinfo.port, rinfo.address);
        emitter.emit('connection', link);
        return;
      }
      link.receive(msg);
    });
    socket.on('error', (err) => emitter.emit('error', err));
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(port, host, () => {
        socket.off('error', reject);
        emitter.port = socket.address().port;
        resolve();
      });
    });
    emitter.close = () =>
      new Promise((r) => {
        for (const link of links.values()) link.destroy();
        links.clear();
        socket.close(r);
      });
    return emitter;
  }
  throw new Error(`unknown transport: ${transport}`);
}
