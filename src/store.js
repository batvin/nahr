import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, readJson, writeJson } from './util.js';

const FILE = path.join(DATA_DIR, 'state.json');

function defaults() {
  return {
    version: 1,
    secret: crypto.randomBytes(24).toString('hex'),
    servers: [],
    tunnels: [],
    settings: {
      theme: 'dark',
      benchSeconds: 3,
      benchStreams: 4,
      autoScore: true,
    },
    history: [],
    demo: { running: false, agents: [] },
  };
}

let state = null;

export function getState() {
  if (!state) {
    state = { ...defaults(), ...readJson(FILE, {}) };
    if (!state.secret) state.secret = defaults().secret;
    state.settings = { ...defaults().settings, ...(state.settings || {}) };
    state.demo = { ...defaults().demo, ...(state.demo || {}) };
    state.servers ||= [];
    state.tunnels ||= [];
    state.history ||= [];
    save();
  }
  return state;
}

export function save() {
  if (state) writeJson(FILE, state);
}

export function update(mutator) {
  const next = mutator(getState());
  save();
  return next === undefined ? getState() : next;
}

export function findServer(id) {
  return getState().servers.find((s) => s.id === id);
}

export function findTunnel(id) {
  return getState().tunnels.find((t) => t.id === id);
}
