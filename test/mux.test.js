import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { duplexPair } from './helpers.js';
import { Mux } from '../src/mux.js';

function pair() {
  const [aRaw, bRaw] = duplexPair();
  const a = new Mux(aRaw, { isDialer: true });
  const b = new Mux(bRaw, { isDialer: false });
  a.on('error', () => {});
  b.on('error', () => {});
  return { a, b, aRaw, bRaw };
}

test('mux opens streams and streams data with SYN initials', async () => {
  const { a, b } = pair();
  const incoming = new Promise((resolve) => b.once('stream', resolve));
  const stream = a.openStream(Buffer.from('GET /'));
  const remote = await incoming;
  const chunks = [];
  remote.on('data', (c) => chunks.push(c));
  stream.write('hello');
  stream.end('!');
  await new Promise((r) => remote.once('end', r));
  const text = Buffer.concat(chunks).toString();
  assert.ok(text.startsWith('GET /'), `initial delivered first: ${text}`);
  assert.ok(text.includes('hello!'), 'data delivered');
  stream.destroy();
  remote.destroy();
  a.close();
  b.close();
});

test('mux response stream returns data to opener', async () => {
  const { a, b } = pair();
  const incoming = new Promise((resolve) => b.once('stream', resolve));
  const local = a.openStream(Buffer.from('ping'));
  const remote = await incoming;
  remote.write('pong');
  remote.end();
  const chunks = [];
  local.on('data', (c) => chunks.push(c));
  await new Promise((r) => local.once('end', r));
  assert.equal(Buffer.concat(chunks).toString(), 'pong');
  local.destroy();
  remote.destroy();
  a.close();
  b.close();
});

test('mux datagrams are delivered on the other side', async () => {
  const { a, b } = pair();
  const got = new Promise((resolve) => b.once('datagram', resolve));
  await a.sendDatagram(Buffer.from('dgram-payload'));
  assert.equal((await got).toString(), 'dgram-payload');
  a.close();
  b.close();
});

test('mux handles many interleaved streams', async () => {
  const { a, b } = pair();
  b.on('stream', (stream) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => stream.end(Buffer.concat(chunks)));
  });
  const jobs = Array.from({ length: 25 }, async (_, i) => {
    const s = a.openStream();
    s.end(`stream-${i}`);
    const replies = [];
    for await (const chunk of s) replies.push(chunk);
    return Buffer.concat(replies).toString();
  });
  const results = await Promise.all(jobs);
  assert.equal(results.length, 25);
  for (let i = 0; i < 25; i++) assert.ok(results.includes(`stream-${i}`));
  a.close();
  b.close();
});
