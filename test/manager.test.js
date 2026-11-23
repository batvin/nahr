import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePort, maskToken, formatUptime, statusLines, VERSION, DEFAULT_PANEL_PORT } from '../src/manager.js';

test('manager parses ports with a safe fallback', () => {
  assert.equal(parsePort('18080'), 18080);
  assert.equal(parsePort(' 7700 '), 7700);
  assert.equal(parsePort('0', 99), 99);
  assert.equal(parsePort('70000', 99), 99);
  assert.equal(parsePort('abc', 99), 99);
  assert.equal(parsePort('12.5', 99), 99);
  assert.equal(DEFAULT_PANEL_PORT, 18080);
});

test('manager masks the shared token in the UI', () => {
  assert.equal(maskToken(''), '—');
  assert.equal(maskToken('short'), 'short');
  assert.equal(maskToken('a1b2c3d4e5f60718293a4b5c6d7e8f90'), 'a1b2c3…8f90');
});

test('manager formats uptime in Persian', () => {
  assert.equal(formatUptime(0), '0ثانیه');
  assert.equal(formatUptime(59), '59ثانیه');
  assert.equal(formatUptime(125), '2دقیقه');
  assert.equal(formatUptime(7200), '2ساعت 0دقیقه');
  assert.equal(formatUptime(90000), '1روز 1ساعت');
});

test('manager renders a status snapshot', () => {
  const lines = statusLines({
    hostname: 'test-box',
    ipv4: '1.2.3.4',
    ipv6: '::1',
    installed: true,
    version: VERSION,
    tunnels: 2,
    panel: { active: true, url: 'http://127.0.0.1:18080/panel' },
    agent: { active: true, port: 7700, id: 'test-box' },
    token: 'secret',
  });
  assert.equal(lines.length, 4);
  assert.match(lines[0], /test-box.*1\.2\.3\.4.*::1/);
  assert.match(lines[1], /2 تانل/);
  assert.match(lines[2], /18080\/panel/);
  assert.match(lines[3], /7700/);
});
