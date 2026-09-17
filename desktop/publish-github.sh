#!/bin/bash
# Release lifecycle for the LOCAL (Mac) half of a desktop release — event-driven, no polling.
#
# Updates come from GitHub Releases (electron-updater `github` provider). Windows builds in CI
# (release-desktop-win.yml) on the desktop-v<ver> tag push and uploads its assets to the
# release. Mac can't cross-compile, so this script owns the Mac half of the SAME release:
#   1. builds the Mac app (skip with --no-build if release/ is already current),
#   2. WAITS for that tag's Windows CI run to finish — via `gh run watch`, which streams the
#      run's status and blocks until it completes (nonzero exit on failure). No poll loop.
#   3. uploads the Mac assets into the release the moment CI is done,
#   4. GOES LIVE in one step: the release is a DRAFT (invisible to every client, never "Latest")
#      until both platforms' files are verified present; only then is it published, re-checked
#      through the public URLs, and re-drafted automatically if that check fails.
#      All of 3-4 is scripts/release-assets.mjs — the same tool Windows CI uploads with.
#
# Usage: cd desktop && ./publish-github.sh [--no-build]
set -euo pipefail
cd "$(dirname "$0")"
REPO="Shazambom/shazam-poe2-dashboard"
VER=$(node -p "require('./package.json').version")

# EE2 QUERY PORT SYNC — refresh desktop/src/vendor/ee2-query from EE2's latest release tag, snapshot
# GGG's trade data, regenerate the goldens with EE2's own code (docs/trading-workspace-roadmap.md §8).
# Network is required to release anyway; a failing step aborts. The refreshed vendor/data/goldens are
# part of the release commit (review the golden diff `git diff --stat test/goldens/ee2-query`).
node scripts/sync-ee2.mjs ${EE2_TAG:+--tag "$EE2_TAG"}
git add -A src/vendor/ee2-query test/goldens/ee2-query
git diff --cached --quiet || git commit -q -m "chore(ee2-query): sync vendored EE2 port for $VER" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"

# TEST GATE — runs before anything remote (tag push, CI trigger, upload). A red test aborts
# the release here; GitHub Actions never sees it (owner directive: tests gate the deploy
# scripts, not CI).
../ops/run-tests.sh
# Stable tags are `desktop-v<ver>`; BETA tags are the bare semver `<ver>` (e.g. 0.2.54-beta.1).
# Why: electron-updater's GitHub provider parses the TAG as semver on the prerelease/channel path
# (`if (!semver.valid(hrefTag)) continue`), and the `desktop-v` prefix makes every tag invalid →
# "No published versions on GitHub". A bare-semver tag is parseable, so beta clients find it. Stable
# keeps `desktop-v*` because that path resolves via /releases/latest (literal tag match, no semver).
case "$VER" in *-beta*) TAG="$VER" ;; *) TAG="desktop-v${VER}" ;; esac

# Create the release as a DRAFT before the tag push, so the CI run it fires finds the draft and
# uploads into it instead of creating a public release. Idempotent (re-runs reuse what exists).
node scripts/release-assets.mjs ensure-draft "$TAG"

# Tag + push — this is what fires the Windows CI run. Idempotent: if the tag already exists
# (locally or on origin) it is left alone, so re-running after a failed upload is safe.
if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  git tag -a "$TAG" -m "Desktop v${VER}"
fi
git push origin main
git push origin "$TAG"

if [ "${1:-}" != "--no-build" ]; then
  # Pull the CURRENT market snapshot from the market-seed-latest GitHub release before
  # packaging so every release bundles a fresh seed (Windows CI pulls the same asset).
  # fetch-seed.sh fails hard if the download or the gz is bad — better a failed build than a
  # seedless ship.
  ./fetch-seed.sh
  npm run dist:mac
fi

# electron-builder always names the Mac update manifest latest-mac.yml regardless of the version's
# prerelease tag. For a -beta version, rename it to the beta channel file the beta updater fetches —
# so a beta build emits ONLY beta-mac.yml and never disturbs stable's latest-mac.yml.
case "$VER" in *-beta*) [ -f release/latest-mac.yml ] && mv -f release/latest-mac.yml release/beta-mac.yml ;; esac

# Preflight: never publish a seedless build. Confirm the seed the app will bundle exists and
# is a valid gzip, with its version sidecar (the backend reads the sidecar to decide re-seeding).
SEED="market-seed/market-seed.sqlite.gz"
[ -f "$SEED" ] && gzip -t "$SEED" 2>/dev/null || { echo "FATAL: $SEED missing or corrupt — run ./fetch-seed.sh"; exit 1; }
[ -f "$SEED.version" ] || { echo "FATAL: $SEED.version sidecar missing — re-run ./fetch-seed.sh"; exit 1; }
echo "seed OK: v$(cat "$SEED.version") ($(du -h "$SEED" | cut -f1))"

# Mac artifacts electron-builder wrote to release/. The channel manifest the Mac updater reads is
# latest-mac.yml on stable, beta-mac.yml for a -beta version (electron-builder names it by channel).
case "$VER" in *-beta*) MAC_YML="beta-mac.yml" ;; *) MAC_YML="latest-mac.yml" ;; esac
FILES=(
  "release/Arbiter-${VER}-arm64.dmg"
  "release/Arbiter-${VER}-arm64.dmg.blockmap"
  "release/Arbiter-${VER}-arm64-mac.zip"
  "release/Arbiter-${VER}-arm64-mac.zip.blockmap"
  "release/${MAC_YML}"
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

# CI has put the Windows assets in the draft; add the Mac assets (manifest last, retried, each
# checked against GitHub's own sha256), then the single go-live flip with verify + auto-rollback.
node scripts/release-assets.mjs upload "$TAG" "${FILES[@]}"
node scripts/release-assets.mjs publish "$TAG"
echo "release $TAG is live on both platforms"
