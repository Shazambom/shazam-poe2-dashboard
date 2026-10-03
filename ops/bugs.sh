#!/usr/bin/env bash
# The owner's bug-report commands; the triage-bugs skill (.claude/skills/triage-bugs) drives them.
# Everything on shazam goes through sshshazambom; the inbox's only writer is the feedback bot
# (bugs.py drops action files it applies within a minute; thread replies are fixed texts).
#
#   ops/bugs.sh list [new|triaged|open|resolved|closed|all]   # JSON, newest first (default: new)
#   ops/bugs.sh pull <report> <dest-dir>                      # copy one report folder here
#   ops/bugs.sh triage|resolve|close <report>                 # ask the bot to set it
#   ops/bugs.sh resolve-merged [ref]                          # resolve every open report a commit on
#                                                             # <ref> (default main) names: "Fixes-Report: <id>"
set -euo pipefail
REMOTE=${REMOTE:-/home/shazam/shazam-poe2-dashboard}
CLI="python3 $REMOTE/ops/feedback-bot/bugs.py --inbox $REMOTE/feedback-inbox"
ID_RE='^([0-9A-HJ-NP-Z]{6}(-[0-9]+)?|posts/[0-9]+)$'   # a report folder, never anything a shell would read

check_id() { [[ "$1" =~ $ID_RE ]] || { echo "not a report id: $1" >&2; exit 2; }; }

cmd=${1:-}; shift || true
case "$cmd" in
  list)
    state=${1:-new}
    [[ "$state" =~ ^(new|triaged|open|resolved|closed|all)$ ]] || { echo "unknown state: $state" >&2; exit 2; }
    sshshazambom sudo "$CLI list --state $state" ;;
  pull)
    check_id "$1"; mkdir -p "$2"
    sshshazambom sudo "tar czf - -C $REMOTE/feedback-inbox $1" | tar xzf - -C "$2"
    echo "$2/$1" ;;
  triage|resolve|close)
    check_id "$1"
    sshshazambom sudo "$CLI act $1 $cmd" ;;
  resolve-merged)
    ref=${1:-main}
    git rev-parse --verify -q "$ref" >/dev/null || { echo "no such ref: $ref" >&2; exit 2; }
    for r in $(sshshazambom sudo "$CLI list --state open" | python3 -c 'import json,sys; [print(r["report"]) for r in json.load(sys.stdin)]'); do
      check_id "$r"
      if [ -n "$(git log "$ref" -F --grep "Fixes-Report: $r" --format=%h)" ]; then
        sshshazambom sudo "$CLI act $r resolve" >/dev/null && echo "resolved $r"
      fi
    done ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
