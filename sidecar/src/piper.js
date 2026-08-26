import fs from 'node:fs';
import path from 'node:path';
import { MODELS_DIR, AUDIO_DIR, getSettings } from './config.js';
import { loadCatalog } from './catalog.js';
import { chunkText, f32ToPcm16, buildWav } from './audio.js';
import { espeakPhonemize, toIds } from './phonemes.js';

/**
 * Piper TTS engine (VITS models from rhasspy/piper-voices, plain ONNX run on
 * onnxruntime-node — CPU only). Kept behind the same engine boundary as
 * kokoro-js: nothing here leaks past synthesize()/voice metadata.
 */

const DEFAULT_SCALES = { noise: 0.667, noiseW: 0.8 };

export function piperDir(model, modelsDir = MODELS_DIR) {
  return path.join(modelsDir, 'piper', model.id);
}

/** [onnxPath, configJsonPath] for a piper catalog model. */
export function piperFiles(model, modelsDir = MODELS_DIR) {
  const base = path.basename(model.voicePath);
  const dir = piperDir(model, modelsDir);
  return [path.join(dir, base), path.join(dir, `${base}.json`)];
}

// --- Install ----------------------------------------------------------------

async function downloadTo(url, dest, { signal, onProgress }) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  const total = Number(res.headers.get('content-length')) || null;
  const out = fs.createWriteStream(dest);
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    if (signal?.aborted) { out.destroy(); throw new Error('Install canceled'); }
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (!out.write(Buffer.from(value))) {
      await new Promise((resolve) => out.once('drain', resolve));
    }
    if (total) onProgress?.({ status: 'progress', loaded: received, total, file: path.basename(dest) });
  }
  out.end();
  await new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });
  onProgress?.({ status: 'done', file: path.basename(dest) });
}

/** HF resolve URLs for the model's onnx + json pair. */
export function piperUrls(model) {
  const revision = model.revision || 'main';
  return ['', '.json'].map((suffix) =>
    `https://huggingface.co/${model.repository}/resolve/${revision}/${model.voicePath}${suffix}?download=true`);
}

export async function installPiperFiles({ model, modelsDir, signal, onProgress }) {
  const dir = piperDir(model, modelsDir);
  fs.mkdirSync(dir, { recursive: true });
  for (const [suffix, url] of ['', '.json'].map((suffix, i) => [suffix, piperUrls(model)[i]])) {
    await downloadTo(url, path.join(dir, path.basename(model.voicePath + suffix)), { signal, onProgress });
  }
}

// --- Inference --------------------------------------------------------------

const voices = new Map(); // model.id -> { session, config, timer, lastUsed }

export function unloadPiper() {
  for (const entry of voices.values()) clearTimeout(entry.timer);
  voices.clear();
}

export function piperState() {
  let lastUsed = 0;
  for (const entry of voices.values()) {
    if (entry.lastUsed > lastUsed) lastUsed = entry.lastUsed;
  }
  return { loaded: voices.size > 0, lastUsed: lastUsed || null };
}

function touch(entry, unloadAfterMinutes) {
  entry.lastUsed = Date.now();
  clearTimeout(entry.timer);
  if (unloadAfterMinutes > 0) {
    entry.timer = setTimeout(() => voices.delete(entry.id), unloadAfterMinutes * 60_000);
    entry.timer.unref();
  }
}

async function loadVoice(model) {
  const cached = voices.get(model.id);
  if (cached) return cached;
  const [onnxPath, jsonPath] = piperFiles(model);
  for (const p of [onnxPath, jsonPath]) {
    if (!fs.existsSync(p)) {
      const err = new Error('Model is not installed');
      err.code = 'model.not_installed';
      throw err;
    }
  }
  const ort = await import('onnxruntime-node');
  const config = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const session = await ort.InferenceSession.create(onnxPath);
  const names = new Set(session.inputNames ?? []);
  for (const need of ['input', 'input_lengths', 'scales']) {
    if (names.size && !names.has(need)) {
      const err = new Error(`Piper model is missing ONNX input "${need}"`);
      err.code = 'tts.piper_inputs';
      throw err;
    }
  }
  const entry = { id: model.id, session, config, timer: null, lastUsed: 0 };
  voices.set(model.id, entry);
  return entry;
}

/**
 * Synthesize text to a single WAV file (same contract as engine.synthesize).
 * `load` and `phonemize` are injectable for tests.
 */
export async function synthesize(text, {
  model,
  speed = 1.0,
  onProgress,
  signal,
  audioDir = AUDIO_DIR,
  load = loadVoice,
  phonemize = espeakPhonemize,
  unloadAfterMinutes = getSettings().unloadAfterMinutes,
} = {}) {
  const ort = await import('onnxruntime-node');
  const { session, config } = await load(model);
  const idMap = config.phoneme_id_map;
  const sampleRate = config.audio?.sample_rate ?? 22050;
  const lang = model.languages[0];
  const chunks = chunkText(text);
  if (chunks.length === 0) throw new Error('Nothing to speak');

  const pcmParts = [];
  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) throw new Error('Synthesis aborted');
    const ipa = await phonemize(chunks[i], lang);
    const ids = toIds(ipa, idMap);
    const feed = {
      input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
      // Piper scales: noise, length (inverse of speed), noise_w.
      scales: new ort.Tensor('float32',
        Float32Array.from([DEFAULT_SCALES.noise, 1 / (speed || 1), DEFAULT_SCALES.noiseW]), [3]),
    };
    const results = await session.run(feed);
    const audio = results.audio ?? results.output ?? Object.values(results)[0];
    pcmParts.push(f32ToPcm16(audio.data));
    onProgress?.({ stage: 'synthesizing', chunk: i + 1, totalChunks: chunks.length, text: chunks[i] });
  }
  touch(voices.get(model.id) ?? { id: model.id }, unloadAfterMinutes);

  const pcm = Buffer.concat(pcmParts);
  fs.mkdirSync(audioDir, { recursive: true });
  const file = path.join(audioDir, `sayit-${Date.now()}.wav`);
  fs.writeFileSync(file, buildWav(pcm, sampleRate));
  return { file, chunks, durationSec: pcm.length / 2 / sampleRate, speed };
}

// --- Voice registry ---------------------------------------------------------

/** Voice metadata for every piper catalog row, keyed by voice id. */
export function piperVoices(catalog = loadCatalog()) {
  const out = {};
  for (const m of catalog) {
    if (m.engine !== 'piper-onnx') continue;
    out[m.defaultVoice] = {
      name: (m.displayName || m.id).replace(/^Piper\s+/, ''),
      lang: m.languages[0],
      gender: m.gender || 'unknown',
      family: 'piper',
    };
  }
  return out;
}
