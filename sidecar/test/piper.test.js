import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { synthesize, piperVoices, piperFiles, piperUrls } from '../src/piper.js';
import { loadCatalog } from '../src/catalog.js';
import { chunkText, buildWav, f32ToPcm16 } from '../src/audio.js';

const PAOLA = loadCatalog().find((m) => m.id === 'piper-it-paola');

const CONFIG = {
  audio: { sample_rate: 22050 },
  phoneme_id_map: { '^': [1], $: [2], '0': [0], c: [10], i: [11], 'a': [12], 'o': [13], ' ': [30] },
};

function fakeLoad(calls) {
  return async (model) => {
    calls.push(model.id);
    return {
      config: CONFIG,
      session: {
        async run(feed) {
          calls.push({ feed });
          const n = Number(feed.input_lengths[0] ?? feed.input_lengths?.data?.[0] ?? 5);
          // Echo the ids count as sample count so duration math is checkable.
          const samples = new Float32Array(Math.max(n, 4));
          samples.fill(0.5);
          return { audio: { data: samples } };
        },
      },
    };
  };
}

function fakePhonemize(calls) {
  return async (text, lang) => {
    calls.push({ text, lang });
    return 'ciao';
  };
}

test('synthesize runs per chunk, writes WAV at model sample rate', async () => {
  const calls = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sayit-piper-'));
  const audioDir = path.join(dir, 'audio');
  const out = await synthesize('ciao ciao.', {
    model: PAOLA,
    speed: 1.5,
    audioDir,
    load: fakeLoad(calls),
    phonemize: fakePhonemize(calls),
    unloadAfterMinutes: 0,
  });
  assert.ok(fs.existsSync(out.file));
  const wav = fs.readFileSync(out.file);
  assert.equal(wav.readUInt32LE(24), 22050); // sample rate from config
  assert.equal(out.chunks.length, 1);
  const phonemizeCalls = calls.filter((c) => c.lang);
  assert.deepEqual(phonemizeCalls.map((c) => c.lang), ['it']);
  const feedCall = calls.find((c) => c.feed);
  assert.ok(feedCall);
  assert.equal(feedCall.feed.scales.dims?.[0], 3);
  assert.ok(Math.abs(feedCall.feed.scales.data[1] - 1 / 1.5) < 1e-6);
});

test('chunkText splits long input at sentence boundaries', () => {
  const text = Array(30).fill('Ciao come stai.').join(' ');
  const chunks = chunkText(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 400));
});

test('buildWav header math for 16-bit mono', () => {
  const pcm = f32ToPcm16(Float32Array.from([0, 0.5, -0.5, 1]));
  assert.equal(pcm.length, 8);
  const wav = buildWav(pcm, 22050);
  assert.equal(wav.length, 44 + 8);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(28), 22050 * 2); // byte rate
});

test('piperVoices exposes one voice per catalog row with family tag', () => {
  const v = piperVoices();
  assert.deepEqual(Object.keys(v).sort(), ['piper_it_paola', 'piper_it_riccardo']);
  assert.equal(v.piper_it_paola.lang, 'it');
  assert.equal(v.piper_it_paola.family, 'piper');
  assert.equal(v.piper_it_paola.gender, 'female');
});

test('piperFiles derives onnx + json paths under piper/<id>', () => {
  const [onnx, json] = piperFiles(PAOLA, '/models');
  assert.equal(onnx, path.join('/models', 'piper', 'piper-it-paola', 'it_IT-paola-medium.onnx'));
  assert.equal(json, onnx + '.json');
});

test('piperUrls builds HF resolve URLs for both files', () => {
  assert.deepEqual(piperUrls(PAOLA), [
    'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/it/it_IT/paola/medium/it_IT-paola-medium.onnx?download=true',
    'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/it/it_IT/paola/medium/it_IT-paola-medium.onnx.json?download=true',
  ]);
});
