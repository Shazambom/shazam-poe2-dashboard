#!/bin/bash
# Upload the market seed to the GitHub release `market-seed-latest` so Windows CI (which
# can't reach the LAN) can download it during a desktop build. No gh CLI needed — uses the
# REST API with curl. Run from the Mac (before a Windows release) or from shazam's cron.
#
# Requires:
#   GH_TOKEN  — a PAT / fine-grained token with `contents: write` on the repo
#   GH_REPO   — owner/name (e.g. Shazambom/shazam-poe2-dashboard)
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
rel_body=$(mktemp)
trap 'rm -f "$rel_body"' EXIT
code=$(curl -sS -o "$rel_body" -w '%{http_code}' "${AUTH[@]}" "$API/releases/tags/$TAG")
if [ "$code" = "200" ]; then
  rid=$(python3 -c 'import json, sys; print(json.load(sys.stdin).get("id", ""))' < "$rel_body")
elif [ "$code" = "404" ]; then
  rel=$(curl -fsS "${AUTH[@]}" -X POST "$API/releases" \
    -d "{\"tag_name\":\"$TAG\",\"name\":\"Market seed (rolling)\",\"body\":\"Prebuilt market snapshot bundled into desktop builds. Auto-updated.\",\"prerelease\":true}")
  rid=$(printf '%s' "$rel" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("id", ""))')
else
  echo "GitHub release lookup failed (HTTP $code)" >&2
  cat "$rel_body" >&2
  exit 1
fi
[ -n "$rid" ] || {
  echo "could not resolve release id for $TAG"
  exit 1
}

for f in "$@"; do
  name=$(basename "$f")
  # Delete an existing asset of the same name (assets are immutable otherwise). Parse the
  # JSON with python — GitHub returns compact JSON (no space after ':'), which defeats a
  # grep/sed match and would leave the old asset in place → 422 on re-upload.
  existing=$(curl -fsS "${AUTH[@]}" "$API/releases/$rid/assets" \
    | python3 -c 'import json, sys; print(next((str(a["id"]) for a in json.load(sys.stdin) if a["name"] == sys.argv[1]), ""))' "$name")
  if [ -n "$existing" ]; then
    curl -fsS "${AUTH[@]}" -X DELETE "$API/releases/assets/$existing" > /dev/null
  fi
  echo "uploading $name ..."
  curl -fsS "${AUTH[@]}" -H "Content-Type: application/octet-stream" \
    --data-binary @"$f" "$UP/releases/$rid/assets?name=$name" > /dev/null
done
echo "done: uploaded $# asset(s) to $GH_REPO release $TAG"
