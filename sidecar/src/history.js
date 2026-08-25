import fs from 'node:fs';
import crypto from 'node:crypto';
import { HISTORY_FILE } from './config.js';

const MAX_ENTRIES = 200;

function load() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); }
  catch { return []; }
}

function save(entries) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(entries, null, 2));
}

export function listHistory() {
  return load();
}

export function addHistory({ text, voice, speed, file, durationSec }) {
  const entries = load();
  const entry = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    text,
    voice,
    speed,
    file,
    durationSec,
  };
  entries.unshift(entry);
  save(entries.slice(0, MAX_ENTRIES));
  return entry;
}

export function getHistory(id) {
  return load().find((e) => e.id === id) || null;
}

export function deleteHistory(id) {
  const entries = load();
  const entry = entries.find((e) => e.id === id);
  save(entries.filter((e) => e.id !== id));
  if (entry?.file) { try { fs.unlinkSync(entry.file); } catch { /* already gone */ } }
  return Boolean(entry);
}
