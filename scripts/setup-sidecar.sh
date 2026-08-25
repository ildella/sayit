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
# User ~/.npmrc often has allow-scripts=…; npm 12 warns (and can fail)
# when package.json also has allowScripts. Isolate from userconfig.
# npm run also exports npm_config_* — clear allow-scripts the same way.
npm_config_allow_scripts= npm install --omit=dev --userconfig /dev/null

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
