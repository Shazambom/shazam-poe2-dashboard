#!/bin/bash
# Upload the market seed to the GitHub release `market-seed-latest` so Windows CI (which
# can't reach the LAN) can download it during a desktop build. No gh CLI needed — uses the
# REST API with curl. Run from the Mac (before a Windows release) or from shazam's cron.
#
# Requires:
#   GH_TOKEN  — a PAT / fine-grained token with `contents: write` on the repo
#   GH_REPO   — owner/name (e.g. ianmoreno/shazam-poe2-dashboard)
#
# Usage: GH_TOKEN=... GH_REPO=owner/name ./upload-seed-github.sh <seed.gz> [<seed.gz.version>]
set -euo pipefail
: "${GH_TOKEN:?set GH_TOKEN}"
: "${GH_REPO:?set GH_REPO (owner/name)}"
TAG=market-seed-latest
API="https://api.github.com/repos/$GH_REPO"
UP="https://uploads.github.com/repos/$GH_REPO"
AUTH=(-H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json")

# Ensure the release exists (create if missing). It's a rolling, non-source release.
rel=$(curl -fsS "${AUTH[@]}" "$API/releases/tags/$TAG" 2>/dev/null || true)
rid=$(printf '%s' "$rel" | sed -n 's/.*"id": *\([0-9]\+\).*/\1/p' | head -1)
if [ -z "$rid" ]; then
  rel=$(curl -fsS "${AUTH[@]}" -X POST "$API/releases" \
    -d "{\"tag_name\":\"$TAG\",\"name\":\"Market seed (rolling)\",\"body\":\"Prebuilt market snapshot bundled into desktop builds. Auto-updated.\",\"prerelease\":true}")
  rid=$(printf '%s' "$rel" | sed -n 's/.*"id": *\([0-9]\+\).*/\1/p' | head -1)
fi
[ -n "$rid" ] || { echo "could not resolve release id for $TAG"; exit 1; }

for f in "$@"; do
  name=$(basename "$f")
  # Delete an existing asset of the same name (assets are immutable otherwise).
  existing=$(curl -fsS "${AUTH[@]}" "$API/releases/$rid/assets" | \
    tr '}' '\n' | grep -F "\"name\": \"$name\"" -A0 | sed -n 's/.*"id": *\([0-9]\+\).*/\1/p' | head -1 || true)
  [ -n "$existing" ] && curl -fsS "${AUTH[@]}" -X DELETE "$API/releases/assets/$existing" >/dev/null || true
  echo "uploading $name ..."
  curl -fsS "${AUTH[@]}" -H "Content-Type: application/octet-stream" \
    --data-binary @"$f" "$UP/releases/$rid/assets?name=$name" >/dev/null
done
echo "done: uploaded $# asset(s) to $GH_REPO release $TAG"
