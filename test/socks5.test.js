import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import './helpers.js';
import { freePort, sleep, waitFor } from './helpers.js';
import { createSocks5Server } from '../src/socks5.js';

test('SOCKS5 early client bytes arrive once as initial, never written twice', async () => {
  const port = await freePort();
  let initialSeen = null;
  const written = [];
  const server = createSocks5Server({
    host: '127.0.0.1',
    port,
    onConnect: (_dest, _socket, initial) => {
      initialSeen = initial.toString();
      const up = new PassThrough();
      up.on('data', (chunk) => written.push(chunk));
      up.on('error', () => {});
      return up;
    },
  });
  if (!server.listening) await new Promise((r) => server.once('listening', r));

  const client = net.connect(port, '127.0.0.1');
  let buf = Buffer.alloc(0);
  let stage = 0;
  const reply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no SOCKS5 reply')), 4000);
    client.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0 && buf.length >= 2) {
        buf = buf.subarray(2);
        stage = 1;
        client.write(Buffer.concat([
          Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0, 80]),
          Buffer.from('EARLY-TLS-BYTES'),
        ]));
      }
      if (stage === 1 && buf.length >= 10) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  client.on('error', () => {});
  try {
    await new Promise((r) => client.once('connect', r));
    client.write(Buffer.from([5, 1, 0]));
    await reply;
    await waitFor(() => initialSeen !== null, { message: 'onConnect initial missing' });
    await sleep(150);

    assert.equal(initialSeen, 'EARLY-TLS-BYTES', 'early bytes handed to the tunnel once');
    assert.equal(Buffer.concat(written).toString(), '', 'early bytes not duplicated by socks5.js');
  } finally {
    client.destroy();
    await new Promise((r) => server.close(r));
  }
});
