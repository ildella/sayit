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

if [ -t 1 ]; then
  DIM="$(printf '\033[2m')"
  BOLD="$(printf '\033[1m')"
  RESET="$(printf '\033[0m')"
else
  DIM= BOLD= RESET=
fi

# User ~/.npmrc often has allow-scripts=…; npm 12 warns (and can fail)
# when package.json also has allowScripts. Isolate from userconfig.
# npm run also exports npm_config_* — clear allow-scripts the same way.
printf '%s  · npm (deps — safe to ignore)%s\n' "$DIM" "$RESET"
if ! npm_out="$(npm_config_allow_scripts= npm install --omit=dev --userconfig /dev/null 2>&1)"; then
  printf '%s\n' "$npm_out" >&2
  exit 1
fi
printf '%s\n' "$npm_out" | sed "s/^/${DIM}    /; s/$/${RESET}/"
printf '\n'

cp "$SRC/cli/sayit.js" "$BIN/sayit"
cp "$SRC/scripts/sayit-clipboard.sh" "$BIN/sayit-clipboard"
chmod +x "$BIN/sayit" "$BIN/sayit-clipboard"

echo "${BOLD}✓  Sidecar${RESET}  $DEST/sidecar"
echo "${BOLD}✓  CLI${RESET}      $BIN/sayit  (+ sayit-clipboard)"
echo
echo "◇  Optional — systemd user service"
echo "     mkdir -p ~/.config/systemd/user"
echo "     cp $SRC/scripts/sayit.service ~/.config/systemd/user/"
echo "     systemctl --user enable --now sayit"
