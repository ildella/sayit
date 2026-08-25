#!/bin/sh
# Speak the current clipboard. Bind this to a custom shortcut in your
# desktop settings — the reliable way to get a global hotkey on Wayland.
if command -v wl-paste >/dev/null 2>&1; then
    TEXT=$(wl-paste -n 2>/dev/null)
elif command -v xclip >/dev/null 2>&1; then
    TEXT=$(xclip -o -selection clipboard 2>/dev/null)
elif command -v xsel >/dev/null 2>&1; then
    TEXT=$(xsel -b -o 2>/dev/null)
else
    echo "sayit-clipboard: need wl-paste, xclip, or xsel" >&2
    exit 1
fi

[ -z "$(printf '%s' "$TEXT" | tr -d '[:space:]')" ] && exit 0

export SAYIT_TEXT="$TEXT"
export SAYIT_TOKEN="$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/sayit/token")"
node -e '
fetch("http://127.0.0.1:7878/v1/speak", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + process.env.SAYIT_TOKEN,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ text: process.env.SAYIT_TEXT }),
}).catch(() => process.exit(1));
'
