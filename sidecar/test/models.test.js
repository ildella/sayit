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

function store(dir, { active = 'kokoro-q8', installFiles, unload } = {}) {
  let activeId = active;
  return createModelStore({
    modelsDir: dir,
    catalog: loadCatalog(),
    getActiveId: () => activeId,
    setActiveId: (id) => { activeId = id; },
    installFiles: installFiles ?? (async ({ model }) => {
      const p = path.join(dir, '.installed');
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(p, model.id), 'ok');
    }),
    unloadEngine: unload,
  });
}

test('list starts with both SKUs not installed', () => {
  const listed = store(tmpDir()).listModels();
  assert.equal(listed.length, 2);
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
