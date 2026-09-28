#!/bin/bash
# Pull the EE2 item texts and built history search URLs (desktop/src/dev-ee2-telemetry.js) out of
# shazam's install log into local files to work with:
#
#   ./ops/pull-ee2-items.sh            # → desktop/test/fixtures/ee2/live/NNN-<origin>.txt (item texts)
#                                      #   desktop/test/fixtures/ee2/live/queries.txt (one search URL per line)
#
# live/ is gitignored; copy what you want into fixtures/ee2/items.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${SHAZAM_HOST:-shazam@192.168.1.250}"
LOG="${SHAZAM_INSTALL_LOG:-/home/shazam/shazam-poe2-dashboard/data/install-reports.log}"
OUT="$ROOT/desktop/test/fixtures/ee2/live"
mkdir -p "$OUT"
ssh "$HOST" "cat '$LOG'" | python3 - "$OUT" <<'EOF'
import re, sys, pathlib
out = pathlib.Path(sys.argv[1])
log = sys.stdin.read()
# The server files every POST as "===== <stamp> from <client> =====\n<body>"; the body starts with
# telemetry.js's "v<version> <platform> " prefix, then the diagnostic's own first line.
blocks = re.split(r"^===== (.+?) =====\n", log, flags=re.M)
items, queries, seen = [], [], set()
for i in range(1, len(blocks) - 1, 2):
    stamp, body = blocks[i], blocks[i + 1]
    m = re.match(r"v(\S+) (\S+) origin=(\S+)(?: name=\"([^\"]*)\")?\n(.*)", body, re.S)
    if not m:
        continue
    version, platform, origin, name, rest = m.groups()
    rest = rest.rstrip("\n")
    if rest.startswith("Item Class:") or "\nRarity:" in rest[:200]:
        if rest in seen:
            continue
        seen.add(rest)
        items.append((stamp, origin, rest))
    elif rest.startswith("http"):
        queries.append(f"{stamp}\t{origin}\t{name or ''}\t{rest}")
for n, (stamp, origin, text) in enumerate(items, 1):
    (out / f"{n:03d}-{origin}.txt").write_text(text + "\n", encoding="utf-8")
(out / "queries.txt").write_text("\n".join(queries) + ("\n" if queries else ""), encoding="utf-8")
print(f"{len(items)} item text(s), {len(queries)} search URL(s) → {out}")
EOF
