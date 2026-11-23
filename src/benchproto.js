import { Mux } from './mux.js';
import { mean, percentile } from './util.js';

function readExact(stream, size, timeout = 8000) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('bench command timed out'));
    }, timeout);
    const cleanup = () => {
      clearTimeout(timer);
      stream.off('readable', onReadable);
      stream.off('error', onError);
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    // Read in paused mode so bytes after `size` are never lost: the next reader
    // (or a later readExact) will see them via unshift().
    const onReadable = () => {
      let chunk;
      while ((chunk = stream.read()) !== null) {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length >= size) {
          const result = buf.subarray(0, size);
          cleanup();
          if (buf.length > size) stream.unshift(buf.subarray(size));
          resolve(result);
          return;
        }
      }
    };
    stream.on('readable', onReadable);
    stream.on('error', onError);
    onReadable();
  });
}

/** Runs on the listening agent. Answers ping / download / upload streams. */
export function attachBenchResponder(mux) {
  mux.on('stream', (stream) => {
    void (async () => {
      try {
        const first = await readExact(stream, 1);
        const cmd = String.fromCharCode(first[0]);
        if (cmd === 'P' || cmd === 'D') {
          const rest = await readExact(stream, 8);
          const head = Buffer.concat([first, rest]);
          if (cmd === 'P') {
            stream.write(head);
            stream.end();
            return;
          }
          const duration = rest.readUInt32BE(0);
          const chunk = Buffer.alloc(64 * 1024, 7);
          const until = Date.now() + duration;
          while (Date.now() < until && !stream.destroyed) {
            if (!stream.write(chunk)) {
              await new Promise((resolve) => stream.once('drain', resolve));
            }
          }
          stream.end();
          return;
        }
        if (cmd === 'U') {
          let total = 0;
          await new Promise((resolve, reject) => {
            stream.on('data', (chunk) => (total += chunk.length));
            stream.once('end', resolve);
            stream.once('error', reject);
          });
          const reply = Buffer.alloc(8);
          reply.writeBigUInt64BE(BigInt(total), 0);
          stream.write(reply);
          stream.end();
          return;
        }
        stream.end();
      } catch {
        stream.destroy();
      }
    })();
  });
}

/** Runs on the dialing agent. Measures RTT, download and upload through the channel. */
export async function runBench(channel, { seconds = 3, streams = 4, pings = 20, label = '' } = {}) {
  const mux = new Mux(channel, { isDialer: true });
  const rtts = [];
  let lost = 0;
  try {
    for (let i = 0; i < pings; i++) {
      try {
        const stream = mux.openStream();
        const sent = Buffer.alloc(9);
        sent[0] = 0x50;
        sent.writeBigUInt64BE(BigInt(Date.now() * 1000), 1);
        const started = process.hrtime.bigint();
        stream.write(sent);
        const echo = await readExact(stream, 9, 5000);
        rtts.push(Number(process.hrtime.bigint() - started) / 1e6);
        void echo;
        stream.destroy();
      } catch {
        lost++;
      }
    }

    const phase = async (kind) => {
      const tasks = [];
      const start = Date.now();
      for (let i = 0; i < streams; i++) {
        tasks.push(
          (async () => {
            const stream = mux.openStream();
            if (kind === 'D') {
              const cmd = Buffer.alloc(9);
              cmd[0] = 0x44;
              cmd.writeUInt32BE((seconds + 1) * 1000, 1);
              stream.write(cmd);
              let bytes = 0;
              let countedAt = 0;
              await new Promise((resolve, reject) => {
                stream.on('data', (chunk) => {
                  const at = Date.now();
                  if (!countedAt && at - start >= 500) countedAt = at;
                  if (countedAt) bytes += chunk.length;
                });
                stream.once('end', resolve);
                stream.once('error', reject);
                setTimeout(() => {
                  stream.destroy();
                  resolve();
                }, (seconds + 3) * 1000).unref?.();
              });
              const ms = Date.now() - (countedAt || start);
              return { bytes, ms: ms > 0 ? ms : 1 };
            }
            const cmd = Buffer.alloc(1, 0x55);
            stream.write(cmd);
            const payload = Buffer.alloc(64 * 1024, 5);
            let bytes = 0;
            let countedAt = 0;
            const until = start + (seconds + 1) * 1000;
            while (Date.now() < until && !stream.destroyed) {
              if (!stream.write(payload)) await new Promise((resolve) => stream.once('drain', resolve));
              const at = Date.now();
              if (!countedAt && at - start >= 500) countedAt = at;
              if (countedAt) bytes += payload.length;
            }
            stream.end();
            await new Promise((resolve) => stream.once('finish', resolve));
            const ms = Date.now() - (countedAt || start);
            return { bytes, ms: ms > 0 ? ms : 1 };
          })(),
        );
      }
      const results = await Promise.all(tasks);
      const bytes = results.reduce((sum, r) => sum + r.bytes, 0);
      const ms = Math.max(...results.map((r) => r.ms));
      return (bytes * 8) / 1_000_000 / (ms / 1000);
    };

    const downloadMbps = await phase('D');
    const uploadMbps = await phase('U');
    const median = percentile(rtts, 50);
    const p95 = percentile(rtts, 95);
    const jitter = mean(rtts.slice(1).map((v, i) => Math.abs(v - rtts[i])));
    return {
      label,
      latency: {
        median_ms: +median.toFixed(2),
        p95_ms: +p95.toFixed(2),
        jitter_ms: +jitter.toFixed(2),
        sent: pings,
        received: rtts.length,
        loss_pct: +((lost / pings) * 100).toFixed(1),
      },
      download_mbps: +downloadMbps.toFixed(2),
      upload_mbps: +uploadMbps.toFixed(2),
    };
  } finally {
    mux.close();
  }
}
