#!/bin/sh
# Installs the sidecar into ~/.local/share/sayit/sidecar and the CLI into
# ~/.local/bin. Run once after cloning (or from the app bundle's setup).
set -eu

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/sayit"
BIN="$HOME/.local/bin"

mkdir -p "$DEST" "$BIN"
rm -rf "$DEST/sidecar"
cp -r "$SRC/sidecar" "$DEST/sidecar"
cd "$DEST/sidecar"
# npm run exports its config as npm_config_* env vars; the user's global
# allow-scripts then trips npm 12's EALLOWSCRIPTS in project installs.
npm_config_allow_scripts= npm install --omit=dev

cp "$SRC/cli/sayit.js" "$BIN/sayit"
cp "$SRC/scripts/sayit-clipboard.sh" "$BIN/sayit-clipboard"
chmod +x "$BIN/sayit" "$BIN/sayit-clipboard"

echo "Sidecar installed to $DEST/sidecar"
echo "CLI installed to $BIN/sayit (and sayit-clipboard)"
echo
echo "Optionally install a systemd user service:"
echo "  mkdir -p ~/.config/systemd/user"
echo "  cp $SRC/scripts/sayit.service ~/.config/systemd/user/"
echo "  systemctl --user enable --now sayit"
