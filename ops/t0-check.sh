#!/bin/bash
# Refuse a STABLE desktop release while the beta line of that version has a T0 blocker on the
# beta telemetry log (a full-sync fallback reported by a client: seed failed, unseeded, digest
# cold start, league full crawl, empty mod tables — backend/app/devtelemetry.py T0_KINDS).
# Called by desktop/publish-github.sh for stable versions. Fails CLOSED: no log, no ssh → no ship.
#
#   ops/t0-check.sh <x.y.z>   # 0 = clear AND validated by a healthy beta client; 2 = blockers; 1 = not validated / could not check
set -uo pipefail
VER="${1:?x.y.z}"
HOST="${SHAZAM_HOST:-shazam@192.168.1.250}"
LOG="${SHAZAM_INSTALL_LOG:-/home/shazam/shazam-poe2-dashboard/data/install-reports.log}"
XYZ="${VER%%-*}"
REPO="${GH_REPO:-Shazambom/shazam-poe2-dashboard}"
# Only events since the latest beta of this line went live count: an earlier beta's blocker that
# a later beta fixed must not block forever. No beta at all → nothing on the beta channel was
# validated → refuse (owner rule: every stable release follows a beta push).
SINCE=$(gh release list --repo "$REPO" --limit 50 --json tagName,publishedAt,isPrerelease \
  -q "[.[] | select(.isPrerelease and (.tagName | startswith(\"$XYZ-beta\")))] | sort_by(.publishedAt) | last | .publishedAt" 2>/dev/null)
[ -n "$SINCE" ] && [ "$SINCE" != "null" ] || { echo "T0 check: no $XYZ-beta.N release found; a stable release needs a beta first"; exit 1; }
SINCE_FMT=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$SINCE" "+%Y-%m-%d %H:%M:%S" 2>/dev/null || date -u -d "$SINCE" "+%Y-%m-%d %H:%M:%S")
scp -q "$(dirname "$0")/t0-scan.py" "$HOST:/tmp/t0-scan.py" || { echo "T0 check: cannot reach shazam; refusing to ship blind"; exit 1; }
OUT=$(ssh "$HOST" "python3 /tmp/t0-scan.py --log '$LOG' --version '$XYZ' --since '$SINCE_FMT'"); RC=$?
echo "$OUT"
case "$RC" in
  0) echo "T0 check: $XYZ beta line clear and validated by a healthy beta client since $SINCE_FMT" ;;
  2) echo "T0 check: BLOCKED — a beta client reported a full-sync fallback on the $XYZ line since $SINCE_FMT (see above)" ;;
  3) echo "T0 check: NOT VALIDATED — no beta client has reported a healthy seed and mod tables since $SINCE_FMT; silence is not validation" ; RC=1 ;;
  *) echo "T0 check: could not read the telemetry log on shazam; refusing to ship blind" ; RC=1 ;;
esac
exit $RC
