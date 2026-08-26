import { getSettings } from './config.js';
import { getModel } from './catalog.js';
import { synthesize as kokoroSynthesize, engineState as kokoroState, VOICES } from './engine.js';
import { synthesize as piperSynthesize, piperVoices, piperState } from './piper.js';

/**
 * Engine router: picks the synthesis backend for the active catalog model and
 * exposes the merged voice registry. server.js talks only to this module —
 * kokoro-js and piper stay swappable behind it.
 */

export function engineState() {
  const settings = getSettings();
  const model = getModel(settings.model);
  if (model.engine === 'piper-onnx') {
    const p = piperState();
    return { loaded: p.loaded, loading: false, model: settings.model, lastUsed: p.lastUsed };
  }
  return kokoroState();
}

/** Piper bakes speed into the WAV (VITS length_scale). Do not stretch again in mpv. */
export function playbackSpeed(engine, requested) {
  if (engine === 'piper-onnx') return 1;
  return requested;
}

export function voiceRegistry(catalog) {
  return {
    ...Object.fromEntries(Object.entries(VOICES).map(([id, v]) => [id, { ...v, family: 'kokoro' }])),
    ...piperVoices(catalog),
  };
}

const REGISTRY = voiceRegistry();

export function resolveVoice(voice) {
  const id = voice || getSettings().voice;
  const meta = REGISTRY[id];
  if (!meta) {
    const err = new Error(`Unknown voice: ${id}`);
    err.code = 'voice.unknown';
    throw err;
  }
  return { id, ...meta };
}

export async function synthesize(text, opts = {}) {
  const model = getModel(getSettings().model);
  if (model.engine === 'piper-onnx') {
    return piperSynthesize(text, { ...opts, model });
  }
  return kokoroSynthesize(text, opts);
}
