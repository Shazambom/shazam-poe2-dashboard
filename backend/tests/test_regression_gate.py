"""The release gate `ops/regression-diff.py` (desktop/publish-github.sh runs it before every publish):
its acceptance rules and how it classifies route differences. The data-driven run itself is exercised
by the publish script against the owner's data.

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_regression_gate.py -q
"""
import importlib.util
import os
import stat
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("regression_diff", ROOT / "ops" / "regression-diff.py")
rd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rd)


def _accept(tmp_path, text):
    p = tmp_path / "accept.txt"
    p.write_text(text)
    return str(p)


LINES = ["loops    recipe loop: chaos>greater-chaos-orb|greater-chaos-orb>chaos:r",
         "pool     left: #99 chaos>exalted|exalted>x|x>chaos"]


def test_every_difference_accepted_for_this_exact_version_passes(tmp_path):
    path = _accept(tmp_path, "version: 0.3.8-beta.3\n# why: new recipe loops\nloops    recipe loop: *\npool     left: #99 *\n")
    assert rd.check_accept(LINES, path, "0.3.8-beta.3") == []


def test_an_acceptance_never_carries_to_another_release(tmp_path):
    path = _accept(tmp_path, "version: 0.3.8-beta.2\nloops    recipe loop: *\npool     left: *\n")
    assert any("is for version '0.3.8-beta.2'" in p for p in rd.check_accept(LINES, path, "0.3.8-beta.3"))


def test_an_unaccepted_difference_blocks(tmp_path):
    path = _accept(tmp_path, "version: 0.3.8-beta.3\nloops    recipe loop: *\n")
    assert rd.check_accept(LINES, path, "0.3.8-beta.3") == [f"UNACCEPTED: {LINES[1]}"]


def test_a_stale_accept_line_blocks(tmp_path):
    path = _accept(tmp_path, "version: 0.3.8-beta.3\nloops    recipe loop: *\npool     left: *\nvalues   *\n")
    assert rd.check_accept(LINES, path, "0.3.8-beta.3") == ["STALE accept line (matches nothing): values   *"]


def test_no_accept_file_blocks_any_difference_and_nothing_to_accept_passes(tmp_path):
    assert rd.check_accept(LINES, None, "0.3.8-beta.3")
    assert rd.check_accept(LINES, str(tmp_path / "missing.txt"), "0.3.8-beta.3")
    assert rd.check_accept([], None, None) == []


def test_a_hash_inside_an_accept_line_is_part_of_it(tmp_path):
    """Reported lines carry ranks like #99; only whole-line comments are comments."""
    path = _accept(tmp_path, "version: v\nloops    recipe loop: *\npool     left: #99 chaos>exalted|exalted>x|x>chaos\n")
    assert rd.check_accept(LINES, path, "v") == []
    path = _accept(tmp_path, "version: v\nloops    recipe loop: *\npool     left: #98 *\n")
    assert f"UNACCEPTED: {LINES[1]}" in rd.check_accept(LINES, path, "v")


def _dump(loops, recipe_loops, pool):
    return {"values": {}, "busiest": {}, "cards": {}, "market_table": [], "hold": {}, "convert": {},
            "loops": loops, "recipe_loops": recipe_loops, "routes": {"pool": pool}}


def test_routes_exchange_only_loops_must_not_change_and_score_shifts_are_one_line():
    base = _dump({"a": [5.0, 10, 10.5, 100]}, [], [["a", 5.0, 0.9, False], ["b", 3.0, 0.8, False]])
    new = _dump({"a": [5.0, 10, 10.6, 100]}, ["r"], [["b", 3.0, 0.81, False], ["a", 5.0, 0.8, False],
                                                    ["r", 50.0, 0.7, True]])
    assert rd.diff(base, new) == [
        "loops    exchange-only loop changed: a: [5.0, 10, 10.5, 100] -> [5.0, 10, 10.6, 100]",
        "loops    recipe loop: r",
        "pool     joined (recipe): #2 r",
        "pool     score/rank shifts only (margins unchanged): 2 loops, largest score shift 0.1000, largest rank shift 1",
    ]


def test_a_card_difference_names_only_the_fields_that_changed():
    """Owner, 2026-10-08: accept the CHANGE precisely, not a catch-all and not an id list that drifts with the data.
    A changed card reports its changed fields, sorted, so an accept line can say "only the numeraire moved"
    (`cards    *: change_pct * -> *; pref_num * -> *; trend_num * -> *`) and a card whose price moved is refused."""
    base = _dump({}, [], []); new = _dump({}, [], [])
    base["cards"] = {"chaos": {"id": "chaos", "mid": 70.0, "pref_num": "vaal", "trend_num": "vaal", "change_pct": 0.02, "hub": True}}
    new["cards"] = {"chaos": {"id": "chaos", "mid": 70.0, "pref_num": "divine", "trend_num": "divine", "change_pct": 0.8, "hub": True},
                    "exalted": {"id": "exalted", "mid": 1.0, "pref_num": "divine"}}
    assert rd.diff(base, new) == [
        "cards    chaos: change_pct 0.02 -> 0.8; pref_num vaal -> divine; trend_num vaal -> divine",
        "cards    exalted: None -> {'id': 'exalted', 'mid': 1.0, 'pref_num': 'divine'}",
    ]


def _write_exec(path: Path, content: str) -> None:
    path.write_text(content)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _run_publish_with_failing_regression_gate(tmp_path: Path, script_text: str) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    repo = tmp_path / "repo"
    (repo / "desktop").mkdir(parents=True)
    (repo / "ops").mkdir(parents=True)
    (repo / "desktop" / "package.json").write_text('{"version": "0.3.99-beta.1"}\n')
    pub = repo / "desktop" / "publish-github.sh"
    _write_exec(pub, script_text)

    log_file = tmp_path / "calls.log"
    _write_exec(repo / "ops" / "run-tests.sh", f"#!/bin/sh\necho 'run-tests' >> {log_file}\n")
    (repo / "ops" / "regression-diff.py").write_text("# stub\n")

    stub_bin = tmp_path / "bin"
    stub_bin.mkdir()
    _write_exec(
        stub_bin / "git",
        f"""#!/bin/sh
echo "git $*" >> {log_file}
case "$1" in
  branch) echo main ;;
  diff) exit 0 ;;
  rev-parse) echo deadbeef ;;
  *) exit 0 ;;
esac
""",
    )
    _write_exec(
        stub_bin / "node",
        f"""#!/bin/sh
echo "node $*" >> {log_file}
if [ "$1" = "-p" ]; then
  echo "0.3.99-beta.1"
fi
exit 0
""",
    )
    _write_exec(
        stub_bin / "python3",
        f"""#!/bin/sh
echo "python3 $*" >> {log_file}
exit 1
""",
    )

    env = {**os.environ, "PATH": f"{stub_bin}:{os.environ['PATH']}"}
    proc = subprocess.run(["/bin/bash", str(pub)], cwd=repo / "desktop", env=env, capture_output=True, text=True, check=False)
    calls = log_file.read_text().splitlines() if log_file.exists() else []
    return proc, calls


def test_the_publish_script_runs_the_gate_before_anything_remote(tmp_path):
    script = (ROOT / "desktop" / "publish-github.sh").read_text()
    gate = script.index("../ops/regression-diff.py --version \"$VER\" --accept ../ops/regression-accept.txt")
    assert script.index("../ops/run-tests.sh") < gate < script.index("git push origin main")
    assert gate < script.index("release-assets.mjs ensure-draft")
    proc, calls = _run_publish_with_failing_regression_gate(tmp_path, script)
    assert proc.returncode != 0, "a failed gate stops the release"
    assert "FATAL: regression diff" in proc.stdout, "a failed gate explains why it stopped"
    assert not any(c.startswith("git push") for c in calls), "a failed gate never pushes"
    assert not any("release-assets.mjs" in c for c in calls), "a failed gate never touches GitHub releases"

