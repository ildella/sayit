#!/bin/sh
# Build latest.json for tauri-plugin-updater from a signed AppImage + .sig.
set -eu

tag="$1"
repo="${2:-ildella/sayit}"
bundle="${3:-src-tauri/target/release/bundle/appimage}"
out="${4:-latest.json}"

appimage=$(ls "$bundle"/*.AppImage | head -n 1)
sig=$(ls "$bundle"/*.AppImage.sig | head -n 1)
name=$(basename "$appimage")
version=$(node -p "require('./src-tauri/tauri.conf.json').version")
pub_date=$(date -u +%Y-%m-%dT%H:%M:%SZ)
notes=$(git log -1 --pretty=%s)
url="https://github.com/${repo}/releases/download/${tag}/${name}"
signature=$(cat "$sig")

node -e '
const [version, notes, pub_date, url, signature] = process.argv.slice(1);
process.stdout.write(JSON.stringify({
  version,
  notes,
  pub_date,
  platforms: { "linux-x86_64": { url, signature } },
}, null, 2) + "\n");
' "$version" "$notes" "$pub_date" "$url" "$signature" > "$out"

echo "wrote $out for $name ($version)"
