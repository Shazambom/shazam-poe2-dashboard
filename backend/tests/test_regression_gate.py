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
_spec = importlib.util.spec_from_file_location(
    "regression_diff", ROOT / "ops" / "regression-diff.py"
)
assert _spec is not None and _spec.loader is not None
rd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rd)


def _accept(tmp_path, text):
    p = tmp_path / "accept.txt"
    p.write_text(text)
    return str(p)


LINES = [
    "loops    recipe loop: chaos>greater-chaos-orb|greater-chaos-orb>chaos:r",
    "pool     left: #99 chaos>exalted|exalted>x|x>chaos",
]


def test_every_difference_accepted_for_this_exact_version_passes(tmp_path):
    path = _accept(
        tmp_path,
        "version: 0.3.8-beta.3\n# why: new recipe loops\nloops    recipe loop: *\npool     left: #99 *\n",
    )
    assert rd.check_accept(LINES, path, "0.3.8-beta.3") == []


def test_an_acceptance_never_carries_to_another_release(tmp_path):
    path = _accept(
        tmp_path, "version: 0.3.8-beta.2\nloops    recipe loop: *\npool     left: *\n"
    )
    assert any(
        "is for version '0.3.8-beta.2'" in p
        for p in rd.check_accept(LINES, path, "0.3.8-beta.3")
    )


def test_an_unaccepted_difference_blocks(tmp_path):
    path = _accept(tmp_path, "version: 0.3.8-beta.3\nloops    recipe loop: *\n")
    assert rd.check_accept(LINES, path, "0.3.8-beta.3") == [f"UNACCEPTED: {LINES[1]}"]


def test_a_stale_accept_line_blocks(tmp_path):
    path = _accept(
        tmp_path,
        "version: 0.3.8-beta.3\nloops    recipe loop: *\npool     left: *\nvalues   *\n",
    )
    assert rd.check_accept(LINES, path, "0.3.8-beta.3") == [
        "STALE accept line (matches nothing): values   *"
    ]


def test_no_accept_file_blocks_any_difference_and_nothing_to_accept_passes(tmp_path):
    assert rd.check_accept(LINES, None, "0.3.8-beta.3")
    assert rd.check_accept(LINES, str(tmp_path / "missing.txt"), "0.3.8-beta.3")
    assert rd.check_accept([], None, None) == []


def test_a_hash_inside_an_accept_line_is_part_of_it(tmp_path):
    """Reported lines carry ranks like #99; only whole-line comments are comments."""
    path = _accept(
        tmp_path,
        "version: v\nloops    recipe loop: *\npool     left: #99 chaos>exalted|exalted>x|x>chaos\n",
    )
    assert rd.check_accept(LINES, path, "v") == []
    path = _accept(
        tmp_path, "version: v\nloops    recipe loop: *\npool     left: #98 *\n"
    )
    assert f"UNACCEPTED: {LINES[1]}" in rd.check_accept(LINES, path, "v")


def _dump(loops, recipe_loops, pool):
    return {
        "values": {},
        "busiest": {},
        "cards": {},
        "market_table": [],
        "hold": {},
        "convert": {},
        "loops": loops,
        "recipe_loops": recipe_loops,
        "routes": {"pool": pool},
    }


def test_routes_exchange_only_loops_must_not_change_and_score_shifts_are_one_line():
    base = _dump(
        {"a": [5.0, 10, 10.5, 100]},
        [],
        [["a", 5.0, 0.9, False], ["b", 3.0, 0.8, False]],
    )
    new = _dump(
        {"a": [5.0, 10, 10.6, 100]},
        ["r"],
        [["b", 3.0, 0.81, False], ["a", 5.0, 0.8, False], ["r", 50.0, 0.7, True]],
    )
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
    base = _dump({}, [], [])
    new = _dump({}, [], [])
    base["cards"] = {
        "chaos": {
            "id": "chaos",
            "mid": 70.0,
            "pref_num": "vaal",
            "trend_num": "vaal",
            "change_pct": 0.02,
            "hub": True,
        }
    }
    new["cards"] = {
        "chaos": {
            "id": "chaos",
            "mid": 70.0,
            "pref_num": "divine",
            "trend_num": "divine",
            "change_pct": 0.8,
            "hub": True,
        },
        "exalted": {"id": "exalted", "mid": 1.0, "pref_num": "divine"},
    }
    assert rd.diff(base, new) == [
        "cards    chaos: change_pct 0.02 -> 0.8; pref_num vaal -> divine; trend_num vaal -> divine",
        "cards    exalted: None -> {'id': 'exalted', 'mid': 1.0, 'pref_num': 'divine'}",
    ]


def _write_exec(path: Path, content: str) -> None:
    path.write_text(content)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _run_publish_stubbed(
    tmp_path: Path,
    script_text: str,
    *,
    fail_on_test_call: int | None = None,
    sync_changes: bool = False,
    regression_fails: bool = True,
) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    repo = tmp_path / "repo"
    (repo / "desktop").mkdir(parents=True)
    (repo / "ops").mkdir(parents=True)
    (repo / "desktop" / "package.json").write_text('{"version": "0.3.99-beta.1"}\n')
    pub = repo / "desktop" / "publish-github.sh"
    _write_exec(pub, script_text)

    log_file = tmp_path / "calls.log"
    count_file = tmp_path / "test-count"
    fail_expr = str(fail_on_test_call or 0)
    _write_exec(
        repo / "ops" / "run-tests.sh",
        f"""#!/bin/sh
n=$(cat {count_file} 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > {count_file}
echo "run-tests $n" >> {log_file}
if [ "$n" = "{fail_expr}" ]; then
  exit 1
fi
exit 0
""",
    )
    (repo / "ops" / "regression-diff.py").write_text("# stub\n")

    diff_exit = 1 if sync_changes else 0
    stub_bin = tmp_path / "bin"
    stub_bin.mkdir()
    _write_exec(
        stub_bin / "git",
        f"""#!/bin/sh
echo "git $*" >> {log_file}
case "$1" in
  branch) echo main ;;
  diff) exit {diff_exit} ;;
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
    reg_exit = 1 if regression_fails else 0
    _write_exec(
        stub_bin / "python3",
        f"""#!/bin/sh
echo "python3 $*" >> {log_file}
exit {reg_exit}
""",
    )

    env = {**os.environ, "PATH": f"{stub_bin}:{os.environ['PATH']}"}
    proc = subprocess.run(
        ["/bin/bash", str(pub)],
        cwd=repo / "desktop",
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    calls = log_file.read_text().splitlines() if log_file.exists() else []
    return proc, calls


def test_the_publish_script_runs_the_gate_before_anything_remote(tmp_path):
    script = (ROOT / "desktop" / "publish-github.sh").read_text()
    gate = script.index(
        '../ops/regression-diff.py --version "$VER" --accept ../ops/regression-accept.txt'
    )
    assert (
        script.index("../ops/run-tests.sh")
        < gate
        < script.index("git push origin main")
    )
    assert gate < script.index("release-assets.mjs ensure-draft")
    proc, calls = _run_publish_stubbed(tmp_path, script, regression_fails=True)
    assert proc.returncode != 0, "a failed gate stops the release"
    assert "FATAL: regression diff" in proc.stdout, (
        "a failed gate explains why it stopped"
    )
    assert not any(c.startswith("git push") for c in calls), (
        "a failed gate never pushes"
    )
    assert not any("release-assets.mjs" in c for c in calls), (
        "a failed gate never touches GitHub releases"
    )


def test_red_test_gate_stops_before_ee2_sync(tmp_path):
    script = (ROOT / "desktop" / "publish-github.sh").read_text()
    proc, calls = _run_publish_stubbed(
        tmp_path, script, fail_on_test_call=1, sync_changes=True
    )
    assert proc.returncode != 0
    assert calls.index("run-tests 1") >= 0
    assert not any("sync-ee2.mjs" in c for c in calls), (
        "a red test stops before EE2 sync"
    )
    assert not any(c.startswith("git commit") for c in calls), (
        "a red test never commits"
    )


def test_ee2_sync_with_no_changes_runs_tests_once_and_makes_no_commit(tmp_path):
    script = (ROOT / "desktop" / "publish-github.sh").read_text()
    proc, calls = _run_publish_stubbed(
        tmp_path, script, sync_changes=False, regression_fails=True
    )
    assert proc.returncode != 0
    test_calls = [i for i, c in enumerate(calls) if c.startswith("run-tests ")]
    sync_idx = next(i for i, c in enumerate(calls) if "sync-ee2.mjs" in c)
    assert len(test_calls) == 1 and test_calls[0] < sync_idx
    assert not any(c.startswith("git commit") for c in calls)


def test_ee2_sync_with_changes_reruns_tests_before_committing(tmp_path):
    script = (ROOT / "desktop" / "publish-github.sh").read_text()
    proc, calls = _run_publish_stubbed(
        tmp_path / "pass", script, sync_changes=True, regression_fails=True
    )
    assert proc.returncode != 0
    sync_idx = next(i for i, c in enumerate(calls) if "sync-ee2.mjs" in c)
    commit_idx = next(i for i, c in enumerate(calls) if c.startswith("git commit"))
    assert (
        calls.index("run-tests 1") < sync_idx < calls.index("run-tests 2") < commit_idx
    )

    proc2, calls2 = _run_publish_stubbed(
        tmp_path / "fail2", script, fail_on_test_call=2, sync_changes=True
    )
    assert proc2.returncode != 0
    assert "run-tests 2" in calls2
    assert not any(c.startswith("git commit") for c in calls2), (
        "a failing post-sync test stops before commit"
    )
    assert not any(c.startswith("git push") for c in calls2), (
        "a failing post-sync test never pushes"
    )
