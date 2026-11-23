#!/usr/bin/env node
import { Panel } from '../src/panel.js';
import { Agent } from '../src/agent.js';
import { TRANSPORTS, TRANSPORT_INFO } from '../src/transports.js';
import { runBench, subscribe as benchSubscribe } from '../src/bench.js';
import { getState } from '../src/store.js';
import { ROOT } from '../src/util.js';

const args = process.argv.slice(2);
const command = args[0] || 'panel';
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

function banner() {
  console.log('\n  نهر  ·  Nahr  —  encrypted tunnels + benchmark\n');
}

async function panelCommand() {
  const panel = new Panel({ port: Number(flag('port', process.env.PORT || 8080)), host: flag('host', '0.0.0.0') });
  await panel.start();
  banner();
  console.log(`  پنل:      http://localhost:${panel.port}/panel`);
  console.log(`  وبسایت:   http://localhost:${panel.port}/`);
  console.log(`  مستندات:  http://localhost:${panel.port}/docs\n`);
  const shutdown = async () => {
    await panel.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function agentCommand() {
  const agent = new Agent({
    id: flag('id', 'agent'),
    name: flag('name', flag('id', 'agent')),
    port: Number(flag('port', 7700)),
    host: flag('host', '0.0.0.0'),
    token: flag('token', process.env.NAHR_TOKEN || ''),
  });
  await agent.start();
  console.log(`agent ${agent.id} ready on ${agent.host}:${agent.port}`);
  const shutdown = async () => {
    await agent.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function demoCommand() {
  const panel = new Panel({ port: Number(flag('port', process.env.PORT || 8080)), host: flag('host', '0.0.0.0') });
  await panel.start();
  await panel.startDemo();
  banner();
  console.log(`  دمو آماده است: http://localhost:${panel.port}/panel`);
  console.log('  دو ایجنت محلی و ۵ تانل ساخته شدند. وارد «محک» شوید و تست را آغاز کنید.\n');
  const shutdown = async () => {
    await panel.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function benchCommand() {
  const state = getState();
  if (state.servers.length < 2) {
    console.error('دو سرور لازم است. اول `npm run demo` یا از پنل سرور اضافه کنید.');
    process.exit(1);
  }
  const [entry, exit] = state.servers;
  const profile = flag('profile', 'balanced');
  const seconds = Number(flag('seconds', 3));
  benchSubscribe((run) => {
    if (!run) return;
    const done = run.candidates.filter((c) => c.state === 'ok' || c.state === 'fail').length;
    process.stdout.write(`\r  ${run.state}: ${done}/${run.candidates.length}   `);
  });
  console.log(`\nمحک: ${entry.name}  →  ${exit.name}  · پروفایل ${profile}\n`);
  const result = await runBench({ entryId: entry.id, exitId: exit.id, profile, seconds, streams: Number(flag('streams', 4)) });
  console.log('\n');
  for (const c of result.candidates.sort((a, b) => (b.score || 0) - (a.score || 0))) {
    const m = c.metrics;
    const cells = c.state === 'ok'
      ? `${String(c.score).padStart(3)}  ${String(m?.download_mbps?.toFixed(1) ?? '—').padStart(7)}  ${String(m?.upload_mbps?.toFixed(1) ?? '—').padStart(7)}  ${String(m?.latency?.median_ms?.toFixed(1) ?? '—').padStart(6)}  ${String(m?.latency?.loss_pct ?? '—').padStart(5)}`
      : `  —                                       ${c.error || ''}`.slice(0, 90);
    console.log(`  ${(TRANSPORT_INFO[c.transport]?.label || c.transport).padEnd(8)} ${c.mode.padEnd(8)} ${cells}`);
  }
  if (result.recommended) {
    console.log(`\n  ✔ پیشنهاد: ${result.recommended.label} · حالت ${result.recommended.mode} · امتیاز ${result.recommended.score}`);
  } else {
    console.log('\n  ✖ هیچ ترنسپورتی جواب نداد. فایروال پورت‌ها و توکن را بررسی کنید.');
  }
  process.exit(0);
}

function help() {
  console.log(`
نهر — تونل رمزنگاری شده با پنل وب و محک داخلی

  node bin/nahr.js panel   [--port 8080]       پنل + وبسایت + مستندات
  node bin/nahr.js demo    [--port 8080]       پنل به همراه ۲ ایجنت و ۵ تانل آزمایشی
  node bin/nahr.js agent   --port 7700 --id x  ایجنت روی یک سرور
  node bin/nahr.js bench   [--seconds 3]       اجرای محک بین دو سرور ثبت شده

  ترنسپورت‌ها: ${TRANSPORTS.join(', ')}
  مسیر داده:   ${ROOT}/data
`);
}

const commands = { panel: panelCommand, agent: agentCommand, demo: demoCommand, bench: benchCommand, help, '--help': help, '-h': help };
try {
  await (commands[command] || help)();
} catch (err) {
  console.error(`خطا: ${err.stack || err.message}`);
  process.exit(1);
}
