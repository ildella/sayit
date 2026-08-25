import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireInstalled } from '../src/engine.js';

test('synthesize path refuses when model is not installed', () => {
  assert.throws(() => requireInstalled(false), (err) => err.code === 'model.not_installed');
  assert.doesNotThrow(() => requireInstalled(true));
});
