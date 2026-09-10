#!/bin/sh
# Stage a production sidecar tree for Tauri resources (GUI .deb / .rpm).
# Invoked by beforeBundleCommand — not by `tauri dev` or `build:ci`.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/sidecar"
DEST="$ROOT/src-tauri/sidecar-bundle"

if [ ! -f "$SRC/package.json" ] || [ ! -f "$SRC/package-lock.json" ]; then
  echo "prepare-sidecar-bundle: missing sidecar/package.json or package-lock.json" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"
cp "$SRC/package.json" "$SRC/package-lock.json" "$DEST/"
cp -R "$SRC/src" "$DEST/src"

cd "$DEST"
# Isolate from ~/.npmrc; package.json allowScripts still permits onnxruntime-node.
if ! npm_config_allow_scripts= npm ci --omit=dev --userconfig /dev/null; then
  echo "prepare-sidecar-bundle: npm ci failed" >&2
  exit 1
fi

if [ ! -f "$DEST/src/index.js" ]; then
  echo "prepare-sidecar-bundle: src/index.js missing after copy" >&2
  exit 1
fi

# onnxruntime-node ships every OS/arch plus CUDA plugins. linuxdeploy walks
# those ELF files, then dies on libcublasLt. Keep this host only.
case "$(uname -m)" in
  x86_64) ort_arch=x64 ;;
  aarch64|arm64) ort_arch=arm64 ;;
  *) ort_arch=x64 ;;
esac
ort="$DEST/node_modules/onnxruntime-node/bin/napi-v3"
if [ -d "$ort" ]; then
  find "$ort" -mindepth 1 -maxdepth 1 -type d ! -name linux -exec rm -rf {} +
  if [ -d "$ort/linux" ]; then
    find "$ort/linux" -mindepth 1 -maxdepth 1 -type d ! -name "$ort_arch" -exec rm -rf {} +
  fi
  rm -f "$ort/linux/$ort_arch"/libonnxruntime_providers_cuda.so \
        "$ort/linux/$ort_arch"/libonnxruntime_providers_tensorrt.so
fi

echo "prepare-sidecar-bundle: $DEST"
