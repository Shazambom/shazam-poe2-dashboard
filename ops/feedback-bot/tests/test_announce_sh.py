"""ops/announce.sh — a stable release's announcement, from the publish script's side.

    ops/announce.sh check desktop-v<x.y.z>   before anything is pushed: shazam's own bot rules accept these
                                             notes (so its bot is deployed and agrees with this checkout)
    ops/announce.sh desktop-v<x.y.z>         once live: confirm the release (GitHub's Latest, every installer
                                             uploaded and downloadable), hand the notes to the bot, and wait
                                             until the bot has posted them

Owner, 2026-10-04: "should only fire after confirmed released". The payload travels base64-encoded, so nothing
from the notes reaches a remote shell raw."""
import base64
import json
import os
import shutil
import stat
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SH = ROOT / "ops" / "announce.sh"
NOTES = "# 1.2.3\n\nFaster stash. Cleaner sales.\n\n- Stash loads faster\n- Sales list tidied\n"


def exe(path: Path, body: str):
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


def setup(tmp_path, latest=("desktop-v1.2.3",), verify_ok=True, bot_posts=True):
    """A fake shazam (bugs.py + the bot rules, run locally), a fake gh whose Latest answers come in order, a
    fake release-assets.mjs verify, and — when `bot_posts` — a fake bot that marks each drop announced."""
    remote = tmp_path / "remote"
    (remote / "ops" / "feedback-bot" / "bot").mkdir(parents=True)
    shutil.copy(ROOT / "ops" / "feedback-bot" / "bugs.py", remote / "ops" / "feedback-bot" / "bugs.py")
    shutil.copy(ROOT / "ops" / "feedback-bot" / "bot" / "announce.py", remote / "ops" / "feedback-bot" / "bot" / "announce.py")
    inbox = remote / "feedback-inbox"
    inbox.mkdir()
    root = tmp_path / "repo"
    (root / "docs" / "release-notes").mkdir(parents=True)
    (root / "docs" / "release-notes" / "1.2.3.md").write_text(NOTES)
    (root / "desktop" / "scripts").mkdir(parents=True)
    (root / "desktop" / "scripts" / "release-assets.mjs").write_text(
        f"import fs from 'node:fs'\n"
        f"if (process.argv[2] !== 'verify' || process.argv[4] !== '--live') process.exit(9)\n"
        f"fs.appendFileSync({json.dumps(str(tmp_path / 'verified'))}, process.argv[3] + '\\n')\n"
        f"process.exit({0 if verify_ok else 1})\n")
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    post = (f'python3 - <<"PY"\nimport json, pathlib\ni = pathlib.Path({json.dumps(str(inbox))})\n'
            f'for f in (i / "announce").glob("*.json"):\n    s = json.loads((i / "state.json").read_text()) if (i / "state.json").exists() else {{}}\n'
            f'    s["announced"] = sorted(set(s.get("announced", [])) | {{json.loads(f.read_text())["version"]}})\n'
            f'    (i / "state.json").write_text(json.dumps(s)); f.unlink()\nPY\n') if bot_posts else ""
    exe(bin_ / "sshshazambom", f'#!/usr/bin/env bash\n[ "$1" = sudo ] && shift\nbash -c "$*"; rc=$?\n{post}exit $rc\n')
    answers = tmp_path / "latest"
    answers.write_text("\n".join(latest) + "\n")
    exe(bin_ / "gh", f"""#!/usr/bin/env bash
if [ "$1 $2" = "api repos/Shazambom/shazam-poe2-dashboard/releases/latest" ]; then
  head -1 "{answers}"; [ "$(wc -l < "{answers}")" -gt 1 ] && sed -i.bak 1d "{answers}"; exit 0
fi
echo "unexpected gh $*" >&2; exit 9
""")
    env = {**os.environ, "PATH": f"{bin_}:{os.environ['PATH']}", "REMOTE": str(remote), "ANNOUNCE_WAIT_S": "0"}
    return env, inbox, root


def run(env, root, *args):
    return subprocess.run(["bash", str(SH), *args, str(root)], env=env, capture_output=True, text=True)


def state(inbox):
    p = inbox / "state.json"
    return json.loads(p.read_text()) if p.exists() else {}


def test_a_live_stable_release_is_handed_to_the_bot_and_confirmed_posted(tmp_path):
    env, inbox, root = setup(tmp_path)
    r = run(env, root, "desktop-v1.2.3")
    assert r.returncode == 0, r.stderr
    assert state(inbox)["announced"] == ["1.2.3"]
    assert (tmp_path / "verified").read_text() == "desktop-v1.2.3\n", "the release tool confirmed it live"
    assert "posted" in r.stdout


def test_it_fails_when_the_bot_never_posts_so_the_release_warns(tmp_path):
    env, inbox, root = setup(tmp_path, bot_posts=False)
    r = run(env, root, "desktop-v1.2.3")
    assert r.returncode != 0
    assert "not posted" in r.stderr
    assert (inbox / "announce" / "1.2.3.json").exists(), "the drop is there: the bot just hasn't posted it"


def test_nothing_is_announced_unless_the_release_is_confirmed_live(tmp_path):
    for i, kw in enumerate(({"latest": ("desktop-v1.2.2",) * 5}, {"verify_ok": False})):
        env, inbox, root = setup(tmp_path / str(i), **kw)
        r = run(env, root, "desktop-v1.2.3")
        assert r.returncode != 0 and not (inbox / "announce").exists(), kw


def test_a_latest_pointer_that_lags_a_moment_is_waited_for(tmp_path):
    env, inbox, root = setup(tmp_path, latest=("desktop-v1.2.2", "desktop-v1.2.3"))
    assert run(env, root, "desktop-v1.2.3").returncode == 0
    assert state(inbox)["announced"] == ["1.2.3"]


def test_only_a_stable_tag_is_announced(tmp_path):
    for i, tag in enumerate(("1.2.3-beta.1", "desktop-v1.2.3-beta.1", "main", "desktop-v1.2.3; rm -rf /")):
        env, inbox, root = setup(tmp_path / str(i), latest=(tag,))
        assert run(env, root, tag).returncode != 0, tag
        assert not (inbox / "announce").exists(), tag


def test_check_asks_shazams_own_rules_and_writes_nothing(tmp_path):
    env, inbox, root = setup(tmp_path)
    assert run(env, root, "check", "desktop-v1.2.3").returncode == 0
    assert not (inbox / "announce").exists()
    (root / "docs" / "release-notes" / "1.2.3.md").write_text(NOTES + "Prose after the bullets.\n")
    assert run(env, root, "check", "desktop-v1.2.3").returncode != 0


def test_check_fails_when_shazams_bot_is_not_deployed(tmp_path):
    env, inbox, root = setup(tmp_path)
    (inbox.parent / "ops" / "feedback-bot" / "bugs.py").write_text("import sys; sys.exit(2)\n")   # an old bugs.py
    r = run(env, root, "check", "desktop-v1.2.3")
    assert r.returncode != 0 and "deploy-web.sh bot" in r.stderr


def test_bugs_py_refuses_a_bad_payload_and_writes_the_drop_whole(tmp_path):
    env, inbox, root = setup(tmp_path)
    cli = ["python3", str(inbox.parent / "ops" / "feedback-bot" / "bugs.py"), "--inbox", str(inbox)]
    bad = base64.b64encode(json.dumps({"version": "1.2.3", "summary": "x", "bullets": ["y"], "windows": "https://evil.example/a.exe"}).encode()).decode()
    assert subprocess.run([*cli, "announce", bad], capture_output=True).returncode != 0
    assert subprocess.run([*cli, "announce", "not base64 !!"], capture_output=True).returncode != 0
    assert not (inbox / "announce").exists() or not list((inbox / "announce").iterdir())
    good = base64.b64encode(json.dumps({"version": "1.2.3", "summary": "Faster stash.", "bullets": ["Stash loads faster"]}).encode()).decode()
    assert subprocess.run([*cli, "announce", good], capture_output=True).returncode == 0
    assert sorted(p.name for p in (inbox / "announce").iterdir()) == ["1.2.3.json"], "no temp file left behind"
    out = subprocess.run([*cli, "announced", "1.2.3"], capture_output=True, text=True)
    assert out.returncode != 0, "not announced until the bot records it"
    (inbox / "state.json").write_text(json.dumps({"announced": ["1.2.3"]}))
    assert subprocess.run([*cli, "announced", "1.2.3"], capture_output=True).returncode == 0
