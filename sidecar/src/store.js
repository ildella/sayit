import { MODELS_DIR, getSettings, saveSettings } from './config.js';
import { createModelStore } from './models.js';
import { bindModelStore, installKokoroFiles, unloadEngine } from './engine.js';

export const modelStore = createModelStore({
  modelsDir: MODELS_DIR,
  getActiveId: () => getSettings().model,
  setActiveId: (id) => saveSettings({ model: id }),
  installFiles: installKokoroFiles,
  unloadEngine,
});

bindModelStore(modelStore);
