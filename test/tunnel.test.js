import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import './helpers.js';
import { echoServer, freePort, waitFor } from './helpers.js';
import { TunnelRuntime } from '../src/tunnel.js';
import { encodeDest, decodeDest, normalizeDestHost } from '../src/socks5.js';

const TOKEN = 'tunnel-test-token';

test('destination header strips SOCKS IPv6 brackets and keeps a real IPv6 literal', () => {
  assert.equal(normalizeDestHost('[2001:4860:4802:32::78]'), '2001:4860:4802:32::78');
  assert.equal(normalizeDestHost('ifconfig.me'), 'ifconfig.me');
  const encoded = encodeDest({ host: '[2001:4860:4802:32::78]', port: 443 });
  assert.equal(encoded[0], 4); // ATYP IPv6, not a bracketed domain
  const decoded = decodeDest(encoded);
  assert.equal(decoded.port, 443);
  assert.equal(normalizeDestHost(decoded.host), '2001:4860:4802:32:0:0:0:78');
});

/** Minimal SOCKS5 client: greeting, then CONNECT for a domain target. */
function socksConnect(port, host, targetPort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => reject(new Error('socks connect timeout')), 8000);
    let stage = 0;
    const onData = (chunk) => {
      if (stage === 0) {
        assert.equal(chunk[0], 5, 'SOCKS5 greeting');
        stage = 1;
        const name = Buffer.from(host);
        const req = Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([targetPort >> 8, targetPort & 255])]);
        socket.write(req);
        return;
      }
      if (stage === 1) {
        clearTimeout(timer);
        socket.off('data', onData);
        if (chunk[1] !== 0) return reject(new Error(`SOCKS reply code ${chunk[1]}`));
        resolve(socket);
      }
    };
    socket.on('data', onData);
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on('connect', () => socket.write(Buffer.from([5, 1, 0])));
  });
}

/** Bring up an entry+exit pair in direct mode and return the SOCKS port. */
async function pair(transports) {
  const target = await echoServer();
  const listenPort = await freePort();
  const socksPort = await freePort();
  const exit = new TunnelRuntime({
    id: 'exit', name: 'exit', role: 'exit', transport: transports, mode: 'direct', listenPort, profile: 'balanced',
  }, { token: TOKEN });
  await exit.start();

  const entry = new TunnelRuntime({
    id: 'entry', name: 'entry', role: 'entry', transport: transports, mode: 'direct',
    remoteHost: '127.0.0.1', remotePort: listenPort, socksPort, profile: 'balanced',
  }, { token: TOKEN });
  await entry.start();

  await waitFor(() => entry.status().channels > 0, { message: 'entry channel not connected' });
  return { entry, exit, target, socksPort };
}

for (const transport of ['tcp', 'tcpmux', 'ws', 'udp']) {
  test(`SOCKS5 CONNECT through ${transport} tunnel`, { timeout: 20000 }, async () => {
    const { entry, exit, target, socksPort } = await pair(transport);
    try {
      const client = await socksConnect(socksPort, '127.0.0.1', target.port);
      client.write('through-tunnel');
      const reply = await new Promise((resolve, reject) => {
        const parts = [];
        let bytes = 0;
        client.on('data', (c) => {
          parts.push(c);
          bytes += c.length;
          if (bytes >= 'through-tunnel'.length) resolve(Buffer.concat(parts).toString());
        });
        client.on('error', reject);
        setTimeout(() => reject(new Error('echo timeout')), 6000).unref?.();
      });
      assert.equal(reply, 'through-tunnel');
      client.destroy();
    } finally {
      await entry.stop();
      await exit.stop();
      await target.close();
    }
  });
}

test('explicit port forward maps a fixed local port to an exit destination', { timeout: 20000 }, async () => {
  const target = await echoServer();
  const listenPort = await freePort();
  const forwardPort = await freePort();
  const exit = new TunnelRuntime({
    id: 'exit', name: 'exit', role: 'exit', transport: 'tcpmux', mode: 'direct', listenPort, profile: 'balanced',
  }, { token: TOKEN });
  await exit.start();
  const entry = new TunnelRuntime({
    id: 'entry', name: 'entry', role: 'entry', transport: 'tcpmux', mode: 'direct',
    remoteHost: '127.0.0.1', remotePort: listenPort, profile: 'balanced',
    forwards: [{ listenHost: '127.0.0.1', listenPort: forwardPort, targetHost: '127.0.0.1', targetPort: target.port }],
  }, { token: TOKEN });
  await entry.start();
  await waitFor(() => entry.status().channels > 0, { message: 'entry channel not connected' });

  try {
    assert.equal(entry.status().forwards.length, 1);
    const client = net.connect({ host: '127.0.0.1', port: forwardPort });
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    client.write('fixed-port');
    const reply = await new Promise((resolve, reject) => {
      const parts = [];
      let bytes = 0;
      client.on('data', (c) => {
        parts.push(c);
        bytes += c.length;
        if (bytes >= 'fixed-port'.length) resolve(Buffer.concat(parts).toString());
      });
      client.on('error', reject);
      setTimeout(() => reject(new Error('forward echo timeout')), 6000).unref?.();
    });
    assert.equal(reply, 'fixed-port');
    client.destroy();
  } finally {
    await entry.stop();
    await exit.stop();
    await target.close();
  }
});

test('tunnel status reports live stats', async () => {
  const { entry, exit, target, socksPort } = await pair('tcpmux');
  try {
    const status = entry.status();
    assert.equal(status.running, true);
    assert.equal(status.role, 'entry');
    assert.ok(status.channels > 0);
    assert.equal(status.socksPort, socksPort);
  } finally {
    await entry.stop();
    await exit.stop();
    await target.close();
  }
});

test('reverse mode: exit dials the entry and forwards work', { timeout: 20000 }, async () => {
  const target = await echoServer();
  const listenPort = await freePort();
  const forwardPort = await freePort();
  const entry = new TunnelRuntime({
    id: 'entry', name: 'entry', role: 'entry', transport: 'tcpmux', mode: 'reverse',
    listenPort, profile: 'balanced',
    forwards: [{ listenHost: '127.0.0.1', listenPort: forwardPort, targetHost: '127.0.0.1', targetPort: target.port }],
  }, { token: TOKEN });
  await entry.start();
  const exit = new TunnelRuntime({
    id: 'exit', name: 'exit', role: 'exit', transport: 'tcpmux', mode: 'reverse',
    remoteHost: '127.0.0.1', remotePort: listenPort, profile: 'balanced',
  }, { token: TOKEN });
  await exit.start();
  await waitFor(() => exit.status().channels > 0, { message: 'reverse exit did not dial entry' });

  try {
    const client = net.connect({ host: '127.0.0.1', port: forwardPort });
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    client.write('reverse-forward');
    const reply = await new Promise((resolve, reject) => {
      const parts = [];
      let bytes = 0;
      client.on('data', (c) => {
        parts.push(c);
        bytes += c.length;
        if (bytes >= 'reverse-forward'.length) resolve(Buffer.concat(parts).toString());
      });
      client.on('error', reject);
      setTimeout(() => reject(new Error('reverse forward timeout')), 6000).unref?.();
    });
    assert.equal(reply, 'reverse-forward');
    client.destroy();
  } finally {
    await exit.stop();
    await entry.stop();
    await target.close();
  }
});
