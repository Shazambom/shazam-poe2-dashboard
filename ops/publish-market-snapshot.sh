#!/bin/bash
# Runs ON shazam (root cron, HOURLY — see docs/release-runbook.md "Seed"). Exports a fresh
# market snapshot from the live market.sqlite and publishes it to the `market-seed-latest`
# GitHub release — the ONE seed channel both desktop builds pull from (Windows CI and the Mac
# `fetch-seed.sh`). There is no LAN /downloads copy any more: if the GitHub upload cannot
# happen, this script FAILS (nonzero) so a frozen seed is loud, never silent.
#
# Install:
#   ./ops/deploy-web.sh ops        # syncs this + the exporter + the uploader to shazam:~/bin
#   crontab (root):  17 * * * * /home/shazam/bin/publish-market-snapshot.sh >> /home/shazam/poe2-snapshot.log 2>&1
#
# Every current league ships only the days the server's seed poll verified final for every tracked
# item (app/seedready.py; docs/bugs/2026-09-28-partial-sync-data.md). The first run of a UTC day
# always publishes; later runs publish only when a league has verified a newer day (poe2scout caught
# up), and otherwise exit quietly. A publish is recorded only after its upload succeeds, so a failed
# upload is retried the next hour.
#   token: ops/refresh-gh-token.sh places ~/.poe2-gh-token (contents: write on the repo)
set -euo pipefail

REPO="${SEED_REPO:-/home/shazam/shazam-poe2-dashboard}"
CONTAINER="${SEED_CONTAINER:-shazam-poe2-dashboard-backend-1}"
EXPORT_PY="$(dirname "$0")/export-market-snapshot.py"
UPLOADER="${SEED_UPLOADER:-$(dirname "$0")/upload-seed-github.sh}"
OUT="$REPO/data/market-seed.sqlite.gz"
PUBLISHED="$REPO/data/market-seed.published-cut"   # the .cut of the last seed that reached GitHub

echo "=== $(date -u +%FT%TZ) publish-market-snapshot ==="

# Rebuild the mod-pool tables on the day's first publish only (backend/app/modpool.py: the RePoE
# PoE2 export + ~100 poe2db pages → mod_pools / mod_currencies), so the seed carries this patch's
# pools without the hourly runs re-reading poe2db. A failed rebuild keeps the previous tables.
if ! grep -q "\"date\": \"$(date -u +%F)\"" "$PUBLISHED" 2>/dev/null; then
  sudo docker exec -i "$CONTAINER" python -m app.modpool --force \
    || echo "WARN: mod pool refresh failed; the seed carries the previous mod tables"
fi

# Export inside the backend container: it has the live DB at /data, python, and the app
# package (cwd=/app) the exporter imports its data policy from. Piping the script over stdin
# keeps it decoupled from the image. Exit 3 = nothing newer than today's published seed.
set +e
sudo docker exec -i "$CONTAINER" python - \
  --src /data/market.sqlite --out /data/market-seed.sqlite.gz \
  --only-if-newer /data/market-seed.published-cut < "$EXPORT_PY"
rc=$?
set -e
[ "$rc" -eq 3 ] && { echo "no newer verified day; nothing to publish"; exit 0; }
[ "$rc" -eq 0 ] || { echo "FATAL: exporter failed (exit $rc)"; exit "$rc"; }
[ -f "$OUT" ] && [ -f "$OUT.version" ] && [ -f "$OUT.cut" ] || { echo "FATAL: exporter produced no $OUT(.version/.cut)"; exit 1; }
echo "exported v$(cat "$OUT.version") ($(du -h "$OUT" | cut -f1))"

# Publish to the GitHub release asset. Uses the REST API directly (no gh CLI on shazam). The
# token lives in ~/.poe2-gh-token (placed by ops/refresh-gh-token.sh, chmod 600, never committed).
export GH_REPO="${GH_REPO:-Shazambom/shazam-poe2-dashboard}"
if [ -z "${GH_TOKEN:-}" ] && [ -r "/home/shazam/.poe2-gh-token" ]; then
  GH_TOKEN="$(cat "/home/shazam/.poe2-gh-token")"; export GH_TOKEN
fi
[ -n "${GH_TOKEN:-}" ] || { echo "FATAL: no GitHub token — run ops/refresh-gh-token.sh to place ~/.poe2-gh-token"; exit 1; }
"$UPLOADER" "$OUT" "$OUT.version"
cp "$OUT.cut" "$PUBLISHED"
echo "published v$(cat "$OUT.version") via $(basename "$UPLOADER")"
