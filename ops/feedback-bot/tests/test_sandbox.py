"""opener.py runs the cell as a child under rlimits + a wall clock; a hostile cell is killed or
fails and is reported as REFUSE, never as OK."""
import json
import sys
from pathlib import Path

import pytest

from conftest import gz, valid_doc
from opener import opener

FIX = Path(__file__).resolve().parent / "cells"


def run(tmp_path, cell_argv, timeout=5):
    inp = tmp_path / "in.gz"
    inp.write_bytes(gz(valid_doc()))
    out = tmp_path / "out"
    return opener.run_one(inp, out, cell_argv=cell_argv, wall_s=timeout), out


def test_the_real_cell_reports_ok_and_result_json_is_schema_shaped(tmp_path):
    r, out = run(tmp_path, [sys.executable, "-m", "opener.cell"])
    assert r == {"status": "OK", "shortId": "7F3K2Q", "reason": ""}
    assert json.loads((out / "result.json").read_text()) == r
    assert (out / "report.json").exists()


def test_a_broken_report_is_quarantined(tmp_path):
    inp = tmp_path / "in.gz"; inp.write_bytes(b"abc")
    out = tmp_path / "out"
    r = opener.run_one(inp, out, cell_argv=[sys.executable, "-m", "opener.cell"], wall_s=5)
    assert r["status"] == "QUARANTINE" and r["shortId"] == ""


@pytest.mark.parametrize("cell,why", [
    ("alloc", "2 GB allocation fails under RLIMIT_AS"),
    ("spin", "an infinite loop hits the wall clock / RLIMIT_CPU"),
    ("fork", "fork() fails under RLIMIT_NPROC"),
    ("bigfile", "a 100 MB write fails under RLIMIT_FSIZE"),
    ("crash", "an uncaught exception is a crash"),
])
def test_hostile_cells_are_refused(tmp_path, cell, why):
    if cell == "alloc" and sys.platform == "darwin":
        pytest.skip("macOS does not enforce RLIMIT_AS; the bot runs on Linux (shazam), where it does")
    r, out = run(tmp_path, [sys.executable, str(FIX / f"{cell}.py")], timeout=3)
    assert r["status"] == "REFUSE", why
    assert json.loads((out / "result.json").read_text())["status"] == "REFUSE"


def test_the_input_is_deleted_after_the_run(tmp_path):
    inp = tmp_path / "in.gz"; inp.write_bytes(gz(valid_doc()))
    opener.run_one(inp, tmp_path / "out", cell_argv=[sys.executable, "-m", "opener.cell"], wall_s=5)
    assert not inp.exists()
