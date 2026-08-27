// THROWAWAY SPIKE — do NOT merge into the app.
//
// Kokoro Italian G2P listen spike (plan: kokoro-italian-g2p-1).
// Proves whether Kokoro-82M + espeak-ng Italian IPA is worth productizing.
//
// Pipeline (mirrors engine.js model loading, bypasses the English phonemizer):
//   1. espeak-ng --ipa -v it  -> Italian IPA
//   2. tts.tokenizer(ipa, { truncation: true })  -> input_ids
//   3. tts.generate_from_ids(input_ids, { voice })  -> WAV
//
// We call generate_from_ids directly so the English misaki phonemizer is never
// invoked; the Italian .bin style vectors load from the local kokoro-js voices
// dir (k() reads ../voices/{id}.bin and does NOT call _validate_voice).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const SIDE_PATH = path.dirname(new URL(import.meta.url).pathname);
const OUT_DIR = path.join(SIDE_PATH, 'spike-italian-out');
fs.mkdirSync(OUT_DIR, { recursive: true });

const MODELS_DIR = path.join(
  process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
  'sayit', 'models',
);

const ITALIAN_VOICES = ['if_sara', 'im_nicola'];
const ENGLISH_BASELINE = 'af_heart'; // English style on the same IPA = "accented" baseline
const SPEED = 1.0;

const SENTENCES = [
  'Ciao, come stai?',
  'Buongiorno a tutti, benvenuti.',
  'La pizza napoletana è buonissima.',
  'Milano è una città molto elegante.',
  'Non capisco quello che dici.',
];

// ---- 0. preconditions ----------------------------------------------------
function checkEspeak() {
  try {
    const v = execFileSync('espeak-ng', ['--version'], { encoding: 'utf8' });
    console.log('espeak-ng:', v.trim().split('\n')[0]);
    return true;
  } catch {
    console.error('PREREQ FAIL: espeak-ng not found on PATH');
    return false;
  }
}

// ---- 1. espeak-ng Italian IPA --------------------------------------------
function italianIpa(text) {
  // --ipa  (try --ipa=3 too; kokoro was trained on espeak-ng IPA)
  const raw = execFileSync(
    'espeak-ng', ['--ipa', '-q', '-v', 'it', text], { encoding: 'utf8' },
  );
  // espeak-ng emits newlines between words; join into a single IPA string, no
  // English post-processing (r->ɹ, x->k, ʲ->j, ɬ->l) is applied — Italian only.
  return raw.replace(/\s+/g, ' ').trim();
}

// ---- WAV writer (PCM16 mono, like engine.js buildWav) ---------------------
function buildWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function writeWav(name, audio) {
  const f32 = audio.audio;
  const sr = audio.sampling_rate || 24000;
  // Peak-normalize to 0.99 so a voice that happens to exceed [-1,1] isn't
  // clamped (which would add clipping artifacts and unfairly bias the A/B).
  let peak = 0;
  for (let i = 0; i < f32.length; i++) peak = Math.max(peak, Math.abs(f32[i]));
  const gain = peak > 0 ? Math.min(1, 0.99 / peak) : 1;

  const pcm = Buffer.alloc(f32.length * 2);
  for (let j = 0; j < f32.length; j++) {
    const s = Math.max(-1, Math.min(1, f32[j] * gain));
    pcm.writeInt16LE(Math.round(s * 32767), j * 2);
  }
  const wav = buildWav(pcm, sr);
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, wav);
  const dur = pcm.length / 2 / sr;
  return { file, dur, peak: Number((peak * gain).toFixed(3)), gain: Number(gain.toFixed(3)) };
}

// ---- Piper leg (detect + skip if binary missing) -------------------------
function tryPiper(text, ipa, outName) {
  let bin = null;
  for (const c of ['piper', 'piper-linux']) {
    try { bin = execFileSync('command', ['-v', c], { encoding: 'utf8' }).trim(); break; }
    catch { /* not found */ }
  }
  if (!bin) {
    return { skipped: true, reason: 'piper binary not installed (only the Riccardo model is cached)' };
  }
  // Not implemented for the spike unless piper is present on PATH.
  return { skipped: true, reason: 'piper present but wiring not implemented in spike' };
}

// ---- main ----------------------------------------------------------------
async function main() {
  if (!checkEspeak()) process.exit(1);

  const { env } = await import('@huggingface/transformers');
  env.cacheDir = MODELS_DIR;
  const { KokoroTTS } = await import('kokoro-js');
  console.log(`Loading Kokoro (cacheDir=${MODELS_DIR}) ...`);
  const tts = await KokoroTTS.from_pretrained(
    'onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8' },
  );

  const results = [];
  for (let i = 0; i < SENTENCES.length; i++) {
    const text = SENTENCES[i];
    const ipa = italianIpa(text);
    console.log(`\n[${i + 1}/${SENTENCES.length}] "${text}"`);
    console.log(`   IPA: ${ipa}`);

    const row = { text, ipa, voices: {} };

    for (const voice of [...ITALIAN_VOICES, ENGLISH_BASELINE]) {
      const label = voice === ENGLISH_BASELINE ? 'en(af_heart)' : voice;
      try {
        const { input_ids } = tts.tokenizer(ipa, { truncation: true });
        const audio = await tts.generate_from_ids(input_ids, { voice, speed: SPEED });
        const r = writeWav(`s${i + 1}-${voice}.wav`, audio);
        row.voices[label] = { ...r, ok: true };
        console.log(`   ${label.padEnd(14)} -> ${path.basename(r.file)}  (${r.dur.toFixed(2)}s, peak ${r.peak})`);
      } catch (err) {
        row.voices[label] = { ok: false, error: String(err.message || err) };
        console.log(`   ${label.padEnd(14)} -> ERROR: ${err.message || err}`);
      }
    }

    const piper = tryPiper(text, ipa, `s${i + 1}-piper-riccardo.wav`);
    row.piper = piper;
    if (piper.skipped) console.log(`   piper-riccardo   -> SKIPPED: ${piper.reason}`);

    results.push(row);
  }

  console.log('\n=== WAV files written to:', OUT_DIR, '===');
  console.log('Listen A/B: each sN-{if_sara,im_nicola,af_heart}.wav is the SAME sentence.');
  console.log('  - if_sara / im_nicola = Italian Kokoro');
  console.log('  - af_heart            = English voice reading Italian IPA (accented baseline)');
  console.log('  - piper-riccardo      = SKIPPED (binary not installed)\n');

  fs.writeFileSync(
    path.join(OUT_DIR, 'manifest.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), sentences: results }, null, 2),
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
