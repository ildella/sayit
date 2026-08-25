import fs from 'node:fs';
import path from 'node:path';
import { loadCatalog, getModel } from './catalog.js';

const BUSY = new Set(['queued', 'downloading', 'verifying', 'canceling']);

export function createModelStore({
  modelsDir,
  catalog = loadCatalog(),
  getActiveId,
  setActiveId,
  installFiles,
  onChange: onChangeArg,
  unloadEngine,
}) {
  let onChange = onChangeArg;
  const runtime = new Map(); // id -> { state, error, progress }
  let activeInstall = null; // { id, abort }

  function markerPath(id) {
    return path.join(modelsDir, '.installed', id);
  }

  function repoCacheDir(repository) {
    return path.join(modelsDir, `models--${repository.replaceAll('/', '--')}`);
  }

  function walkFiles(dir, acc = []) {
    if (!fs.existsSync(dir)) return acc;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walkFiles(p, acc);
      else acc.push(p);
    }
    return acc;
  }

  function filesLookInstalled(model) {
    if (fs.existsSync(markerPath(model.id))) return true;
    const files = walkFiles(repoCacheDir(model.repository));
    const onnx = files.filter((f) => f.endsWith('.onnx'));
    if (onnx.length === 0) return false;
    const dtype = model.dtype.toLowerCase();
    const hit = onnx.some((f) => f.toLowerCase().includes(dtype));
    if (hit) return true;
    // Legacy lazy q8 download: quantized onnx with no dtype in the name.
    if (dtype === 'q8') {
      return onnx.some((f) => /quantized|model\.onnx$/i.test(f));
    }
    return false;
  }

  function diskState(model) {
    const run = runtime.get(model.id);
    if (run && BUSY.has(run.state)) return run.state;
    if (run?.state === 'failed') return 'failed';
    return filesLookInstalled(model) ? 'installed' : 'notInstalled';
  }

  function snapshot() {
    const active = getActiveId();
    return catalog.map((model) => {
      const run = runtime.get(model.id);
      const state = diskState(model);
      return {
        ...model,
        state,
        active: active === model.id && state === 'installed',
        error: run?.error ?? null,
        progress: run?.progress ?? null,
      };
    });
  }

  function emit() {
    onChange?.(snapshot());
  }

  function listModels() {
    return snapshot();
  }

  function requireModel(id) {
    return getModel(id, catalog);
  }

  function isInstalled(id) {
    return filesLookInstalled(requireModel(id));
  }

  async function install(id, { selectAfterInstall = false } = {}) {
    const model = requireModel(id);
    if (activeInstall) {
      const err = new Error('Another download is active');
      err.code = 'model.busy';
      throw err;
    }
    if (filesLookInstalled(model)) {
      if (selectAfterInstall) select(id);
      return snapshot();
    }

    const abort = new AbortController();
    activeInstall = { id, abort };
    runtime.set(id, { state: 'downloading', error: null, progress: null });
    emit();

    try {
      await installFiles({
        model,
        modelsDir,
        signal: abort.signal,
        onProgress: (progress) => {
          const cur = runtime.get(id);
          if (cur) {
            runtime.set(id, { ...cur, state: 'downloading', progress });
            emit();
          }
        },
      });
      if (abort.signal.aborted) {
        runtime.delete(id);
        emit();
        return snapshot();
      }
      fs.mkdirSync(path.dirname(markerPath(id)), { recursive: true });
      fs.writeFileSync(markerPath(id), `${Date.now()}\n`);
      runtime.delete(id);
      if (selectAfterInstall) select(id);
      emit();
      return snapshot();
    } catch (err) {
      if (abort.signal.aborted) {
        runtime.delete(id);
        emit();
        return snapshot();
      }
      runtime.set(id, { state: 'failed', error: err.message, progress: null });
      emit();
      err.code = err.code || 'model.install_failed';
      throw err;
    } finally {
      if (activeInstall?.id === id) activeInstall = null;
    }
  }

  function cancelInstall(id) {
    if (!activeInstall || activeInstall.id !== id) {
      const err = new Error('No matching install in progress');
      err.code = 'model.not_installing';
      throw err;
    }
    runtime.set(id, { state: 'canceling', error: null, progress: runtime.get(id)?.progress ?? null });
    emit();
    activeInstall.abort.abort();
  }

  function select(id) {
    const model = requireModel(id);
    if (!filesLookInstalled(model)) {
      const err = new Error('Model is not installed');
      err.code = 'model.not_installed';
      throw err;
    }
    const prev = getActiveId();
    setActiveId(id);
    if (prev !== id) unloadEngine?.();
    emit();
    return snapshot();
  }

  function remove(id) {
    const model = requireModel(id);
    if (getActiveId() === id && filesLookInstalled(model)) {
      const err = new Error('Cannot remove the active model');
      err.code = 'model.active';
      throw err;
    }
    const marker = markerPath(id);
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
    // Only delete the shared HF cache if no other installed SKU of this repo remains.
    const stillNeeded = catalog.some(
      (m) => m.id !== id && m.repository === model.repository && filesLookInstalled(m),
    );
    if (!stillNeeded) {
      const dir = repoCacheDir(model.repository);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
    runtime.delete(id);
    emit();
    return snapshot();
  }

  function setOnChange(fn) {
    onChange = fn;
  }

  return { listModels, install, cancelInstall, select, remove, isInstalled, setOnChange };
}
