import crypto from 'node:crypto';
import { Duplex } from 'node:stream';

const MAGIC = Buffer.from('NAH1', 'ascii');
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const TAG_LEN = 16;
const MAX_CHUNK = 16384;
const HANDSHAKE_TIMEOUT = 12000;

function ephemeral() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { pub, privateKey };
}

function importPub(raw) {
  if (raw.length !== 32) throw new Error('bad public key length');
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

function proof(token, pub) {
  return crypto.createHmac('sha256', token).update(pub).digest();
}

function derive(shared, token) {
  const salt = crypto.createHash('sha256').update(token).digest();
  return {
    c2s: crypto.hkdfSync('sha256', shared, salt, Buffer.from('nahr/client-to-server/v1'), 32),
    s2c: crypto.hkdfSync('sha256', shared, salt, Buffer.from('nahr/server-to-client/v1'), 32),
  };
}

export function writeAll(stream, buffer) {
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    };
    const ok = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      stream.off('error', fail);
      stream.off('close', fail);
    };
    stream.on('error', fail);
    stream.on('close', fail);
    stream.write(buffer, (err) => (err ? fail(err) : ok()));
  });
}

export function readExact(stream, bytes, timeoutMs = HANDSHAKE_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let got = 0;
    let head = null;
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('error', onError);
      stream.off('close', onClose);
      stream.pause();
      if (err) reject(err);
      else resolve({ bytes: head, leftover: Buffer.concat(chunks) });
    };
    const onData = (chunk) => {
      chunks.push(chunk);
      got += chunk.length;
      if (got >= bytes) {
        const all = Buffer.concat(chunks, got);
        head = all.subarray(0, bytes);
        chunks.length = 0;
        if (all.length > bytes) chunks.push(all.subarray(bytes));
        finish(null);
      }
    };
    const onError = (err) => finish(err);
    const onClose = () => finish(new Error('connection closed during handshake'));
    const timer = setTimeout(() => finish(new Error('handshake timed out')), timeoutMs);
    stream.on('data', onData);
    stream.on('error', onError);
    stream.on('close', onClose);
    stream.resume();
  });
}

/** Run the mutual-auth X25519 handshake. role: 'dial' or 'listen'. */
export async function handshake(stream, token, role, timeoutMs = HANDSHAKE_TIMEOUT) {
  const eph = ephemeral();
  let peer;
  let leftoverBytes = Buffer.alloc(0);
  if (role === 'dial') {
    const hello = Buffer.alloc(4 + 32 + 32);
    MAGIC.copy(hello, 0);
    eph.pub.copy(hello, 4);
    proof(token, eph.pub).copy(hello, 36);
    await writeAll(stream, hello);
    const reply = await readExact(stream, 68, timeoutMs);
    peer = reply.bytes;
    leftoverBytes = reply.leftover;
    if (!peer.subarray(0, 4).equals(MAGIC)) throw new Error('bad handshake magic');
    if (!crypto.timingSafeEqual(peer.subarray(36), proof(token, peer.subarray(4, 36)))) throw new Error('token mismatch');
  } else {
    const hello = await readExact(stream, 68, timeoutMs);
    peer = hello.bytes;
    leftoverBytes = hello.leftover;
    if (!peer.subarray(0, 4).equals(MAGIC)) throw new Error('bad handshake magic');
    if (!crypto.timingSafeEqual(peer.subarray(36), proof(token, peer.subarray(4, 36)))) throw new Error('token mismatch');
    const reply = Buffer.alloc(68);
    MAGIC.copy(reply, 0);
    eph.pub.copy(reply, 4);
    proof(token, eph.pub).copy(reply, 36);
    await writeAll(stream, reply);
  }
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: importPub(peer.subarray(4, 36)) });
  const keys = derive(shared, token);
  return { keys, leftover: leftoverBytes };
}

function nonce(direction, counter) {
  const buf = Buffer.alloc(12);
  buf.write(direction, 0, 4, 'ascii');
  buf.writeBigUInt64BE(BigInt(counter), 4);
  return buf;
}

/** An authenticated, encrypted byte stream on top of any Duplex stream. */
export class SealedStream extends Duplex {
  constructor(raw, keys, role, options = {}) {
    super({ highWaterMark: 256 * 1024, allowHalfOpen: false });
    this.raw = raw;
    this.encKey = role === 'dial' ? keys.c2s : keys.s2c;
    this.decKey = role === 'dial' ? keys.s2c : keys.c2s;
    this.encDir = role === 'dial' ? 'C2S' : 'S2C';
    this.decDir = role === 'dial' ? 'S2C' : 'C2S';
    this.txCounter = 0;
    this.rxCounter = 0;
    this.rx = Buffer.alloc(0);
    this.txChain = Promise.resolve();
    this.rawPaused = false;
    this.initial = options.initial && options.initial.length ? options.initial : null;
    this._onRawData = this._onRawData.bind(this);
    this._onRawError = (err) => this.destroy(err);
    this._onRawEnd = () => this.push(null);
    this._onRawClose = () => this.push(null);
  }

  _construct(cb) {
    this.raw.on('data', this._onRawData);
    this.raw.on('error', this._onRawError);
    this.raw.on('end', this._onRawEnd);
    this.raw.on('close', this._onRawClose);
    this.raw.resume();
    if (this.initial) {
      const initial = this.initial;
      this.initial = null;
      this._onRawData(initial);
    }
    cb();
  }

  _onRawData(chunk) {
    this.rx = this.rx.length ? Buffer.concat([this.rx, chunk]) : chunk;
    while (this.rx.length >= 2) {
      const len = this.rx.readUInt16BE(0);
      if (len < TAG_LEN || this.rx.length < 2 + len) break;
      const packet = this.rx.subarray(2, 2 + len);
      this.rx = this.rx.subarray(2 + len);
      let plain;
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', this.decKey, nonce(this.decDir, this.rxCounter++));
        decipher.setAuthTag(packet.subarray(packet.length - TAG_LEN));
        plain = Buffer.concat([decipher.update(packet.subarray(0, packet.length - TAG_LEN)), decipher.final()]);
      } catch {
        this.destroy(new Error('wrong key or corrupted packet'));
        return;
      }
      if (!this.push(plain)) {
        this.rawPaused = true;
        this.raw.pause();
        break;
      }
    }
  }

  _read() {
    if (this.rawPaused) {
      this.rawPaused = false;
      this.raw.resume();
    }
  }

  _write(chunk, _enc, cb) {
    this.txChain = this.txChain.then(async () => {
      for (let offset = 0; offset < chunk.length; offset += MAX_CHUNK) {
        const part = chunk.subarray(offset, Math.min(offset + MAX_CHUNK, chunk.length));
        const cipher = crypto.createCipheriv('aes-256-gcm', this.encKey, nonce(this.encDir, this.txCounter++));
        const body = Buffer.concat([cipher.update(part), cipher.final(), cipher.getAuthTag()]);
        const frame = Buffer.alloc(2 + body.length);
        frame.writeUInt16BE(body.length, 0);
        body.copy(frame, 2);
        if (this.raw.destroyed) throw new Error('transport closed');
        if (!this.raw.write(frame)) {
          await new Promise((resolve) => this.raw.once('drain', resolve));
        }
      }
    }).then(() => cb(), cb);
  }

  _final(cb) {
    this.txChain.then(() => {
      try {
        this.raw.end();
      } catch {
        /* already gone */
      }
      cb();
    }, cb);
  }

  _destroy(err, cb) {
    this.raw.off('data', this._onRawData);
    this.raw.off('error', this._onRawError);
    this.raw.off('end', this._onRawEnd);
    this.raw.off('close', this._onRawClose);
    if (!this.raw.destroyed) this.raw.destroy();
    cb(err);
  }
}

/** Seal one UDP datagram. A fresh 96-bit random nonce goes in front of every packet. */
export function sealDatagram(key, direction, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  cipher.setAAD(Buffer.from(direction, 'ascii'));
  return Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

export function openDatagram(key, direction, packet) {
  if (packet.length < 12 + TAG_LEN) throw new Error('short datagram');
  const iv = packet.subarray(0, 12);
  const body = packet.subarray(12, packet.length - TAG_LEN);
  const tag = packet.subarray(packet.length - TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  decipher.setAAD(Buffer.from(direction, 'ascii'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
