import fs from 'node:fs';
import path from 'node:path';
import { MODELS_DIR, AUDIO_DIR, getSettings } from './config.js';

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
const MAX_CHUNK_CHARS = 400;

let tts = null;
let loadingPromise = null;
let unloadTimer = null;
let lastUsed = 0;

export function engineState() {
  return {
    loaded: tts !== null,
    loading: loadingPromise !== null,
    model: getSettings().model,
    lastUsed: lastUsed || null,
  };
}

async function ensureLoaded() {
  if (tts) { touch(); return tts; }
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    const { KokoroTTS } = await import('kokoro-js');
    const settings = getSettings();
    const instance = await KokoroTTS.from_pretrained(settings.model, {
      dtype: 'q8',
      cache_dir: MODELS_DIR,
    });
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
export function chunkText(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?;:]+[.!?;:]*\s*/g) || [clean];
  const chunks = [];
  let buf = '';
  for (const s of sentences) {
    if (buf.length + s.length > MAX_CHUNK_CHARS && buf) {
      chunks.push(buf.trim());
      buf = s;
    } else {
      buf += s;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

/** Write a 16-bit PCM mono WAV. */
function buildWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

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
    const f32 = audio.audio;
    const pcm = Buffer.alloc(f32.length * 2);
    for (let j = 0; j < f32.length; j++) {
      const s = Math.max(-1, Math.min(1, f32[j]));
      pcm.writeInt16LE(Math.round(s * 32767), j * 2);
    }
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
