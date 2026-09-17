#!/bin/bash
# Release lifecycle for the LOCAL (Mac) half of a desktop release — event-driven, no polling.
#
# Updates come from GitHub Releases (electron-updater `github` provider). Windows builds in CI
# (release-desktop-win.yml), started by this script, and uploads its assets to the draft
# release. Mac can't cross-compile, so this script owns the Mac half of the SAME release:
#   1. builds the Mac app (skip with --no-build if release/ is already current),
#   2. starts the Windows CI build (workflow_dispatch — NO tag is pushed; publishing creates it)
#      and WAITS for it via `gh run watch`, which streams the run's status and blocks until it
#      completes (nonzero exit on failure). No poll loop.
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
# Releases are cut from main: CI builds main's head and the published tag lands on it.
[ "$(git branch --show-current)" = "main" ] || { echo "FATAL: releases are cut from main (on '$(git branch --show-current)')"; exit 1; }
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

# The commit this release is cut from. main goes up first (CI checks this sha out, and the workflow
# file itself is read from main); the TAG IS NOT PUSHED — GitHub's releases.atom lists bare tags, so
# a tag pushed up front makes every beta client chase a manifest that isn't public yet. Publishing
# the draft (the last step) creates the tag, so tag + release + files appear together.
git push origin main
SHA=$(git rev-parse main)

# Create the release as a DRAFT targeting that commit. Idempotent (re-runs reuse/retarget it).
node scripts/release-assets.mjs ensure-draft "$TAG" "$SHA"

# Start the Windows CI build — unless a previous run of this script already got the Windows files
# into the draft (its manifest goes up last, so its presence means the Windows half is complete).
case "$VER" in *-beta*) WIN_YML="beta.yml" ;; *) WIN_YML="latest.yml" ;; esac
RID=""
if node scripts/release-assets.mjs has "$TAG" "$WIN_YML"; then
  echo "Windows files already in the draft — not rebuilding"
  NEED_CI=0
else
  NEED_CI=1
  T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  gh workflow run release-desktop-win.yml --repo "$REPO" --ref main -f tag="$TAG" -f sha="$SHA"
fi

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

if [ "$NEED_CI" = 1 ]; then
  # Find the run we just dispatched (named after the tag, created after T0). Brief retry only to
  # let the run register; the actual wait is event-driven below.
  echo "locating Windows CI run for $TAG ..."
  for _ in $(seq 1 30); do
    RID=$(gh run list --repo "$REPO" --workflow=release-desktop-win.yml --event workflow_dispatch --limit 20 \
          --json databaseId,displayTitle,createdAt \
          -q "map(select(.displayTitle==\"Windows build $TAG\" and .createdAt>=\"$T0\")) | .[0].databaseId // empty" 2>/dev/null || true)
    [ -n "$RID" ] && break
    sleep 4
  done
  [ -n "$RID" ] || { echo "no Windows CI run found for $TAG — did the dispatch fail?"; exit 1; }

  # Event-driven wait: streams status, blocks until the run finishes, exits nonzero if it failed.
  echo "watching Windows CI run $RID (blocks until it finishes) ..."
  gh run watch "$RID" --repo "$REPO" --exit-status --interval 10
fi

# CI has put the Windows assets in the draft; add the Mac assets (manifest last, retried, each
# checked against GitHub's own sha256), then the single go-live flip with verify + auto-rollback.
node scripts/release-assets.mjs upload "$TAG" "${FILES[@]}"
node scripts/release-assets.mjs publish "$TAG"
# Publishing created the tag on GitHub; bring it home and confirm it points at what we built.
git fetch -q origin "refs/tags/$TAG:refs/tags/$TAG"
[ "$(git rev-parse "$TAG^{commit}")" = "$SHA" ] || { echo "WARNING: tag $TAG is not at $SHA"; exit 1; }
echo "release $TAG is live on both platforms"
