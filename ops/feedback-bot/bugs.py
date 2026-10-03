"""The owner's side of the bug-report inbox. Runs on shazam, through sshshazambom (stdlib only):

    sudo python3 ops/feedback-bot/bugs.py list [--state new|triaged|open|resolved|closed|all] [--kind bugs|ideas|feedback]
    sudo python3 ops/feedback-bot/bugs.py act <report> triage|resolve|close

`list` prints JSON: the reports and posts the bot tied to a forum thread (state.json's posts), newest
first, with their status (no status file yet = "new"). `act` never touches a report: it drops an action
file in inbox/actions/ for the bot — the inbox's only writer — to apply on its next minute (the
thread reply is a fixed text; see bot.REPLY). Used by the triage-bugs skill and ops/bugs.sh. `--kind ideas` /
`feedback` lists the word-only forums' posts instead (ideas/<threadId>, feedback/<threadId>; ops/ideas.sh); those
can only be marked seen ("triage"), since resolve / close reply in the thread with a bug-report text.
"""
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

INBOX = Path(os.environ.get("FEEDBACK_INBOX", "/home/shazam/shazam-poe2-dashboard/feedback-inbox"))
ACTIONS = ("triage", "resolve", "close")
STATES = {"new": {"new"}, "triaged": {"triaged"}, "open": {"new", "triaged"}, "resolved": {"resolved"},
          "closed": {"closed"}, "all": {"new", "triaged", "resolved", "closed"}}
BOT_UID = 10001
TEXT_KINDS = ("ideas", "feedback")          # the bot's TEXT_FORUMS folders


def _kind(rel: str) -> str:
    head = rel.split("/", 1)[0]
    return head if head in TEXT_KINDS else "bugs"


def _json(p: Path) -> dict:
    try:
        return json.loads(p.read_text())
    except (OSError, ValueError):
        return {}


def _posts(inbox: Path) -> dict[str, int]:
    return {v["dir"]: int(tid) for tid, v in (_json(inbox / "state.json").get("posts") or {}).items()}


def listing(inbox: Path, state: str = "open", kind: str = "bugs") -> list[dict]:
    want = STATES[state]
    rows = []
    for rel, tid in _posts(inbox).items():
        if _kind(rel) != kind:
            continue
        d = inbox / rel
        st = _json(d / "status.json").get("state") or "new"
        if st not in want:
            continue
        post, man = _json(d / "discord.json"), _json(d / "report.json").get("manifest") or {}
        msgs = post.get("messages", [])
        first = next((m for m in msgs if m.get("from") == "reporter"), {})
        row = {"report": rel, "thread": tid, "state": st, "title": post.get("title", ""), "text": first.get("text", "")[:300]}
        if kind == "bugs":
            row.update({"at": man.get("ts"), "version": man.get("appVersion"), "platform": man.get("platform"),
                        "channel": man.get("channel"), "has_report": (d / "report.json").is_file()})
        else:
            row.update({"at": first.get("at"), "replies": max(0, len(msgs) - 1)})
        rows.append(row)
    return sorted(rows, key=lambda r: -r["thread"])


def act(inbox: Path, report: str, action: str) -> Path:
    if action not in ACTIONS or report not in _posts(inbox) or (_kind(report) != "bugs" and action != "triage"):
        raise ValueError(f"unknown report or action: {report!r} {action!r}")
    adir = inbox / "actions"
    adir.mkdir(exist_ok=True)
    path = adir / f"{time.time_ns()}-{report.replace('/', '_')}.json"
    path.write_text(json.dumps({"report": report, "action": action}))
    for p in (adir, path):                      # the bot (uid 10001) consumes the file
        try:
            os.chown(p, BOT_UID, -1)
        except PermissionError:
            pass
    return path


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--inbox", type=Path, default=INBOX)
    sub = ap.add_subparsers(dest="cmd", required=True)
    ls = sub.add_parser("list")
    ls.add_argument("--state", choices=sorted(STATES), default="open")
    ls.add_argument("--kind", choices=("bugs", *TEXT_KINDS), default="bugs")
    a = sub.add_parser("act")
    a.add_argument("report")
    a.add_argument("action", choices=ACTIONS)
    args = ap.parse_args(argv)
    if args.cmd == "list":
        print(json.dumps(listing(args.inbox, args.state, args.kind), ensure_ascii=False, indent=1))
    else:
        print(act(args.inbox, args.report, args.action))


if __name__ == "__main__":
    main()
