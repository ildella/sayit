import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED = ['id', 'displayName', 'family', 'engine', 'repository', 'dtype'];

export function loadCatalog(source) {
  const data = typeof source === 'string' || Buffer.isBuffer(source)
    ? JSON.parse(source)
    : source ?? JSON.parse(fs.readFileSync(defaultCatalogPath(), 'utf8'));
  if (!Array.isArray(data.models) || data.models.length === 0) {
    throw new Error('Catalog has no models');
  }
  const ids = new Set();
  for (const model of data.models) {
    for (const key of REQUIRED) {
      if (!model[key]) throw new Error(`Catalog model missing ${key}`);
    }
    // Piper-style single-voice rows must say where the ONNX lives in the repo.
    if (model.engine === 'piper-onnx' && !model.voicePath) {
      throw new Error(`Catalog model ${model.id} missing voicePath`);
    }
    if (ids.has(model.id)) throw new Error(`Duplicate catalog id ${model.id}`);
    ids.add(model.id);
  }
  return data.models;
}

export function getModel(id, models = loadCatalog()) {
  const model = models.find((m) => m.id === id);
  if (!model) throw new Error(`Unknown model: ${id}`);
  return model;
}

export function defaultCatalogPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'catalog.json');
}
