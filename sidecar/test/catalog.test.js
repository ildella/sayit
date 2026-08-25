import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog, getModel } from '../src/catalog.js';

test('catalog lists kokoro q8 as recommended and q4 as available', () => {
  const models = loadCatalog();
  assert.equal(models.length, 2);
  const q8 = getModel('kokoro-q8', models);
  const q4 = getModel('kokoro-q4', models);
  assert.equal(q8.stability, 'recommended');
  assert.equal(q8.dtype, 'q8');
  assert.equal(q4.stability, 'available');
  assert.equal(q4.engine, 'kokoro-js');
});

test('unknown catalog id fails', () => {
  assert.throws(() => getModel('nope', loadCatalog()), /Unknown model: nope/);
});
