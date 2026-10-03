"""ops/ideas.sh — the owner's commands for the word-only forums (#feature-ideas, #feedback); the
pull-ideas and pull-feedback skills drive them, through sshshazambom like ops/bugs.sh. It lists, pulls and
marks posts seen; it never resolves, closes or replies, and post ids are checked before they reach a
remote shell."""
import json
import subprocess
from pathlib import Path

from test_bugs_cli import with_ideas
from test_bugs_sh import actions, env_for

ROOT = Path(__file__).resolve().parents[3]
SH = ROOT / "ops" / "ideas.sh"


def ideas_env(tmp_path):
    env, remote = env_for(tmp_path)
    (remote / "feedback-inbox").rename(tmp_path / "bugs-only")
    with_ideas(tmp_path).rename(remote / "feedback-inbox")
    return env, remote


def sh(env, *a, check=True):
    return subprocess.run(["bash", str(SH), *a], env=env, capture_output=True, text=True, check=check)


def test_list_defaults_to_new_ideas_and_takes_feedback(tmp_path):
    env, _ = ideas_env(tmp_path)
    assert [r["report"] for r in json.loads(sh(env, "list").stdout)] == ["ideas/20"]
    assert [r["report"] for r in json.loads(sh(env, "list", "feedback", "all").stdout)] == ["feedback/21"]


def test_pull_copies_the_post_and_seen_asks_the_bot(tmp_path):
    env, remote = ideas_env(tmp_path)
    dest = tmp_path / "pulled"
    sh(env, "pull", "ideas/20", str(dest))
    assert json.loads((dest / "ideas" / "20" / "discord.json").read_text())["title"] == "Include/Exclude items"
    sh(env, "seen", "ideas/20")
    assert actions(remote) == [json.dumps({"action": "triage", "report": "ideas/20"}, sort_keys=True)]


def test_ids_and_kinds_are_checked_and_there_is_no_resolve_or_close(tmp_path):
    env, remote = ideas_env(tmp_path)
    for args in (("seen", "posts/9"), ("seen", "ideas/20;id"), ("pull", "../x", str(tmp_path)), ("list", "bugs"),
                 ("list", "ideas", "resolved"), ("close", "ideas/20"), ("resolve", "ideas/20")):
        assert sh(env, *args, check=False).returncode != 0, args
    assert actions(remote) == []
