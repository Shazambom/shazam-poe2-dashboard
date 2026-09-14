#!/bin/bash
# Auto-publish the newest desktop-v* GitHub release into the dashboard /downloads
# channel. Runs on shazam (which can reach both GitHub and the local channel) — GitHub
# cloud runners can't reach this LAN, so shazam PULLS instead of CI pushing.
set -euo pipefail
REPO="Shazambom/shazam-poe2-dashboard"
DL="/home/shazam/shazam-poe2-dashboard/downloads"
tag=$(curl -fsSL "https://api.github.com/repos/$REPO/releases" \
  | python3 -c "import json,sys;rs=json.load(sys.stdin);t=[r['tag_name'] for r in rs if r['tag_name'].startswith('desktop-v')];print(t[0] if t else '')")
[ -n "$tag" ] || { echo "$(date -Is) no desktop release"; exit 0; }
ver="${tag#desktop-v}"
cur=$(grep -E '^version:' "$DL/latest.yml" 2>/dev/null | awk '{print $2}' || echo none)
if [ "$ver" = "$cur" ]; then echo "$(date -Is) already at $ver"; exit 0; fi
base="https://github.com/$REPO/releases/download/$tag"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$base/latest.yml" -o "$tmp/latest.yml"
exe=$(grep -E '^path:' "$tmp/latest.yml" | sed 's/^path:[[:space:]]*//')
curl -fsSL "$base/ShazamDash.Setup.$ver.exe"          -o "$tmp/$exe"
curl -fsSL "$base/ShazamDash.Setup.$ver.exe.blockmap" -o "$tmp/$exe.blockmap"
curl -fsSL "$base/ShazamDash-$ver-win.zip"            -o "$tmp/ShazamDash-$ver-win.zip"
# sanity: a real self-contained installer is tens of MB
sz=$(stat -c%s "$tmp/$exe"); [ "$sz" -gt 5000000 ] || { echo "$(date -Is) exe too small ($sz), abort"; exit 1; }
cp "$tmp/$exe" "$tmp/$exe.blockmap" "$tmp/ShazamDash-$ver-win.zip" "$tmp/latest.yml" "$DL/"
echo "$(date -Is) published $ver ($sz bytes)"
