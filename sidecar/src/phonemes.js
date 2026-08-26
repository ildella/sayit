import { execFile } from 'node:child_process';

/**
 * Grapheme-to-phoneme for non-English engines. Piper models consume espeak-ng
 * IPA; kokoro-js's bundled phonemizer is English-only, so Piper voices get
 * their phonemes from the system espeak-ng binary (a distro package, same
 * class of runtime dependency as mpv — not Python, not a build step).
 */

// Catalog language code -> espeak-ng voice name.
const ESPEAK_VOICES = {
  it: 'it',
  es: 'es',
  'pt-br': 'pt-br',
  fr: 'fr-fr',
};

export function espeakVoiceFor(lang) {
  return ESPEAK_VOICES[lang] || lang;
}

function runEspeak(args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('espeak-ng', args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') {
          err.code = 'tts.espeak_missing';
          err.message = 'espeak-ng is not installed (needed for Piper voices). Install it with your package manager (e.g. sudo apt install espeak-ng).';
        } else {
          err.code = 'tts.espeak_failed';
        }
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

export async function hasEspeak(run = runEspeak) {
  try {
    await run(['--version']);
    return true;
  } catch {
    return false;
  }
}

const ESPEAK_MISSING = 'espeak-ng is not installed (needed for Piper voices). Install it with your package manager (e.g. sudo apt install espeak-ng).';

/** Text -> IPA string via espeak-ng. `run` is injectable for tests. */
export async function espeakPhonemize(text, lang, run = runEspeak) {
  try {
    const out = await run(['--ipa', '-q', '-v', espeakVoiceFor(lang), text]);
    return out.replace(/\s+/g, ' ').trim();
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'tts.espeak_missing') {
      err.code = 'tts.espeak_missing';
      err.message = ESPEAK_MISSING;
    } else {
      err.code = err.code || 'tts.espeak_failed';
    }
    throw err;
  }
}

/**
 * IPA -> Piper phoneme ids, following piper's convention: BOS '^', then each
 * symbol's ids followed by a PAD '0', closing with EOS '$'. Symbols missing
 * from the model's phoneme_id_map (espeak version drift, tie bars) are
 * dropped rather than fatal — a skipped symbol degrades one phone, an
 * exception kills the whole utterance.
 */
export function toIds(ipa, idMap) {
  const ids = [...(idMap['^'] ?? [])];
  const pad = idMap['0'] ?? [0];
  for (const sym of ipa) {
    const mapped = idMap[sym];
    if (!mapped) continue;
    ids.push(...mapped, ...pad);
  }
  ids.push(...(idMap['$'] ?? []));
  return ids;
}
