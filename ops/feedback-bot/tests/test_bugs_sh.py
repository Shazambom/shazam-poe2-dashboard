"""ops/bugs.sh — the owner's bug commands (the triage-bugs skill drives them; everything on shazam goes
through sshshazambom). `resolve-shipped` resolves exactly the open reports a commit in a STABLE release
(desktop-v<x.y.z>) names with a `Fixes-Report: <id>` trailer — never main, a branch or a beta; report
ids are checked before they reach a remote shell."""
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


def actions(remote):
    d = remote / "feedback-inbox" / "actions"
    return sorted(json.dumps(json.loads(p.read_text()), sort_keys=True) for p in d.glob("*.json")) if d.exists() else []


def repo_with_releases(tmp_path):
    """main: a fix shipped in stable desktop-v1.0.0, a later fix only in beta 1.1.0-beta.1, one only merged."""
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "commit", "-q", "--allow-empty", "-m", "fix hold cache\n\nFixes-Report: BBBBBB")
    git(repo, "tag", "desktop-v1.0.0")
    git(repo, "commit", "-q", "--allow-empty", "-m", "fix sales card\n\nFixes-Report: posts/9")
    git(repo, "tag", "1.1.0-beta.1")
    return repo


def test_only_a_stable_release_resolves_reports(tmp_path):
    """Owner, 2026-10-03: "Only Stable release is allowed to resolve bugs, beta is only for development"."""
    env, remote = env_for(tmp_path)
    repo = repo_with_releases(tmp_path)
    out = subprocess.run(["bash", str(SH), "resolve-shipped"], cwd=repo, env=env, capture_output=True, text=True, check=True).stdout
    assert actions(remote) == [json.dumps({"action": "resolve", "report": "BBBBBB"}, sort_keys=True)]
    assert "BBBBBB" in out and "posts/9" not in out, "a fix that only reached a beta stays open"


def test_main_a_branch_or_a_beta_tag_never_resolves(tmp_path):
    env, remote = env_for(tmp_path)
    repo = repo_with_releases(tmp_path)
    for ref in ("main", "1.1.0-beta.1", "HEAD"):
        r = subprocess.run(["bash", str(SH), "resolve-shipped", ref], cwd=repo, env=env, capture_output=True, text=True)
        assert r.returncode != 0 and "stable" in r.stderr, ref
    r = subprocess.run(["bash", str(SH), "resolve-merged"], cwd=repo, env=env, capture_output=True, text=True)
    assert r.returncode != 0, "resolving on a merge is gone"
    r = subprocess.run(["bash", str(SH), "resolve", "BBBBBB"], cwd=repo, env=env, capture_output=True, text=True)
    assert r.returncode != 0, "no resolving by hand: only a stable release resolves"
    assert actions(remote) == []


def test_publishing_a_stable_release_resolves_its_reports_and_a_beta_does_not():
    src = (ROOT / "desktop" / "publish-github.sh").read_text()
    live = src.index('echo "release $TAG is live on both platforms"')
    call = src.index("bugs.sh resolve-shipped")
    assert call > live, "only once the release is live"
    assert '*-beta*) ;;' in src[src.rindex("case", 0, call):call], "a beta version skips it"


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
        r = subprocess.run(["bash", str(SH), "close", bad], env=env, capture_output=True, text=True, cwd=tmp_path)
        assert r.returncode != 0, bad
    assert not (tmp_path / "PWNED").exists() and not (remote / "feedback-inbox" / "actions").exists()
