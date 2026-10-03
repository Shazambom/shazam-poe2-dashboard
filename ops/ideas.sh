#!/usr/bin/env bash
# The owner's commands for the Discord #feature-ideas and #feedback forums; the pull-ideas and pull-feedback
# skills (.claude/skills) drive them. The feedback bot keeps those posts as words only (title + thread
# messages + status) under feedback-inbox/{ideas,feedback}/<threadId>/; everything on shazam goes through
# sshshazambom, and the bot stays the inbox's only writer. Nothing here replies in Discord.
#
#   ops/ideas.sh list [ideas|feedback] [new|triaged|all]   # JSON, newest first (default: ideas new)
#   ops/ideas.sh pull <post> <dest-dir>                    # copy one post folder here (<dest>/<post>)
#   ops/ideas.sh seen <post>                               # mark it read (status "triaged"); it leaves "new"
set -euo pipefail
REMOTE=${REMOTE:-/home/shazam/shazam-poe2-dashboard}
CLI="python3 $REMOTE/ops/feedback-bot/bugs.py --inbox $REMOTE/feedback-inbox"
ID_RE='^(ideas|feedback)/[0-9]+$'   # a post folder, never anything a shell would read

check_id() { [[ "$1" =~ $ID_RE ]] || { echo "not an idea or feedback post: $1" >&2; exit 2; }; }

cmd=${1:-}; shift || true
case "$cmd" in
  list)
    kind=${1:-ideas}; state=${2:-new}
    [[ "$kind" =~ ^(ideas|feedback)$ ]] || { echo "unknown forum: $kind" >&2; exit 2; }
    [[ "$state" =~ ^(new|triaged|all)$ ]] || { echo "unknown state: $state" >&2; exit 2; }
    sshshazambom sudo "$CLI list --kind $kind --state $state" ;;
  pull)
    check_id "$1"; mkdir -p "$2"
    sshshazambom sudo "tar czf - -C $REMOTE/feedback-inbox $1" | tar xzf - -C "$2"
    echo "$2/$1" ;;
  seen)
    check_id "$1"
    sshshazambom sudo "$CLI act $1 triage" ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
