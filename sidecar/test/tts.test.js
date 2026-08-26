import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceRegistry, resolveVoice, playbackSpeed } from '../src/tts.js';
import { loadCatalog } from '../src/catalog.js';

test('registry merges kokoro and piper voices with family tags', () => {
  const r = voiceRegistry(loadCatalog());
  assert.equal(r.af_heart.family, 'kokoro');
  assert.equal(r.af_heart.lang, 'en-us');
  assert.equal(r.piper_it_paola.family, 'piper');
  assert.equal(r.piper_it_paola.lang, 'it');
  assert.ok(Object.keys(r).length >= 13);
});

test('piper playback speed is 1 so mpv does not double-stretch', () => {
  assert.equal(playbackSpeed('piper-onnx', 2), 1);
  assert.equal(playbackSpeed('kokoro-js', 2), 2);
});

test('resolveVoice falls back to settings default and rejects unknown', () => {
  assert.equal(resolveVoice('piper_it_paola').id, 'piper_it_paola');
  assert.throws(
    () => resolveVoice('nope', { defaultVoice: 'missing' }),
    (err) => err.code === 'voice.unknown',
  );
});

test('stale kokoro italian id falls back to active piper voice', () => {
  const v = resolveVoice('im_nicola', { defaultVoice: 'piper_it_riccardo' });
  assert.equal(v.id, 'piper_it_riccardo');
  assert.equal(v.family, 'piper');
});
