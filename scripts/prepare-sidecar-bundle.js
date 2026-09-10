#!/usr/bin/env node
// Stage a production sidecar tree for Tauri resources (GUI packages).
// Invoked by beforeBundleCommand — not by `tauri dev` or `build:ci`.
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'sidecar');
const DEST = path.join(ROOT, 'src-tauri', 'sidecar-bundle');

function fail(msg) {
  console.error(`prepare-sidecar-bundle: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(SRC, 'package.json')) || !fs.existsSync(path.join(SRC, 'package-lock.json'))) {
  fail('missing sidecar/package.json or package-lock.json');
}

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });
fs.copyFileSync(path.join(SRC, 'package.json'), path.join(DEST, 'package.json'));
fs.copyFileSync(path.join(SRC, 'package-lock.json'), path.join(DEST, 'package-lock.json'));
fs.cpSync(path.join(SRC, 'src'), path.join(DEST, 'src'), { recursive: true });

const emptyNpmrc = path.join(os.tmpdir(), 'sayit-empty-npmrc');
fs.writeFileSync(emptyNpmrc, '');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const ci = spawnSync(npm, ['ci', '--omit=dev', `--userconfig=${emptyNpmrc}`], {
  cwd: DEST,
  stdio: 'inherit',
  env: { ...process.env, npm_config_allow_scripts: '' },
  shell: process.platform === 'win32',
});
if (ci.status !== 0) fail('npm ci failed');

if (!fs.existsSync(path.join(DEST, 'src', 'index.js'))) {
  fail('src/index.js missing after copy');
}

// onnxruntime-node ships every OS/arch plus CUDA plugins. linuxdeploy walks
// those ELF files, then dies on libcublasLt. Keep this host only.
const ortOs = process.platform;
const ortArch = process.arch === 'arm64' ? 'arm64' : 'x64';
const ort = path.join(DEST, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3');
if (fs.existsSync(ort)) {
  for (const name of fs.readdirSync(ort)) {
    const p = path.join(ort, name);
    if (fs.statSync(p).isDirectory() && name !== ortOs) {
      fs.rmSync(p, { recursive: true, force: true });
    }
  }
  const osDir = path.join(ort, ortOs);
  if (fs.existsSync(osDir)) {
    for (const name of fs.readdirSync(osDir)) {
      const p = path.join(osDir, name);
      if (fs.statSync(p).isDirectory() && name !== ortArch) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    }
    const binDir = path.join(osDir, ortArch);
    if (fs.existsSync(binDir)) {
      for (const f of fs.readdirSync(binDir)) {
        if (/onnxruntime_providers_(cuda|tensorrt)/i.test(f)) {
          fs.rmSync(path.join(binDir, f), { force: true });
        }
      }
    }
  }
}

console.log(`prepare-sidecar-bundle: ${DEST}`);
