// Shared reactive state (Svelte 5 runes), fed by the sidecar's SSE stream.
import { openEvents, getStatus, getVoices, getHistory, getSettings, getModels } from './api.js';

export const state = $state({
  connected: false,
  player: { playing: false, paused: false, position: 0, duration: 0, speed: 1.0, volume: 1.0, controllable: false },
  engine: { loaded: false, loading: false, model: '' },
  job: null,          // { phase: 'synthesizing'|'playing'|'done', text }
  progress: null,     // { chunk, totalChunks }
  voices: [],
  models: [],
  history: [],
  settings: { voice: 'af_heart', speed: 1.0, volume: 1.0, unloadAfterMinutes: 10 },
  error: null,
});

let boot = null;

export async function initStore() {
  if (boot) return boot;
  boot = (async () => {
    try {
      const [status, voices, history, settings, models] = await Promise.all([
        getStatus(), getVoices(), getHistory(), getSettings(), getModels(),
      ]);
      state.player = { ...state.player, ...status.player };
      state.engine = status.engine;
      state.job = status.job;
      state.voices = Array.isArray(voices) ? voices : [];
      state.history = history;
      // Merge so older sidecars (no volume yet) cannot wipe defaults and crash the UI.
      state.settings = { ...state.settings, ...settings };
      state.models = Array.isArray(models) ? models : [];
      if (!Array.isArray(models)) {
        state.error = 'Sidecar is outdated (GET /v1/models is not a list). Run scripts/setup-sidecar.sh and restart the service.';
      }
      state.connected = true;
    } catch (err) {
      boot = null;
      state.error = `Cannot reach the sayit service: ${err.message}`;
      return;
    }

    await openEvents({
      state: (p) => { state.player = { ...state.player, ...p }; },
      job: (j) => { state.job = j; if (j.phase !== 'synthesizing') state.progress = null; },
      progress: (p) => { state.progress = p; },
      history: (entry) => { state.history = [entry, ...state.history].slice(0, 200); },
      models: (models) => { state.models = models; },
      error: (e) => { state.error = e.message; },
      closed: () => {
        state.connected = false;
        boot = null;
        setTimeout(() => { initStore(); }, 3000);
      },
    });
  })();
  return boot;
}

export function fmtTime(sec) {
  if (!Number.isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
