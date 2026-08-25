// Shared reactive state (Svelte 5 runes), fed by the sidecar's SSE stream.
import { openEvents, getStatus, getVoices, getHistory, getSettings } from './api.js';

export const state = $state({
  connected: false,
  player: { playing: false, paused: false, position: 0, duration: 0, speed: 1.0, controllable: false },
  engine: { loaded: false, loading: false, model: '' },
  job: null,          // { phase: 'synthesizing'|'playing'|'done', text }
  progress: null,     // { chunk, totalChunks }
  voices: [],
  history: [],
  settings: { voice: 'af_heart', speed: 1.0, unloadAfterMinutes: 10 },
  error: null,
});

let started = false;

export async function initStore() {
  if (started) return;
  started = true;
  try {
    const [status, voices, history, settings] = await Promise.all([
      getStatus(), getVoices(), getHistory(), getSettings(),
    ]);
    state.player = status.player;
    state.engine = status.engine;
    state.job = status.job;
    state.voices = voices;
    state.history = history;
    state.settings = settings;
    state.connected = true;
  } catch (err) {
    state.error = `Cannot reach the sayit service: ${err.message}`;
    return;
  }

  await openEvents({
    state: (p) => { state.player = p; },
    job: (j) => { state.job = j; if (j.phase !== 'synthesizing') state.progress = null; },
    progress: (p) => { state.progress = p; },
    history: (entry) => { state.history = [entry, ...state.history].slice(0, 200); },
    error: (e) => { state.error = e.message; },
    closed: () => {
      state.connected = false;
      // Simple reconnect loop.
      setTimeout(() => { started = false; initStore(); }, 3000);
    },
  });
}

export function fmtTime(sec) {
  if (!Number.isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
