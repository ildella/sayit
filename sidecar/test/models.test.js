import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCatalog } from '../src/catalog.js';
import { createModelStore } from '../src/models.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sayit-models-'));
}

function store(dir, { active = 'kokoro-q8', voice = 'af_heart', installFiles, unload } = {}) {
  let activeId = active;
  let activeVoice = voice;
  const s = createModelStore({
    modelsDir: dir,
    catalog: loadCatalog(),
    getActiveId: () => activeId,
    setActiveId: (id) => { activeId = id; },
    getVoice: () => activeVoice,
    setVoice: (v) => { activeVoice = v; },
    installFiles: installFiles ?? (async ({ model }) => {
      const p = path.join(dir, '.installed');
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(p, model.id), 'ok');
    }),
    unloadEngine: unload,
  });
  s.activeVoice = () => activeVoice;
  return s;
}

test('list starts with every SKU not installed', () => {
  const listed = store(tmpDir()).listModels();
  assert.equal(listed.length, 4);
  assert.ok(listed.every((m) => m.state === 'notInstalled'));
  assert.ok(listed.every((m) => m.active === false));
});

test('install then list shows installed; select marks active', async () => {
  const s = store(tmpDir(), { active: null });
  await s.install('kokoro-q8');
  const after = s.listModels();
  const q8 = after.find((m) => m.id === 'kokoro-q8');
  assert.equal(q8.state, 'installed');
  assert.equal(q8.active, false);
  s.select('kokoro-q8');
  assert.equal(s.listModels().find((m) => m.id === 'kokoro-q8').active, true);
});

test('second install while busy fails', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = store(tmpDir(), {
    installFiles: async () => { await gate; },
  });
  const first = s.install('kokoro-q8');
  await new Promise((r) => setImmediate(r));
  await assert.rejects(() => s.install('kokoro-q4'), /Another download is active/);
  release();
  await first;
});

test('remove active is rejected', async () => {
  const s = store(tmpDir());
  await s.install('kokoro-q8');
  s.select('kokoro-q8');
  assert.throws(() => s.remove('kokoro-q8'), /Cannot remove the active model/);
});

test('remove last installed leaves zero installed', async () => {
  let active = 'kokoro-q8';
  const dir = tmpDir();
  const s = createModelStore({
    modelsDir: dir,
    catalog: loadCatalog(),
    getActiveId: () => active,
    setActiveId: (id) => { active = id; },
    installFiles: async ({ model }) => {
      fs.mkdirSync(path.join(dir, '.installed'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.installed', model.id), 'ok');
    },
  });
  await s.install('kokoro-q8');
  await s.install('kokoro-q4');
  s.select('kokoro-q4');
  s.remove('kokoro-q8');
  active = null;
  s.remove('kokoro-q4');
  assert.equal(s.listModels().filter((m) => m.state === 'installed').length, 0);
});

test('unknown id fails', () => {
  const s = store(tmpDir());
  assert.throws(() => s.select('nope'), /Unknown model/);
});

test('legacy q8 onnx cache counts as installed', () => {
  const dir = tmpDir();
  const onnx = path.join(dir, 'models--onnx-community--Kokoro-82M-v1.0-ONNX', 'onnx');
  fs.mkdirSync(onnx, { recursive: true });
  fs.writeFileSync(path.join(onnx, 'model_quantized.onnx'), 'x');
  const listed = store(dir).listModels();
  assert.equal(listed.find((m) => m.id === 'kokoro-q8').state, 'installed');
  assert.equal(listed.find((m) => m.id === 'kokoro-q4').state, 'notInstalled');
});

test('piper install writes onnx+json and counts as installed', async () => {
  const dir = tmpDir();
  const s = store(dir, {
    installFiles: async ({ model }) => {
      const piperDir = path.join(dir, 'piper', model.id);
      fs.mkdirSync(piperDir, { recursive: true });
      const base = path.basename(model.voicePath);
      fs.writeFileSync(path.join(piperDir, base), 'onnx');
      fs.writeFileSync(path.join(piperDir, `${base}.json`), '{}');
    },
  });
  await s.install('piper-it-paola');
  const paola = s.listModels().find((m) => m.id === 'piper-it-paola');
  assert.equal(paola.state, 'installed');
  s.select('piper-it-paola');
  assert.equal(s.listModels().find((m) => m.id === 'piper-it-paola').active, true);
});

test('select piper model switches voice to that family', async () => {
  const dir = tmpDir();
  const s = store(dir, {
    installFiles: async ({ model }) => {
      if (model.voicePath) {
        const piperDir = path.join(dir, 'piper', model.id);
        fs.mkdirSync(piperDir, { recursive: true });
        const base = path.basename(model.voicePath);
        fs.writeFileSync(path.join(piperDir, base), 'onnx');
        fs.writeFileSync(path.join(piperDir, `${base}.json`), '{}');
        return;
      }
      const p = path.join(dir, '.installed');
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(p, model.id), 'ok');
    },
  });
  await s.install('kokoro-q8');
  await s.install('piper-it-paola');
  s.select('kokoro-q8');
  assert.equal(s.activeVoice(), 'af_heart');
  s.select('piper-it-paola');
  assert.equal(s.activeVoice(), 'piper_it_paola');
  s.select('kokoro-q8');
  assert.equal(s.activeVoice(), 'af_heart');
});

test('piper without config json is not installed', () => {
  const dir = tmpDir();
  const piperDir = path.join(dir, 'piper', 'piper-it-paola');
  fs.mkdirSync(piperDir, { recursive: true });
  fs.writeFileSync(path.join(piperDir, 'it_IT-paola-medium.onnx'), 'onnx');
  assert.equal(store(dir).listModels().find((m) => m.id === 'piper-it-paola').state, 'notInstalled');
});

test('remove piper model deletes its directory', async () => {
  const dir = tmpDir();
  const piperDir = path.join(dir, 'piper', 'piper-it-paola');
  const s = store(dir, {
    installFiles: async ({ model }) => {
      fs.mkdirSync(path.join(dir, 'piper', model.id), { recursive: true });
      const base = path.basename(model.voicePath);
      fs.writeFileSync(path.join(dir, 'piper', model.id, base), 'onnx');
      fs.writeFileSync(path.join(dir, 'piper', model.id, `${base}.json`), '{}');
    },
  });
  await s.install('piper-it-paola');
  s.remove('piper-it-paola');
  assert.equal(fs.existsSync(piperDir), false);
  assert.equal(s.listModels().find((m) => m.id === 'piper-it-paola').state, 'notInstalled');
});
