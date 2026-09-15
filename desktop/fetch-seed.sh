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
mkdir -p market-seed
echo "fetching seed from GitHub release market-seed-latest ($REPO)"
gh release download market-seed-latest --repo "$REPO" \
  --pattern 'market-seed.sqlite.gz*' --dir market-seed --clobber

gzip -t market-seed/market-seed.sqlite.gz
echo "seed ready ($(du -h market-seed/market-seed.sqlite.gz | cut -f1), v$(cat market-seed/market-seed.sqlite.gz.version)):"
ls -la market-seed
