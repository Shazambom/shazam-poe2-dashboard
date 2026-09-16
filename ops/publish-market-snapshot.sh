#!/bin/bash
# Runs ON shazam (root cron, daily — see docs/release-runbook.md "Seed"). Exports a fresh
# market snapshot from the live market.sqlite and publishes it to the `market-seed-latest`
# GitHub release — the ONE seed channel both desktop builds pull from (Windows CI and the Mac
# `fetch-seed.sh`). There is no LAN /downloads copy any more: if the GitHub upload cannot
# happen, this script FAILS (nonzero) so a frozen seed is loud, never silent.
#
# Install:
#   ./ops/deploy-web.sh ops        # syncs this + the exporter + the uploader to shazam:~/bin
#   crontab (root):  17 4 * * * /home/shazam/bin/publish-market-snapshot.sh >> /home/shazam/poe2-snapshot.log 2>&1
#   token: ops/refresh-gh-token.sh places ~/.poe2-gh-token (contents: write on the repo)
set -euo pipefail

REPO=/home/shazam/shazam-poe2-dashboard
CONTAINER=shazam-poe2-dashboard-backend-1
EXPORT_PY="$(dirname "$0")/export-market-snapshot.py"
OUT="$REPO/data/market-seed.sqlite.gz"

echo "=== $(date -u +%FT%TZ) publish-market-snapshot ==="

# Export inside the backend container: it has the live DB at /data, python, and the app
# package (cwd=/app) the exporter imports its data policy from. Piping the script over stdin
# keeps it decoupled from the image.
sudo docker exec -i "$CONTAINER" python - \
  --src /data/market.sqlite --out /data/market-seed.sqlite.gz < "$EXPORT_PY"
[ -f "$OUT" ] && [ -f "$OUT.version" ] || { echo "FATAL: exporter produced no $OUT(.version)"; exit 1; }
echo "exported v$(cat "$OUT.version") ($(du -h "$OUT" | cut -f1))"

# Publish to the GitHub release asset. Uses the REST API directly (no gh CLI on shazam). The
# token lives in ~/.poe2-gh-token (placed by ops/refresh-gh-token.sh, chmod 600, never committed).
export GH_REPO="${GH_REPO:-Shazambom/shazam-poe2-dashboard}"
if [ -z "${GH_TOKEN:-}" ] && [ -r "/home/shazam/.poe2-gh-token" ]; then
  GH_TOKEN="$(cat "/home/shazam/.poe2-gh-token")"; export GH_TOKEN
fi
[ -n "${GH_TOKEN:-}" ] || { echo "FATAL: no GitHub token — run ops/refresh-gh-token.sh to place ~/.poe2-gh-token"; exit 1; }
"$(dirname "$0")/upload-seed-github.sh" "$OUT" "$OUT.version"
echo "published v$(cat "$OUT.version") to GitHub release market-seed-latest"
