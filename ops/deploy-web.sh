#!/bin/bash
# Deploy to the WEB TEST ENV on shazam (staging — this is NOT shipping; see CLAUDE.md
# "Web vs desktop"). Runs the full test gate first; a red test aborts before any rsync.
#
#   ./ops/deploy-web.sh              # tests → rsync backend/app + frontend/src → rebuild both
#   ./ops/deploy-web.sh backend      # ... rebuild only the backend container
#   ./ops/deploy-web.sh frontend     # ... rebuild only the frontend container
#   ./ops/deploy-web.sh ops          # also sync ops/ (publisher + exporter) to shazam's ~/bin
#
# shazam is not in the docker group, so the rebuild goes through the sshshazambom wrapper with
# `sudo bash -c` (it only roots the first program otherwise).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
HOST="${SHAZAM_HOST:-shazam@192.168.1.250}"
REMOTE="${SHAZAM_REPO:-/home/shazam/shazam-poe2-dashboard}"
WHAT="${1:-all}"

./ops/run-tests.sh

case "$WHAT" in
  all|backend)
    rsync -az --delete --exclude='__pycache__' backend/app/ "$HOST:$REMOTE/backend/app/"
    rsync -az --delete --exclude='__pycache__' backend/sidecar/ "$HOST:$REMOTE/backend/sidecar/" ;;
esac
case "$WHAT" in
  all|frontend)
    rsync -az --delete --exclude='node_modules' --exclude='dist' frontend/src/ "$HOST:$REMOTE/frontend/src/"
    rsync -az frontend/nginx.conf "$HOST:$REMOTE/frontend/nginx.conf" ;;
esac
case "$WHAT" in
  ops)
    rsync -az ops/publish-market-snapshot.sh ops/export-market-snapshot.py ops/upload-seed-github.sh "$HOST:bin/"
    echo "ops scripts synced to $HOST:~/bin"; exit 0 ;;
esac

SERVICES="backend frontend"
[ "$WHAT" = backend ] && SERVICES="backend"
[ "$WHAT" = frontend ] && SERVICES="frontend"
sshshazambom sudo bash -c "'cd $REMOTE && docker compose up -d --build $SERVICES'"
echo "deployed to web test env ($SERVICES)"
