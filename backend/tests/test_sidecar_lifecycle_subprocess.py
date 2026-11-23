"""Real-subprocess lifecycle tests for the analytics sidecar and its supervisor.

Unlike test_sidecar_runner.py (in-process) and test_sidecar_supervisor.py (mocked Popen),
these tests spawn actual Python child processes against a real WAL market.sqlite with an open
stdin pipe, covering OS-level failure modes mocks cannot see:
  - clean idle exit (rc=0) with stdin-EOF watchdog active (no SIGABRT in _enter_buffered_busy)
  - supervisor sleep-until-wake after idle exit, then fresh respawn on wake()
  - orphan 'running' job self-heal at startup
  - clean supervisor stop() tearing down the live child via stdin EOF / terminate

Run:  DATA_DIR=$(mktemp -d) MARKET_SEED= .venv-test/bin/python -m pytest backend/tests/test_sidecar_lifecycle_subprocess.py -v
"""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import threading
import time
from datetime import datetime, UTC
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import analytics, sidecar_supervisor as sup

BACKEND_DIR = Path(__file__).resolve().parents[1]

DAY = 86400

_DDL = """
CREATE TABLE item_meta (item_id INTEGER PRIMARY KEY, name TEXT, category TEXT);
CREATE TABLE league_daily (league TEXT, item_id INTEGER, day TEXT, close REAL, average REAL,
                           volume INTEGER, PRIMARY KEY(league,item_id,day));
CREATE TABLE analytics_cache (kind TEXT, key TEXT, computed_at INTEGER, value_json TEXT,
                              PRIMARY KEY(kind,key));
CREATE TABLE analytics_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, params_json TEXT
                             DEFAULT '{}', state TEXT DEFAULT 'queued', enqueued_at INTEGER,
                             started_at INTEGER, finished_at INTEGER, error TEXT);
"""


def _seed_market_db(data_dir: Path) -> Path:
    db_path = data_dir / "market.sqlite"
    c = sqlite3.connect(str(db_path))
    c.execute("PRAGMA journal_mode=WAL")
    c.executescript(_DDL)
    c.execute("INSERT INTO item_meta VALUES(1, 'Divine Orb', 'currency')")
    c.execute("INSERT INTO item_meta VALUES(291, 'Divine Orb', 'currency')")
    rows = []
    # 30 calm liquid days + volume-confirmed anomaly on day 27 for discords
    for i in range(30):
        close = 10.0 + (0.2 if i % 2 else -0.2)
        vol = 30_000
        if i == 27:
            close, vol = 30.0, 300_000
        day = datetime.fromtimestamp(1_700_000_000 + i * DAY, UTC).strftime("%Y-%m-%d")
        rows.append(("Std", 1, day, close, close, vol))
    # Two leagues for item 291 so arc DTW produces weights
    for i in range(20):
        day = datetime.fromtimestamp(1_600_000_000 + i * DAY, UTC).strftime("%Y-%m-%d")
        rows.append(("Old", 291, day, 8.0 + 0.5 * i, 8.0 + 0.5 * i, 100))
    for i in range(12):
        day = datetime.fromtimestamp(1_700_000_000 + i * DAY, UTC).strftime("%Y-%m-%d")
        rows.append(("Std", 291, day, 10.0 + 0.4 * i, 10.0 + 0.4 * i, 100))
    c.executemany("INSERT INTO league_daily VALUES(?,?,?,?,?,?)", rows)
    c.commit()
    c.close()
    return db_path


def _runner_cmd(idle_s: float = 0.6) -> list[str]:
    """Subprocess entrypoint that runs the real sidecar.runner.main() with a short idle timeout."""
    code = (
        f"import sys; sys.path.insert(0, {str(BACKEND_DIR)!r}); "
        "from sidecar import runner; "
        f"runner.IDLE_EXIT_S = {idle_s!r}; "
        "runner.main()"
    )
    return [sys.executable, "-c", code]


def _wait_until(pred, timeout: float = 15.0, interval: float = 0.05) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(interval)
    return False


def test_real_sidecar_completes_jobs_and_exits_cleanly_at_idle(tmp_path):
    db_path = _seed_market_db(tmp_path)
    c = sqlite3.connect(str(db_path))
    analytics.enqueue(c, "discords", {"league": "Std"})
    analytics.enqueue(c, "arc", {"league": "Std"})
    c.commit()
    c.close()

    env = dict(
        os.environ,
        DATA_DIR=str(tmp_path),
        ARBITER_PARENT_PID=str(os.getpid()),
        ARBITER_TELEMETRY="0",
    )
    proc = subprocess.Popen(
        _runner_cmd(idle_s=0.6),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    try:
        # Keep stdin OPEN the entire time — matches how sidecar_supervisor runs it.
        rc = proc.wait(timeout=20)
        assert proc.stderr is not None
        stderr = proc.stderr.read().decode("utf-8", "replace")
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)
        if proc.stdin:
            try:
                proc.stdin.close()
            except Exception:
                pass

    assert rc == 0, f"sidecar did not exit cleanly at idle: rc={rc} stderr={stderr!r}"

    c = sqlite3.connect(str(db_path))
    try:
        disc = analytics.read_cache(c, "discords", "current")
        arc = analytics.read_cache(c, "arc", "current")
        states = [
            r[0] for r in c.execute("SELECT state FROM analytics_jobs ORDER BY id")
        ]
    finally:
        c.close()

    assert states == ["done", "done"]
    assert disc and disc["league"] == "Std" and len(disc["signals"]) == 1
    assert arc and arc["league"] == "Std" and arc["resembles"] == "Old"


def test_real_sidecar_heals_orphaned_running_job_at_startup(tmp_path):
    db_path = _seed_market_db(tmp_path)
    c = sqlite3.connect(str(db_path))
    # Simulate a job left stuck in 'running' by a previous hard crash.
    c.execute(
        "INSERT INTO analytics_jobs(kind, params_json, state, enqueued_at, started_at) "
        "VALUES('arc', '{\"league\":\"Std\"}', 'running', 1, 1)"
    )
    c.commit()
    c.close()

    env = dict(
        os.environ,
        DATA_DIR=str(tmp_path),
        ARBITER_PARENT_PID=str(os.getpid()),
        ARBITER_TELEMETRY="0",
    )
    proc = subprocess.Popen(
        _runner_cmd(idle_s=0.5),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    try:
        rc = proc.wait(timeout=20)
        assert proc.stderr is not None
        stderr = proc.stderr.read().decode("utf-8", "replace")
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)
        if proc.stdin:
            try:
                proc.stdin.close()
            except Exception:
                pass

    assert rc == 0, (
        f"expected clean rc=0 after orphan recovery, got rc={rc} stderr={stderr!r}"
    )
    c = sqlite3.connect(str(db_path))
    try:
        state = c.execute("SELECT state FROM analytics_jobs").fetchone()[0]
        arc = analytics.read_cache(c, "arc", "current")
    finally:
        c.close()
    assert state == "done"
    assert arc and arc["resembles"] == "Old"


def test_supervisor_sleeps_after_idle_wakes_on_new_job_and_stops_cleanly(
    tmp_path, monkeypatch
):
    db_path = _seed_market_db(tmp_path)
    c = sqlite3.connect(str(db_path))
    analytics.enqueue(c, "arc", {"league": "Std"})
    c.commit()
    c.close()

    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("ARBITER_TELEMETRY", "0")
    monkeypatch.setattr(sup, "_tlog", lambda *a, **k: None)
    monkeypatch.setattr(sup, "_stop", False)
    monkeypatch.setattr(sup, "_proc", None)
    sup._wake.clear()

    t = threading.Thread(
        target=sup._supervise, args=(_runner_cmd(idle_s=0.5),), daemon=True
    )
    t.start()
    try:
        # 1. Wait for job #1 to finish and sidecar #1 to exit cleanly into idle sleep.
        def _job_done(n: int) -> bool:
            conn = sqlite3.connect(str(db_path))
            try:
                cnt = conn.execute(
                    "SELECT COUNT(*) FROM analytics_jobs WHERE state='done'"
                ).fetchone()[0]
                return cnt >= n
            finally:
                conn.close()

        assert _wait_until(lambda: _job_done(1), timeout=20), "job #1 did not finish"
        first_pid = sup._proc.pid if sup._proc else None
        assert first_pid is not None
        assert _wait_until(
            lambda: sup._proc is not None and sup._proc.poll() == 0, timeout=10
        ), (
            f"sidecar did not idle-exit cleanly (poll={sup._proc.poll() if sup._proc else None})"
        )

        # Confirm it stays asleep (no crash respawn loop) for 1.2s.
        time.sleep(1.2)
        assert sup._proc is not None
        assert sup._proc.pid == first_pid and sup._proc.poll() == 0, (
            "sidecar unexpectedly respawned while idle"
        )

        # 2. Enqueue job #2 and wake the supervisor -> must spawn a new PID and finish job #2.
        c = sqlite3.connect(str(db_path))
        analytics.enqueue(c, "discords", {"league": "Std"})
        c.commit()
        c.close()
        sup.wake()

        assert _wait_until(
            lambda: sup._proc is not None and sup._proc.pid != first_pid, timeout=10
        ), "supervisor did not respawn sidecar after wake()"
        assert _wait_until(lambda: _job_done(2), timeout=20), (
            "job #2 did not finish after wake()"
        )
    finally:
        sup.stop()
        t.join(timeout=10)

    assert not t.is_alive(), "supervisor thread did not exit on stop()"
    if sup._proc is not None:
        assert sup._proc.poll() is not None, (
            "sidecar child process survived supervisor stop()"
        )
