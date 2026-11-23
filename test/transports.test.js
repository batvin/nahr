import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { listenChannel, dialChannel, TRANSPORTS } from '../src/transports.js';
import { Mux } from '../src/mux.js';

const TOKEN = 'transport-test-token';

/** For each transport: listen, dial, exchange a payload through the Mux, then close. */
for (const transport of TRANSPORTS) {
  test(`transport ${transport}: dial, encrypt, stream and close`, { timeout: 20000 }, async () => {
    const listener = await listenChannel(transport, { port: 0, token: TOKEN, profile: 'gaming' });
    const got = [];
    listener.on('connection', (channel) => {
      const mux = new Mux(channel, { isDialer: false });
      mux.on('stream', (stream) => {
        stream.on('data', (c) => got.push(c));
        stream.on('end', () => stream.end(Buffer.concat([Buffer.from('echo:'), ...got])));
      });
    });

    const channel = await dialChannel(transport, {
      host: '127.0.0.1',
      port: listener.port,
      token: TOKEN,
      timeout: 8000,
      profile: 'gaming',
    });
    const mux = new Mux(channel, { isDialer: true });
    const stream = mux.openStream();
    stream.end('payload');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'echo:payload');

    stream.destroy();
    mux.close();
    await listener.close();
  });
}

test('all five transports are registered', () => {
  assert.deepEqual(TRANSPORTS, ['tcp', 'tcpmux', 'ws', 'wss', 'udp']);
});
