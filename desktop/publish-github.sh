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

# REGRESSION GATE (owner, 2026-09-30) — also before anything remote. The last stable version and this
# code run on the same snapshot of the owner's data; every difference in what users see (prices, busiest
# markets, price cards, Market, Hold, exchange-only loops, the Arbitrage pool, Convert) must be accepted
# for THIS version in ops/regression-accept.txt, or the release stops. Fails closed without the data.
# 0.3.8-beta.1/2 passed every test and moved 17 prices by up to 4300%; this is what would have caught it.
python3 ../ops/regression-diff.py --version "$VER" --accept ../ops/regression-accept.txt \
  || { echo "FATAL: regression diff: an unaccepted difference (or no data to compare); not publishing $VER"; exit 1; }
# Stable tags are `desktop-v<ver>`; BETA tags are the bare semver `<ver>` (e.g. 0.2.54-beta.1).
# Why: electron-updater's GitHub provider parses the TAG as semver on the prerelease/channel path
# (`if (!semver.valid(hrefTag)) continue`), and the `desktop-v` prefix makes every tag invalid →
# "No published versions on GitHub". A bare-semver tag is parseable, so beta clients find it. Stable
# keeps `desktop-v*` because that path resolves via /releases/latest (literal tag match, no semver).
case "$VER" in *-beta*) TAG="$VER" ;; *) TAG="desktop-v${VER}" ;; esac

# T0 gate (owner directive 2026-09-25): a full-sync fallback reported on the beta channel is a hard
# blocker for stable. ops/t0-check.sh reads shazam's beta telemetry log for this version's beta line
# and fails closed. Betas themselves are not gated: they are how the blockers get found.
case "$VER" in *-beta*) ;; *) ../ops/t0-check.sh "$VER" || { echo "FATAL: T0 blocker on the beta line of $VER (or the check could not run); not shipping stable"; exit 1; } ;; esac
# A stable release is announced in Discord #releases once live: its patch notes must exist and fit the owner's
# format now, before anything is pushed (docs/release-notes/<x.y.z>.md, docs/release-notes/STYLE.md).
case "$VER" in *-beta*) ;; *) python3 ../ops/release_notes.py check "$VER" || { echo "FATAL: no good release notes for $VER (docs/release-notes/$VER.md); not shipping stable"; exit 1; } ;; esac
# ...committed exactly as they will be announced (the release commit carries them)...
case "$VER" in *-beta*) ;; *) { (cd .. && git ls-files --error-unmatch "docs/release-notes/$VER.md" >/dev/null 2>&1 && git diff --quiet HEAD -- "docs/release-notes/$VER.md"); } || { echo "FATAL: commit docs/release-notes/$VER.md first (the release carries the notes it announces)"; exit 1; } ;; esac
# ...and accepted by shazam's own feedback bot, so it is deployed with these rules (else: ./ops/deploy-web.sh bot).
case "$VER" in *-beta*) ;; *) ../ops/announce.sh check "desktop-v$VER" || { echo "FATAL: shazam's feedback bot can't announce $VER; not shipping stable"; exit 1; } ;; esac

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
  # `gh workflow run` prints the new run's URL; its id is the last path segment.
  RID=$(gh workflow run release-desktop-win.yml --repo "$REPO" --ref main -f tag="$TAG" -f sha="$SHA" \
        | grep -oE 'actions/runs/[0-9]+' | grep -oE '[0-9]+$' | tail -1 || true)
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
  # Fallback if gh printed no URL: the newest unfinished run named after this tag. (No timestamp
  # filter — this Mac's clock was 4 min ahead of GitHub's and "created after T0" matched nothing.)
  [ -n "$RID" ] || echo "locating Windows CI run for $TAG ..."
  for _ in $(seq 1 30); do
    [ -n "$RID" ] && break
    RID=$(gh run list --repo "$REPO" --workflow=release-desktop-win.yml --event workflow_dispatch --limit 20 \
          --json databaseId,displayTitle,status \
          -q "map(select(.displayTitle==\"Windows build $TAG\" and .status!=\"completed\")) | .[0].databaseId // empty" 2>/dev/null || true)
    [ -n "$RID" ] || sleep 4
  done
  [ -n "$RID" ] || { echo "no Windows CI run found for $TAG — did the dispatch fail?"; exit 1; }

  # Event-driven wait: streams status, blocks until the run finishes, exits nonzero if it failed.
  echo "watching Windows CI run $RID (blocks until it finishes) ..."
  gh run watch "$RID" --repo "$REPO" --exit-status --interval 10
fi

# Never publish a seedless Windows build (0.3.12-beta.2 did): the run that built the draft's Windows files
# must show fetch-seed.sh's check. On a re-run that reused those files, find that run by its title. The log
# is saved before it is searched: piping it straight into grep -q fails under pipefail on the match itself.
[ -n "$RID" ] || RID=$(gh run list --repo "$REPO" --workflow=release-desktop-win.yml --limit 20 \
      --json databaseId,displayTitle,conclusion \
      -q "map(select(.displayTitle==\"Windows build $TAG\" and .conclusion==\"success\")) | .[0].databaseId // empty")
[ -n "$RID" ] || { echo "FATAL: no successful Windows CI run found for $TAG to check its market snapshot"; exit 1; }
CILOG=$(mktemp)
gh run view "$RID" --repo "$REPO" --log > "$CILOG"
grep -q 'seed ready (' "$CILOG" \
  || { echo "FATAL: Windows CI run $RID bundled no checked market snapshot (no 'seed ready' in its log)"; exit 1; }
echo "Windows CI run $RID bundled a checked market snapshot"

# CI has put the Windows assets in the draft; add the Mac assets (manifest last, retried, each
# checked against GitHub's own sha256), then the single go-live flip with verify + auto-rollback.
node scripts/release-assets.mjs upload "$TAG" "${FILES[@]}"
node scripts/release-assets.mjs publish "$TAG"
# Publishing created the tag on GitHub; bring it home and confirm it points at what we built.
git fetch -q origin "refs/tags/$TAG:refs/tags/$TAG"
[ "$(git rev-parse "$TAG^{commit}")" = "$SHA" ] || { echo "WARNING: tag $TAG is not at $SHA"; exit 1; }
echo "release $TAG is live on both platforms"

# A STABLE release resolves the bug reports its commits fix ("Fixes-Report: <id>"): the bot replies in
# each thread with its fixed "ships in the next update" text. A beta never does — beta is development
# only (owner, 2026-10-03). A failure here never fails the release that is already live.
case "$VER" in *-beta*) ;; *) ../ops/bugs.sh resolve-shipped "$TAG" \
  || echo "WARNING: could not resolve the shipped bug reports; run ops/bugs.sh resolve-shipped $TAG" ;; esac

# A STABLE release is announced in Discord #releases, tagging @notifier, with its patch notes and installers
# (owner, 2026-10-04: "should only fire after confirmed released"; announce.sh confirms it is live again).
# A failure here never fails the release that is already live.
case "$VER" in *-beta*) ;; *) ../ops/announce.sh "$TAG" \
  || echo "WARNING: the release announcement was not sent; run ops/announce.sh $TAG" ;; esac
