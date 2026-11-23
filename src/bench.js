import { TRANSPORTS, TRANSPORT_INFO } from './transports.js';
import { getState, save } from './store.js';
import { uid, clamp } from './util.js';
import { logger } from './log.js';

const log = logger('bench');
const listeners = new Set();
let current = null;

const WEIGHTS = {
  balanced: { speed: 0.5, latency: 0.3, stability: 0.2 },
  ultraspeed: { speed: 0.7, latency: 0.15, stability: 0.15 },
  gaming: { speed: 0.25, latency: 0.4, stability: 0.35 },
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function publish() {
  const snapshot = current ? snapshotOf(current) : null;
  for (const fn of listeners) {
    try {
      fn(snapshot);
    } catch {
      /* ignore */
    }
  }
}

export function snapshotOf(run) {
  if (!run) return null;
  return {
    id: run.id,
    state: run.state,
    entryId: run.entryId,
    exitId: run.exitId,
    profile: run.profile,
    started: run.started,
    finished: run.finished,
    error: run.error,
    candidates: run.candidates.map((c) => ({ ...c })),
    recommended: run.recommended || null,
  };
}

export function currentBench() {
  return current ? snapshotOf(current) : null;
}

export async function callAgent(server, endpoint, body, timeout = 20000) {
  if (!server) throw new Error('server not found');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`http://${server.host}:${server.agentPort}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nahr-token': server.token || getState().secret },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`agent replied: ${text.slice(0, 120)}`);
    }
    if (!res.ok || data.error) throw new Error(data.error || `agent HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function scoreOf(result, bestSpeed, profile) {
  if (!result) return null;
  const w = WEIGHTS[profile] || WEIGHTS.balanced;
  const speed = bestSpeed > 0 ? clamp((result.download_mbps * 0.7 + result.upload_mbps * 0.3) / bestSpeed, 0, 1) * 100 : 0;
  const rtt = result.latency?.median_ms ?? 500;
  const latency = clamp(100 - Math.max(0, rtt - 5) * 1.15, 0, 100);
  const jitter = result.latency?.jitter_ms ?? 20;
  const loss = result.latency?.loss_pct ?? 100;
  const stability = clamp(100 - loss * 8 - jitter * 2.5, 0, 100);
  const total = Math.round(speed * w.speed + latency * w.latency + stability * w.stability);
  return { total, parts: { speed: Math.round(speed), latency: Math.round(latency), stability: Math.round(stability) } };
}

/** Probe every transport in both directions, then measure the fastest few. */
export async function runBench({ entryId, exitId, profile = 'balanced', seconds = 3, streams = 4 }) {
  if (current && (current.state === 'probe' || current.state === 'speed')) throw Object.assign(new Error('bench already running'), { code: 'busy' });
  const state = getState();
  const entry = state.servers.find((s) => s.id === entryId);
  const exit = state.servers.find((s) => s.id === exitId);
  if (!entry || !exit) throw new Error('server not found');
  if (entry.id === exit.id) throw new Error('pick two different servers');

  const run = {
    id: uid('b-'),
    state: 'probe',
    entryId,
    exitId,
    profile,
    started: Date.now(),
    finished: null,
    error: null,
    candidates: [],
    recommended: null,
  };
  current = run;
  publish();
  const token = state.secret;

  try {
    for (const transport of TRANSPORTS) {
      for (const mode of ['reverse', 'direct']) {
        run.candidates.push({
          key: `${transport}:${mode}`,
          transport,
          label: TRANSPORT_INFO[transport].label,
          mode,
          state: 'wait',
          error: null,
          probe: null,
          result: null,
          score: null,
        });
      }
    }
    publish();

    // Stage 1: short reachability + RTT probe. Batching keeps memory usage
    // sane on 1 GB VPS servers (10 simultaneous muxes caused OOM kills).
    for (let i = 0; i < run.candidates.length; i += 4) {
      await Promise.all(
        run.candidates.slice(i, i + 4).map(async (candidate) => {
        const listener = modeServer(candidate.mode, 'listener', entry, exit);
        const dialer = modeServer(candidate.mode, 'dialer', entry, exit);
        let listenId = null;
        try {
          const started = await callAgent(listener, '/bench/listen', {
            transport: candidate.transport,
            token,
            profile,
            ttl: 180000,
          });
          listenId = started.id;
          candidate.state = 'probe';
          publish();
          const measured = await callAgent(dialer, '/bench/dial', {
            transport: candidate.transport,
            host: listener.host === '0.0.0.0' ? '127.0.0.1' : listener.host,
            port: started.port,
            token,
            profile,
            seconds: 0.3,
            streams: 1,
            pings: 6,
            label: candidate.label,
          }, 20000);
          candidate.probe = measured.result;
          candidate.state = 'ok';
        } catch (err) {
          candidate.state = 'fail';
          candidate.error = err.message;
        } finally {
          if (listenId) await callAgent(listener, '/bench/close', { id: listenId }).catch(() => {});
          publish();
        }
        }),
      );
    }

    const viable = run.candidates.filter((c) => c.state === 'ok');
    run.state = 'speed';
    publish();

    // Stage 2: every reachable transport gets the same full-length measurement.
    // Probe latency is not comparable between transports, so using it to pick a
    // shortlist used to recommend a tunnel that could barely download anything.
    // Run in small batches so one path does not skew all the others.
    for (let i = 0; i < viable.length; i += 2) {
      const batch = viable.slice(i, i + 2);
      await Promise.all(
        batch.map(async (candidate) => {
          const listener = modeServer(candidate.mode, 'listener', entry, exit);
          const dialer = modeServer(candidate.mode, 'dialer', entry, exit);
          let listenId = null;
          try {
            const started = await callAgent(listener, '/bench/listen', {
              transport: candidate.transport,
              token,
              profile,
              ttl: 180000,
            });
            listenId = started.id;
            candidate.state = 'speed';
            publish();
            const measured = await callAgent(dialer, '/bench/dial', {
              transport: candidate.transport,
              host: listener.host === '0.0.0.0' ? '127.0.0.1' : listener.host,
              port: started.port,
              token,
              profile,
              seconds,
              streams,
              pings: 18,
              label: candidate.label,
            }, (seconds + 25) * 1000);
            candidate.result = measured.result;
            if (candidate.result.download_mbps < 0.5 || candidate.result.upload_mbps < 0.5) {
              throw new Error('مسیر یکطرفه تقریباً بسته است (دانلود یا آپلود < 0.5 Mbps)');
            }
            candidate.state = 'ok';
          } catch (err) {
            candidate.state = 'fail';
            candidate.error = err.message;
          } finally {
            if (listenId) await callAgent(listener, '/bench/close', { id: listenId }).catch(() => {});
            publish();
          }
        }),
      );
    }

    const measured = run.candidates.filter((c) => c.result);
    const bestSpeed = Math.max(1, ...measured.map((c) => c.result.download_mbps * 0.7 + c.result.upload_mbps * 0.3));
    for (const c of run.candidates) {
      // Only full throughput measurements are comparable. A short probe is a
      // burst and must never be scored as if it were a 4-second speed test.
      if (c.state === 'ok' && !c.result) c.state = 'probe';
      if (c.state !== 'ok') continue;
      const source = c.result;
      if (!source) continue;
      const scored = scoreOf(source, bestSpeed, profile);
      c.score = scored.total;
      c.parts = scored.parts;
      c.metrics = source;
    }
    const ranked = run.candidates.filter((c) => c.score != null).sort((a, b) => b.score - a.score);
    run.recommended = ranked[0] || null;
    run.state = 'done';
    run.finished = Date.now();
    const state2 = getState();
    state2.history.unshift(snapshotOf(run));
    state2.history = state2.history.slice(0, 20);
    save();
    log.info(`bench ${run.id} done — best: ${run.recommended ? `${run.recommended.label} ${run.recommended.mode}` : 'none'}`);
  } catch (err) {
    run.state = 'failed';
    run.error = err.message;
    run.finished = Date.now();
    log.error(`bench ${run.id} failed: ${err.message}`);
  } finally {
    publish();
  }
  return snapshotOf(run);
}

export function modeServer(mode, side, entry, exit) {
  // Keep the labels identical to TunnelRuntime: direct = exit listens / entry dials,
  // reverse = entry listens / exit dials. Otherwise "apply winner" flips the topology.
  const listener = mode === 'direct' ? exit : entry;
  return side === 'listener' ? listener : listener === entry ? exit : entry;
}

export function stopBench() {
  if (!current || (current.state !== 'probe' && current.state !== 'speed')) return false;
  current.state = 'stopped';
  current.finished = Date.now();
  publish();
  return true;
}

export function lastBench() {
  const state = getState();
  return current ? snapshotOf(current) : state.history[0] || null;
}

export function applyBench(benchId, key) {
  const state = getState();
  const run = current?.id === benchId ? current : state.history.find((b) => b.id === benchId);
  if (!run) throw new Error('bench result not found');
  const candidate = run.candidates.find((c) => c.key === key);
  if (!candidate) throw new Error('candidate not found');
  let tunnel = state.tunnels.find((t) => t.entryId === run.entryId && t.exitId === run.exitId);
  if (!tunnel) {
    tunnel = {
      id: uid('t-'),
      name: `${candidate.label} ${candidate.mode}`,
      entryId: run.entryId,
      exitId: run.exitId,
      transport: candidate.transport,
      mode: candidate.mode,
      profile: run.profile,
      listenPort: 0,
      socksPort: 1080,
      enabled: false,
    };
    state.tunnels.push(tunnel);
  }
  tunnel.transport = candidate.transport;
  tunnel.mode = candidate.mode;
  tunnel.profile = run.profile;
  save();
  return tunnel;
}
