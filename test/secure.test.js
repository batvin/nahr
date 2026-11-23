import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { duplexPair } from './helpers.js';
import { handshake, SealedStream, sealDatagram, openDatagram } from '../src/secure.js';

const TOKEN = 'test-secret-token';

function collect(stream) {
  const parts = [];
  stream.on('data', (c) => parts.push(c));
  return {
    text: () => Buffer.concat(parts).toString(),
    bytes: () => Buffer.concat(parts),
    wait: () => new Promise((resolve) => stream.once('end', resolve)),
  };
}

test('X25519 handshake derives matching keys on both sides', async () => {
  const [clientRaw, serverRaw] = duplexPair();
  const [client, server] = await Promise.all([
    handshake(clientRaw, TOKEN, 'dial'),
    handshake(serverRaw, TOKEN, 'listen'),
  ]);
  assert.deepEqual(client.keys.c2s, server.keys.c2s, 'c2s keys match');
  assert.deepEqual(client.keys.s2c, server.keys.s2c, 's2c keys match');
  assert.notDeepEqual(client.keys.c2s, client.keys.s2c, 'directions differ');
  clientRaw.destroy();
  serverRaw.destroy();
});

test('handshake rejects a wrong token', async () => {
  const [clientRaw, serverRaw] = duplexPair();
  const results = await Promise.allSettled([
    handshake(clientRaw, 'wrong-token', 'dial', 400),
    handshake(serverRaw, TOKEN, 'listen', 400),
  ]);
  assert.ok(results.some((r) => r.status === 'rejected'), 'at least one side rejects');
  clientRaw.destroy();
  serverRaw.destroy();
});

test('SealedStream carries payloads both directions', async () => {
  const [clientRaw, serverRaw] = duplexPair();
  const [a, b] = await Promise.all([
    handshake(clientRaw, TOKEN, 'dial'),
    handshake(serverRaw, TOKEN, 'listen'),
  ]);
  const client = new SealedStream(clientRaw, a.keys, 'dial', { initial: a.leftover });
  const server = new SealedStream(serverRaw, b.keys, 'listen', { initial: b.leftover });
  const fromServer = collect(server);
  const fromClient = collect(client);

  client.write('hello ');
  client.write('world');
  server.write('reply');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(fromServer.text(), 'hello world');
  assert.equal(fromClient.text(), 'reply');
  client.destroy();
  server.destroy();
});

test('SealedStream survives a 1 MB transfer', async () => {
  const [clientRaw, serverRaw] = duplexPair();
  const [a, b] = await Promise.all([
    handshake(clientRaw, TOKEN, 'dial'),
    handshake(serverRaw, TOKEN, 'listen'),
  ]);
  const client = new SealedStream(clientRaw, a.keys, 'dial', { initial: a.leftover });
  const server = new SealedStream(serverRaw, b.keys, 'listen', { initial: b.leftover });
  const fromServer = collect(server);

  const payload = Buffer.alloc(1024 * 1024, 0x5a);
  client.end(payload);
  await fromServer.wait();
  assert.ok(fromServer.bytes().equals(payload), '1 MB survives round trip');
  client.destroy();
  server.destroy();
});

test('datagram sealing is authenticated and direction-bound', () => {
  const key = Buffer.alloc(32, 7);
  const plain = Buffer.from('udp payload');
  const sealed = sealDatagram(key, 'DATA', plain);
  assert.ok(openDatagram(key, 'DATA', sealed).equals(plain));
  assert.throws(() => openDatagram(key, 'ACK', sealed));
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => openDatagram(key, 'DATA', tampered));
});
