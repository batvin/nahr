import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
// On Windows, import.meta.url paths start with /D:/... — the replace above fixes that.
export const DATA_DIR = path.resolve(process.env.NAHR_DATA || path.join(ROOT, 'data'));

export const uid = (prefix = '') => prefix + randomBytes(8).toString('hex');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const now = () => Date.now();

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const i = clamp(Math.ceil((p / 100) * sorted.length) - 1, 0, sorted.length - 1);
  return sorted[i];
}

export function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
}

export function formatMbps(bytesPerSec) {
  return ((bytesPerSec * 8) / 1_000_000).toFixed(1);
}

export function parseAddr(value, fallbackPort) {
  const s = String(value || '').trim();
  if (s.startsWith('[')) {
    const m = s.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (m) return { host: m[1], port: Number(m[2] || fallbackPort) };
  }
  const idx = s.lastIndexOf(':');
  if (idx > 0 && s.slice(idx + 1).includes('.') === false) {
    return { host: s.slice(0, idx), port: Number(s.slice(idx + 1)) || fallbackPort };
  }
  return { host: s, port: fallbackPort };
}

export function safeName(value) {
  return String(value || '').replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 48) || 'unnamed';
}
