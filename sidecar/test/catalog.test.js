import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog, getModel } from '../src/catalog.js';

test('catalog lists kokoro q8 as recommended and q4 as available', () => {
  const models = loadCatalog();
  assert.equal(models.length, 4);
  const q8 = getModel('kokoro-q8', models);
  const q4 = getModel('kokoro-q4', models);
  assert.equal(q8.stability, 'recommended');
  assert.equal(q8.dtype, 'q8');
  assert.equal(q4.stability, 'available');
  assert.equal(q4.engine, 'kokoro-js');
});

test('piper rows carry voicePath, revision and italian language', () => {
  const models = loadCatalog();
  const paola = getModel('piper-it-paola', models);
  const riccardo = getModel('piper-it-riccardo', models);
  assert.equal(paola.engine, 'piper-onnx');
  assert.equal(paola.voicePath, 'it/it_IT/paola/medium/it_IT-paola-medium.onnx');
  assert.equal(paola.revision, 'v1.0.0');
  assert.deepEqual(paola.languages, ['it']);
  assert.equal(paola.gender, 'female');
  assert.equal(riccardo.stability, 'available');
  assert.equal(riccardo.gender, 'male');
});

test('piper row without voicePath is rejected', () => {
  const bad = {
    schemaVersion: 1,
    models: [{
      id: 'piper-broken', displayName: 'x', family: 'piper', engine: 'piper-onnx',
      repository: 'rhasspy/piper-voices', dtype: 'onnx',
    }],
  };
  assert.throws(() => loadCatalog(bad), /missing voicePath/);
});

test('unknown catalog id fails', () => {
  assert.throws(() => getModel('nope', loadCatalog()), /Unknown model: nope/);
});
