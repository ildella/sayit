# AGENTS.md — sayit-linux

Crucial reminders for future sessions. See LINUX.md for full architecture.

## Build / Dev

- **Node ≥ 20**, Rust, **mpv** (playback), `wl-paste`/`xclip`/`xsel` (clipboard).
- Root deps: `@tauri-apps/cli`. App and sidecar have their own `package.json`.
- Dev: `npm run dev` starts sidecar + `tauri dev`. `beforeDevCommand` runs from project root with `--prefix app`.
- CI: `npm run build:ci` (`tauri build --no-bundle`) on Ubuntu 22.04, macOS, Windows. Do not add bundling to that job until the sidecar is inside the package.
- Sidecar search order: `$SAYIT_SIDECAR_DIR` → `~/.local/share/sayit/sidecar`.

## Gotchas

- **Rust `move` closure**: `main.rs` `.run()` needs `move` to own `sidecar` — already fixed, don't regress.
- **Sidecar package-lock**: was generated against a private registry (`npm.mirrors.msh.team`). If reinstalling, remove lockfile and use public npm.
- **ONNX postinstall scripts**: `onnxruntime-node`, `sharp`, `protobufjs` need install-scripts approval after fresh install.
- **Svelte `$state` naming collision**: `store.svelte.js` exports `state`, which conflicts with the `$state` rune in components. `+page.svelte` imports it as `appState` — keep it that way, or rename the store export.
- **CORS** is `*` on loopback + token — don't tighten without handling vite dev server.
- **Engine boundary**: `engine.js` is the kokoro-js isolation layer; don't leak types past it.
- **Models come from `sidecar/src/catalog.json`** — do not hardcode Hugging Face ids in the UI.

## Invariants (from LINUX.md §9)

No Python in sidecar. Loopback + token always. No telemetry. Keep CLI surface compatible.
