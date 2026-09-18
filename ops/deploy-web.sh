#!/bin/bash
# Deploy to the WEB TEST ENV on shazam (staging — this is NOT shipping; see CLAUDE.md
# "Web vs desktop"). Runs the full test gate first; a red test aborts before any rsync.
#
#   ./ops/deploy-web.sh              # tests → rsync backend/app + frontend/src → rebuild both
#   ./ops/deploy-web.sh backend      # ... rebuild only the backend container
#   ./ops/deploy-web.sh frontend     # ... rebuild only the frontend container
#   ./ops/deploy-web.sh ops          # also sync ops/ (publisher + exporter) to shazam's ~/bin
#   ./ops/deploy-web.sh bot          # the feedback listener + opener cell (docs/dev-notes.md → Feedback reports)
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
rsync -az docker-compose.yml "$HOST:$REMOTE/docker-compose.yml"
case "$WHAT" in
  bot)
    # The opener always; the Discord listener only once its token exists on the box (until then it
    # would just restart-loop). Keys: docs/dev-notes.md → "Feedback reports".
    rsync -az --delete --exclude='__pycache__' --exclude='tests' ops/feedback-bot/ "$HOST:$REMOTE/ops/feedback-bot/"
    # The inbox is a bind mount the bot (uid 10001) writes and the owner reads on the host.
    sshshazambom sudo bash -c "'mkdir -p $REMOTE/feedback-inbox && chown 10001 $REMOTE/feedback-inbox'"
    SERVICES="feedback-opener"
    ssh "$HOST" test -s /etc/arbiter/discord-token && SERVICES="feedback-opener feedback-bot"
    sshshazambom sudo bash -c "'cd $REMOTE && docker compose build $SERVICES && docker compose up -d $SERVICES'"
    echo "deployed: $SERVICES"; exit 0 ;;
  ops)
    rsync -az ops/publish-market-snapshot.sh ops/export-market-snapshot.py ops/upload-seed-github.sh "$HOST:bin/"
    echo "ops scripts synced to $HOST:~/bin"; exit 0 ;;
esac

SERVICES="backend frontend"
[ "$WHAT" = backend ] && SERVICES="backend"
[ "$WHAT" = frontend ] && SERVICES="frontend"
sshshazambom sudo bash -c "'cd $REMOTE && docker compose up -d --build $SERVICES'"
echo "deployed to web test env ($SERVICES)"
