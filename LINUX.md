# LINUX.md — Port Notes for Developers and Agents

This document explains **why** the Linux port of
[callebtc/sayit](https://github.com/callebtc/sayit) is built the way it is.
Read this before touching anything: most structures that look unusual are
deliberate responses to Linux platform constraints, not accidents.

The original is a macOS/Apple-silicon app. This is a **rewrite, not a port** —
every Apple-specific layer was replaced with a Linux equivalent while keeping
the original's architecture, CLI surface, and privacy guarantees.

---

## 1. Component map (original → this port)

| macOS original | Linux port | Rationale |
|---|---|---|
| SwiftUI menu-bar app | **Tauri v2 shell + SvelteKit 2 / Svelte 5 UI** (`app/`, `src-tauri/`) | Cross-platform tray/window toolkit already used by the maintainer; Svelte explicitly chosen over React |
| MLX Audio (`mlx-audio-swift`) | **kokoro-js** on `onnxruntime-node` (`sidecar/src/engine.js`) | The only serious pure-JS local TTS engine; see §2 |
| XPC (app ↔ service) | **REST + SSE on `127.0.0.1:7878`**, Bearer-token auth (`sidecar/src/server.js`) | Mirrors the original's own optional HTTP server; any local client (app, CLI, scripts) can attach |
| AVAudioPlayer | **mpv via JSON IPC socket** (`sidecar/src/player.js`), `aplay` fallback | mpv gives pause/seek/speed/position for free; see §4 |
| Accessibility API (read selection in any app) | **Clipboard-only** (`sayit-clipboard.sh`, Ctrl+Alt+V) | No cross-compositor selection API on Linux; see §5 |
| macOS Services menu | `sayit-clipboard.sh`, bound as a DE custom shortcut | DE-agnostic equivalent of a system service |
| `sayit` CLI | Identical CLI surface (`cli/sayit.js`) | Deliberate parity: same commands, same behavior |

## 2. Why kokoro-js, and why it's the only engine

Hard constraint from the maintainer: **the sidecar must be pure JavaScript —
no Python**. That eliminates the entire Piper/Coqui/Chatterbox/Qwen3-TTS
ecosystem, which is Python-bound.

Kokoro-82M is the one high-quality open TTS model with a production-grade JS
runtime (`kokoro-js`, via `@huggingface/transformers` + `onnxruntime-node`,
q8-quantized ONNX, CPU-only, ~90 MB download). It is therefore the **sole
engine** in this port. Consequences:

- **No voice cloning** — Kokoro doesn't support it. The original's Voice
  Studio feature is absent by necessity, not by choice.
- **No other models** (Qwen3-TTS, Chatterbox, OmniVoice are MLX or Python).
- The engine is isolated behind `sidecar/src/engine.js` (`synthesize()`,
  `engineState()`, `VOICES`) so a second backend (e.g. a future ONNX export
  of another model, or an optional native Piper binding) can slot in without
  touching the server, player, or UI. **Do not leak kokoro-js types past
  this module.**

Long-text handling: Kokoro can't ingest arbitrary length, so `engine.js`
chunks at sentence boundaries (~400 chars), synthesizes chunk-by-chunk
(progress events over SSE), and **concatenates raw PCM16 and rewrites the WAV
header in pure JS** — no ffmpeg dependency. Sample rate is taken from the
model output, not hardcoded (except as fallback).

Model lifecycle: a **catalog** (`sidecar/src/catalog.json`) lists engines we
can actually run (today: Kokoro q8 and q4). Install is explicit
(`POST /v1/models/:id/install`); first speak does **not** download. One
model stays in memory and unloads after N idle minutes
(`unloadAfterMinutes`). The Settings list is a marketplace; Speak shows
onboarding when zero models are installed.

## 3. Service architecture: HTTP + token, not direct embedding

The sidecar is a standalone per-user daemon; the Tauri app is just another
client. This mirrors the original's "frontend separated from a per-user
backend service" design and buys:

- CLI, shell scripts, and other local apps get the same API as the UI.
- The sidecar can run under `systemd --user` independently of the app
  (`scripts/sayit.service`); the app detects a live service on port 7878
  (`TcpStream::connect` in `main.rs`) and doesn't spawn a duplicate.

**Auth**: a random token in `~/.config/sayit/token` (mode 0600), required as
`Authorization: Bearer` on every `/v1/*` route. The service binds to
`127.0.0.1` only — keep it that way. CORS is `*` deliberately: the service is
loopback + token-protected, and the Tauri webview / vite dev server need to
reach it cross-origin. If you ever bind beyond loopback, tighten CORS first.

**SSE gotcha**: the UI does NOT use `EventSource` (it can't set headers).
`app/src/lib/api.js` parses SSE manually over `fetch` so the token stays in
the `Authorization` header. Don't "simplify" this back to `EventSource`
without moving auth to a query param.

**State flow**: server is source of truth. It pushes `state`, `job`,
`progress`, `history`, `error` events over `/v1/events`; the Svelte store
(`app/src/lib/store.svelte.js`) is a dumb projection with a reconnect loop.

**Single job semantics**: `POST /v1/speak` returns `202` immediately;
synthesis progress flows over SSE. A new speak request aborts the in-flight
one (`AbortController`) and stops playback — same as the original's
replace-current behavior. There is no queue.

## 4. Playback: mpv over JSON IPC

Pure-JS audio playback with pause/seek/speed/position doesn't exist in the
Node ecosystem (native `speaker` modules are write-only streams). The port
delegates to **mpv** with `--input-ipc-server` (a Unix socket), speaking its
newline-delimited JSON protocol (`player.js`): observes `time-pos`,
`duration`, `pause`; sends `set_property` / `seek`.

- If mpv is absent: falls back to fire-and-forget `aplay` and reports
  `controllable: false`; the UI disables transport controls accordingly.
- The socket lives in `~/.cache/sayit/mpv.sock` and is unlinked before each
  spawn (stale sockets from killed processes are normal).
- mpv creates its socket asynchronously — `player.js` retries the connection
  for ~2 s. This is intentional; don't replace it with a single connect.

## 5. Input: clipboard, not selection — the core compromise

The original's flagship feature is speaking the *current selection* in any
app via the macOS Accessibility API. **Linux has no equivalent**:

- **X11**: `xclip -o` (PRIMARY selection) comes close, but only on X11.
- **Wayland**: compositors deliberately expose no global selection or
  accessibility protocol. Any "read the focused app's selection" feature
  would be per-compositor (GNOME/KDE/wlroots extensions) and fragile.

The compromise: **clipboard-driven**. The user copies, then hits the hotkey
(Ctrl+Alt+V). The original itself ships this as a fallback mode, so UX
degradation is modest.

Second constraint: `tauri-plugin-global-shortcut` only registers global
hotkeys on **X11**; Wayland compositors block app-registered globals. Hence
`scripts/sayit-clipboard.sh`: a DE-agnostic script (wl-paste → xclip → xsel
fallback chain) meant to be bound as a custom shortcut in the desktop
environment's own settings — the only reliable global-hotkey mechanism on
Wayland. The Rust shell duplicates the same clipboard fallback chain for the
in-app hotkey. **Keep the two fallback chains in sync** (`main.rs
read_clipboard()` ↔ `sayit-clipboard.sh`).

## 6. Filesystem layout (XDG)

| Path | Content |
|---|---|
| `~/.config/sayit/token` | API token, 0600 — shared by app, CLI, scripts |
| `~/.config/sayit/settings.json` | port, host, voice, speed, model, unload timeout |
| `~/.local/share/sayit/sidecar/` | installed sidecar (by `scripts/setup-sidecar.sh`) |
| `~/.local/share/sayit/history.json` | last 200 entries, references WAV files |
| `~/.cache/sayit/models/` | HF model cache (passed as `cache_dir` to kokoro-js) |
| `~/.cache/sayit/audio/` | synthesized WAVs (deleted with history entries) |

The token file is the single source of truth for auth: the CLI reads it
directly, the app gets it via the `get_token` Tauri command (with
`?token=` / localStorage fallbacks for browser dev), scripts read it from
disk. Anything that needs the API should resolve the token the same way.

## 7. Tauri shell specifics

- `build.rs` + `tauri-build` exist because `tauri::generate_context!()`
  requires `OUT_DIR` — removing them breaks the build with a confusing macro
  error.
- `beforeDevCommand`/`beforeBuildCommand` run from the **project root**, so
  they use `--prefix app`; `frontendDist` is relative to `src-tauri/`, so it
  keeps `../app/build`. Mixing these up produces an ENOENT two directories
  away from the real problem.
- The tray icon has a 1×1 transparent fallback (`Image::new_owned`) because
  `default_window_icon()` can be `None` in some bundling configurations.
- CSP in `tauri.conf.json` must keep `connect-src http://127.0.0.1:7878` or
  the webview can't reach the sidecar.

## 8. Known limitations (vs the original)

1. Kokoro family only (q8 / q4 ONNX); no voice cloning, no MLX/Python families (§2). Marketplace UI is ready for more catalog rows later.
2. No selection capture, clipboard only (§5).
3. Global hotkey X11-only inside the app; Wayland needs the DE-bound script
   (§5).
4. English voices only. kokoro-js ships Italian/ES/FR/PT voice *bins* but
    its phonemizer WASM is English-only, so those ids fail at generate.
    The `VOICES` table in `engine.js` lists what actually works.
5. Single in-flight job; no queue (§3).
6. Linux only — nothing here is tested on macOS/Windows, though the sidecar
   and CLI are platform-agnostic in principle (mpv/aplay are the
   platform-specific bits).

## 9. Invariants — do not break these

- **No Python, no new native build steps** in the sidecar. If a feature
  needs one, it doesn't belong in the sidecar.
- **Loopback + token** on the HTTP API, always.
- **engine.js is a boundary** — engine-agnostic interface out, kokoro-js in.
- **Models come from the catalog** — do not hardcode Hugging Face ids in the UI.
- **Offline after first model download**; no analytics, no telemetry, no
  passive clipboard monitoring (the original's privacy posture is part of
  the product).
- CLI command surface stays compatible with the original where the feature
  exists.
