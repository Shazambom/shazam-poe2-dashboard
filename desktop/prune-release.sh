#!/bin/bash
# Delete the Mac installers of every version except the one just released.
#
#   ./prune-release.sh <version> [release-dir]     # release-dir defaults to ./release beside this script
#
# desktop/release/ kept every .dmg and .zip ever built (160 versions filled the disk). publish-github.sh
# runs this once a release is live. It removes only Arbiter-<other version>-arm64.dmg, -arm64-mac.zip and
# their .blockmap files directly inside the release directory: never the version given, never the update
# manifests, never mac-arm64/ (the app the owner launches), never a Windows file.
set -euo pipefail

if [[ $# -lt 1 || -z ${1} ]]; then
  echo "usage: prune-release.sh <version> [release-dir]" >&2
  exit 2
fi
VER="$1"
DIR="${2:-$(cd "$(dirname "$0")" && pwd)/release}"

if [[ ! -d ${DIR} ]]; then
  echo "prune-release: ${DIR} is not a directory" >&2
  exit 1
fi
# A wrong version would match nothing and so delete every installer: only prune around a version that is there.
if [[ ! -f "${DIR}/Arbiter-${VER}-arm64.dmg" ]]; then
  echo "prune-release: Arbiter-${VER}-arm64.dmg is not in ${DIR}; nothing removed" >&2
  exit 1
fi

removed=0
for file in "${DIR}"/Arbiter-*-arm64.dmg "${DIR}"/Arbiter-*-arm64.dmg.blockmap \
  "${DIR}"/Arbiter-*-arm64-mac.zip "${DIR}"/Arbiter-*-arm64-mac.zip.blockmap; do
  if [[ ! -f ${file} ]]; then
    continue
  fi
  case "$(basename "${file}")" in
    "Arbiter-${VER}-arm64.dmg" | "Arbiter-${VER}-arm64.dmg.blockmap" | \
      "Arbiter-${VER}-arm64-mac.zip" | "Arbiter-${VER}-arm64-mac.zip.blockmap") ;;
    *)
      rm -f -- "${file}"
      removed=$((removed + 1))
      ;;
  esac
done

if [[ ${removed} -eq 0 ]]; then
  echo "prune-release: no old Mac installers in ${DIR}"
else
  echo "prune-release: removed ${removed} old Mac installer file(s) from ${DIR}, kept ${VER}"
fi
