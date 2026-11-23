import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { safeName } from './util.js';

export const CONNECT_PREFIX = 'nh1_';
export const DEFAULT_TTL_HOURS = 24;
export const DEFAULT_PANEL_LOCAL = 'http://127.0.0.1:18080';

export function normalizeUrl(value, scheme = 'http') {
  let s = String(value || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `${scheme}://${s}`;
  return s.replace(/\/+$/, '');
}

/** ساخت کد اتصال: آدرس ایجنت عمومی روی میزبان پنل + توکن مشترک + انقضاء. */
export function encodeConnectCode({
  agent = '',
  panel = '',
  panelLocal = DEFAULT_PANEL_LOCAL,
  token = '',
  name = '',
  ttlHours = DEFAULT_TTL_HOURS,
  now = Date.now(),
} = {}) {
  const publicAgent = normalizeUrl(agent || panel);
  if (!publicAgent) throw new Error('آدرس عمومی ایجنت لازم است (مثال http://IP:7700)');
  if (!token) throw new Error('توکن مشترک لازم است');
  const payload = {
    v: 1,
    a: publicAgent,
    u: normalizeUrl(panelLocal || DEFAULT_PANEL_LOCAL),
    t: token,
    n: String(name || '').slice(0, 48),
    exp: Math.floor(now / 1000) + Math.max(1, Number(ttlHours) || DEFAULT_TTL_HOURS) * 3600,
  };
  return CONNECT_PREFIX + Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeConnectCode(code, { now = Date.now() } = {}) {
  const s = String(code || '').trim();
  if (!s.startsWith(CONNECT_PREFIX)) throw new Error(`کد اتصال معتبر نیست (باید با ${CONNECT_PREFIX} شروع شود)`);
  let data;
  try {
    data = JSON.parse(Buffer.from(s.slice(CONNECT_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new Error('کد اتصال خوانده نشد');
  }
  if (data.v !== 1 || !data.a || !data.t) throw new Error('ساختار کد اتصال نامعتبر است');
  if (data.exp && now / 1000 > Number(data.exp)) throw new Error('کد اتصال منقضی شده است');
  return {
    agent: normalizeUrl(data.a),
    panelLocal: normalizeUrl(data.u || DEFAULT_PANEL_LOCAL),
    token: data.t,
    name: data.n || '',
    expiresAt: Number(data.exp) || 0,
  };
}

export function localIPv4() {
  const nets = Object.values(os.networkInterfaces()).flat().filter(Boolean);
  const local = nets.find((n) => n.family === 'IPv4' && !n.internal)?.address || '';
  try {
    const r = spawnSync('curl', ['-fsS', '--max-time', '3', 'https://api.ipify.org'], { encoding: 'utf8', timeout: 4000 });
    if (r.status === 0 && /^\d+\.\d+\.\d+\.\d+$/.test((r.stdout || '').trim())) return r.stdout.trim();
  } catch {
    /* offline */
  }
  return local || '127.0.0.1';
}

function envValue(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function writeConnectEnv(file, { token = '', id = '', name = '' } = {}) {
  if (!file) return '';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = [
    `NAHR_TOKEN=${envValue(token)}`,
    `NAHR_ID=${envValue(id)}`,
    `NAHR_NAME=${envValue(name)}`,
    '',
  ].join('\n');
  fs.writeFileSync(file, body, { mode: 0o600 });
  return file;
}

export function readConnectEnv(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)=(.*)$/);
      if (!m) continue;
      out[m[1]] = m[2].replace(/^"|"$/g, '').replace(/\\(["\\])/g, '$1');
    }
  } catch {
    /* missing */
  }
  return out;
}

/** ثبت سرور روی پنل: ترجیحاً از طریق ایجنت همان سرور تا پنل محلی بماند. */
export async function applyConnect({ code = '', envFile = '', agentPort = 7700, replace = false, host = '' } = {}) {
  const info = decodeConnectCode(code);
  const ip = host || localIPv4();
  const id = safeName(os.hostname());
  const name = info.name || os.hostname();
  const server = { id, name, host: ip, agentPort: Number(agentPort) || 7700, token: info.token, dialHost: ip, region: '' };
  let reply;

  if (info.agent) {
    const res = await fetch(`${info.agent}/connect/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nahr-token': info.token },
      body: JSON.stringify({ code, replace, server }),
      signal: AbortSignal.timeout(9000),
    });
    reply = await res.json().catch(() => ({}));
    if (res.status === 409 || reply.needsConfirm) {
      return { ok: false, needsConfirm: true, duplicate: reply.duplicate, info, server };
    }
    if (!res.ok) return { ok: false, err: reply.error || `خطای ${res.status} از ایجنت پنل`, info, server };
  } else {
    let existing = [];
    try {
      const res = await fetch(`${info.panelLocal}/api/servers`, { signal: AbortSignal.timeout(6000) });
      if (res.ok) existing = (await res.json()).servers || [];
    } catch {
      /* ignore */
    }
    const dup = existing.find((s) => s.id === id || s.host === ip);
    if (dup && !replace) return { ok: false, needsConfirm: true, duplicate: dup, info, server };
    const res = await fetch(`${info.panelLocal}/api/servers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(server),
      signal: AbortSignal.timeout(8000),
    });
    reply = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, err: reply.error || `خطای ${res.status} از پنل`, info, server };
  }

  writeConnectEnv(envFile, { token: info.token, id, name });
  return { ok: true, info, server, reply };
}

/** دستور تکخطی که روی سرور جدید زده میشود. */
export function connectCommand(code, installerUrl = 'https://raw.githubusercontent.com/batvin/nahr/main/scripts/quick-install.sh') {
  return `bash <(curl -fsSL ${installerUrl}) --agent ${code}`;
}
