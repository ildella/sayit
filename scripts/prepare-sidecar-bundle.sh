#!/bin/sh
# Thin wrapper so existing `sh scripts/prepare-sidecar-bundle.sh` calls still work.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/scripts/prepare-sidecar-bundle.js"
