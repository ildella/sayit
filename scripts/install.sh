#!/bin/sh
# Say It — Linux: standalone installer for non-developers.
#
# Usage (from a copy of this repo):
#   bash scripts/install.sh              # service + sayit CLI
#   bash scripts/install.sh --systemd    # also start automatically at login
#
# The same script becomes a one-liner once the repo is published:
#   curl -fsSL <REPO_URL>/raw/<branch>/scripts/install.sh | bash -s -- --systemd
# In piped mode it downloads the project tarball from SAYIT_REPO_URL.
set -eu

# --- Config -----------------------------------------------------------------
# Piped installs fetch the project from here. Point this at the public repo
# when publishing; local checkouts never need it.
REPO_URL="${SAYIT_REPO_URL:-}"
REPO_BRANCH="${SAYIT_REPO_BRANCH:-main}"

SYSTEMD=no
for arg in "$@"; do
  case "$arg" in
    --systemd|-s) SYSTEMD=yes ;;
    *) echo "install.sh: unknown argument: $arg (expected --systemd)" >&2; exit 2 ;;
  esac
done

# --- Locate project sources -------------------------------------------------
# Local checkout: a `sidecar/` + `cli/` next to the current directory (or the
# script). Piped from curl: download the tarball into a temp dir.
SCRIPT_DIR="$(dirname "$0")"
if [ -f "sidecar/package.json" ] && [ -f "cli/sayit.js" ]; then
  SRC="$(pwd)"
elif [ -f "$SCRIPT_DIR/../sidecar/package.json" ]; then
  SRC="$(cd "$SCRIPT_DIR/.." && pwd)"
elif [ -z "$REPO_URL" ]; then
  echo "install.sh: no local checkout found and SAYIT_REPO_URL is not set." >&2
  echo "Run this from the repo, or set SAYIT_REPO_URL to the project URL." >&2
  exit 1
else
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  echo "Downloading $REPO_URL@$REPO_BRANCH …"
  curl -fsSL "$REPO_URL/archive/refs/heads/$REPO_BRANCH.tar.gz" | tar -xz -C "$TMP"
  SRC="$(ls -d "$TMP"/*/ 2>/dev/null | head -1)"
  [ -n "$SRC" ] || { echo "install.sh: could not extract the project tarball" >&2; exit 1; }
  SRC="${SRC%/}"
fi

# --- Prerequisites ----------------------------------------------------------
node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1 || [ "$node_major" -lt 20 ]; then
  echo "error: Node.js >= 20 and npm are required." >&2
  echo "  Debian/Ubuntu: sudo apt install nodejs npm" >&2
  echo "  or: https://nodejs.org" >&2
  exit 1
fi
if ! command -v mpv >/dev/null 2>&1 && ! command -v aplay >/dev/null 2>&1; then
  echo "error: no audio player found (install mpv for best results, or alsa-utils for aplay)." >&2
  exit 1
fi
if ! command -v mpv >/dev/null 2>&1; then
  echo "warning: mpv not found — playback will fall back to aplay (no pause/seek)." >&2
fi
if ! command -v wl-paste >/dev/null 2>&1 && ! command -v xclip >/dev/null 2>&1 && ! command -v xsel >/dev/null 2>&1; then
  echo "warning: no clipboard tool found (wl-paste/xclip/xsel) — the clipboard hotkey won't work." >&2
fi

# --- Install ----------------------------------------------------------------
if command -v sayit >/dev/null 2>&1; then
  echo "Stopping any running sayit service…"
  sayit service stop >/dev/null 2>&1 || true
fi

sh "$SRC/scripts/setup-sidecar.sh"

if [ "$SYSTEMD" = yes ]; then
  if systemctl --user daemon-reload >/dev/null 2>&1; then
    mkdir -p "$HOME/.config/systemd/user"
    cp "$SRC/scripts/sayit.service" "$HOME/.config/systemd/user/sayit.service"
    systemctl --user daemon-reload
    if systemctl --user enable --now sayit; then
      echo "Autostart enabled (systemd --user unit)."
    else
      echo "warning: could not enable the systemd unit — start the service manually with: sayit service start" >&2
    fi
  else
    echo "warning: systemd user session not available — skipping autostart." >&2
  fi
else
  sayit service start
fi

# --- Summary ----------------------------------------------------------------
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "warning: ~/.local/bin is not on your PATH — add it, then reopen your terminal." >&2 ;;
esac

echo
echo "Say It installed."
echo "  service: ~/.local/share/sayit/sidecar"
echo "  command: $(command -v sayit)"
echo "Test it with:  sayit \"Hello from Say It\""
echo "Status:        sayit service status"
