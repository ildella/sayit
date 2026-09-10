# Say It

[![CI Linux](https://img.shields.io/github/actions/workflow/status/ildella/sayit/ci-linux.yml?branch=master&label=Linux)](https://github.com/ildella/sayit/actions/workflows/ci-linux.yml)
[![CI macOS](https://img.shields.io/github/actions/workflow/status/ildella/sayit/ci-macos.yml?branch=master&label=macOS)](https://github.com/ildella/sayit/actions/workflows/ci-macos.yml)
[![CI Windows](https://img.shields.io/github/actions/workflow/status/ildella/sayit/ci-windows.yml?branch=master&label=Windows)](https://github.com/ildella/sayit/actions/workflows/ci-windows.yml)

Private, local text-to-speech. Say It turns copied text into speech with open
models running entirely on your machine — your text and generated audio never
leave your computer.

This is a Linux-first port of [callebtc/sayit](https://github.com/callebtc/sayit)
(macOS / Apple silicon). It keeps the original architecture and CLI while
replacing Apple-specific layers with Tauri, Svelte, and kokoro-js.

<p align="center">
  <img src="docs/screenshots/desktop-speak.png" alt="Say It desktop app — Speak tab" width="720">
</p>

Linux (X11 and Wayland) is built and tested. macOS and Windows should compile;
help wanted.

## Highlights

- **Speak from anywhere.** Copy text and press the clipboard hotkey
  (**Ctrl+Alt+V** on X11), or bind `sayit-clipboard` as a custom shortcut in
  your desktop environment — the reliable path on Wayland.
- **A desktop player.** Tray window to speak, pause, seek, change playback
  speed, and revisit history without leaving your current app.
- **Open models.** Download supported Kokoro-82M weights in the app or CLI
  (`kokoro-q8` ~90 MB, or `kokoro-q4`). Speak never downloads on its own.
- **Efficient model loading.** Only one model is kept in memory, and it is
  unloaded after a configurable idle period (ten minutes by default).
- **Local by design.** Synthesis works offline after model download. There is
  no analytics, cloud inference, or passive clipboard monitoring.
- **Hear your coding agent work.** The bundled
  [Say It agent skill](skills/sayit/SKILL.md) provides live, hands-free spoken
  progress updates while an agent works.

## Getting started

Say It needs **Node ≥ 20**, npm, and **mpv** for playback (`aplay` is a
limited fallback). Clipboard tools (`wl-paste`, `xclip`, or `xsel`) only if
you want the hotkey.

1. Install the sidecar and CLI, and start the service at login:

   ```sh
   git clone https://github.com/ildella/sayit.git
   cd sayit
   bash scripts/install.sh --systemd
   ```

   Omit `--systemd` to start the daemon once without enabling it. Put
   `~/.local/bin` on your `PATH`.

2. Download a model (once, then the app stays offline):

   ```sh
   sayit models install kokoro-q8 --use
   ```

3. Speak:

   ```sh
   sayit "Hello from Say It"
   ```

   Or copy text and invoke the hotkey / `sayit-clipboard`.

Onboarding in the desktop app offers the same recommended model if none is
installed. `POST /v1/speak` returns 409 until a catalog model is installed
and selected.

### Terminal

The install includes a `sayit` CLI for speech, playback, models, and
automation:

```sh
sayit "Read this aloud"
printf 'Read standard input' | sayit
sayit status
sayit pause
sayit resume
sayit volume 0          # silence; 1 = normal, 2 = boost
sayit service status
sayit skill path
```

Run `sayit --help` for all commands. The CLI talks to the sidecar on
`127.0.0.1:7878`. If the daemon is down: `sayit service start` (or
`systemctl --user start sayit` after `--systemd`).

### Coding-agent voice mode

After install:

```sh
sayit skill install
```

That copies `SKILL.md` to `~/.agents/skills/sayit/` (OpenCode and other
agents that read that directory). Then tell the agent:

```text
Load the Say It skill and use it for live spoken updates.
```

**Claude Code** (if you use it instead):

```sh
mkdir -p ~/.claude/skills/sayit
cp "$(sayit skill path)" ~/.claude/skills/sayit/SKILL.md
```

Re-run `sayit skill install` after upgrading Say It. The sidecar must be
running and a model installed before speech works.

### Wayland vs X11

In-app global shortcuts (**Ctrl+Alt+V**) work on X11. Wayland compositors
block them — bind a **custom shortcut** in your desktop settings to
`sayit-clipboard` (installed next to the CLI). There is no cross-compositor
API for another app's *selection* (not clipboard); on X11 you can point
`sayit-clipboard` at `xclip -o` (PRIMARY) instead.

## Build from source

The steps above install the **CLI and sidecar**. The desktop app is a Tauri
v2 + SvelteKit UI; you need Rust and [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/)
as well as Node ≥ 20 and mpv.

```sh
git clone https://github.com/ildella/sayit.git && cd sayit
npm run setup              # sidecar + CLI into ~/.local
npm install                # @tauri-apps/cli
npm --prefix app install   # SvelteKit UI
npm run dev                # sidecar + Tauri window
```

`npm run dev` (or `npm run tauri dev`) opens the tray/window. If a daemon is
already listening on port 7878, Tauri connects to it instead of spawning a
second one.

```sh
npm run tauri build        # .deb / AppImage (Linux)
npm run build:ci           # compile the shell, skip installers
```

The `.deb` installs a **Say It** launcher and `/usr/bin/sayit` (the GUI).
The setup script puts the **CLI** at `~/.local/bin/sayit`. If `~/.local/bin`
is first on `PATH`, a GNOME icon or `sayit status` may run the CLI instead of
the window — launch the GUI with `/usr/bin/sayit`.

After pulling updates, re-run `npm run setup` (or `scripts/setup-sidecar.sh`)
and restart the service so the GUI and CLI are not talking to a stale
sidecar.

CI runs `build:ci` on Ubuntu 22.04, macOS, and Windows. That proves the crate
and UI compile; the TTS sidecar is still installed separately, so those
binaries are not a shippable app yet.

## Architecture

The SvelteKit frontend (in a Tauri v2 tray shell) is separate from a
per-user Node sidecar that owns model downloads, synthesis, playback, and
history. The app, CLI, and `sayit-clipboard` talk to that service over a
token-protected REST + SSE API bound to `127.0.0.1:7878`. There is no
Python; synthesis is **Kokoro-82M** via kokoro-js / onnxruntime-node (CPU).

```
┌──────────────┐   REST + SSE, Bearer token   ┌──────────────────┐
│ Tauri v2 app │ ◄──────────────────────────► │ sidecar (Node)   │
│ SvelteKit UI │                              │ kokoro-js engine │
│ sayit CLI    │ ◄──────────────────────────► │ mpv playback     │
│ sayit-clipboard                            │ history, models  │
└──────────────┘                              └──────────────────┘
```

How the port maps onto the original (XPC → loopback HTTP, MLX → kokoro-js,
selection → clipboard), filesystem layout, and invariants are in
[LINUX.md](LINUX.md).

## Acknowledgments

Say It was created by [callebtc](https://github.com/callebtc) as a
privacy-first macOS app. This project exists thanks to his generosity in
releasing it under MIT. For the original Apple-silicon experience (MLX Audio,
voice cloning, Voice Studio), use
[callebtc/sayit](https://github.com/callebtc/sayit).

## License

[MIT](LICENSE), like the original. Models are distributed under their own
licenses. Only synthesize voices you have the right to use.
