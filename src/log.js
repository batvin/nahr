import { ROOT, safeName } from './util.js';
import fs from 'node:fs';
import path from 'node:path';

const entries = [];
const listeners = new Set();
const MAX = 2000;

export function log(level, scope, message, extra) {
  const entry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    level,
    scope: safeName(scope),
    message: String(message),
    ...(extra ? { extra } : {}),
  };
  entries.push(entry);
  if (entries.length > MAX) entries.shift();
  for (const fn of listeners) {
    try {
      fn(entry);
    } catch {
      /* ignore a broken subscriber */
    }
  }
  if (process.env.NAHR_QUIET !== '1') {
    const line = `[${new Date(entry.at).toISOString().slice(11, 19)}] ${level.toUpperCase().padEnd(5)} ${scope}: ${entry.message}`;
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
  }
}

export const logger = (scope) => ({
  info: (msg, extra) => log('info', scope, msg, extra),
  warn: (msg, extra) => log('warn', scope, msg, extra),
  error: (msg, extra) => log('error', scope, msg, extra),
  debug: (msg, extra) => log('debug', scope, msg, extra),
});

export function getLogs({ level, scope, limit = 200 } = {}) {
  let out = entries;
  if (level) out = out.filter((e) => e.level === level);
  if (scope) out = out.filter((e) => e.scope.includes(scope));
  return out.slice(-Math.min(1000, Number(limit) || 200)).reverse();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function writeLogFile() {
  try {
    const dir = path.join(ROOT, 'data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'last.log'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  } catch {
    /* logging to disk is best-effort */
  }
}
