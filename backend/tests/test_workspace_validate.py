"""Pins backend/app/workspace.py — the pure validate_workspace() guard behind PUT /api/trading/workspace.
It validates and never truncates: a rejection names the limit; anything within limits round-trips
byte-for-byte, including the additive fields batch 3 introduces (q, origin, ts, league, item…)."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import workspace as W  # noqa: E402


def _s(i, **extra):
    return {"id": f"n_{i}", "kind": "search", "name": f"S{i}", "slug": "abc", **extra}


def _doc(tree):
    return {"version": 2, "tree": tree, "layout": None, "openTabs": []}


def test_accepts_a_normal_document_and_the_new_fields():
    doc = _doc([
        _s(1, q='{"query":{}}', origin="ee2", ts=1758013456789, league="X", degraded=False,
           item={"name": "Headhunter", "baseType": "Heavy Belt"}),
        {"id": "n_h", "kind": "folder", "sys": "ee2-history", "name": "H", "open": True, "children": [_s(2)]},
    ])
    assert W.validate_workspace(doc) is None


@pytest.mark.parametrize("bad, msg", [
    ({"version": 1, "tree": []}, "version"),
    ({"version": 2, "tree": {}}, "tree"),
    (_doc(["x"]), "node"),
    (_doc([{"kind": "search", "name": "no id"}]), "id"),
    (_doc([{"id": 1, "kind": "search"}]), "id"),
    (_doc([{"id": "n_1", "kind": "thing"}]), "kind"),
    (_doc([{"id": "n_1", "kind": "folder", "children": "nope"}]), "children"),
    (_doc([_s(1), _s(1)]), "duplicate"),
])
def test_shape_errors_name_the_problem(bad, msg):
    err = W.validate_workspace(bad)
    assert err is not None and err.status == 400 and msg in err.detail


def test_limits_are_named_not_truncated():
    big = _doc([_s(i) for i in range(W.MAX_WORKSPACE_NODES + 1)])
    err = W.validate_workspace(big)
    assert err.status == 400 and "MAX_WORKSPACE_NODES" in err.detail

    deep = _s(0)
    for i in range(W.MAX_WORKSPACE_DEPTH + 1):
        deep = {"id": f"f_{i}", "kind": "folder", "children": [deep]}
    err = W.validate_workspace(_doc([deep]))
    assert err.status == 400 and "MAX_WORKSPACE_DEPTH" in err.detail

    fat = _doc([_s(1, slug="x" * (W.MAX_WORKSPACE_BYTES + 10))])
    err = W.validate_workspace(fat)
    assert err.status == 413 and "MAX_WORKSPACE_BYTES" in err.detail


def test_cyclic_document_terminates():
    f = {"id": "f", "kind": "folder", "children": []}
    f["children"].append(f)
    err = W.validate_workspace(_doc([f]))
    assert err is not None and err.status == 400
