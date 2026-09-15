#!/bin/bash
# Publish the locally-built Mac artifacts to the GitHub Release for this version.
#
# Updates now come from GitHub Releases (electron-updater `github` provider). Windows
# ships through CI (release-desktop-win.yml creates/uploads to the desktop-v<ver> tag);
# Mac builds locally (PyInstaller can't cross-compile), so this script uploads the Mac
# dmg/zip/blockmap + latest-mac.yml into the SAME release so both platforms live under
# one tag and GitHub's "Latest release" pointer resolves correctly for the updater.
set -euo pipefail
cd "$(dirname "$0")"

VER=$(node -p "require('./package.json').version")
TAG="desktop-v${VER}"

# Mac artifacts electron-builder wrote to release/. latest-mac.yml is what the updater reads.
FILES=(
  "release/Arbiter-${VER}-arm64.dmg"
  "release/Arbiter-${VER}-arm64.dmg.blockmap"
  "release/Arbiter-${VER}-arm64-mac.zip"
  "release/Arbiter-${VER}-arm64-mac.zip.blockmap"
  "release/latest-mac.yml"
)
for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "missing $f — run 'npm run dist:mac' first"; exit 1; }
done

# The Windows CI usually creates the release first (on the tag push). If it hasn't yet,
# create it here; otherwise just upload (clobbering any prior Mac upload of the same name).
if gh release view "$TAG" >/dev/null 2>&1; then
  gh release upload "$TAG" "${FILES[@]}" --clobber
else
  gh release create "$TAG" "${FILES[@]}" --title "$TAG" --notes "Arbiter ${VER}"
fi
echo "published Mac artifacts to GitHub release $TAG"
