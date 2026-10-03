"""bugs.py — the owner's side of the inbox (run on shazam through sshshazambom; stdlib only). `list`
shows the reports and posts the bot knows (state.json's posts), newest first, with their status
(no status file yet = "new"), title, the reporter's first words and the app's version/platform;
`--state` filters (new, triaged, open = new+triaged, resolved, closed, all). `act` never touches a
report: it drops an action file for the bot (the inbox's only writer) to apply."""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import bugs  # noqa: E402


def inbox(tmp_path):
    ib = tmp_path / "inbox"
    for d, title, state, ts in (("AAAAAA", "Old one", "resolved", "2026-10-01T10:00:00Z"),
                                ("BBBBBB", "Hold empty", None, "2026-10-02T23:52:11Z"),
                                ("posts/9", "No file", "triaged", None)):
        (ib / d).mkdir(parents=True)
        (ib / d / "discord.json").write_text(json.dumps({"title": title, "messages": [{"at": "x", "from": "reporter", "text": f"{title} text " * 50}]}))
        if state:
            (ib / d / "status.json").write_text(json.dumps({"state": state, "at": "t"}))
        if ts:
            (ib / d / "report.json").write_text(json.dumps({"manifest": {"ts": ts, "appVersion": "0.3.9", "platform": "win32", "channel": "stable"}}))
    (ib / "state.json").write_text(json.dumps({"last_thread_id": 9, "posts": {
        "1": {"dir": "AAAAAA", "reporter": 5}, "2": {"dir": "BBBBBB", "reporter": 5}, "9": {"dir": "posts/9", "reporter": 6}}}))
    (ib / "ZZZZZZ").mkdir()                                       # a report the bot never tied to a post: not listed
    return ib


def test_list_open_by_default_newest_first_with_status_and_first_words(tmp_path):
    ib = inbox(tmp_path)
    rows = bugs.listing(ib, "open")
    assert [(r["report"], r["state"]) for r in rows] == [("posts/9", "triaged"), ("BBBBBB", "new")]
    b = rows[1]
    assert (b["thread"], b["title"], b["version"], b["platform"]) == (2, "Hold empty", "0.3.9", "win32")
    assert b["text"].startswith("Hold empty text") and len(b["text"]) <= 300
    assert [r["report"] for r in bugs.listing(ib, "new")] == ["BBBBBB"]
    assert [r["report"] for r in bugs.listing(ib, "resolved")] == ["AAAAAA"]
    assert len(bugs.listing(ib, "all")) == 3


def test_act_drops_an_action_file_for_the_bot(tmp_path):
    ib = inbox(tmp_path)
    path = bugs.act(ib, "BBBBBB", "resolve")
    assert json.loads(path.read_text()) == {"report": "BBBBBB", "action": "resolve"}
    assert path.parent == ib / "actions"
    assert not (ib / "BBBBBB" / "status.json").exists(), "the bot applies it, not bugs.py"


def test_act_refuses_unknown_reports_and_actions(tmp_path):
    ib = inbox(tmp_path)
    for report, action in (("ZZZZZZ", "resolve"), ("BBBBBB", "say"), ("../x", "close")):
        try:
            bugs.act(ib, report, action)
        except ValueError:
            continue
        raise AssertionError(f"accepted {report} {action}")
    assert not (ib / "actions").exists()


def test_the_command_line(tmp_path):
    ib = inbox(tmp_path)
    out = subprocess.run([sys.executable, str(HERE / "bugs.py"), "--inbox", str(ib), "list", "--state", "new"],
                         capture_output=True, text=True, check=True).stdout
    assert [r["report"] for r in json.loads(out)] == ["BBBBBB"]
    subprocess.run([sys.executable, str(HERE / "bugs.py"), "--inbox", str(ib), "act", "BBBBBB", "triage"], check=True, capture_output=True)
    assert len(list((ib / "actions").glob("*.json"))) == 1


def with_ideas(tmp_path):
    """The inbox above plus an idea (with a reply) and a feedback post, as the bot keeps them."""
    ib = inbox(tmp_path)
    st = json.loads((ib / "state.json").read_text())
    for d, tid, title in (("ideas/20", 20, "Include/Exclude items"), ("feedback/21", 21, "Love it")):
        (ib / d).mkdir(parents=True)
        (ib / d / "discord.json").write_text(json.dumps({"title": title, "messages": [
            {"at": "2026-10-03T01:00:00+00:00", "from": "reporter", "text": f"{title} words"},
            {"at": "2026-10-03T02:00:00+00:00", "from": "other", "text": "+1"}]}))
        st["posts"][str(tid)] = {"dir": d, "reporter": 5}
    (ib / "state.json").write_text(json.dumps(st))
    return ib


def test_bug_listings_never_show_idea_or_feedback_posts(tmp_path):
    ib = with_ideas(tmp_path)
    assert {r["report"] for r in bugs.listing(ib, "all")} == {"AAAAAA", "BBBBBB", "posts/9"}


def test_kind_lists_ideas_or_feedback_with_their_first_words_date_and_replies(tmp_path):
    ib = with_ideas(tmp_path)
    [row] = bugs.listing(ib, "new", kind="ideas")
    assert (row["report"], row["thread"], row["title"], row["text"], row["at"], row["replies"]) == (
        "ideas/20", 20, "Include/Exclude items", "Include/Exclude items words", "2026-10-03T01:00:00+00:00", 1)
    assert [r["report"] for r in bugs.listing(ib, "all", kind="feedback")] == ["feedback/21"]


def test_an_idea_can_only_be_marked_seen_never_resolved_or_closed(tmp_path):
    """Resolve / close post a bug-report reply in the thread; an idea's thread gets nothing."""
    ib = with_ideas(tmp_path)
    assert json.loads(bugs.act(ib, "ideas/20", "triage").read_text())["action"] == "triage"
    for action in ("resolve", "close"):
        try:
            bugs.act(ib, "feedback/21", action)
        except ValueError:
            continue
        raise AssertionError(f"accepted {action} on a feedback post")


def test_the_command_line_takes_a_kind(tmp_path):
    ib = with_ideas(tmp_path)
    out = subprocess.run([sys.executable, str(HERE / "bugs.py"), "--inbox", str(ib), "list", "--state", "all", "--kind", "ideas"],
                         capture_output=True, text=True, check=True).stdout
    assert [r["report"] for r in json.loads(out)] == ["ideas/20"]
