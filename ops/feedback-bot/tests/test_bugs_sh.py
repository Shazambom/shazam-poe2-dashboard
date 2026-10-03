"""ops/bugs.sh — the owner's bug commands (the triage-bugs skill drives them; everything on shazam goes
through sshshazambom). `resolve-merged` resolves exactly the open reports a commit on the merged ref
names with a `Fixes-Report: <id>` trailer; report ids are checked before they reach a remote shell."""
import json
import os
import shutil
import stat
import subprocess
from pathlib import Path

from test_bugs_cli import inbox

ROOT = Path(__file__).resolve().parents[3]
SH = ROOT / "ops" / "bugs.sh"


def env_for(tmp_path):
    remote = tmp_path / "remote"
    (remote / "ops" / "feedback-bot").mkdir(parents=True)
    shutil.copy(ROOT / "ops" / "feedback-bot" / "bugs.py", remote / "ops" / "feedback-bot" / "bugs.py")
    shutil.move(str(inbox(tmp_path)), remote / "feedback-inbox")
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    fake = bin_ / "sshshazambom"                       # runs the command here, as shazam would
    fake.write_text('#!/usr/bin/env bash\n[ "$1" = sudo ] && shift\nexec bash -c "$*"\n')
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    return {**os.environ, "PATH": f"{bin_}:{os.environ['PATH']}", "REMOTE": str(remote)}, remote


def git(repo, *a):
    subprocess.run(["git", "-C", str(repo), *a], check=True, capture_output=True,
                   env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"})


def test_resolve_merged_resolves_only_the_reports_a_merged_commit_names(tmp_path):
    env, remote = env_for(tmp_path)
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "commit", "-q", "--allow-empty", "-m", "fix hold cache\n\nFixes-Report: BBBBBB")
    git(repo, "checkout", "-q", "-b", "wip")
    git(repo, "commit", "-q", "--allow-empty", "-m", "not merged yet\n\nFixes-Report: posts/9")
    out = subprocess.run(["bash", str(SH), "resolve-merged", "main"], cwd=repo, env=env, capture_output=True, text=True, check=True).stdout
    acts = [json.loads(p.read_text()) for p in (remote / "feedback-inbox" / "actions").glob("*.json")]
    assert acts == [{"report": "BBBBBB", "action": "resolve"}] and "BBBBBB" in out


def test_list_pull_and_act(tmp_path):
    env, remote = env_for(tmp_path)
    run = lambda *a: subprocess.run(["bash", str(SH), *a], env=env, capture_output=True, text=True, check=True).stdout
    assert [r["report"] for r in json.loads(run("list"))] == ["BBBBBB"], "new reports by default"
    dest = tmp_path / "pulled"
    run("pull", "BBBBBB", str(dest))
    assert (dest / "BBBBBB" / "discord.json").is_file()
    run("close", "posts/9")
    assert [json.loads(p.read_text()) for p in (remote / "feedback-inbox" / "actions").glob("*.json")] == [{"report": "posts/9", "action": "close"}]


def test_a_report_id_that_is_not_one_never_reaches_the_remote_shell(tmp_path):
    env, remote = env_for(tmp_path)
    for bad in ("BBBBBB; touch PWNED", "../etc", "bbbbbb", "posts/x"):
        r = subprocess.run(["bash", str(SH), "resolve", bad], env=env, capture_output=True, text=True, cwd=tmp_path)
        assert r.returncode != 0, bad
    assert not (tmp_path / "PWNED").exists() and not (remote / "feedback-inbox" / "actions").exists()
