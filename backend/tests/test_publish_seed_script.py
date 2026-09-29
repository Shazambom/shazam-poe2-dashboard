"""ops/publish-market-snapshot.sh, run for real with docker/sudo and the GitHub uploader faked
(docs/bugs/2026-09-28-partial-sync-data.md). The cron runs it hourly: the first run of a UTC day
always publishes; later runs publish only when a league verifies a newer day; the mod pools rebuild
once a day; a failed upload is retried next hour.

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_publish_seed_script.py -q
"""
import json
import os
import sqlite3
import stat
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import db  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "ops" / "publish-market-snapshot.sh"


def _exe(path: Path, body: str) -> None:
    path.write_text("#!/bin/bash\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


def _setup(tmp: Path, cut: str) -> dict:
    repo, fakes = tmp / "repo", tmp / "bin"
    (repo / "data").mkdir(parents=True)
    fakes.mkdir()
    c = sqlite3.connect(str(repo / "data" / "market.sqlite"))
    c.executescript(db.MARKET_SCHEMA)
    hour = int(time.time()) // 3600 * 3600
    c.execute("INSERT INTO kv_ops VALUES('digest_cursor', ?)", (json.dumps(hour),))
    c.execute("INSERT INTO kv_ops VALUES('lh_current', '[\"Cur\"]')")
    c.execute("INSERT INTO kv_ops VALUES('seed_poll', ?)", (json.dumps({"at": time.time(), "leagues": ["Cur"]}),))
    for day in ("2026-09-26", "2026-09-27", "2026-09-28"):
        c.execute("INSERT INTO league_daily VALUES('Cur', 1, ?, 1.0, 1.0, 5)", (day,))
    c.commit()
    c.close()
    set_cut(repo, cut)
    log = tmp / "calls.log"
    # `sudo docker exec -i <container> python ...` runs the python locally, with /data -> repo/data.
    _exe(fakes / "sudo", f'''echo "container $4" >> "{log}"; shift 4; echo "docker $*" >> "{log}"
shift                                     # drop the container's `python`
[ "$1" = "-m" ] && exit 0
args=(); for a in "$@"; do args+=("${{a//\\/data/{repo}/data}}"); done
cd "{ROOT}/backend" && exec "{sys.executable}" "${{args[@]}}"
''')
    _exe(fakes / "uploader", f'echo "upload $*" >> "{log}"; [ -f "{tmp}/upload-fails" ] && exit 1; exit 0\n')
    env = {**os.environ, "PATH": f"{fakes}:{os.environ['PATH']}", "SEED_REPO": str(repo),
           "SEED_UPLOADER": str(fakes / "uploader"), "GH_TOKEN": "x"}
    return {"repo": repo, "log": log, "env": env, "tmp": tmp}


def set_cut(repo: Path, day: str) -> None:
    c = sqlite3.connect(str(repo / "data" / "market.sqlite"))
    c.execute("INSERT OR REPLACE INTO kv_ops VALUES('seed_cut:Cur', ?)", (json.dumps({"day": day, "through": day, "stale": []}),))
    c.commit()
    c.close()


def run(s: dict) -> subprocess.CompletedProcess:
    s["log"].write_text("") if s["log"].exists() else None
    return subprocess.run(["bash", str(SCRIPT)], env=s["env"], capture_output=True, text=True)


def calls(s: dict) -> str:
    return s["log"].read_text() if s["log"].exists() else ""


def test_the_first_run_of_the_day_rebuilds_mod_pools_and_publishes(tmp_path):
    s = _setup(tmp_path, "2026-09-27")
    r = run(s)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "app.modpool" in calls(s) and "upload" in calls(s)
    assert "ships through 2026-09-27" in r.stdout


def test_a_later_run_with_nothing_newer_publishes_nothing_and_skips_mod_pools(tmp_path):
    s = _setup(tmp_path, "2026-09-27")
    run(s)
    r = run(s)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "upload" not in calls(s) and "app.modpool" not in calls(s)
    assert "nothing newer" in r.stdout


def test_a_later_run_publishes_a_newly_verified_day(tmp_path):
    s = _setup(tmp_path, "2026-09-27")
    run(s)
    set_cut(s["repo"], "2026-09-28")
    r = run(s)
    assert r.returncode == 0 and "upload" in calls(s) and "app.modpool" not in calls(s)


def test_a_failed_upload_is_retried_next_hour(tmp_path):
    s = _setup(tmp_path, "2026-09-27")
    (tmp_path / "upload-fails").touch()
    assert run(s).returncode != 0
    (tmp_path / "upload-fails").unlink()
    r = run(s)
    assert r.returncode == 0 and "upload" in calls(s), "the failed publish is not recorded as done"


def test_a_test_env_can_point_it_at_its_own_container(tmp_path):
    """The seed test env on shazam runs this same script against a second container and archives
    instead of uploading, beside the production publisher."""
    s = _setup(tmp_path, "2026-09-27")
    s["env"]["SEED_CONTAINER"] = "poe2-seedtest-backend"
    assert run(s).returncode == 0
    assert "poe2-seedtest-backend" in calls(s)


def test_an_unverified_league_fails_loudly(tmp_path):
    s = _setup(tmp_path, "2026-09-27")
    c = sqlite3.connect(str(s["repo"] / "data" / "market.sqlite"))
    c.execute("DELETE FROM kv_ops WHERE key='seed_cut:Cur'")
    c.commit()
    c.close()
    r = run(s)
    assert r.returncode != 0 and "upload" not in calls(s)
