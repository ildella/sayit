import http from 'node:http';
import fs from 'node:fs';
import { synthesize, engineState, resolveVoice, voiceRegistry, playbackSpeed } from './tts.js';
import { player } from './player.js';
import { addHistory, listHistory, getHistory, deleteHistory } from './history.js';
import { getToken, getSettings, saveSettings } from './config.js';
import { getModel } from './catalog.js';
import { modelStore } from './store.js';

/**
 * Versioned REST API bound to 127.0.0.1, token-protected — same shape as
 * Say It's optional HTTP server. SSE at /v1/events pushes player state and
 * synthesis progress to the UI.
 */

let currentJob = null; // { id, text, phase: 'synthesizing'|'playing', abort }
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

player.on('state', (state) => broadcast('state', state));
player.on('finished', () => { if (currentJob) currentJob.phase = 'done'; });
modelStore.setOnChange((models) => broadcast('models', models));

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 10_000_000) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

async function speak(text, { voice, speed } = {}) {
  // Replace whatever is in flight, mirroring Say It's single-job behavior.
  if (currentJob?.abort) currentJob.abort.abort();
  await player.stop();

  const abort = new AbortController();
  const job = { text, phase: 'synthesizing', abort };
  currentJob = job;
  broadcast('job', { phase: job.phase, text });

  const result = await synthesize(text, {
    voice, speed,
    signal: abort.signal,
    onProgress: (p) => broadcast('progress', p),
  });
  if (abort.signal.aborted) return { aborted: true };

  const requestedSpeed = speed || getSettings().speed;
  const playSpeed = playbackSpeed(getModel(getSettings().model).engine, requestedSpeed);
  await player.play(result.file, { speed: playSpeed, volume: getSettings().volume });
  job.phase = 'playing';
  broadcast('job', { phase: job.phase, text, file: result.file });

  const entry = addHistory({
    text, voice: voice || getSettings().voice, speed: playSpeed,
    file: result.file, durationSec: result.durationSec,
  });
  broadcast('history', entry);
  return { id: entry.id, durationSec: result.durationSec };
}

export function createServer() {
  const token = getToken();
  const settings = getSettings();

  const server = http.createServer(async (req, res) => {
    // Localhost-only service; permissive CORS so the Tauri webview and
    // vite dev server can call the API directly.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const route = `${req.method} ${url.pathname}`;

    // Auth: everything under /v1 requires the bearer token.
    if (url.pathname.startsWith('/v1')) {
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${token}`) {
        return json(res, 401, { error: 'Unauthorized' });
      }
    }

    // SSE stream
    if (route === 'GET /v1/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: state\ndata: ${JSON.stringify(player.state)}\n\n`);
      res.write(`event: models\ndata: ${JSON.stringify(modelStore.listModels())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    try {
      switch (route) {
        case 'GET /v1/status':
          return json(res, 200, {
            player: player.state,
            engine: engineState(),
            job: currentJob ? { phase: currentJob.phase, text: currentJob.text } : null,
          });

        case 'POST /v1/speak': {
          const { text, voice, speed } = await readBody(req);
          if (!text || !text.trim()) return json(res, 400, { error: 'text is required' });
          try {
            const active = getModel(getSettings().model);
            const v = resolveVoice(voice);
            if (v.family !== active.family) {
              return json(res, 409, {
                error: `Voice "${v.id}" belongs to the ${v.family} engine but the active model is ${active.family}. Select the matching model first.`,
                code: 'voice.model_mismatch',
              });
            }
            if (!modelStore.isInstalled(getSettings().model)) {
              return json(res, 409, { error: 'Model is not installed', code: 'model.not_installed' });
            }
          } catch (err) {
            return json(res, 409, { error: err.message, code: err.code || 'model.not_installed' });
          }
          speak(text, { voice, speed }).catch((err) => {
            if (currentJob) currentJob.phase = 'error';
            broadcast('job', { phase: 'error', text: currentJob?.text });
            broadcast('error', { message: err.message, code: err.code });
          });
          return json(res, 202, { accepted: true });
        }

        case 'POST /v1/pause': await player.pause(); return json(res, 200, { ok: true });
        case 'POST /v1/resume': await player.resume(); return json(res, 200, { ok: true });
        case 'POST /v1/stop':
          if (currentJob?.abort) currentJob.abort.abort();
          await player.stop();
          return json(res, 200, { ok: true });

        case 'POST /v1/seek': {
          const { seconds = 0 } = await readBody(req);
          await player.seek(Number(seconds));
          return json(res, 200, { ok: true });
        }

        case 'POST /v1/speed': {
          const { speed } = await readBody(req);
          await player.setSpeed(Number(speed));
          return json(res, 200, { ok: true });
        }

        // Volume spans 0 (silence) to 2, same range as Say It on macOS.
        case 'POST /v1/volume': {
          const { volume } = await readBody(req);
          const v = Number(volume);
          if (!Number.isFinite(v) || v < 0 || v > 2) {
            return json(res, 400, { error: 'Volume must be between 0 and 2', code: 'playback.invalid_volume' });
          }
          await player.setVolume(v);
          saveSettings({ volume: v });
          return json(res, 200, { ok: true, settings: getSettings() });
        }

        case 'GET /v1/voices':
          return json(res, 200, Object.entries(voiceRegistry()).map(([id, v]) => ({ id, ...v })));

        case 'GET /v1/models':
          return json(res, 200, modelStore.listModels());

        case 'GET /v1/history':
          return json(res, 200, listHistory());

        case 'POST /v1/history/replay': {
          const { id } = await readBody(req);
          const entry = getHistory(id);
          if (!entry) return json(res, 404, { error: 'Not found' });
          if (entry.file && fs.existsSync(entry.file)) {
            await player.play(entry.file, { speed: entry.speed || 1.0, volume: getSettings().volume });
            return json(res, 200, { ok: true, cached: true });
          }
          speak(entry.text, { voice: entry.voice, speed: entry.speed })
            .catch((err) => broadcast('error', { message: err.message }));
          return json(res, 202, { accepted: true, cached: false });
        }

        case 'POST /v1/settings': {
          const patch = await readBody(req);
          return json(res, 200, saveSettings(patch));
        }

        case 'GET /v1/settings':
          return json(res, 200, getSettings());
      }

      const delMatch = url.pathname.match(/^\/v1\/history\/([\w-]+)$/);
      if (req.method === 'DELETE' && delMatch) {
        return deleteHistory(delMatch[1])
          ? json(res, 200, { ok: true })
          : json(res, 404, { error: 'Not found' });
      }

      const modelInstall = url.pathname.match(/^\/v1\/models\/([\w-]+)\/install$/);
      if (modelInstall) {
        const id = modelInstall[1];
        if (req.method === 'POST') {
          const body = await readBody(req).catch(() => ({}));
          const pending = modelStore.install(id, { selectAfterInstall: !!body.selectAfterInstall });
          pending.catch((err) => broadcast('error', { message: err.message, code: err.code }));
          return json(res, 202, { accepted: true });
        }
        if (req.method === 'DELETE') {
          modelStore.cancelInstall(id);
          return json(res, 202, { accepted: true });
        }
      }

      const modelId = url.pathname.match(/^\/v1\/models\/([\w-]+)$/);
      if (modelId && req.method === 'DELETE') {
        modelStore.remove(modelId[1]);
        return json(res, 200, { ok: true });
      }

      const modelSelect = url.pathname.match(/^\/v1\/models\/([\w-]+)\/select$/);
      if (modelSelect && req.method === 'POST') {
        return json(res, 200, modelStore.select(modelSelect[1]));
      }

      json(res, 404, { error: 'Not found' });
    } catch (err) {
      const code = err.code === 'model.not_installed' || err.code === 'model.active' || err.code === 'model.busy'
        ? 409
        : err.message?.startsWith('Unknown model') ? 404 : 500;
      json(res, code, { error: err.message, code: err.code });
    }
  });

  server.listen(settings.port, settings.host, () => {
    console.log(`sayit sidecar listening on http://${settings.host}:${settings.port}`);
  });
  return server;
}
