import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { freePort, waitFor } from './helpers.js';
import { Agent } from '../src/agent.js';
import { Panel } from '../src/panel.js';
import { update, getState } from '../src/store.js';

const TOKEN = 'panel-test-token';

test('panel reports live status for a started tunnel with forwards', { timeout: 20000 }, async () => {
  const agentEntryPort = await freePort();
  const agentExitPort = await freePort();
  const panelPort = await freePort();
  const forwardPort = await freePort();
  const targetPort = await freePort();
  const secret = getState().secret;
  const entry = new Agent({ id: 'entry', name: 'entry', port: agentEntryPort, token: secret });
  const exit = new Agent({ id: 'exit', name: 'exit', port: agentExitPort, token: secret });
  await Promise.all([entry.start(), exit.start()]);
  update((s) => {
    s.servers = [
      { id: 'entry', name: 'entry', host: '127.0.0.1', agentPort: agentEntryPort, token: secret, dialHost: '127.0.0.1' },
      { id: 'exit', name: 'exit', host: '127.0.0.1', agentPort: agentExitPort, token: secret, dialHost: '127.0.0.1' },
    ];
    s.tunnels = [];
  });
  const panel = new Panel({ port: panelPort, host: '127.0.0.1' });
  await panel.start();
  try {
    const base = `http://127.0.0.1:${panel.port}`;
    const created = await (await fetch(`${base}/api/tunnels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'test', entryId: 'entry', exitId: 'exit', transport: 'tcpmux', mode: 'direct', listenPort: 0,
        forwards: [{ listenHost: '127.0.0.1', listenPort: forwardPort, targetHost: '127.0.0.1', targetPort }],
      }),
    })).json();
    assert.ok(created.ok, created.error || 'create failed');
    const id = created.tunnel.id;
    const started = await (await fetch(`${base}/api/tunnels/${id}/start`, { method: 'POST' })).json();
    assert.ok(started.ok, started.error || 'start failed');
    await waitFor(async () => {
      const data = await (await fetch(`${base}/api/tunnels`)).json();
      return data.tunnels[0]?.status?.running === true;
    }, { message: 'panel did not report running status' });
    const data = await (await fetch(`${base}/api/tunnels`)).json();
    assert.equal(data.tunnels[0].status.role, 'entry');
    assert.equal(data.tunnels[0].status.forwards.length, 1);
    assert.equal(typeof data.tunnels[0].status.exitListenPort, 'number');
    await fetch(`${base}/api/tunnels/${id}/stop`, { method: 'POST' });
  } finally {
    await panel.stop();
    await Promise.all([entry.stop(), exit.stop()]);
  }
});
