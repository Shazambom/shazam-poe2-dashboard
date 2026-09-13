#!/bin/bash
# Push the freshly built desktop artifacts to the shazam server's /downloads.
# electron-updater reads latest*.yml from there, so pushing a new build is all
# it takes for running apps to see the update.
set -euo pipefail
cd "$(dirname "$0")"
DEST=shazam@192.168.1.250:/home/shazam/shazam-poe2-dashboard/downloads/
ls release/ | grep -E '\.(dmg|zip|exe|blockmap)$|latest.*\.yml' || { echo "nothing built in release/"; exit 1; }
rsync -avz --include='*.dmg' --include='*.zip' --include='*.exe' --include='*.blockmap' \
  --include='latest*.yml' --exclude='*' release/ "$DEST"
echo "published to $DEST"
