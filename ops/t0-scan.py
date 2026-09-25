#!/usr/bin/env python3
"""Classify T0 blockers from the beta telemetry log.

Clients on the beta channel report a full-sync fallback as one line, `[T0]: <kind>: <msg>`
(backend/app/devtelemetry.py). This reads shazam's install log, groups those lines by version,
platform and kind, and answers the release question: does the beta line of version x.y.z have a
T0 event since the last beta went live? The stable publisher refuses to ship while it does
(desktop/publish-github.sh → ops/t0-check.sh). No Discord, no new channel: the log is the channel.

    python3 ops/t0-scan.py --log data/install-reports.log                     # summary, JSON
    python3 ops/t0-scan.py --log ... --version 0.3.6 [--since "2026-09-25 19:30:00"]
      # exit 2: a blocker on that line; 3: no blocker but no healthy beta client reported either; 0: validated
"""
from __future__ import annotations

import argparse
import json
import re
import sys

_HEADER = re.compile(r"^===== (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) from (\S+) =====")
_T0 = re.compile(r"^v(\S+) (\S+) (?:frozen=\S+ )?\[T0\]: ([a-z-]+): (.*)$")
# The seed step's pre-T0 failure line (0.3.6-beta.2): the same event, classified the same way.
_LEGACY_SEED_FAILED = re.compile(r"^v(\S+) (\S+) (?:frozen=\S+ )?\[seed\]: FAILED \((.*)$")
# A healthy startup: the seed left mod tables. Positive evidence a beta build works on a client.
_MODS = re.compile(r"^v(\S+) (\S+) (?:frozen=\S+ )?\[mods\]: snapshot v(-?\d+) pools=(\d+)")


def parse(lines) -> list[dict]:
    """Every T0 line with the time and client of the report header above it."""
    events, at, client = [], None, None
    for raw in lines:
        line = raw.rstrip("\n")
        h = _HEADER.match(line)
        if h:
            at, client = h.group(1), h.group(2)
            continue
        m = _T0.match(line)
        if m:
            events.append({"at": at, "client": client, "version": m.group(1), "platform": m.group(2), "kind": m.group(3), "msg": m.group(4)})
            continue
        m = _LEGACY_SEED_FAILED.match(line)
        if m:
            events.append({"at": at, "client": client, "version": m.group(1), "platform": m.group(2), "kind": "seed-failed", "msg": m.group(3)})
            continue
        m = _MODS.match(line)
        if m:
            events.append({"at": at, "client": client, "version": m.group(1), "platform": m.group(2), "kind": "ok" if int(m.group(4)) > 0 else "mods-empty",
                           "msg": f"snapshot v{m.group(3)} pools={m.group(4)}"})
    return events


def summarize(events: list[dict]) -> dict:
    """version → platform → kind → {count, first, last, sample} (blockers only)."""
    out: dict = {}
    for e in events:
        if e["kind"] == "ok":
            continue
        slot = out.setdefault(e["version"], {}).setdefault(e["platform"], {}).setdefault(e["kind"], {"count": 0, "first": e["at"], "last": e["at"], "sample": e["msg"]})
        slot["count"] += 1
        slot["last"] = e["at"]
    return out


def blockers(events: list[dict], xyz: str, since: str | None = None) -> list[tuple]:
    """The (version, platform, kind) triples on version x.y.z's line (its betas and itself) at or
    after `since`, deduplicated in order of appearance."""
    seen, out = set(), []
    for e in events:
        if e["kind"] == "ok" or not (e["version"] == xyz or e["version"].startswith(xyz + "-")):
            continue
        if since and (e["at"] or "") < since:
            continue
        key = (e["version"], e["platform"], e["kind"])
        if key not in seen:
            seen.add(key)
            out.append(key)
    return out


def validated(events: list[dict], xyz: str, since: str | None = None) -> list[tuple]:
    """The (version, platform, at) of healthy startups on version x.y.z's line at or after
    `since`: a client that seeded and holds mod tables. Silence is not validation."""
    return [(e["version"], e["platform"], e["at"]) for e in events
            if e["kind"] == "ok" and (e["version"] == xyz or e["version"].startswith(xyz + "-")) and not (since and (e["at"] or "") < since)]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", required=True)
    ap.add_argument("--version", help="x.y.z: report and exit 2 on blockers for that line")
    ap.add_argument("--since", help='"YYYY-MM-DD HH:MM:SS": only events at or after this count')
    args = ap.parse_args(argv)
    with open(args.log, encoding="utf-8", errors="replace") as f:
        events = parse(f)
    if not args.version:
        print(json.dumps(summarize(events), indent=1))
        return 0
    found = blockers(events, args.version, args.since)
    ok = validated(events, args.version, args.since)
    print(json.dumps({"version": args.version, "since": args.since, "blockers": [list(b) for b in found], "validated_by": [list(v) for v in ok],
                      "detail": {f"{v} {p}": summarize([e for e in events if e["version"] == v and e["platform"] == p])[v][p] for v, p, _ in found}}, indent=1))
    # 2: a blocker; 3: no blocker but no healthy beta client either (silence is not validation).
    return 2 if found else (0 if ok else 3)


if __name__ == "__main__":
    sys.exit(main())
