#!/bin/bash
# Auto-publish the newest desktop-v* GitHub release into the dashboard /downloads
# channel. Runs on shazam (which can reach both GitHub and the local channel) — GitHub
# cloud runners can't reach this LAN, so shazam PULLS instead of CI pushing.
#
# Name-agnostic: it downloads whatever assets the release has and renames the installer
# from GitHub's dotted asset name (e.g. "Arbiter.Setup.0.2.26.exe") to the spaced name
# latest.yml's `path:` expects ("Arbiter Setup 0.2.26.exe"). Survives product renames.
set -euo pipefail
REPO="Shazambom/shazam-poe2-dashboard"
DL="/home/shazam/shazam-poe2-dashboard/downloads"

rel=$(curl -fsSL "https://api.github.com/repos/$REPO/releases" \
  | python3 -c "import json,sys;rs=json.load(sys.stdin);r=next((x for x in rs if x['tag_name'].startswith('desktop-v')),None);print(json.dumps(r) if r else '')")
[ -n "$rel" ] || { echo "$(date -Is) no desktop release"; exit 0; }
tag=$(printf '%s' "$rel" | python3 -c "import json,sys;print(json.load(sys.stdin)['tag_name'])")
ver="${tag#desktop-v}"
cur=$(grep -E '^version:' "$DL/latest.yml" 2>/dev/null | awk '{print $2}' || echo none)
if [ "$ver" = "$cur" ]; then echo "$(date -Is) already at $ver"; exit 0; fi

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
printf '%s' "$rel" | python3 -c "
import json,sys
for a in json.load(sys.stdin)['assets']: print(a['name']+'\t'+a['browser_download_url'])
" | while IFS=$'\t' read -r name url; do curl -fsSL "$url" -o "$tmp/$name"; done

[ -f "$tmp/latest.yml" ] || { echo "$(date -Is) release has no latest.yml"; exit 1; }
exe=$(grep -E '^path:' "$tmp/latest.yml" | sed 's/^path:[[:space:]]*//')      # spaced name
dotted=$(printf '%s' "$exe" | tr ' ' '.')                                     # GitHub asset name
# Only rename when GitHub actually mangled the name (spaces -> dots). Newer builds use a
# space-free artifactName, so dotted == exe and a self-`mv X X` would fail under `set -e`.
if [ "$dotted" != "$exe" ]; then
  [ -f "$tmp/$dotted" ] && mv -f "$tmp/$dotted" "$tmp/$exe"
  [ -f "$tmp/$dotted.blockmap" ] && mv -f "$tmp/$dotted.blockmap" "$tmp/$exe.blockmap"
fi

sz=$(stat -c%s "$tmp/$exe" 2>/dev/null || echo 0)
[ "$sz" -gt 5000000 ] || { echo "$(date -Is) installer missing/too small ($sz), abort"; exit 1; }

cd "$tmp"
for f in *.exe *.exe.blockmap *.zip latest.yml; do
  [ -e "$f" ] && cp -f "$f" "$DL/$f"
done
echo "$(date -Is) published $ver as '$exe' ($sz bytes)"
