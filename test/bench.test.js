import test from 'node:test';
import assert from 'node:assert/strict';
import { useTestData, freePort } from './helpers.js';
import { Agent } from '../src/agent.js';
import { runBench, applyBench, lastBench, modeServer } from '../src/bench.js';
import { getState } from '../src/store.js';

test('benchmark mode labels match tunnel topology', () => {
  const entry = { id: 'entry' };
  const exit = { id: 'exit' };
  assert.equal(modeServer('direct', 'listener', entry, exit), exit);
  assert.equal(modeServer('direct', 'dialer', entry, exit), entry);
  assert.equal(modeServer('reverse', 'listener', entry, exit), entry);
  assert.equal(modeServer('reverse', 'dialer', entry, exit), exit);
});

async function startAgent(id) {
  const port = await freePort();
  const agent = new Agent({ id, name: id, port, host: '127.0.0.1', token: getState().secret });
  await agent.start();
  return { agent, port };
}

test('benchmark probes transports and recommends a winner', { timeout: 120000 }, async () => {
  const a = await startAgent('bench-a');
  const b = await startAgent('bench-b');
  getState().servers.push(
    { id: 'bench-a', name: 'A', host: '127.0.0.1', agentPort: a.port, token: getState().secret, dialHost: '127.0.0.1' },
    { id: 'bench-b', name: 'B', host: '127.0.0.1', agentPort: b.port, token: getState().secret, dialHost: '127.0.0.1' },
  );

  try {
    const result = await runBench({ entryId: 'bench-a', exitId: 'bench-b', profile: 'balanced', seconds: 1, streams: 2 });
    assert.equal(result.state, 'done', `bench failed: ${result.error}`);
    assert.equal(result.candidates.length, 10, '5 transports x 2 directions');
    assert.ok(result.recommended, 'a winner is recommended');
    assert.ok(result.recommended.score > 0, 'winner has a positive score');
    assert.ok(result.recommended.metrics.download_mbps >= 0.5 && result.recommended.metrics.upload_mbps >= 0.5,
      'winner can carry traffic in both directions');
    assert.ok(result.candidates.some((c) => c.state === 'ok' && c.result), 'at least one speed result');
    assert.ok(result.candidates.every((c) => c.state !== 'ok' || c.result), 'no probe-only candidate is ranked as ok');
    assert.equal(lastBench()?.id, result.id, 'result is persisted');

    const tunnel = applyBench(result.id, result.recommended.key);
    assert.equal(tunnel.transport, result.recommended.transport);
    assert.equal(tunnel.mode, result.recommended.mode);
    console.log(`  winner: ${result.recommended.label} ${result.recommended.mode} (score ${result.recommended.score})`);
  } finally {
    await a.agent.stop();
    await b.agent.stop();
  }
});
