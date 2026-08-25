# Say It

Private, local text-to-speech, cross-platform. Say It turns copied text into
speech with open models running entirely on your machine — your text and
generated audio never leave your computer.

This is a multi-platform port of [callebtc/sayit](https://github.com/callebtc/sayit)
(macOS / Apple silicon), keeping its architecture and CLI surface while
swapping every Apple-specific layer for portable equivalents:

| macOS original            | This port                                   |
| ------------------------- | ------------------------------------------- |
| SwiftUI menu-bar app      | Tauri v2 + SvelteKit 2 / Svelte 5 tray app  |
| MLX Audio (Apple silicon) | **kokoro-js** — Kokoro-82M on onnxruntime-node, pure JavaScript |
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
│ SvelteKit UI │                              │ kokoro-js engine │
│ sayit CLI    │ ◄──────────────────────────► │ mpv playback     │
│ sayit-clipboard                            │ history, models  │
└──────────────┘                              └──────────────────┘
```

- **sidecar/** — per-user service: synthesis (Kokoro-82M, q8, CPU),
  playback via mpv's JSON IPC (pause / seek / speed), history, settings.
  One model in memory, unloaded after 10 idle minutes (configurable).
- **app/** — SvelteKit 2 + Svelte 5 UI: speak box, transport controls,
  speed, history, voices, settings. Built static, served by Tauri.
- **cli/sayit.js** — `sayit "text"`, `printf … | sayit`, `sayit status`,
  `pause`, `resume`, `stop`, `seek`, `speed`, `voices`, `history`, `replay`.
- **src-tauri/** — tray icon, global hotkey (Ctrl+Alt+V speaks clipboard),
  spawns the sidecar, hands the API token to the webview.

## Quick install (non-developer)

Requirements: Node ≥ 20, npm, and **mpv** for playback (falls back to `aplay`).
Clipboard tools (`wl-paste` / `xclip` / `xsel`) only if you want the hotkey.

```sh
curl -fsSL https://raw.githubusercontent.com/ildella/sayit/master/scripts/install.sh | bash -s -- --systemd
```

Or from a clone of this repo:

```sh
bash scripts/install.sh                 # service + sayit CLI
bash scripts/install.sh --systemd       # + start automatically at login
```

Installs the sidecar to `~/.local/share/sayit/sidecar` and the `sayit`
command to `~/.local/bin/sayit`, then starts the daemon. First synthesis
downloads the Kokoro model (~90 MB); everything after that is offline.

```sh
sayit "Hello from Say It"   # speak
sayit status                # player + engine status
sayit service status        # is the daemon running?
```

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

First synthesis downloads the Kokoro model (~90 MB, q8) from Hugging Face
into `~/.cache/sayit/models`. Everything after that is fully offline.

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
| `~/.config/sayit/settings.json` | port, voice, speed, unload timeout |
| `~/.local/share/sayit/history.json` | spoken history (last 200) |
| `~/.cache/sayit/models` | downloaded models |
| `~/.cache/sayit/audio` | synthesized WAVs |

## API (v1)

`GET /v1/status` · `POST /v1/speak|pause|resume|stop|seek|speed` ·
`GET /v1/voices|models|history|settings` · `POST /v1/history/replay` ·
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
