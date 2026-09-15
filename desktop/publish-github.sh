#!/bin/bash
# Release lifecycle for the LOCAL (Mac) half of a desktop release — event-driven, no polling.
#
# Updates come from GitHub Releases (electron-updater `github` provider). Windows builds in CI
# (release-desktop-win.yml) on the desktop-v<ver> tag push and uploads its assets to the
# release. Mac can't cross-compile, so this script owns the Mac half of the SAME release:
#   1. builds the Mac app (skip with --no-build if release/ is already current),
#   2. WAITS for that tag's Windows CI run to finish — via `gh run watch`, which streams the
#      run's status and blocks until it completes (nonzero exit on failure). No poll loop.
#   3. uploads the Mac assets into the release the moment CI is done.
#
# Usage: cd desktop && ./publish-github.sh [--no-build]
set -euo pipefail
cd "$(dirname "$0")"
REPO="Shazambom/shazam-poe2-dashboard"
VER=$(node -p "require('./package.json').version")
TAG="desktop-v${VER}"

if [ "${1:-}" != "--no-build" ]; then
  # shazam is the seed build-server for the Mac half: pull the CURRENT market snapshot from
  # its /downloads before packaging so every release bundles a fresh seed (Windows CI pulls
  # the same snapshot from the market-seed-latest GitHub release). fetch-seed.sh fails hard
  # if shazam is unreachable or the gz is corrupt — better a failed build than a seedless ship.
  ./fetch-seed.sh
  npm run dist:mac
fi

# Preflight: never publish a seedless build. Confirm the seed the app will bundle exists and
# is a valid gzip, with its version sidecar (the backend reads the sidecar to decide re-seeding).
SEED="market-seed/market-seed.sqlite.gz"
[ -f "$SEED" ] && gzip -t "$SEED" 2>/dev/null || { echo "FATAL: $SEED missing or corrupt — run ./fetch-seed.sh"; exit 1; }
[ -f "$SEED.version" ] || { echo "FATAL: $SEED.version sidecar missing — re-run ./fetch-seed.sh"; exit 1; }
echo "seed OK: v$(cat "$SEED.version") ($(du -h "$SEED" | cut -f1))"

# Mac artifacts electron-builder wrote to release/. latest-mac.yml is what the updater reads.
FILES=(
  "release/Arbiter-${VER}-arm64.dmg"
  "release/Arbiter-${VER}-arm64.dmg.blockmap"
  "release/Arbiter-${VER}-arm64-mac.zip"
  "release/Arbiter-${VER}-arm64-mac.zip.blockmap"
  "release/latest-mac.yml"
)
for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "missing $f — run 'npm run dist:mac' first (or drop --no-build)"; exit 1; }
done

# Find the Windows CI run for this tag. A tag-triggered run reports the tag as its headBranch.
# Brief retry only to let the run register after the tag push — this locates the run id; the
# actual wait is event-driven below.
echo "locating Windows CI run for $TAG ..."
RID=""
for _ in $(seq 1 30); do
  RID=$(gh run list --repo "$REPO" --workflow=release-desktop-win.yml --limit 20 \
        --json databaseId,headBranch,event \
        -q "map(select(.headBranch==\"$TAG\")) | .[0].databaseId // empty" 2>/dev/null || true)
  [ -n "$RID" ] && break
  sleep 4
done
[ -n "$RID" ] || { echo "no Windows CI run found for $TAG — was the tag pushed?"; exit 1; }

# Event-driven wait: streams status, blocks until the run finishes, exits nonzero if it failed.
echo "watching Windows CI run $RID (blocks until it finishes) ..."
gh run watch "$RID" --repo "$REPO" --exit-status --interval 10

# CI has created the release with the Windows assets; drop the Mac assets into the same release.
gh release upload "$TAG" "${FILES[@]}" --repo "$REPO" --clobber
echo "published Mac artifacts to GitHub release $TAG"
