import { MODELS_DIR, getSettings, saveSettings } from './config.js';
import { createModelStore } from './models.js';
import { bindModelStore, installKokoroFiles, unloadEngine } from './engine.js';
import { installPiperFiles, unloadPiper } from './piper.js';

export const modelStore = createModelStore({
  modelsDir: MODELS_DIR,
  getActiveId: () => getSettings().model,
  setActiveId: (id) => saveSettings({ model: id }),
  getVoice: () => getSettings().voice,
  setVoice: (voice) => saveSettings({ voice }),
  installFiles: (args) =>
    args.model.engine === 'piper-onnx' ? installPiperFiles(args) : installKokoroFiles(args),
  unloadEngine: () => { unloadEngine(); unloadPiper(); },
});

bindModelStore(modelStore);
