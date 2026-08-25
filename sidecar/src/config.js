import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const XDG_CONFIG = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const XDG_DATA = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
const XDG_CACHE = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');

export const CONFIG_DIR = path.join(XDG_CONFIG, 'sayit');
export const DATA_DIR = path.join(XDG_DATA, 'sayit');
export const CACHE_DIR = path.join(XDG_CACHE, 'sayit');
export const MODELS_DIR = path.join(CACHE_DIR, 'models');
export const AUDIO_DIR = path.join(CACHE_DIR, 'audio');
export const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
export const TOKEN_FILE = path.join(CONFIG_DIR, 'token');
export const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
export const MPV_SOCKET = path.join(CACHE_DIR, 'mpv.sock');

for (const dir of [CONFIG_DIR, DATA_DIR, CACHE_DIR, MODELS_DIR, AUDIO_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Load or create the API token. File is created with mode 0600. */
export function getToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t) return t;
  } catch { /* missing */ }
  const token = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

const DEFAULT_SETTINGS = {
  port: 7878,
  host: '127.0.0.1',
  voice: 'af_heart',
  speed: 1.0,
  model: 'kokoro-q8',
  unloadAfterMinutes: 10,
};

function normalizeSettings(settings) {
  if (typeof settings.model === 'string' && settings.model.includes('/')) {
    return { ...settings, model: 'kokoro-q8' };
  }
  return settings;
}

export function getSettings() {
  try {
    return normalizeSettings({
      ...DEFAULT_SETTINGS,
      ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')),
    });
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(patch) {
  const merged = { ...getSettings(), ...patch };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
  return merged;
}
