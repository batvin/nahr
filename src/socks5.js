import net from 'node:net';
import dgram from 'node:dgram';
import { logger } from './log.js';

const log = logger('socks5');

/** Encode/decode the destination header carried as the first bytes of a tunnel stream. */
export function encodeDest({ host, port }) {
  const h = String(host);
  if (net.isIPv4(h)) {
    const out = Buffer.alloc(1 + 4 + 2);
    out[0] = 1;
    h.split('.').forEach((part, i) => out.writeUInt8(Number(part), 1 + i));
    out.writeUInt16BE(port, 5);
    return out;
  }
  if (net.isIPv6(h)) {
    const out = Buffer.alloc(1 + 16 + 2);
    out[0] = 4;
    writeIPv6(out, h, 1);
    out.writeUInt16BE(port, 17);
    return out;
  }
  const name = Buffer.from(h.slice(0, 255), 'utf8');
  const out = Buffer.alloc(1 + 1 + name.length + 2);
  out[0] = 3;
  out[1] = name.length;
  name.copy(out, 2);
  out.writeUInt16BE(port, 2 + name.length);
  return out;
}

function writeIPv6(buf, address, offset) {
  const sections = address.toLowerCase().split('::');
  const left = sections[0] ? sections[0].split(':') : [];
  const right = sections[1] ? sections[1].split(':') : [];
  const words = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  words.forEach((w, i) => buf.writeUInt16BE(parseInt(w || '0', 16), offset + i * 2));
}

export function decodeDest(buf) {
  if (!buf.length) throw new Error('missing destination');
  const type = buf[0];
  if (type === 1) {
    if (buf.length < 7) throw new Error('short IPv4 destination');
    return { host: `${buf[1]}.${buf[2]}.${buf[3]}.${buf[4]}`, port: buf.readUInt16BE(5), rest: buf.subarray(7) };
  }
  if (type === 3) {
    const len = buf[1];
    if (buf.length < 2 + len + 2) throw new Error('short domain destination');
    return { host: buf.subarray(2, 2 + len).toString('utf8'), port: buf.readUInt16BE(2 + len), rest: buf.subarray(4 + len) };
  }
  if (type === 4) {
    if (buf.length < 19) throw new Error('short IPv6 destination');
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push(buf.readUInt16BE(1 + i * 2).toString(16));
    return { host: `[${parts.join(':')}]`, port: buf.readUInt16BE(17), rest: buf.subarray(19) };
  }
  throw new Error(`bad address type: ${type}`);
}

function decodeSocksDest(buf, offset) {
  const type = buf[offset];
  if (type === 1) {
    if (buf.length < offset + 7) return null;
    return { host: `${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}.${buf[offset + 4]}`, port: buf.readUInt16BE(offset + 5), rest: buf.subarray(offset + 7) };
  }
  if (type === 3) {
    const len = buf[offset + 1];
    if (buf.length < offset + 2 + len + 2) return null;
    return { host: buf.subarray(offset + 2, offset + 2 + len).toString('utf8'), port: buf.readUInt16BE(offset + 2 + len), rest: buf.subarray(offset + 4 + len) };
  }
  if (type === 4) {
    if (buf.length < offset + 19) return null;
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push(buf.readUInt16BE(offset + 1 + i * 2).toString(16));
    return { host: `[${parts.join(':')}]`, port: buf.readUInt16BE(offset + 17), rest: buf.subarray(offset + 19) };
  }
  return null;
}

/**
 * A SOCKS5 proxy that hands connections and UDP datagrams to callbacks.
 * onConnect(dest, socket) must return a Duplex that will be piped to the client.
 */
export function createSocks5Server({ onConnect, onDatagram, host = '127.0.0.1', port = 1080 }) {
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    let stage = 0;
    let buffer = Buffer.alloc(0);
    let udpRelay = null;
    let udpClient = null;

    const reply = (code, addr) => {
      const body = Buffer.from([5, code, 0, ...addr]);
      socket.write(body);
    };

    socket.on('data', async (chunk) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        if (stage === 0) {
          if (buffer.length < 2) return;
          if (buffer[0] !== 5) return socket.destroy();
          const methods = buffer.subarray(2, 2 + buffer[1]);
          if (buffer.length < 2 + buffer[1]) return;
          buffer = buffer.subarray(2 + buffer[1]);
          if (!methods.includes(0)) {
            socket.write(Buffer.from([5, 0xff]));
            return socket.destroy();
          }
          socket.write(Buffer.from([5, 0]));
          stage = 1;
        }
        if (stage === 1) {
          if (buffer.length < 5) return;
          const version = buffer[0];
          const cmd = buffer[1];
          if (version !== 5) return socket.destroy();
          const dest = decodeSocksDest(buffer, 3);
          if (!dest) return;
          const consumed = dest.rest.byteOffset - buffer.byteOffset;
          buffer = buffer.subarray(consumed);
          if (cmd === 1) {
            stage = 2;
            socket.pause();
            let upstream;
            try {
              upstream = await onConnect({ host: dest.host, port: dest.port }, socket, dest.rest);
            } catch (err) {
              log.warn(`connect to ${dest.host}:${dest.port} failed: ${err.message}`);
              reply(1, [1, 0, 0, 0, 0, 0]);
              socket.destroy();
              return;
            }
            reply(0, [1, 0, 0, 0, 0, 0]);
            socket.resume();
            if (dest.rest.length) upstream.write(dest.rest);
            socket.pipe(upstream);
            upstream.pipe(socket);
            socket.on('error', () => upstream.destroy());
            upstream.on('error', () => socket.destroy());
            return;
          }
          if (cmd === 3) {
            if (!udpRelay) {
              udpClient = socket.remoteAddress;
              udpRelay = dgram.createSocket('udp4');
              udpRelay.on('message', (msg, rinfo) => {
                const parsed = decodeSocksDest(msg, 2);
                if (!parsed) return;
                const sendBack = (payload) => {
                  try {
                    udpRelay.send(payload, rinfo.port, rinfo.address);
                  } catch {
                    /* ignore */
                  }
                };
                void onDatagram({ host: parsed.host, port: parsed.port }, parsed.rest, sendBack);
              });
              await new Promise((resolve, reject) => {
                udpRelay.once('error', reject);
                udpRelay.bind(0, host, resolve);
              });
            }
            const addr = udpRelay.address();
            reply(0, [1, ...addr.address.split('.').map(Number), ...[(addr.port >> 8) & 255, addr.port & 255]]);
            return;
          }
          reply(7, [1, 0, 0, 0, 0, 0]);
          socket.destroy();
        }
      } catch (err) {
        log.warn(`socks error: ${err.message}`);
        socket.destroy();
      }
    });

    socket.on('close', () => {
      if (udpRelay) {
        try {
          udpRelay.close();
        } catch {
          /* ignore */
        }
      }
    });
  });
  server.listen(port, host);
  return server;
}
