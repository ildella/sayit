<script>
  import { onMount } from 'svelte';
  import { state as appState, initStore, fmtTime } from '$lib/store.svelte.js';
  import * as api from '$lib/api.js';

  let tab = $state('speak');
  let text = $state('');
  let voice = $state('af_heart');
  let speed = $state(1.0);

  onMount(() => { initStore(); });

  // Fill the speak-page pickers once voices arrive. Do not assign only in
  // onMount: a second initStore() used to return before voices existed, so
  // the <select> stayed blank. Only overwrite when the current id is missing.
  $effect(() => {
    const family = models.find((m) => m.active)?.family;
    const known = appState.voices.filter((v) => !family || !v.family || v.family === family);
    if (!known.length) return;
    if (!known.some((v) => v.id === voice)) {
      const fallback = appState.settings.voice;
      voice = known.some((v) => v.id === fallback) ? fallback : known[0].id;
    }
    if (Number.isFinite(appState.settings.speed)) speed = appState.settings.speed;
  });

  const busy = $derived(appState.job?.phase === 'synthesizing');
  const playing = $derived(appState.player.playing);
  const paused = $derived(appState.player.paused);
  const progressPct = $derived(
    appState.player.duration > 0 ? (appState.player.position / appState.player.duration) * 100 : 0
  );
  const models = $derived(Array.isArray(appState.models) ? appState.models : []);
  // Group voices by language for <optgroup> pickers (en-us, en-gb, it, …).
  // Only show voices that belong to the active model's family.
  const voiceGroups = $derived.by(() => {
    const groups = new Map();
    const family = activeModel?.family;
    for (const v of appState.voices) {
      if (family && v.family && v.family !== family) continue;
      if (!groups.has(v.lang)) groups.set(v.lang, []);
      groups.get(v.lang).push(v);
    }
    return [...groups.entries()];
  });
  const installedModels = $derived(models.filter((m) => m.state === 'installed'));
  const needsModel = $derived(installedModels.length === 0);
  const recommended = $derived(models.find((m) => m.stability === 'recommended') || models[0]);
  const installBusy = $derived(models.some((m) => ['queued', 'downloading', 'verifying', 'canceling'].includes(m.state)));
  const activeModel = $derived(models.find((m) => m.active));

  function formatBytes(n) {
    if (!n) return '';
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
    return `${Math.round(n / 1e6)} MB`;
  }

  async function downloadAndUse(id) {
    appState.error = null;
    try { await api.installModel(id, true); }
    catch (err) { appState.error = err.message; }
  }

  async function downloadOnly(id) {
    appState.error = null;
    try { await api.installModel(id, false); }
    catch (err) { appState.error = err.message; }
  }

  async function useModel(id) {
    appState.error = null;
    try { await api.selectModel(id); }
    catch (err) { appState.error = err.message; }
  }

  async function deleteModel(id) {
    appState.error = null;
    try { await api.removeModel(id); }
    catch (err) { appState.error = err.message; }
  }

  async function submit() {
    if (!text.trim() || busy) return;
    appState.error = null;
    try {
      await api.speak(text, { voice, speed });
    } catch (err) {
      appState.error = err.message;
    }
  }

  async function togglePlay() {
    if (paused) await api.resume();
    else await api.pause();
  }

  async function changeSpeed(delta) {
    const next = Math.min(4, Math.max(0.5, Math.round((appState.player.speed + delta) * 4) / 4));
    await api.setSpeed(next);
  }

  function volumeSymbol(v) {
    if (v <= 0) return '🔇';
    if (v < 0.75) return '🔈';
    if (v < 1.5) return '🔉';
    return '🔊';
  }

  async function changeVolume(e) {
    const v = Number(e.target.value);
    appState.player.volume = v; // optimistic; SSE state confirms
    try { await api.setVolume(v); } catch (err) { appState.error = err.message; }
  }

  async function saveDefaultVolume(e) {
    try {
      appState.settings = await api.saveSettings({ volume: Number(e.target.value) });
    } catch (err) { appState.error = err.message; }
  }

  async function replayEntry(id) {
    appState.error = null;
    try { await api.replay(id); } catch (err) { appState.error = err.message; }
  }

  async function removeEntry(id) {
    await api.deleteEntry(id);
    appState.history = appState.history.filter((e) => e.id !== id);
  }
</script>

<div class="shell">
  <header>
    <div class="brand">
      <span class="logo">◉</span> Say It
      <span class="tag">linux</span>
    </div>
    <nav>
      {#each [['speak', 'Speak'], ['history', 'History'], ['settings', 'Settings']] as [id, label] (id)}
        <button class:active={tab === id} onclick={() => (tab = id)}>{label}</button>
      {/each}
    </nav>
    <div class="conn" class:off={!appState.connected}>
      {appState.connected ? '●' : '○'}
    </div>
  </header>

  {#if appState.error}
    <div class="error">
      {appState.error}
      <button class="danger" onclick={() => (appState.error = null)}>✕</button>
    </div>
  {/if}

  <main>
    {#if tab === 'speak'}
      <section class="speak">
        {#if needsModel && recommended}
          <div class="onboard">
            <h3>Download a speech model</h3>
            <p class="dim">Nothing is installed yet. Download a model to start speaking. This is a one-time download; after that the app stays offline.</p>
            <div class="model-card">
              <div>
                <strong>{recommended.displayName}</strong>
                {#if recommended.stability === 'recommended'}<span class="badge">Recommended</span>{/if}
                <div class="dim meta">{formatBytes(recommended.estimatedDiskBytes)} · {recommended.license} · {recommended.family} · {(recommended.languages || []).join(', ')}</div>
                {#if recommended.error}<div class="err-line">{recommended.error}</div>{/if}
                {#if recommended.state === 'downloading' || recommended.state === 'canceling'}
                  <div class="dim">Downloading…</div>
                {/if}
              </div>
              {#if recommended.state === 'downloading' || recommended.state === 'canceling'}
                <button onclick={() => api.cancelModelInstall(recommended.id)}>Cancel</button>
              {:else}
                <button class="primary" onclick={() => downloadAndUse(recommended.id)} disabled={installBusy}>
                  Download and Use {recommended.displayName}
                </button>
              {/if}
            </div>
            <p class="dim"><button class="link" onclick={() => (tab = 'settings')}>More models in Settings</button></p>
          </div>
        {:else}
        <textarea
          rows="7"
          placeholder="Type or paste text to speak… (or use the hotkey: Ctrl+Alt+V speaks the clipboard)"
          bind:value={text}
          onkeydown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submit(); }}
        ></textarea>

        <div class="row controls">
          <label>
            Voice
            <select bind:value={voice}>
              {#each voiceGroups as [lang, vs] (lang)}
                <optgroup label={lang}>
                  {#each vs as v (v.id)}
                    <option value={v.id}>{v.name}</option>
                  {/each}
                </optgroup>
              {/each}
            </select>
          </label>
          <label>
            Speed
            <input type="range" min="0.5" max="2.5" step="0.25" bind:value={speed} />
            <span class="dim">{speed}×</span>
          </label>
          <button class="primary" onclick={submit} disabled={!text.trim() || busy}>
            {busy ? 'Synthesizing…' : 'Speak'}
          </button>
        </div>

        {#if busy && appState.progress}
          <div class="progress-note">
            Synthesizing chunk {appState.progress.chunk}/{appState.progress.totalChunks}…
          </div>
        {/if}

        <div class="player" class:live={playing}>
          <div class="transport">
            <button class="icon" onclick={() => api.seek(-10)} disabled={!playing} title="Back 10s">−10</button>
            <button class="icon big" onclick={togglePlay} disabled={!playing}>
              {paused ? '▶' : '⏸'}
            </button>
            <button class="icon" onclick={() => api.seek(10)} disabled={!playing} title="Forward 10s">+10</button>
            <button class="icon" onclick={() => api.stop()} disabled={!playing && !busy}>⏹</button>
            <span class="spacer"></span>
            <span class="vol-icon" title="Volume">{volumeSymbol(appState.player.volume)}</span>
            <input
              class="vol"
              type="range" min="0" max="2" step="0.05"
              value={appState.player.volume}
              oninput={changeVolume}
              disabled={!appState.player.controllable}
              title="Volume — all the way left is silence"
            />
            <button class="icon" onclick={() => changeSpeed(-0.25)} disabled={!playing}>−</button>
            <span class="speed">{appState.player.speed}×</span>
            <button class="icon" onclick={() => changeSpeed(0.25)} disabled={!playing}>+</button>
          </div>
          <div class="track">
            <div class="fill" style:width="{progressPct}%"></div>
          </div>
          <div class="times">
            <span>{fmtTime(appState.player.position)}</span>
            <span class="dim">
              {#if appState.engine.loading}
                model loading…
              {:else if appState.engine.loaded}
                {activeModel?.displayName || appState.engine.model}
              {:else}
                {activeModel?.displayName || 'model unloaded'}
              {/if}
            </span>
            <span>{fmtTime(appState.player.duration)}</span>
          </div>
        </div>

        {#if appState.job?.text}
          <details class="current-text">
            <summary>Current text</summary>
            <p>{appState.job.text}</p>
          </details>
        {/if}
        {/if}
      </section>

    {:else if tab === 'history'}
      <section>
        {#if appState.history.length === 0}
          <p class="dim empty">Nothing spoken yet.</p>
        {/if}
        <ul class="history">
          {#each appState.history as e (e.id)}
            <li>
              <button class="icon" onclick={() => replayEntry(e.id)} title="Replay">▶</button>
              <div class="h-text">
                <span>{e.text.length > 120 ? e.text.slice(0, 120) + '…' : e.text}</span>
                <span class="dim meta">{e.at.slice(0, 16).replace('T', ' ')} · {e.voice} · {fmtTime(e.durationSec)}</span>
              </div>
              <button class="danger icon" onclick={() => removeEntry(e.id)} title="Delete">✕</button>
            </li>
          {/each}
        </ul>
      </section>

    {:else}
      <section class="settings">
        <h3>Models</h3>
        <ul class="model-list">
          {#each models as m (m.id)}
            <li class="model-card">
              <div>
                <strong>{m.displayName}</strong>
                {#if m.stability === 'recommended'}<span class="badge">Recommended</span>{/if}
                <div class="dim meta">{formatBytes(m.estimatedDiskBytes)} · {m.license} · {m.family} · {(m.languages || []).join(', ')}</div>
                {#if m.error}<div class="err-line">{m.error}</div>{/if}
                {#if m.state === 'downloading' || m.state === 'canceling'}
                  <div class="dim">{m.state === 'canceling' ? 'Canceling…' : 'Downloading…'}</div>
                {/if}
              </div>
              <div class="model-actions">
                {#if m.state === 'installed'}
                  {#if m.active}
                    <span class="dim">Selected</span>
                  {:else}
                    <button onclick={() => useModel(m.id)}>Use</button>
                    <button class="danger" onclick={() => deleteModel(m.id)}>Delete</button>
                  {/if}
                {:else if m.state === 'downloading' || m.state === 'queued' || m.state === 'verifying' || m.state === 'canceling'}
                  <button onclick={() => api.cancelModelInstall(m.id)}>Cancel</button>
                {:else}
                  <button class="primary" onclick={() => downloadAndUse(m.id)} disabled={installBusy}>
                    Download and Use
                  </button>
                  <button onclick={() => downloadOnly(m.id)} disabled={installBusy}>Download</button>
                {/if}
              </div>
            </li>
          {/each}
        </ul>

        <h3>Defaults</h3>
        <label class="setting">
          <span>Default voice</span>
          <select
            value={appState.settings.voice}
            onchange={(e) => api.saveSettings({ voice: e.target.value }).then((s) => (appState.settings = s))}
          >
            {#each voiceGroups as [lang, vs] (lang)}
              <optgroup label={lang}>
                {#each vs as v (v.id)}
                  <option value={v.id}>{v.name} ({lang})</option>
                {/each}
              </optgroup>
            {/each}
          </select>
        </label>
        <label class="setting">
          <span>Default speed</span>
          <input
            type="range" min="0.5" max="2.5" step="0.25"
            value={appState.settings.speed}
            onchange={(e) => api.saveSettings({ speed: Number(e.target.value) }).then((s) => (appState.settings = s))}
          />
          <span class="dim">{appState.settings.speed}×</span>
        </label>
        <label class="setting">
          <span>Default volume (0 = silence)</span>
          <input
            type="range" min="0" max="2" step="0.05"
            value={appState.settings.volume}
            onchange={saveDefaultVolume}
          />
          <span class="dim">{volumeSymbol(appState.settings.volume ?? 1)} {(appState.settings.volume ?? 1).toFixed(2)}×</span>
        </label>
        <label class="setting">
          <span>Unload model after (minutes idle)</span>
          <input
            type="number" min="1" max="120"
            value={appState.settings.unloadAfterMinutes}
            onchange={(e) => api.saveSettings({ unloadAfterMinutes: Number(e.target.value) }).then((s) => (appState.settings = s))}
          />
        </label>

        <h3>Hotkeys & clipboard</h3>
        <p class="dim">
          <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>V</kbd> speaks the clipboard from anywhere
          (registered by the Tauri shell; on X11 only — Wayland compositors block
          global shortcuts, so bind a custom shortcut in your desktop settings to
          run <code>sayit-clipboard</code> instead).
        </p>

        <h3>CLI</h3>
        <pre>sayit "Read this aloud"
printf 'from stdin' | sayit
sayit status · sayit pause · sayit resume</pre>
      </section>
    {/if}
  </main>
</div>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    max-width: 720px;
    margin: 0 auto;
    padding: 0 20px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 14px 0;
    border-bottom: 1px solid var(--border);
  }
  .brand { font-weight: 700; font-size: 16px; display: flex; align-items: center; gap: 7px; }
  .logo { color: var(--accent); }
  .tag {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
    background: var(--accent-soft); color: var(--accent);
    padding: 2px 6px; border-radius: 4px;
  }
  nav { display: flex; gap: 4px; margin-left: auto; }
  nav button { background: transparent; border-color: transparent; color: var(--text-dim); }
  nav button.active { color: var(--text); background: var(--surface-2); }
  .conn { color: #6fcf6f; font-size: 11px; }
  .conn.off { color: var(--danger); }

  .error {
    display: flex; justify-content: space-between; align-items: center;
    background: rgba(217, 85, 85, 0.12);
    border: 1px solid rgba(217, 85, 85, 0.35);
    border-radius: 8px; padding: 8px 12px; margin-top: 12px;
  }

  main { flex: 1; overflow-y: auto; padding: 18px 0 30px; }
  .speak { display: flex; flex-direction: column; gap: 14px; }

  .row.controls { display: flex; align-items: end; gap: 18px; flex-wrap: wrap; }
  .controls label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--text-dim); }
  .controls label:has(input[type='range']) { flex-direction: row; align-items: center; gap: 8px; }
  .controls .primary { margin-left: auto; }

  .progress-note { color: var(--accent); font-size: 13px; }

  .player {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px 16px;
    display: flex; flex-direction: column; gap: 10px;
    opacity: 0.75;
    transition: opacity 0.2s;
  }
  .player.live { opacity: 1; }
  .transport { display: flex; align-items: center; gap: 8px; }
  .transport .big { font-size: 18px; padding: 8px 16px; }
  .spacer { flex: 1; }
  .speed { min-width: 44px; text-align: center; color: var(--text-dim); }
  .vol-icon { font-size: 14px; }
  .vol { width: 90px; }

  .track { height: 5px; background: var(--surface-2); border-radius: 3px; overflow: hidden; }
  .fill { height: 100%; background: var(--accent); transition: width 0.3s linear; }
  .times { display: flex; justify-content: space-between; font-size: 12px; color: var(--text-dim); font-variant-numeric: tabular-nums; }

  .current-text summary { color: var(--text-dim); cursor: pointer; font-size: 13px; }
  .current-text p { color: var(--text-dim); line-height: 1.6; white-space: pre-wrap; }

  .history { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .history li {
    display: flex; align-items: center; gap: 10px;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 10px; padding: 8px 12px;
  }
  .h-text { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .h-text .meta { font-size: 11px; }
  .empty { text-align: center; margin-top: 40px; }

  .settings h3 { margin: 22px 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-dim); }
  .settings h3:first-child { margin-top: 0; }
  .setting { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
  .setting span:first-child { width: 220px; color: var(--text-dim); }
  .settings pre {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: 8px; padding: 12px; overflow-x: auto;
  }
  kbd, code {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: 4px; padding: 1px 5px; font-size: 12px;
  }
  .dim { color: var(--text-dim); }

  .onboard { display: flex; flex-direction: column; gap: 12px; }
  .model-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .model-card {
    display: flex; justify-content: space-between; align-items: center; gap: 12px;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 10px; padding: 12px 14px;
  }
  .model-actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
  .badge {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
    background: var(--accent-soft); color: var(--accent);
    padding: 2px 6px; border-radius: 4px; margin-left: 6px;
  }
  .err-line { color: var(--danger); font-size: 12px; margin-top: 4px; }
  button.link { background: none; border: none; color: var(--accent); padding: 0; cursor: pointer; text-decoration: underline; }
</style>
