#!/bin/bash
# Fetch the bundled market snapshot (seed) for a Mac local build. The seed is the
# disposable market/backfill data (docs/db-architecture.md); bundling it lets a fresh
# install start with a full history instead of a slow cold crawl. Mac builds locally and
# CAN reach the LAN, so we pull straight from shazam's /downloads (Windows CI pulls the
# GitHub release asset instead — see .github/workflows/release-desktop-win.yml).
#
# Run before `electron-builder --mac`. Output: desktop/market-seed/market-seed.sqlite.gz
set -euo pipefail
cd "$(dirname "$0")"

SRC="${SEED_URL:-http://192.168.1.250:8080/downloads/market-seed.sqlite.gz}"
mkdir -p market-seed
echo "fetching seed from $SRC"
curl -fsSL "$SRC" -o market-seed/market-seed.sqlite.gz
curl -fsSL "$SRC.version" -o market-seed/market-seed.sqlite.gz.version
gzip -t market-seed/market-seed.sqlite.gz
echo "seed ready ($(du -h market-seed/market-seed.sqlite.gz | cut -f1), v$(cat market-seed/market-seed.sqlite.gz.version)):"
ls -la market-seed
