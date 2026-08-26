import { test } from 'node:test';
import assert from 'node:assert/strict';
import { espeakVoiceFor, espeakPhonemize, toIds, hasEspeak } from '../src/phonemes.js';

const MAP = { '^': [1], $: [2], '0': [0], a: [10], b: [11], ' ': [30] };

test('espeak voice mapping covers pilot languages and passes through unknown', () => {
  assert.equal(espeakVoiceFor('it'), 'it');
  assert.equal(espeakVoiceFor('pt-br'), 'pt-br');
  assert.equal(espeakVoiceFor('de'), 'de');
});

test('espeakPhonemize normalizes whitespace via injected runner', async () => {
  const run = async (args) => {
    assert.deepEqual(args.slice(0, 4), ['--ipa', '-q', '-v', 'it']);
    return 'tˈʃao\n  come   stai\n';
  };
  assert.equal(await espeakPhonemize('ciao come stai', 'it', run), 'tˈʃao come stai');
});

test('toIds wraps in BOS/EOS, pads per symbol, drops unmapped symbols', () => {
  const ids = toIds('aXb a', MAP);
  assert.deepEqual(ids, [1, 10, 0, 11, 0, 30, 0, 10, 0, 2]);
});

test('toIds on empty input still yields BOS/EOS', () => {
  assert.deepEqual(toIds('', MAP), [1, 2]);
});

test('hasEspeak reports missing binary as typed error source', async () => {
  const fail = () => { const e = new Error('spawn espeak-ng ENOENT'); e.code = 'ENOENT'; throw e; };
  assert.equal(await hasEspeak(fail), false);
  assert.equal(await hasEspeak(async () => 'eSpeak NG 1.52'), true);
});

test('missing espeak-ng is a typed install hint', async () => {
  const fail = async () => {
    const e = new Error('spawn espeak-ng ENOENT');
    e.code = 'ENOENT';
    throw e;
  };
  await assert.rejects(
    () => espeakPhonemize('ciao', 'it', fail),
    (err) => err.code === 'tts.espeak_missing' && /apt install espeak-ng/.test(err.message),
  );
});
