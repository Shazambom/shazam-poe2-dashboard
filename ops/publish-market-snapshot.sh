#!/bin/bash
# Runs ON shazam (cron, daily). Exports a fresh market snapshot from the live dashboard
# DB and publishes it to /downloads so Mac local builds (and, via a token, the GitHub
# release asset for Windows CI) start fresh installs with a full history instead of a slow
# cold crawl. See docs/db-architecture.md + docs/db-maintenance.md.
#
# Install:
#   scp ops/publish-market-snapshot.sh ops/export-market-snapshot.py shazam:~/bin/
#   crontab -e ->  17 4 * * * /home/shazam/bin/publish-market-snapshot.sh >> /home/shazam/poe2-snapshot.log 2>&1
set -euo pipefail

REPO=/home/shazam/shazam-poe2-dashboard
CONTAINER=shazam-poe2-dashboard-backend-1
DOWNLOADS="$REPO/downloads"
EXPORT_PY="$(dirname "$0")/export-market-snapshot.py"

echo "=== $(date -u +%FT%TZ) publish-market-snapshot ==="

# Export inside the backend container (it has the live DB at /data + python). Piping the
# script over stdin keeps it decoupled from the image.
sudo docker exec -i "$CONTAINER" python - \
  --src /data/market.sqlite --out /data/market-seed.sqlite.gz < "$EXPORT_PY"

# Move into the nginx-served /downloads (host path is mounted read-only into the frontend
# container, but the files live on the host, so write them here).
sudo cp "$REPO/data/market-seed.sqlite.gz"          "$DOWNLOADS/"
sudo cp "$REPO/data/market-seed.sqlite.gz.version"  "$DOWNLOADS/"
sudo chown shazam:shazam "$DOWNLOADS/market-seed.sqlite.gz" "$DOWNLOADS/market-seed.sqlite.gz.version"
echo "published to $DOWNLOADS (v$(cat "$DOWNLOADS/market-seed.sqlite.gz.version"))"

# Publish to the GitHub release asset for Windows CI (which can't reach the LAN). Uses the
# REST API directly (no gh CLI on shazam). The token lives in ~/.poe2-gh-token (placed by
# ops/refresh-gh-token.sh, chmod 600, never committed); GH_REPO defaults to this repo.
export GH_REPO="${GH_REPO:-Shazambom/shazam-poe2-dashboard}"
if [ -z "${GH_TOKEN:-}" ] && [ -r "/home/shazam/.poe2-gh-token" ]; then
  GH_TOKEN="$(cat "/home/shazam/.poe2-gh-token")"; export GH_TOKEN
fi
if [ -n "${GH_TOKEN:-}" ] && [ -n "${GH_REPO:-}" ]; then
  "$(dirname "$0")/upload-seed-github.sh" "$DOWNLOADS/market-seed.sqlite.gz" "$DOWNLOADS/market-seed.sqlite.gz.version" \
    && echo "uploaded to GitHub release market-seed-latest" \
    || echo "WARN: GitHub asset upload failed (Mac builds still work from /downloads)"
else
  echo "skip GitHub asset upload — no token. Run ops/refresh-gh-token.sh to place ~/.poe2-gh-token."
fi
