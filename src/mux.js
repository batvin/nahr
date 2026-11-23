import { Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';

export const F = { SYN: 1, DATA: 2, FIN: 4, RST: 8, DATAGRAM: 16 };
const HEADER = 13;

class MuxStream extends Duplex {
  constructor(mux, id, { initial } = {}) {
    super({ highWaterMark: 256 * 1024 });
    this.mux = mux;
    this.id = id;
    this.initial = initial;
    this.localEnded = false;
    this.remoteEnded = false;
  }

  _write(chunk, _enc, cb) {
    // A peer FIN only ends *its* sending side (TCP-style half close).
    // We must still be able to send our response after it.
    this.mux.send(this.id, F.DATA, chunk).then(() => cb(), cb);
  }

  _final(cb) {
    this.localEnded = true;
    this.mux.send(this.id, F.FIN, Buffer.alloc(0)).then(() => cb(), cb);
  }

  _read() {
    this.mux.onStreamRead(this);
  }

  _destroy(err, cb) {
    if (!this.localEnded && !this.mux.closed) this.mux.send(this.id, F.RST, Buffer.alloc(0)).catch(() => {});
    this.mux.streams.delete(this.id);
    cb(err);
  }
}

/** A small stream multiplexer. One mux instance per transport connection. */
export class Mux extends EventEmitter {
  constructor(transport, { isDialer = true, label = 'mux' } = {}) {
    super();
    this.transport = transport;
    this.isDialer = isDialer;
    this.label = label;
    this.streams = new Map();
    this.nextId = isDialer ? 1 : 2;
    this.rx = Buffer.alloc(0);
    this.tx = Promise.resolve();
    this.blocked = new Set();
    this.closed = false;
    this._onData = this._onData.bind(this);
    transport.on('data', this._onData);
    transport.on('error', (err) => this._fail(err));
    transport.on('close', () => this._fail(new Error('transport closed')));
  }

  _fail(err) {
    if (this.closed) return;
    this.closed = true;
    if (this.listenerCount('error')) this.emit('error', err);
    for (const stream of this.streams.values()) {
      // Streams with no error listener would emit an unhandled 'error' during
      // teardown. Attach a no-op so destruction stays quiet.
      if (!stream.listenerCount('error')) stream.on('error', () => {});
      stream.destroy(err);
    }
    this.streams.clear();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.transport.off('data', this._onData);
    if (!this.transport.destroyed) this.transport.destroy();
  }

  openStream(initial = Buffer.alloc(0)) {
    if (this.closed) throw new Error('mux is closed');
    const id = this.nextId;
    this.nextId += 2;
    const stream = new MuxStream(this, id);
    this.streams.set(id, stream);
    this.send(id, F.SYN, initial).catch((err) => stream.destroy(err));
    return stream;
  }

  sendDatagram(payload) {
    return this.send(0, F.DATAGRAM, payload);
  }

  send(id, flags, payload) {
    // During teardown, pending FIN/DATA flushes should resolve quietly instead
    // of turning into uncaught errors on the stream that initiated them.
    if (this.closed) return Promise.resolve();
    this.tx = this.tx.then(async () => {
      if (this.closed || this.transport.destroyed) return;
      const frame = Buffer.allocUnsafe(HEADER + payload.length);
      frame.writeUInt32BE(id >>> 0, 0);
      frame[4] = flags;
      frame.writeUInt32BE(payload.length, 5);
      payload.copy(frame, HEADER);
      if (!this.transport.write(frame)) {
        await new Promise((resolve) => this.transport.once('drain', resolve));
      }
    });
    return this.tx;
  }

  onStreamRead(stream) {
    this.blocked.delete(stream);
    if (this.blocked.size === 0 && this.transport.isPaused?.()) this.transport.resume();
  }

  _onData(chunk) {
    if (this.closed) return;
    this.rx = this.rx.length ? Buffer.concat([this.rx, chunk]) : chunk;
    while (this.rx.length >= HEADER) {
      const id = this.rx.readUInt32BE(0);
      const flags = this.rx[4];
      const len = this.rx.readUInt32BE(5);
      if (len > 16 * 1024 * 1024) return this._fail(new Error('mux frame too large'));
      if (this.rx.length < HEADER + len) break;
      const payload = this.rx.subarray(HEADER, HEADER + len);
      this.rx = this.rx.subarray(HEADER + len);
      this._handleFrame(id, flags, payload);
      if (this.closed) return;
    }
  }

  _handleFrame(id, flags, payload) {
    if (flags & F.DATAGRAM) {
      this.emit('datagram', Buffer.from(payload));
      return;
    }
    let stream = this.streams.get(id);
    if (flags & F.SYN) {
      if (stream) return;
      stream = new MuxStream(this, id);
      this.streams.set(id, stream);
      this.emit('stream', stream);
      if (payload.length) {
        if (!stream.push(Buffer.from(payload))) {
          this.blocked.add(stream);
          if (this.blocked.size === 1) this.transport.pause();
        }
      }
      return;
    }
    if (!stream) return;
    if (flags & F.DATA) {
      const copy = Buffer.from(payload);
      if (!stream.push(copy)) {
        this.blocked.add(stream);
        if (this.blocked.size === 1) this.transport.pause();
      }
    }
    if (flags & F.FIN) {
      stream.remoteEnded = true;
      stream.push(null);
    }
    if (flags & F.RST) {
      stream.remoteEnded = true;
      stream.destroy();
    }
  }
}
