import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import {
  CONNECT_PREFIX, normalizeUrl, encodeConnectCode, decodeConnectCode,
  validatePanelCode, serverFromConnect,
  writeConnectEnv, readConnectEnv, applyConnect, connectCommand,
} from '../src/connect.js';
import { Agent } from '../src/agent.js';

test('connect code round-trips and defaults to 24 hours', () => {
  const now = Date.UTC(2026, 0, 1);
  const code = encodeConnectCode({
    agent: '87.107.81.145:7700',
    panelLocal: 'http://127.0.0.1:18080',
    token: 'abc123',
    name: 'outside',
    now,
  });
  assert.ok(code.startsWith(CONNECT_PREFIX));
  const info = decodeConnectCode(code, { now });
  assert.equal(info.agent, 'http://87.107.81.145:7700');
  assert.equal(info.panelLocal, 'http://127.0.0.1:18080');
  assert.equal(info.token, 'abc123');
  assert.equal(info.name, 'outside');
  assert.equal(info.expiresAt, Math.floor(now / 1000) + 24 * 3600);
});

test('connect code rejects bad prefixes, structure and expiry', () => {
  assert.throws(() => decodeConnectCode('kz1_abc'), /معتبر نیست/);
  assert.throws(() => decodeConnectCode(`${CONNECT_PREFIX}bm90LWpzb24`), /خوانده نشد|نامعتبر/);
  const now = Date.UTC(2026, 0, 1);
  const code = encodeConnectCode({ agent: 'http://1.2.3.4:7700', token: 't', ttlHours: 1, now });
  assert.throws(() => decodeConnectCode(code, { now: now + 2 * 3600 * 1000 }), /منقضی/);
  assert.equal(normalizeUrl('example.com:7700/'), 'http://example.com:7700');
});

test('panel only accepts codes carrying its own secret', () => {
  const code = encodeConnectCode({ agent: 'http://1.2.3.4:7700', token: 'panel-secret', name: 'outside' });
  assert.equal(validatePanelCode(code, 'panel-secret').name, 'outside');
  assert.throws(() => validatePanelCode(code, 'stale-agent-token'), /متعلق به این پنل نیست/);
  const server = serverFromConnect(decodeConnectCode(code), { host: '9.9.9.9', agentPort: 7701 });
  assert.equal(server.id, 'outside');
  assert.equal(server.host, '9.9.9.9');
  assert.equal(server.token, 'panel-secret');
});

test('agent relays a valid code even when its own token is stale', async () => {
  let received = null;
  const panel = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    received = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    assert.equal(req.url, '/api/connect/register');
    assert.equal(req.headers['x-nahr-token'], undefined);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, server: { id: 'outside', host: '9.9.9.9', agentPort: 7700 } }));
  });
  panel.listen(0, '127.0.0.1');
  await once(panel, 'listening');
  const agent = new Agent({ id: 'panel-agent', port: 0, host: '127.0.0.1', token: 'stale-agent-token' });
  await agent.start();
  try {
    const code = encodeConnectCode({
      agent: `http://127.0.0.1:${agent.port}`,
      panelLocal: `http://127.0.0.1:${panel.address().port}`,
      token: 'panel-secret',
      name: 'outside',
    });
    const result = await applyConnect({ code, host: '9.9.9.9' });
    assert.equal(result.ok, true);
    assert.equal(received.code, code);
    assert.equal(received.server.host, '9.9.9.9');
  } finally {
    await agent.stop();
    panel.close();
    await once(panel, 'close');
  }
});

test('connect env file survives quotes and spaces', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nahr-connect-'));
  const file = path.join(dir, 'connect.env');
  writeConnectEnv(file, { token: 'tok', id: 'srv', name: 'outside "north"' });
  const parsed = readConnectEnv(file);
  assert.equal(parsed.NAHR_TOKEN, 'tok');
  assert.equal(parsed.NAHR_ID, 'srv');
  assert.equal(parsed.NAHR_NAME, 'outside "north"');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('one-line command contains the installer URL and the code', () => {
  const cmd = connectCommand('nh1_abc', 'https://example.com/install.sh');
  assert.match(cmd, /bash <\(curl -fsSL https:\/\/example\.com\/install\.sh\) --agent nh1_abc/);
});

test('agent registrar registers the joining server and sends the token', async () => {
  let received = null;
  let tokenHeader = '';
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    received = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    tokenHeader = req.headers['x-nahr-token'] || '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, server: received.server }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  try {
    const code = encodeConnectCode({ agent: `http://127.0.0.1:${port}`, token: 'shared', name: 'outside' });
    const result = await applyConnect({ code, host: '9.9.9.9', agentPort: 7700 });
    assert.equal(result.ok, true);
    assert.equal(result.server.host, '9.9.9.9');
    assert.equal(result.server.token, 'shared');
    assert.equal(tokenHeader, 'shared');
    assert.equal(received.server.name, 'outside');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('duplicate registration asks before replacing', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(409, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ needsConfirm: true, duplicate: { id: 'old', host: '9.9.9.9' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const code = encodeConnectCode({ agent: `http://127.0.0.1:${server.address().port}`, token: 't' });
    const result = await applyConnect({ code, host: '9.9.9.9' });
    assert.equal(result.ok, false);
    assert.equal(result.needsConfirm, true);
    assert.equal(result.duplicate.id, 'old');
  } finally {
    server.close();
    await once(server, 'close');
  }
});
