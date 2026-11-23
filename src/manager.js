import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './util.js';

const require = createRequire(import.meta.url);
export const VERSION = require('../package.json').version;

export const INSTALL_DIR = '/opt/nahr';
export const UNIT_DIR = '/etc/systemd/system';
export const PANEL_UNIT = `${UNIT_DIR}/nahr-panel.service`;
export const AGENT_UNIT = `${UNIT_DIR}/nahr-agent.service`;
export const INSTALLER_URL = 'https://raw.githubusercontent.com/batvin/nahr/main/scripts/quick-install.sh';
export const DEFAULT_PANEL_PORT = 18080;
export const DEFAULT_AGENT_PORT = 7700;

export const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;
const sudo = () => (isRoot() ? [] : ['sudo']);
const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Root for persisted data: the installer layout when present, local repo otherwise. */
export function dataRoot(kind = 'panel') {
  const installed = `/var/lib/nahr/${kind}`;
  return exists(installed) ? installed : path.join(ROOT, 'data');
}
export function stateFile() {
  return path.join(dataRoot('panel'), 'state.json');
}
export function certDir() {
  return path.join(dataRoot('agent'), 'certs');
}

export function run(cmd, args = [], opts = {}) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout || 10000, ...opts });
    return { ok: r.status === 0, code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
  } catch (err) {
    return { ok: false, code: null, out: '', err: err.message };
  }
}

export function runLive(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

export function systemctl(action, ...rest) {
  return run('systemctl', [...sudo(), action, ...rest]);
}
function systemctlRead(action, ...rest) {
  return run('systemctl', [action, ...rest], { timeout: 3000 });
}
export const serviceActive = (unit) => systemctlRead('is-active', unit).out === 'active';
export const serviceEnabled = (unit) => systemctlRead('is-enabled', unit).out === 'enabled';

export function parsePort(value, fallback = 0) {
  const n = Number(String(value ?? '').trim());
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

export function maskToken(token) {
  const s = String(token || '');
  if (!s) return '—';
  return s.length <= 12 ? s : `${s.slice(0, 6)}…${s.slice(-4)}`;
}

export function formatUptime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}روز ${h}ساعت`;
  if (h) return `${h}ساعت ${m}دقیقه`;
  if (m) return `${m}دقیقه`;
  return `${s}ثانیه`;
}

export function readToken() {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return state.secret || process.env.NAHR_TOKEN || '';
  } catch {
    return process.env.NAHR_TOKEN || '';
  }
}

function unitValue(file, flag, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(new RegExp(`--${flag}\\s+([^\\s'"\\n]+)`));
    return m ? m[1] : fallback;
  } catch {
    return fallback;
  }
}

export function publicAddresses() {
  const nets = Object.values(os.networkInterfaces()).flat().filter(Boolean);
  const ipv4 = nets.find((n) => n.family === 'IPv4' && !n.internal)?.address || '—';
  const ipv6 = nets.find((n) => n.family === 'IPv6' && !n.internal)?.address || '—';
  let external = '';
  try {
    external = run('curl', ['-fsS', '--max-time', '3', 'https://api.ipify.org'], { timeout: 4000 }).out;
  } catch {
    /* offline */
  }
  return { ipv4, ipv6: external && ipv6 === '—' ? external : ipv6, external: external || ipv4 };
}

/** Snapshot of everything the menu header and status screen need. */
export async function detect() {
  const installed = exists(path.join(INSTALL_DIR, 'package.json'));
  let version = VERSION;
  if (installed) {
    try {
      version = JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, 'package.json'), 'utf8')).version || VERSION;
    } catch {
      /* keep bundled version */
    }
  }
  const addrs = publicAddresses();
  const panelPort = parsePort(unitValue(PANEL_UNIT, 'port', DEFAULT_PANEL_PORT), DEFAULT_PANEL_PORT);
  const agentPort = parsePort(unitValue(AGENT_UNIT, 'port', DEFAULT_AGENT_PORT), DEFAULT_AGENT_PORT);
  const panel = {
    active: serviceActive('nahr-panel'),
    enabled: serviceEnabled('nahr-panel'),
    port: panelPort,
    url: `http://127.0.0.1:${panelPort}/panel`,
    docs: `http://127.0.0.1:${panelPort}/docs`,
  };
  const agent = {
    active: serviceActive('nahr-agent'),
    enabled: serviceEnabled('nahr-agent'),
    port: agentPort,
    id: unitValue(AGENT_UNIT, 'id', os.hostname()),
    health: null,
  };
  let tunnels = 0;
  if (agent.active) {
    try {
      const res = await fetch(`http://127.0.0.1:${agentPort}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        agent.health = await res.json();
        tunnels = Array.isArray(agent.health.tunnels) ? agent.health.tunnels.length : 0;
      }
    } catch {
      /* agent busy or restarting */
    }
  }
  return {
    hostname: os.hostname(),
    ...addrs,
    installed,
    version,
    panel,
    agent,
    tunnels,
    token: readToken(),
    platform: process.platform,
  };
}

export function statusLines(d) {
  const mark = (on) => (on ? '●' : '○');
  return [
    `${d.hostname}   IPv4 ${d.ipv4}   IPv6 ${d.ipv6}`,
    `${mark(d.installed)} core      نهر ${d.version}${d.installed ? ` · ${d.tunnels} تانل روی این سرور` : ' · نصب نشده'}`,
    `${mark(d.panel.active)} پنل وب   ${d.panel.active ? `روی ${d.panel.url}` : 'نصب/فعال نیست'}`,
    `${mark(d.agent.active)} ایجنت    ${d.agent.active ? `در گوش ${d.agent.port} · ${d.agent.id}` : 'فعال نیست'}`,
  ];
}

export function installOrUpdate() {
  const sudoPrefix = isRoot() ? '' : 'sudo ';
  return runLive('bash', ['-lc', `curl -fsSL ${INSTALLER_URL} | ${sudoPrefix}bash`]);
}

export function setService(unit, enable) {
  const action = enable ? 'enable' : 'disable';
  const r = systemctl(action, '--now', unit);
  return r.ok && enable ? systemctl('restart', unit) : r;
}

export function setPanel(enable) {
  return setService(PANEL_UNIT, enable);
}
export function setAgent(enable) {
  return setService(AGENT_UNIT, enable);
}

export function changePanelPort(value) {
  const port = parsePort(value, 0);
  if (!port || port < 1024) return { ok: false, err: 'پورت باید عددی بین ۱۰۲۴ و ۶۵۵۳۵ باشد.' };
  let text;
  try {
    text = fs.readFileSync(PANEL_UNIT, 'utf8');
  } catch {
    return { ok: false, err: 'واحد سرویس پنل پیدا نشد.' };
  }
  const updated = text.replace(/(--port\s+)\d+/, `$1${port}`);
  if (updated === text && !text.includes(`--port ${port}`)) return { ok: false, err: 'نتوانستم پورت را در واحد سرویس پیدا کنم.' };
  const tmp = path.join(os.tmpdir(), `nahr-panel-${process.pid}.service`);
  try {
    fs.writeFileSync(tmp, updated);
    const cp = run('cp', [...sudo(), tmp, PANEL_UNIT]);
    if (!cp.ok) return cp;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
  const reload = run('systemctl', [...sudo(), 'daemon-reload']);
  if (!reload.ok) return reload;
  return run('systemctl', [...sudo(), 'restart', 'nahr-panel']);
}

export async function connectToPanel(baseUrl, token, local) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return { ok: false, err: 'آدرس باید با http:// یا https:// شروع شود.' };
  const body = {
    name: local.hostname,
    host: local.ipv4 === '—' ? local.external : local.ipv4,
    agentPort: local.agent.port,
    token: token || local.token,
    region: '',
  };
  try {
    const res = await fetch(`${base}/api/servers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok
      ? { ok: true, server: data.server, err: '' }
      : { ok: false, err: data.error || `خطای ${res.status} از پنل` };
  } catch (err) {
    return { ok: false, err: err.message };
  }
}

export function liveLogs() {
  return runLive('journalctl', [...sudo(), '-u', 'nahr-panel', '-u', 'nahr-agent', '-f']);
}

export function certificateFiles() {
  const dir = certDir();
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.pem')).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export function uninstall() {
  const steps = [
    () => systemctl('disable', '--now', 'nahr-panel'),
    () => systemctl('disable', '--now', 'nahr-agent'),
    () => run('rm', [...sudo(), '-f', PANEL_UNIT, AGENT_UNIT]),
    () => run('rm', [...sudo(), '-rf', `${UNIT_DIR}/nahr-panel.service.d`, `${UNIT_DIR}/nahr-agent.service.d`]),
    () => run('systemctl', [...sudo(), 'daemon-reload']),
    () => run('rm', [...sudo(), '-rf', INSTALL_DIR, '/var/lib/nahr', '/usr/local/bin/nahr-manager']),
  ];
  const failures = [];
  for (const step of steps) {
    const r = step();
    if (!r.ok && r.code !== null) failures.push(r.err || r.out);
  }
  return { ok: failures.length === 0, failures };
}
