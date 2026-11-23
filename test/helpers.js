import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Duplex } from 'node:stream';

/** Isolated data directory so tests never touch the user's real state. */
export function useTestData(tag = 'nahr-test') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
  process.env.NAHR_DATA = dir;
  return dir;
}

useTestData();

export const { ROOT, DATA_DIR, uid, sleep } = await import('../src/util.js');
export const net = await import('node:net');
export const crypto = await import('node:crypto');

/** Two in-memory Duplex streams wired end-to-end, without feedback loops. */
export function duplexPair() {
  let a;
  let b;
  a = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      b.push(chunk);
      cb();
    },
    final(cb) {
      b.push(null);
      cb();
    },
  });
  b = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      a.push(chunk);
      cb();
    },
    final(cb) {
      a.push(null);
      cb();
    },
  });
  a.on('error', () => b.destroy());
  b.on('error', () => a.destroy());
  return [a, b];
}

export function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

export async function waitFor(fn, { timeout = 5000, interval = 50, message = 'condition not met' } = {}) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    await sleep(interval);
  }
  throw new Error(`${message}${last ? `: ${last.message}` : ''}`);
}

/** A tiny TCP echo server. */
export async function echoServer() {
  const server = net.createServer((socket) => socket.pipe(socket));
  const port = await freePort();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { server, port, close: () => new Promise((r) => server.close(r)) };
}
