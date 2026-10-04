#!/usr/bin/env bash
# Announce a STABLE release in the Discord #releases channel, tagging @notifier (owner, 2026-10-04). publish-github.sh
# runs both forms:
#   ops/announce.sh check desktop-v<x.y.z> [repo-root]   before anything is pushed: shazam's own copy of the bot's rules
#                                                        accepts these notes (so its bot is deployed and agrees with us)
#   ops/announce.sh desktop-v<x.y.z> [repo-root]         once live: confirm the release (GitHub's Latest; every
#                                                        installer uploaded and downloadable, release-assets.mjs verify),
#                                                        hand the notes to the bot, and wait until it has posted them.
# The notes come from docs/release-notes/<x.y.z>.md (ops/release_notes.py; docs/release-notes/STYLE.md). It exits
# non-zero when the post isn't confirmed, so publish-github.sh warns. The bot never posts a version twice.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MODE=post
[ "${1:-}" = check ] && { MODE=check; shift; }
TAG=${1:-}
ROOT=${2:-"$(dirname "$HERE")"}
REMOTE=${REMOTE:-/home/shazam/shazam-poe2-dashboard}
WAIT_S=${ANNOUNCE_WAIT_S:-10}        # between polls (tests pass 0)
REPO=Shazambom/shazam-poe2-dashboard
BUGS="python3 $REMOTE/ops/feedback-bot/bugs.py --inbox $REMOTE/feedback-inbox"
[[ "$TAG" =~ ^desktop-v([0-9]+\.[0-9]+\.[0-9]+)$ ]] || { echo "not a stable release tag: ${TAG:-none}" >&2; exit 2; }
VER=${BASH_REMATCH[1]}

PAYLOAD=$(python3 "$HERE/release_notes.py" payload "$VER" --root "$ROOT")
B64=$(printf '%s' "$PAYLOAD" | base64 | tr -d '\n')
[[ "$B64" =~ ^[A-Za-z0-9+/=]+$ ]] || { echo "payload encoding failed" >&2; exit 1; }

if [ "$MODE" = check ]; then
  sshshazambom sudo "$BUGS announce --check $B64" >/dev/null \
    || { echo "shazam's feedback bot can't take the $VER announcement: run ./ops/deploy-web.sh bot (it must have this checkout's bot rules)" >&2; exit 1; }
  echo "announcement for $VER: shazam's bot accepts it"
  exit 0
fi

latest=""
for _ in 1 2 3 4 5; do                 # GitHub's Latest pointer can lag the go-live by a moment
  latest=$(gh api "repos/$REPO/releases/latest" -q .tag_name)
  [ "$latest" = "$TAG" ] && break
  sleep "$WAIT_S"
done
[ "$latest" = "$TAG" ] || { echo "not announcing: GitHub's Latest release is $latest, not $TAG" >&2; exit 1; }
node "$ROOT/desktop/scripts/release-assets.mjs" verify "$TAG" --live >/dev/null \
  || { echo "not announcing: $TAG is not confirmed live with every installer downloadable" >&2; exit 1; }

sshshazambom sudo "$BUGS announce $B64" >/dev/null
for _ in $(seq 1 18); do               # the bot posts on its next minute; wait up to ~3 minutes
  if sshshazambom sudo "$BUGS announced $VER" >/dev/null 2>&1; then
    echo "announced $VER: posted in #releases"
    exit 0
  fi
  sleep "$WAIT_S"
done
echo "announcement for $VER queued but not posted yet: check the feedback bot's log (docker compose logs feedback-bot)" >&2
exit 1
