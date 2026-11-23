#!/usr/bin/env node
// نهر · manager — منوی تعاملی ترمینالی برای نصب، پنل و ایجنت
// بدون وابستگی خارجی: فقط ANSI و کتابخانههای استاندارد Node.
import readline from 'node:readline/promises';
import * as M from '../src/manager.js';
import { encodeConnectCode, connectCommand } from '../src/connect.js';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', inverse: '\x1b[7m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', blue: '\x1b[34m',
};
const W = 72;
const line = (ch = '─') => ch.repeat(W);
const pad = (s) => String(s).padEnd(W - 2, ' ');
const ok = (v) => `${C.green}●${C.reset}`;
const off = (v) => `${C.dim}○${C.reset}`;

let index = 0;
let busy = false;
let snapshot = null;

function raw(on) {
  if (!process.stdin.isTTY) return;
  try {
    process.stdin.setRawMode(!!on);
  } catch {
    /* ignore */
  }
}
function clear() {
  process.stdout.write('\x1b[2J\x1b[H\x1b[?25l');
}
function showCursor() {
  process.stdout.write('\x1b[?25h');
}
function out(s = '') {
  process.stdout.write(`${s}\n`);
}
function heading(text) {
  out(`${C.cyan}${text} ${line()}${C.reset}`);
}
function mark(on) {
  return on ? ok() : off();
}

const ITEMS = [
  {
    section: 'نهر',
    label: 'نصب یا بهروزرسانی نهر',
    hint: 'آخرین نسخه را از گیت هاب میگیرم و سرویسها را راهاندازی میکنم.',
    run: async () => {
      out('دریافت آخرین نسخه و اجرای اسکریپت نصب…\n');
      const code = await M.installOrUpdate();
      out(code === 0 ? `\n${ok()} نصب/بهروزرسانی تمام شد.` : `\n${C.red}✖ اسکریپت نصب با کد ${code} تمام شد.${C.reset}`);
    },
  },
  {
    label: 'وضعیت و آدرسها',
    hint: 'نام میزبان، IP، پورتها، سرویسها و تانلهای زنده را نشان میدهم.',
    run: async () => {
      const d = await M.detect();
      heading('وضعیت');
      for (const l of M.statusLines(d)) out(`  ${l}`);
      out('');
      out(`  ${mark(d.panel.enabled)} سرویس پنل:   ${d.panel.enabled ? 'فعال در بوت' : 'غیرفعال'}`);
      out(`  ${mark(d.agent.enabled)} سرویس ایجنت: ${d.agent.enabled ? 'فعال در بوت' : 'غیرفعال'}`);
      out(`  ${mark(d.agent.active)} ایجنت:        ${d.agent.id} · گوش ${d.agent.port}`);
      out(`  ${mark(d.panel.active)} پنل:          ${d.panel.url}`);
      out(`  ${mark(!!d.token)} توکن:          ${M.maskToken(d.token)}`);
      if (d.agent.health) out(`  ${ok()} آپتایم ایجنت: ${M.formatUptime(d.agent.health.uptimeSec)}`);
      out('');
      out(`  ${C.dim}مسیر کد: ${d.installed ? M.INSTALL_DIR : 'نصب نشده'} · سیستم: ${d.platform}${C.reset}`);
    },
  },
  {
    section: 'پنل وب',
    label: 'نصب پنل وب روی این سرور',
    hint: 'سرویس nahr-panel را فعال و راهاندازی میکنم (پیشفرض 127.0.0.1:18080).',
    run: async () => {
      const r = M.setPanel(true);
      out(r.ok ? `${ok()} پنل وب نصب و فعال شد: http://127.0.0.1:${(await M.detect()).panel.port}/panel`
        : `${C.red}✖ ${r.err || 'نتوانستم پنل را فعال کنم.'}${C.reset}`);
    },
  },
  {
    label: 'لینک ورود به پنل',
    hint: 'آدرس محلی و دستور SSH tunnel برای باز کردن پنل از کامپیوتر شما.',
    run: async () => {
      const d = await M.detect();
      heading('لینک ورود');
      out(`  پنل:       ${C.cyan}${d.panel.url}${C.reset}`);
      out(`  مستندات:   ${C.cyan}${d.panel.docs}${C.reset}`);
      out(`  توکن:      ${M.maskToken(d.token)}`);
      out('');
      out('  از کامپیوتر خود:');
      out(`    ${C.green}ssh -L ${d.panel.port}:127.0.0.1:${d.panel.port} root@${d.external}${C.reset}`);
      out(`    سپس: http://localhost:${d.panel.port}/panel`);
    },
  },
  {
    label: 'رمز ورود / توکن مشترک',
    hint: 'توکن دسترسی ایجنتها و پنل را نشان میدهم.',
    run: async () => {
      const d = await M.detect();
      heading('توکن مشترک');
      out(`  ${C.yellow}${d.token || '—'}${C.reset}`);
      out('');
      out(`  ${C.dim}همین توکن را هنگام اضافه کردن سرور در پنل وارد کنید.${C.reset}`);
      out(`  ${C.dim}فایل: ${M.stateFile()}${C.reset}`);
    },
  },
  {
    label: 'آدرسها و گواهیها',
    hint: 'IPv4، IPv6 و گواهی self-signed ایجنت را نشان میدهم.',
    run: async () => {
      const d = await M.detect();
      heading('آدرسها');
      out(`  میزبان:   ${d.hostname}`);
      out(`  IPv4:     ${d.ipv4}`);
      out(`  IPv6:     ${d.ipv6}`);
      out(`  خارجی:    ${d.external}`);
      out('');
      const certs = M.certificateFiles();
      out(`  گواهیها (${certs.length}):`);
      for (const f of certs) out(`    ${C.dim}${f}${C.reset}`);
      if (!certs.length) out(`    ${C.dim}هنوز ساخته نشدهاند.${C.reset}`);
    },
  },
  {
    label: 'پورت پنل',
    hint: 'پورت وب پنل را عوض میکنم و سرویس را ریاستارت میکنم.',
    run: async () => {
      const d = await M.detect();
      const value = await ask('پورت جدید (پیشفرض ۱۸۰۸۰):', String(d.panel.port));
      const r = M.changePanelPort(value);
      out(r.ok ? `${ok()} پورت پنل به ${M.parsePort(value)} تغییر کرد.`
        : `${C.red}✖ ${r.err || r.out || 'خطا در تغییر پورت'}${C.reset}`);
    },
  },
  {
    label: 'حذف پنل وب',
    hint: 'سرویس پنل را متوقف و غیرفعال میکنم (فایتها باقی میمانند).',
    run: async () => {
      const r = M.setPanel(false);
      out(r.ok ? `${ok()} پنل وب متوقف و غیرفعال شد.` : `${C.red}✖ ${r.err || 'خطا'}${C.reset}`);
    },
  },
  {
    section: 'ایجنت',
    label: 'اتصال ایجنت به پنل',
    hint: 'این سرور را با آدرس و توکنش به یک پنل دیگر اضافه میکنم.',
    run: async () => {
      const d = await M.detect();
      const url = await ask('آدرس پنل (مثال http://1.2.3.4:18080):');
      const token = await ask('توکن پنل:', d.token);
      if (!url) return out(`${C.yellow}لغو شد.${C.reset}`);
      out('در حال اتصال…');
      const r = await M.connectToPanel(url, token, d);
      out(r.ok ? `${ok()} سرور ${d.hostname} به پنل اضافه شد.`
        : `${C.red}✖ ${r.err}${C.reset}`);
    },
  },
  {
    label: 'ساخت کد اتصال تکخطی',
    hint: 'کد nh1_ میسازم تا سرور خارج با یک دستور به پنل وصل شود.',
    run: async () => {
      const d = await M.detect();
      const endpoint = await ask('آدرس عمومی ایجنت روی سرور پنل:', `http://${d.external}:${d.agent.port}`);
      const name = await ask('نام سرور جدید (مثال outside):', 'outside');
      const ttl = await ask('اعتبار کد به ساعت:', '24');
      try {
        const code = encodeConnectCode({
          agent: endpoint,
          panelLocal: `http://127.0.0.1:${d.panel.port}`,
          token: d.token,
          name,
          ttlHours: Number(ttl),
        });
        heading('کد اتصال');
        out(`  ${C.yellow}${code}${C.reset}`);
        out('');
        out('  دستور تکخطی روی سرور جدید (root):');
        out(`  ${C.green}${connectCommand(code, M.INSTALLER_URL)}${C.reset}`);
        out('');
        out(`  ${C.dim}کد را مانند توکن نگه دارید؛ بعد از انقضاء کد جدید بسازید.${C.reset}`);
      } catch (err) {
        out(`${C.red}✖ ${err.message}${C.reset}`);
      }
    },
  },
  {
    label: 'حذف ایجنت',
    hint: 'سرویس nahr-agent را متوقف و غیرفعال میکنم.',
    run: async () => {
      const r = M.setAgent(false);
      out(r.ok ? `${ok()} ایجنت متوقف و غیرفعال شد.` : `${C.red}✖ ${r.err || 'خطا'}${C.reset}`);
    },
  },
  {
    section: 'سیستم',
    label: 'لاگ زنده',
    hint: 'journalctl سرویسهای نهر را دنبال میکنم؛ Ctrl+C برای بازگشت.',
    run: async () => {
      out(`${C.dim}در حال نمایش لاگ… Ctrl+C برای بازگشت.${C.reset}\n`);
      await M.liveLogs();
    },
  },
  {
    label: 'حذف کامل نهر',
    hint: 'همه سرویسها، فایتها و فرمان nahr-manager را پاک میکنم.',
    run: async () => {
      const answer = await ask(`برای حذف کامل عبارت ${C.red}${C.bold}بله${C.reset} را تایپ کنید:`);
      if (answer !== 'بله' && answer.toLowerCase() !== 'yes') return out(`${C.yellow}لغو شد.${C.reset}`);
      const r = M.uninstall();
      if (r.ok) out(`${ok()} نهر بهطور کامل حذف شد.`);
      else out(`${C.yellow}⚠ حذف با هشدار تمام شد: ${r.failures.join(' | ')}${C.reset}`);
    },
  },
];

function render() {
  clear();
  const title = `  ◆ نهر · manager   تونل رمزنگاری شده و پنل وب`;
  const version = `v${M.VERSION}`;
  out(`${C.cyan}╭${'─'.repeat(W)}╮${C.reset}`);
  out(`${C.cyan}│${C.reset}${pad(title + ' '.repeat(Math.max(1, W - 2 - title.length - version.length)) + version)}${C.cyan}│${C.reset}`);
  out(`${C.cyan}╰${'─'.repeat(W)}╯${C.reset}`);
  out('');
  if (snapshot) for (const l of M.statusLines(snapshot)) out(`  ${l}`);
  out('');
  let lastSection = '';
  ITEMS.forEach((item, i) => {
    if (item.section && item.section !== lastSection) {
      lastSection = item.section;
      out('');
      heading(lastSection);
    }
    const selected = i === index;
    const pointer = selected ? `${C.cyan}❯${C.reset}` : ' ';
    const num = selected ? `${C.bold}${C.cyan}${String(i + 1).padStart(2)}${C.reset}` : `${C.dim}${String(i + 1).padStart(2)}${C.reset}`;
    out(`  ${pointer}  ${num}  ${selected ? C.bold + item.label + C.reset : item.label}`);
  });
  out('');
  out(`${C.dim}${line()}${C.reset}`);
  out(`  ${C.dim}↑/↓ حرکت · Enter اجرا · شماره پرش · q خروج${C.reset}`);
  out(`  ${C.cyan}› ${ITEMS[index].hint}${C.reset}`);
}

async function ask(label, defaultValue = '') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const answer = await rl.question(`${label}${suffix} `);
  rl.close();
  return String(answer || '').trim() || defaultValue;
}

function onKey(chunk) {
  if (busy) return;
  const s = chunk.toString();
  if (s === '\x03' || s.toLowerCase() === 'q') return void exit();
  if (s === '\x1b[A') {
    index = (index - 1 + ITEMS.length) % ITEMS.length;
    return render();
  }
  if (s === '\x1b[B') {
    index = (index + 1) % ITEMS.length;
    return render();
  }
  if (s === '\r' || s === '\n') return void perform(index);
  if (/^[0-9]$/.test(s)) {
    const n = Number(s);
    if (n === 0) return void exit();
    if (n >= 1 && n <= ITEMS.length) {
      index = n - 1;
      return render();
    }
  }
}

async function perform(i) {
  busy = true;
  process.stdin.off('data', onKey);
  raw(false);
  showCursor();
  try {
    clear();
    heading(ITEMS[i].label);
    out('');
    await ITEMS[i].run();
  } catch (err) {
    out(`${C.red}✖ ${err.message || err}${C.reset}`);
  }
  out('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(`${C.dim}برای بازگشت Enter بزنید…${C.reset} `);
  rl.close();
  raw(true);
  process.stdin.on('data', onKey);
  busy = false;
  snapshot = await M.detect();
  render();
}

function exit() {
  showCursor();
  raw(false);
  process.stdin.pause();
  out(`${C.dim}نهر · خداحافظ!${C.reset}`);
  process.exit(0);
}

async function main() {
  if (process.stdin.isTTY) {
    raw(true);
    process.stdin.resume();
    process.stdin.on('data', onKey);
  } else {
    out(`${C.yellow}ترمینال تعاملی نیست. از «node bin/nahr.js help» برای دیدن دستورات استفاده کنید.${C.reset}`);
  }
  snapshot = await M.detect();
  render();
  if (!process.stdin.isTTY) {
    process.stdin.resume();
    process.stdin.on('end', () => exit());
  }
}

main().catch((err) => {
  showCursor();
  raw(false);
  console.error(`خطا: ${err.stack || err.message}`);
  process.exit(1);
});
