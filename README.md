# Say It

[![CI Linux](https://img.shields.io/github/actions/workflow/status/ildella/sayit/ci-linux.yml?branch=master&label=Linux)](https://github.com/ildella/sayit/actions/workflows/ci-linux.yml)
[![CI macOS](https://img.shields.io/github/actions/workflow/status/ildella/sayit/ci-macos.yml?branch=master&label=macOS)](https://github.com/ildella/sayit/actions/workflows/ci-macos.yml)
[![CI Windows](https://img.shields.io/github/actions/workflow/status/ildella/sayit/ci-windows.yml?branch=master&label=Windows)](https://github.com/ildella/sayit/actions/workflows/ci-windows.yml)

Private, local text-to-speech, cross-platform. Say It turns copied text into
speech with open models running entirely on your machine — your text and
generated audio never leave your computer.

This is a multi-platform port of [callebtc/sayit](https://github.com/callebtc/sayit)
(macOS / Apple silicon), keeping its architecture and CLI surface while
swapping every Apple-specific layer for portable equivalents:

| macOS original            | This port                                   |
| ------------------------- | ------------------------------------------- |
| SwiftUI menu-bar app      | Tauri v2 + SvelteKit 2 / Svelte 5 tray app  |
| MLX Audio (Apple silicon) | **kokoro-js** (English) + **Piper ONNX** (other languages), both on onnxruntime-node |
| XPC                       | Token-protected REST API on 127.0.0.1:7878 + SSE |
| Accessibility selection   | Clipboard hotkey (see Wayland notes below)  |
| macOS Services            | `sayit-clipboard`, bindable in any DE       |
| `sayit` CLI               | Same CLI, same commands                     |

No Python anywhere. The sidecar is Node ≥ 20, the UI is Svelte, the shell is Rust.

## Platform status

| Platform | Status |
| -------- | ------ |
| Linux    | ✅ Built and tested (X11 & Wayland) |
| macOS    | 🔶 Should build — help wanted |
| Windows  | 🔶 Should build — help wanted |

The Tauri v2 shell is cross-platform by design; only the playback helper
(`mpv`, with `aplay` fallback) and clipboard tools are POSIX-flavored today.
Porting notes for macOS/Windows contributors are welcome — see
[LINUX.md](LINUX.md) for how the port is put together and why.

## Architecture

```
┌──────────────┐   REST + SSE, Bearer token   ┌──────────────────┐
│ Tauri v2 app │ ◄──────────────────────────► │ sidecar (Node)   │
│ SvelteKit UI │                              │ kokoro + piper   │
│ sayit CLI    │ ◄──────────────────────────► │ mpv playback     │
│ sayit-clipboard                            │ history, models  │
└──────────────┘                              └──────────────────┘
```

- **sidecar/** — per-user service: synthesis (Kokoro for English; Piper ONNX
  for other languages, Italian first), playback via mpv's JSON IPC
  (pause / seek / speed / volume), history, model catalog, settings. One
  model in memory, unloaded after 10 idle minutes (configurable).
- **app/** — SvelteKit 2 + Svelte 5 UI: speak box, transport, history, voices,
  Settings marketplace for models, onboarding when none are installed.
- **cli/sayit.js** — `sayit "text"`, `printf … | sayit`, `sayit status`,
  `pause`, `resume`, `stop`, `seek`, `speed`, `volume`, `voices`, `models`, `history`, `replay`.
- **src-tauri/** — tray icon, global hotkey (Ctrl+Alt+V speaks clipboard),
  spawns the sidecar, hands the API token to the webview.

## Quick install (non-developer)

Requirements: Node ≥ 20, npm, and **mpv** for playback (falls back to `aplay`).
Clipboard tools (`wl-paste` / `xclip` / `xsel`) only if you want the hotkey.
**espeak-ng** is optional and only required for Piper (non-English) voices
(`sudo apt install espeak-ng` or your distro equivalent).

```sh
curl -fsSL https://raw.githubusercontent.com/ildella/sayit/master/scripts/install.sh | bash -s -- --systemd
```

Or from a clone of this repo:

```sh
bash scripts/install.sh                 # service + sayit CLI
bash scripts/install.sh --systemd       # + start automatically at login
```

Installs the sidecar to `~/.local/share/sayit/sidecar` and the `sayit`
command to `~/.local/bin/sayit`, then starts the daemon. Download a catalog
model from the app (or `sayit models install kokoro-q8 --use`) before
speaking; after that the app stays offline.

```sh
sayit models install kokoro-q8 --use   # once, ~90 MB
sayit "Hello from Say It"              # speak
sayit status                           # player + engine status
sayit volume 0                         # silence; 1 = normal, 2 = boost
sayit service status                   # is the daemon running?
```

After pulling updates, re-run `scripts/setup-sidecar.sh` (or `npm run setup`)
and restart the service. The GUI and CLI talk to whatever is already on
port 7878 — an old sidecar will look “stuck” or reject speak.

## Desktop app (GUI)

From a clone of this repo, with the sidecar already installed (`npm run setup` or `scripts/install.sh`):

```sh
npm install                 # once: @tauri-apps/cli
npm --prefix app install    # once: SvelteKit UI
npm run dev                 # sidecar + Tauri window
```

`npm run dev` starts the sidecar and the tray/window. If the daemon is already up (`sayit service start` or systemd), Tauri connects to it instead of spawning a second one.

Equivalent: `npm run tauri dev` (same window; sidecar auto-spawn if port 7878 is free).

```sh
npm run tauri build         # .deb / AppImage (Linux shell only)
```

The `.deb` installs a **Say It** launcher and `/usr/bin/sayit` (the GUI).
The setup script also puts the **CLI** at `~/.local/bin/sayit`. If your PATH
lists `~/.local/bin` first, the GNOME icon or `sayit status` may run the CLI
instead of the window. Launch the GUI with `/usr/bin/sayit`, the CLI with
`~/.local/bin/sayit`.

## Models and first run

Speech models are a **catalog**, not a silent download on first speak.

- **Onboarding:** if nothing is installed, the Speak tab shows the recommended model (Kokoro q8, ~90 MB) and **Download and Use**. Deleting the last model brings that screen back.
- **Marketplace:** Settings → Models lists every catalog entry we can run today (`kokoro-q8` and `kokoro-q4`). Download, Download and Use, cancel, Use, Delete (not the active model).
- **Progress:** the UI shows downloading / canceling. Byte-level percent is not wired yet (kokoro-js does not expose a reliable byte callback).
- **Speak never downloads.** `POST /v1/speak` returns 409 until a model is installed and selected.

CLI:

```sh
sayit models
sayit models install kokoro-q8 --use
sayit models select kokoro-q4
sayit models rm kokoro-q4
```

Weights land in `~/.cache/sayit/models`. After that the app stays offline. Adding another ONNX family later is a catalog row, not a new Settings screen.

## Setup (development)

Requirements: Node ≥ 20, npm, **mpv** (recommended; falls back to `aplay`),
and `wl-paste` (Wayland) or `xclip`/`xsel` (X11) for clipboard features.
Rust + Tauri prerequisites only if you build the app.

```sh
git clone https://github.com/ildella/sayit && cd sayit

# 1. Install sidecar + CLI into ~/.local/share/sayit and ~/.local/bin
npm run setup          # or: sh scripts/setup-sidecar.sh

# 2a. Run the sidecar standalone…
cd ~/.local/share/sayit/sidecar && npm start

# 2b. …or as a systemd user service
cp scripts/sayit.service ~/.config/systemd/user/
systemctl --user enable --now sayit
```

### Desktop app

```sh
npm install                 # root: pulls @tauri-apps/cli
npm --prefix app install
npm run tauri dev           # dev: vite on :1420 + sidecar auto-spawn
npm run tauri build         # produces .deb / AppImage (Linux shell only)
npm run build:ci            # compile the shell, skip installers
```

CI (`.github/workflows/ci.yml`) runs `build:ci` on Ubuntu 22.04, macOS, and
Windows. That only proves the crate and UI compile — the TTS sidecar is still
installed separately via `scripts/install.sh`, so those binaries are not a
shippable app.

In dev, the app finds the sidecar via `$SAYIT_SIDECAR_DIR` or the installed
copy in `~/.local/share/sayit/sidecar`; if a service is already listening on
7878 it just connects.

## Wayland vs X11

Global shortcut registration (Ctrl+Alt+V inside the app) works on X11.
On Wayland, compositors block app-registered global shortcuts — the reliable
path is a **custom shortcut in your desktop settings** bound to
`sayit-clipboard` (installed by the setup script). Reading another app's
*selection* (not clipboard) has no cross-compositor API on Wayland; on X11
you can adapt `sayit-clipboard` to use `xclip -o` (PRIMARY) instead.

## Config & data

| Path | Content |
| ---- | ------- |
| `~/.config/sayit/token` | API token (0600), shared by app/CLI/scripts |
| `~/.config/sayit/settings.json` | port, voice, speed, volume (0–2), unload timeout |
| `~/.local/share/sayit/history.json` | spoken history (last 200) |
| `~/.cache/sayit/models` | downloaded models |
| `~/.cache/sayit/audio` | synthesized WAVs |
| `~/.cache/sayit/sidecar.log` | sidecar stdout/stderr (when spawned by the GUI) |

## Troubleshooting

**`error: Model is not installed`** — download once:

```sh
sayit models install kokoro-q8 --use
```

Speak never fetches weights by itself.

**Empty Voice menu, red connection dot, or Speak stuck on Synthesizing** —
the UI is talking to an outdated sidecar (or systemd restarted one after you
killed the process). Stop the unit, refresh the install, start again:

```sh
systemctl --user stop sayit
# pkill alone is not enough if the user unit is enabled — systemd will respawn it
ss -ltnp | grep 7878 || echo '7878 libero'
./scripts/setup-sidecar.sh
systemctl --user start sayit   # or: ~/.local/bin/sayit service start
sayit models
sayit status
```

Logs: `journalctl --user -u sayit -f` and `~/.cache/sayit/sidecar.log`.

**`sayit status` opens the desktop window** — PATH hit `/usr/bin/sayit` (GUI).
Use `~/.local/bin/sayit status`.

## API (v1)

`GET /v1/status` · `POST /v1/speak|pause|resume|stop|seek|speed|volume` ·
`GET /v1/voices|models|history|settings` ·
`POST /v1/models/:id/install|select` · `DELETE /v1/models/:id[/install]` ·
`POST /v1/history/replay` ·
`DELETE /v1/history/:id` · `GET /v1/events` (SSE) — all behind
`Authorization: Bearer <token>`.

## Differences from the original

- **Kokoro only, for now.** Qwen3-TTS / Chatterbox / OmniVoice are MLX- or
  Python-bound; kokoro-js is the one solid pure-JS engine today. The engine
  layer (`sidecar/src/engine.js`) is isolated so a second backend (e.g.
  ONNX exports of other models) can slot in.
- **No voice cloning yet.** Kokoro has no cloning support.
- **No selection capture on Linux/Wayland** (see Wayland vs X11).

## Acknowledgments

Say It was created by [callebtc](https://github.com/callebtc) as a beautiful,
privacy-first macOS app. This project exists thanks to his generosity in
releasing it under MIT — thank you! If you want the original Apple-silicon
experience (MLX Audio, voice cloning, Voice Studio), use
[callebtc/sayit](https://github.com/callebtc/sayit). This port reuses its
architecture, API surface, and CLI design.

## License

[MIT](LICENSE), like the original. Models are distributed under their own
licenses. Only synthesize voices you have the right to use.
