#!/bin/bash
# Fetch the bundled market snapshot (seed) for a Mac local build. The seed is the
# disposable market/backfill data (docs/db-architecture.md); bundling it lets a fresh
# install start with a full history instead of a slow cold crawl.
#
# Source of truth is the `market-seed-latest` GitHub release (a rolling prerelease that
# shazam's cron regenerates from the live DB and uploads). Windows CI pulls the SAME asset
# — one seed channel for both platforms. (The old shazam /downloads path is deprecated.)
#
# Run before `electron-builder --mac` (publish-github.sh does this automatically). Needs the
# `gh` CLI authenticated. Output: desktop/market-seed/market-seed.sqlite.gz (+ .version).
set -euo pipefail
cd "$(dirname "$0")"

REPO="${GH_REPO:-Shazambom/shazam-poe2-dashboard}"
SEED=market-seed/market-seed.sqlite.gz
WAIT_S="${FETCH_SEED_WAIT_S:-30}"   # between attempts (tests pass 0)
mkdir -p market-seed
# shazam's cron replaces the asset in place: for a few seconds only the .version sidecar exists (0.3.12-beta.2
# shipped a seedless Windows build from exactly that window). Fetch both together and retry until the
# snapshot itself is there and a valid gzip; fail after ~5 minutes rather than build seedless.
for attempt in $(seq 1 10); do
  echo "fetching seed from GitHub release market-seed-latest ($REPO), attempt $attempt"
  rm -f "$SEED" "$SEED.version"
  gh release download market-seed-latest --repo "$REPO" \
    --pattern 'market-seed.sqlite.gz*' --dir market-seed --clobber || true
  if [ -s "$SEED" ] && [ -s "$SEED.version" ] && gzip -t "$SEED" 2>/dev/null; then
    echo "seed ready ($(du -h "$SEED" | cut -f1), v$(cat "$SEED.version")):"
    ls -la market-seed
    exit 0
  fi
  echo "seed not complete yet (the cron may be replacing it); waiting ${WAIT_S}s"
  sleep "$WAIT_S"
done
echo "FATAL: market-seed-latest has no complete snapshot after 10 attempts" >&2
exit 1
