import fs from 'node:fs';
import path from 'node:path';
import { MODELS_DIR, AUDIO_DIR, getSettings } from './config.js';
import { getModel } from './catalog.js';
import { chunkText, f32ToPcm16, buildWav } from './audio.js';

/**
 * Synthesis engine. Wraps kokoro-js (Kokoro-82M running on onnxruntime-node,
 * pure JavaScript — no Python). The architecture mirrors Say It's: one model
 * kept in memory, unloaded after a configurable idle period.
 */

export const VOICES = {
  // American English
  af_heart: { name: 'Heart', lang: 'en-us', gender: 'female' },
  af_alloy: { name: 'Alloy', lang: 'en-us', gender: 'female' },
  af_nova: { name: 'Nova', lang: 'en-us', gender: 'female' },
  af_bella: { name: 'Bella', lang: 'en-us', gender: 'female' },
  af_sarah: { name: 'Sarah', lang: 'en-us', gender: 'female' },
  am_adam: { name: 'Adam', lang: 'en-us', gender: 'male' },
  am_michael: { name: 'Michael', lang: 'en-us', gender: 'male' },
  // British English
  bf_emma: { name: 'Emma', lang: 'en-gb', gender: 'female' },
  bf_isabella: { name: 'Isabella', lang: 'en-gb', gender: 'female' },
  bm_george: { name: 'George', lang: 'en-gb', gender: 'male' },
  bm_lewis: { name: 'Lewis', lang: 'en-gb', gender: 'male' },
};

const SAMPLE_RATE = 24000;

let tts = null;
let loadingPromise = null;
let unloadTimer = null;
let lastUsed = 0;

let installedCheck = () => false;

export function bindModelStore(store) {
  installedCheck = (id) => store.isInstalled(id);
}

export function requireInstalled(installed) {
  if (!installed) {
    const err = new Error('Model is not installed');
    err.code = 'model.not_installed';
    throw err;
  }
}

export function unloadEngine() {
  tts = null;
  loadingPromise = null;
  clearTimeout(unloadTimer);
}

export function engineState() {
  return {
    loaded: tts !== null,
    loading: loadingPromise !== null,
    model: getSettings().model,
    lastUsed: lastUsed || null,
  };
}

async function withCacheDir(dir, fn) {
  const { env } = await import('@huggingface/transformers');
  env.cacheDir = dir;
  return fn();
}

export async function installKokoroFiles({ model, modelsDir, signal, onProgress }) {
  const { KokoroTTS } = await import('kokoro-js');
  const instance = await withCacheDir(modelsDir, () => KokoroTTS.from_pretrained(model.repository, {
    dtype: model.dtype,
    progress_callback: onProgress,
  }));
  if (signal?.aborted) {
    const err = new Error('Install canceled');
    err.code = 'model.canceled';
    throw err;
  }
  void instance;
}

async function ensureLoaded() {
  const id = getSettings().model;
  requireInstalled(installedCheck(id));
  if (tts) { touch(); return tts; }
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    const { KokoroTTS } = await import('kokoro-js');
    const desc = getModel(id);
    const instance = await withCacheDir(MODELS_DIR, () => KokoroTTS.from_pretrained(desc.repository, {
      dtype: desc.dtype,
    }));
    tts = instance;
    loadingPromise = null;
    touch();
    return instance;
  })().catch((err) => { loadingPromise = null; throw err; });
  return loadingPromise;
}

function touch() {
  lastUsed = Date.now();
  clearTimeout(unloadTimer);
  const mins = getSettings().unloadAfterMinutes;
  if (mins > 0) {
    unloadTimer = setTimeout(() => {
      tts = null; // drop reference; native memory is freed with the session
    }, mins * 60 * 1000);
    unloadTimer.unref();
  }
}

/** Split text into speakable chunks at sentence boundaries. */
export { chunkText } from './audio.js';

/**
 * Synthesize text to a single WAV file. Long text is chunked, synthesized
 * chunk by chunk (progress callback fires per chunk), and the PCM data is
 * concatenated into one file.
 *
 * Returns { file, chunks, durationSec }.
 */
export async function synthesize(text, { voice, speed = 1.0, onProgress, signal } = {}) {
  const model = await ensureLoaded();
  const chunks = chunkText(text);
  if (chunks.length === 0) throw new Error('Nothing to speak');

  const pcmParts = [];
  let samplingRate = SAMPLE_RATE;
  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) throw new Error('Synthesis aborted');
    const audio = await model.generate(chunks[i], { voice: voice || getSettings().voice });
    if (audio.sampling_rate) samplingRate = audio.sampling_rate;
    // RawAudio: { audio: Float32Array, sampling_rate }. Convert to PCM16.
    const pcm = f32ToPcm16(audio.audio);
    pcmParts.push(pcm);
    onProgress?.({ stage: 'synthesizing', chunk: i + 1, totalChunks: chunks.length, text: chunks[i] });
  }
  touch();

  const pcmAll = Buffer.concat(pcmParts);
  const wav = buildWav(pcmAll, samplingRate);
  const file = path.join(AUDIO_DIR, `sayit-${Date.now()}.wav`);
  fs.writeFileSync(file, wav);
  const durationSec = pcmAll.length / 2 / samplingRate;
  return { file, chunks, durationSec, speed };
}
