#!/usr/bin/env bash
#
# Publish sayit-bin to the Omarchy Package Repository (OPR).
#
# Renders packaging/omarchy/sayit-bin/ with the released version and the
# .deb sha256, puts it in a clone of the OPR fork (pkgbuilds/sayit-bin/) on a
# branch cut from upstream/master, commits and pushes that branch to the fork.
# It never writes to omacom/omarchy-pkgs: the PR is opened by hand.
#
# Usage:
#   scripts/publish-omarchy.sh [--check] [version]
#
#   --check    verify release, asset and digest, render the recipe and stop
#              (no clone write, no commit, no push)
#   version    without the leading "v"; defaults to package.json
#
# Env overrides:
#   OMARCHY_FORK_DIR     clone location   (default ~/.cache/sayit/omarchy-pkgs)
#   OMARCHY_FORK         fork remote      (default git@github.com:ildella/omarchy-pkgs.git)
#   OMARCHY_UPSTREAM     upstream remote  (default https://github.com/omacom/omarchy-pkgs.git)
#   OMARCHY_PKGS_BRANCH  branch name      (default add-sayit-bin)
#
# See packaging/omarchy/README.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

UPSTREAM_REPO="ildella/sayit"
CHECK_MODE=false
TARGET_VERSION=""
for arg in "$@"; do
  case "$arg" in
    --check|-c) CHECK_MODE=true ;;
    -h|--help)
      sed -n '3,23p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    -*)
      echo "Error: unknown option: $arg" >&2
      exit 1 ;;
    *)
      if [[ -n "$TARGET_VERSION" ]]; then
        echo "Error: unexpected argument: $arg" >&2
        echo "Usage: publish-omarchy.sh [--check] [version]" >&2
        exit 1
      fi
      TARGET_VERSION="${arg#v}"
      ;;
  esac
done

for cmd in gh git curl sha256sum node; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Error: $cmd not installed." >&2; exit 1; }
done
gh auth status >/dev/null 2>&1 || { echo "Error: gh is not authenticated." >&2; exit 1; }

VERSION="${TARGET_VERSION:-$(node -p "require('$REPO_ROOT/package.json').version")}"
TAG="v$VERSION"
ASSET="SayIt_${VERSION}_amd64.deb"
URL="https://github.com/$UPSTREAM_REPO/releases/download/$TAG/$ASSET"

FORK_DIR="${OMARCHY_FORK_DIR:-$HOME/.cache/sayit/omarchy-pkgs}"
FORK_REMOTE="${OMARCHY_FORK:-git@github.com:ildella/omarchy-pkgs.git}"
UPSTREAM_REMOTE="${OMARCHY_UPSTREAM:-https://github.com/omacom/omarchy-pkgs.git}"
BRANCH="${OMARCHY_PKGS_BRANCH:-add-sayit-bin}"
RECIPE_SRC="$REPO_ROOT/packaging/omarchy/sayit-bin"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "[omarchy] Release: $TAG"
echo "[omarchy] Asset:   $ASSET"

# --- 1. The release and its asset must exist --------------------------------
gh release view "$TAG" -R "$UPSTREAM_REPO" >/dev/null 2>&1 \
  || { echo "Error: release $TAG does not exist on $UPSTREAM_REPO." >&2; exit 1; }
gh release view "$TAG" -R "$UPSTREAM_REPO" --json assets --jq '.assets[].name' | grep -qx "$ASSET" \
  || { echo "Error: $ASSET is not on release $TAG." >&2; exit 1; }

# --- 2. Digest from the release API, and an anonymous download --------------
DIGEST="$(gh api "repos/$UPSTREAM_REPO/releases/tags/$TAG" \
  --jq ".assets[] | select(.name==\"$ASSET\") | .digest")"
DIGEST="${DIGEST#sha256:}"
[[ -n "$DIGEST" ]] || { echo "Error: release API has no digest for $ASSET." >&2; exit 1; }

echo "[omarchy] Downloading $ASSET anonymously..."
curl -fsSL "$URL" -o "$WORK_DIR/$ASSET" \
  || { echo "Error: anonymous download failed: $URL" >&2; exit 1; }

MAGIC="$(head -c 7 "$WORK_DIR/$ASSET")"
[[ "$MAGIC" == "!<arch>" ]] \
  || { echo "Error: $ASSET is not an ar archive (magic: '$MAGIC')." >&2; exit 1; }

LOCAL_SHA="$(sha256sum "$WORK_DIR/$ASSET" | awk '{print $1}')"
[[ "$LOCAL_SHA" == "$DIGEST" ]] \
  || { echo "Error: sha256 $LOCAL_SHA does not match the release digest $DIGEST." >&2; exit 1; }
echo "[omarchy] Verified: ar archive, sha256 $LOCAL_SHA (matches the release digest)"

# --- 3. Render the recipe ---------------------------------------------------
STAGE="$WORK_DIR/stage/pkgbuilds/sayit-bin"
mkdir -p "$STAGE/.omarchy"
sed -e "s/__SAYIT_VERSION__/$VERSION/g" \
    -e "s/__SAYIT_DEB_SHA256__/$LOCAL_SHA/g" \
    "$RECIPE_SRC/PKGBUILD" > "$STAGE/PKGBUILD"
cp "$RECIPE_SRC/.omarchy/package.json" "$STAGE/.omarchy/package.json"
echo "[omarchy] Staged pkgbuilds/sayit-bin:"
echo "  PKGBUILD               pkgver=$VERSION sha256=$LOCAL_SHA"
echo "  .omarchy/package.json  github=$UPSTREAM_REPO digests=true"

if [[ "$CHECK_MODE" == "true" ]]; then
  echo "[omarchy] --check: recipe renders, nothing cloned, committed or pushed."
  exit 0
fi

# --- 4. Fork clone, branch off upstream/master ------------------------------
if [[ ! -d "$FORK_DIR/.git" ]]; then
  echo "[omarchy] Cloning the fork into $FORK_DIR..."
  mkdir -p "$(dirname "$FORK_DIR")"
  git clone -q "$FORK_REMOTE" "$FORK_DIR" \
    || { echo "Error: could not clone $FORK_REMOTE." >&2
         echo "       Fork https://github.com/omacom/omarchy-pkgs first, or pass OMARCHY_FORK=<url>." >&2
         exit 1; }
fi
git -C "$FORK_DIR" remote set-url origin "$FORK_REMOTE"
if git -C "$FORK_DIR" remote get-url upstream >/dev/null 2>&1; then
  git -C "$FORK_DIR" remote set-url upstream "$UPSTREAM_REMOTE"
else
  git -C "$FORK_DIR" remote add upstream "$UPSTREAM_REMOTE"
fi
git -C "$FORK_DIR" fetch -q origin
git -C "$FORK_DIR" fetch -q upstream
FORK_OWNER="$(git -C "$FORK_DIR" remote get-url origin \
  | sed -E 's#^(git@github.com:|https://github.com/)##; s#/.*##; s#\.git$##')"

git -C "$FORK_DIR" checkout -q -B "$BRANCH" upstream/master
rm -rf "$FORK_DIR/pkgbuilds/sayit-bin"
cp -a "$STAGE" "$FORK_DIR/pkgbuilds/"
git -C "$FORK_DIR" add -A pkgbuilds/sayit-bin
if git -C "$FORK_DIR" diff --cached --quiet; then
  echo "[omarchy] No recipe changes for $VERSION; branch $BRANCH is already current."
else
  git -C "$FORK_DIR" commit -q -m "sayit-bin $VERSION"
  git -C "$FORK_DIR" push -q --force-with-lease origin "HEAD:refs/heads/$BRANCH"
  echo "[omarchy] Pushed $FORK_OWNER:$BRANCH"
fi

# --- 5. PR body -------------------------------------------------------------
PR_BODY="$FORK_DIR/sayit-bin-pr-body.md"
cat > "$PR_BODY" <<EOF
## Summary

Add \`sayit-bin\`, the [Say It](https://github.com/ildella/sayit) local
text-to-speech app, to the fast ring.

Say It is a private, offline text-to-speech app for Linux (Tauri v2 +
Kokoro-82M via kokoro-js). Text and audio never leave the machine. MIT
licensed. The upstream package already ships everything — desktop binary,
sidecar, the \`sayit\` CLI, \`sayit-clipboard\`, the agent skill and the
licence — so this recipe is a straight re-wrap of the released \`.deb\`
(no compilation, no patches).

## Provenance

- Upstream: \`github: ildella/sayit\`, tag \`$TAG\`
- Asset: \`$ASSET\`
- sha256: \`$LOCAL_SHA\` (matches the release API \`digest\`)
- \`digests: true\`, \`min_release_age: 24h\`, \`release_ring: fast\`
- The upstream maintainer is the package maintainer; \`source=local\` recipe
  maintained from the upstream release pipeline (\`scripts/publish-omarchy.sh\`).

## Validation

<!-- Fill in with the outputs of the self-tests and the local build. -->

- [ ] \`bin/sync-upstream self-test\`
- [ ] \`bin/omarchy-pkgs self-test\`
- [ ] \`bin/repo build --local --dry-run --package sayit-bin\`
- [ ] \`BYPASS_MIN_RELEASE_AGE=1 bin/sync-upstream sayit-bin\` → no update
- [ ] \`makepkg -c\` + \`namcap PKGBUILD sayit-bin-*.pkg.tar.zst\` (clean Arch)
- [ ] \`makepkg -si\` on Omarchy: launcher, Speak, \`sayit --help\`
EOF

echo
echo "[omarchy] Recipe for $VERSION is on $FORK_OWNER:$BRANCH; PR body at $PR_BODY."
echo "[omarchy] Next, in the clone:"
echo
echo "  cd \"$FORK_DIR\""
echo "  bin/sync-upstream self-test"
echo "  bin/omarchy-pkgs self-test"
echo "  bin/repo build --local --dry-run --package sayit-bin"
echo "  BYPASS_MIN_RELEASE_AGE=1 bin/sync-upstream sayit-bin   # expect: no update"
echo
echo "Then edit sayit-bin-pr-body.md with the results and open the PR:"
echo
echo "  gh pr create --repo omacom/omarchy-pkgs --base master --head $FORK_OWNER:$BRANCH \\"
echo "    --title 'Add sayit-bin, the Say It local text-to-speech app, to the fast ring' \\"
echo "    --body-file $PR_BODY"
