#!/usr/bin/env python3
"""Before/after diff of what users see: run two versions of the backend on identical copies of real
data and report every difference. A GATE: desktop/publish-github.sh runs it before every release, beta or
stable, and refuses to publish on any difference that is not accepted for that exact version.

    python3 ops/regression-diff.py                              # desktop-v<last stable> vs the working tree
    python3 ops/regression-diff.py --base HEAD                  # control: must print NO DIFFERENCES
    python3 ops/regression-diff.py --version 0.3.8-beta.3 --accept ops/regression-accept.txt   # the gate

Both versions run read-only against their own copy of one snapshot of --data (default: the owner's desktop
data dir), with the trade site's cached names applied, so the only difference between the runs is the
code. The base is checked out into a temporary git worktree; the new side is the working tree.

What it compares (every currency, not a sample):
  values     the value table (Graph.values), relative change
  busiest    each currency's busiest market (the volume rule) and what prices it (priced_by)
  cards      every currency's price card: price, the currency it is shown in, source
  market     Economy -> Market's edge table: every market row
  hold       Hold's board at each window the app offers (24h / 3d / 7d / 14d): order and scores
  loops      every exchange-only loop the route search finds (margin, amounts, gold): must not change;
             loops through a recipe are listed separately
  pool       the Arbitrage page's pool (default filters, the user's holdings): joins, leaves, margin
             changes, and one summary line for score/rank shifts
  convert    a fixed set of conversions: best path, output, direct market

The accept file (--accept) holds the differences a release intends:
    version: 0.3.8-beta.3
    # why: recipe loops are new in this release (comments are whole lines only)
    loops    recipe loop: *
`version` must equal --version, so an acceptance never carries over to another release. Other lines
are shell-style globs matched against the reported lines.
Every reported line must match an accept line, and every accept line must match at least one reported
line (a stale acceptance fails too). Exit 0 only when both hold, or when nothing differs.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEFAULT_DATA = Path.home() / "Library/Application Support/Arbiter/data"
CONVERT_PAIRS = [("chaos", "divine"), ("divine", "exalted"), ("exalted", "chaos"), ("regal", "exalted"),
                 ("greater-chaos-orb", "chaos"), ("greater-orb-of-augmentation", "aug"),
                 ("perfect-exalted-orb", "exalted"), ("lesser-desert-rune", "desert-rune")]
REL_TOL = 1e-9

DUMP = r'''
import json, sys
sys.path.insert(0, sys.argv[1])
from app import db, arbitrage, holdscore
from app.currencies import registry
static = db.kv_get("trade_static_cache")
if static:
    registry._apply_static(static)
arbitrage.invalidate_caches()
g = arbitrage.cached_graph()
V = g.values()
ranked = arbitrage.counterparts_by_volume(g, V)
out = {"values": {c: v for c, v in V.items()},
       "busiest": {c: {"busiest": g.busiest.get(c), "priced_by": g.priced_by.get(c),
                       "top": (ranked.get(c) or [(None, None)])[0][1]} for c in V}}
cards = arbitrage.cards(sorted(V), 24)
drop = ("age", "fetched", "loaded", "updated", "t")
out["cards"] = {c: {k: v for k, v in (card or {}).items() if k not in drop and "age" not in k and k != "trend"}
                for c, card in cards.items()}
out["market_table"] = sorted([r["from"], r["to"], r["kind"], r["rate"], r["depth"]]
                             for r in arbitrage.edge_table() if r["kind"] != "recipe")
out["hold"] = {}
for label, hours in (("24h", 24), ("3d", 72), ("7d", 168), ("14d", 336)):   # what each window shows the user
    res = holdscore.leaderboard(holdscore.horizon_for(hours), "all", "divine", None)
    out["hold"][label] = [[a["id"], a["name"], a["hold"], a["ret_pct"]] for a in res["assets"]]
from app.arbitrage import routes as _R
_g, _s, _f, _rv, _cap, _starts, _notional = _R._search_setup(None, None)
_cands = list(_R._iter_candidates(_g, _s, _rv, _cap, _starts, _notional))
out["loops"] = {r["id"]: [round(r["margin_pct"], 9), r["start_amount"], r["end_amount"], r["gold"]]
                for r in _cands if not r["uses_recipe"]}
out["recipe_loops"] = sorted(r["id"] for r in _cands if r["uses_recipe"])
res = arbitrage.find_routes(None, use_cache=False)
out["routes"] = {"total_candidates": res["total_candidates"], "total_after_filters": res["total_after_filters"],
                 "pool": [[r["id"], round(r["margin_pct"], 6), r.get("score"), r["uses_recipe"]] for r in res["routes"]]}
out["convert"] = {}
for have, want in json.loads(sys.argv[2]):
    try:
        c = arbitrage.convert(have, want, 10)
    except Exception as exc:
        out["convert"][f"{have}>{want}"] = {"error": repr(exc)}
        continue
    b, d = c.get("best"), c.get("direct")
    out["convert"][f"{have}>{want}"] = {"best": b and [b["id"], b["out"]], "direct": d and [d["id"], d["out"]]}
print("DUMP" + json.dumps(out, default=str))
'''


def snapshot(data: Path, dest: Path) -> None:
    """One consistent copy of the data dir; each side then gets its own copy of this snapshot."""
    dest.mkdir()
    for name in ("market.sqlite", "user.sqlite", "secret.key", "recipes.json", "install-id"):
        src = data / name
        if not src.exists():
            continue
        if name.endswith(".sqlite"):     # a consistent copy of a live (WAL) database
            subprocess.run(["sqlite3", "-readonly", str(src), f".backup '{dest / name}'"], check=True)
        else:
            shutil.copy2(src, dest / name)
    if (data / "gamedata").exists():
        shutil.copytree(data / "gamedata", dest / "gamedata")


def run_side(tree: Path, snap: Path, work: Path, label: str) -> dict:
    copy = work / f"data-{label}"
    shutil.copytree(snap, copy)
    env = {**os.environ, "DATA_DIR": str(copy), "MARKET_SEED": ""}
    py = str(REPO / ".venv-test/bin/python")
    p = subprocess.run([py, "-c", DUMP, str(tree / "backend"), json.dumps(CONVERT_PAIRS)],
                       cwd=tree / "backend", env=env, capture_output=True, text=True)
    line = next((l for l in p.stdout.splitlines() if l.startswith("DUMP")), None)
    if p.returncode or not line:
        sys.exit(f"{label}: dump failed (exit {p.returncode})\n{p.stderr[-3000:]}")
    return json.loads(line[4:])


def diff(a: dict, b: dict) -> list[str]:
    out = []
    va, vb = a["values"], b["values"]
    for c in sorted(set(va) | set(vb)):
        x, y = va.get(c), vb.get(c)
        if x is None or y is None:
            out.append(f"values   {c}: {x} -> {y}")
        elif abs(y / x - 1) > REL_TOL if x else y != x:
            out.append(f"values   {c}: {x:.6g} -> {y:.6g} ({(y / x - 1) * 100:+.2f}%)" if x else f"values   {c}: {x} -> {y}")
    for sec in ("busiest", "cards"):
        for c in sorted(set(a[sec]) | set(b[sec])):
            x, y = a[sec].get(c), b[sec].get(c)
            if x == y:
                continue
            if isinstance(x, dict) and isinstance(y, dict):      # a changed card: only the fields that moved, sorted
                out.append(f"{sec:8} {c}: " + "; ".join(f"{k} {x.get(k)} -> {y.get(k)}" for k in sorted(set(x) | set(y)) if x.get(k) != y.get(k)))
            else:
                out.append(f"{sec:8} {c}: {x} -> {y}")
    ma = {tuple(r[:3]): r for r in a["market_table"]}; mb = {tuple(r[:3]): r for r in b["market_table"]}
    for k in sorted(set(ma) | set(mb)):
        if ma.get(k) != mb.get(k):
            out.append(f"market   {k[0]}>{k[1]} ({k[2]}): {ma.get(k)} -> {mb.get(k)}")
    for hz in sorted(set(a["hold"]) | set(b["hold"])):
        if a["hold"].get(hz) != b["hold"].get(hz):
            ia = [r[0] for r in a["hold"].get(hz, [])]; ib = [r[0] for r in b["hold"].get(hz, [])]
            out.append(f"hold     {hz}: {'order changed' if ia != ib else 'scores/returns changed'} "
                       f"(top5 {[r[1] for r in a['hold'][hz][:5]]} -> {[r[1] for r in b['hold'][hz][:5]]})")
    la, lb = a["loops"], b["loops"]
    for rid in sorted(set(la) | set(lb)):
        if la.get(rid) != lb.get(rid):
            out.append(f"loops    exchange-only loop changed: {rid}: {la.get(rid)} -> {lb.get(rid)}")
    for rid in sorted(set(b["recipe_loops"]) - set(a["recipe_loops"])):
        out.append(f"loops    recipe loop: {rid}")
    for rid in sorted(set(a["recipe_loops"]) - set(b["recipe_loops"])):
        out.append(f"loops    recipe loop gone: {rid}")
    ra, rb = a["routes"], b["routes"]
    pa = {r[0]: (i, r) for i, r in enumerate(ra["pool"])}; pb = {r[0]: (i, r) for i, r in enumerate(rb["pool"])}
    for rid in sorted(set(pa) - set(pb)):
        out.append(f"pool     left: #{pa[rid][0]} {rid}")
    for rid in sorted(set(pb) - set(pa)):
        out.append(f"pool     joined{' (recipe)' if pb[rid][1][3] else ''}: #{pb[rid][0]} {rid}")
    shifts, ds, dr = 0, 0.0, 0
    for rid in sorted(set(pa) & set(pb)):
        (ia, x), (ib, y) = pa[rid], pb[rid]
        if x[1] != y[1]:
            out.append(f"pool     margin changed: {rid}: {x[1]} -> {y[1]}")
        elif (ia, x[2]) != (ib, y[2]):
            shifts += 1
            ds = max(ds, abs((y[2] or 0) - (x[2] or 0)))
            dr = max(dr, abs(ib - ia))
    if shifts:
        out.append(f"pool     score/rank shifts only (margins unchanged): {shifts} loops, largest score "
                   f"shift {ds:.4f}, largest rank shift {dr}")
    for k in sorted(set(a["convert"]) | set(b["convert"])):
        if a["convert"].get(k) != b["convert"].get(k):
            out.append(f"convert  {k}: {a['convert'].get(k)} -> {b['convert'].get(k)}")
    return out


def check_accept(lines: list[str], path: str | None, version: str | None) -> list[str]:
    """Problems with the acceptance: unaccepted lines, stale accept lines, a wrong or missing version."""
    import fnmatch
    if not lines:
        return []
    if not path or not Path(path).exists():
        return [f"no accept file ({path}): every difference above is unaccepted"]
    entries, ver = [], None
    for raw in Path(path).read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):       # whole-line comments only: reported lines contain '#'
            continue
        if line.startswith("version:"):
            ver = line.split(":", 1)[1].strip()
        else:
            entries.append(line.strip())
    problems = []
    if not version or ver != version:
        problems.append(f"accept file is for version {ver!r}, this release is {version!r}")
    for l in lines:
        if not any(fnmatch.fnmatchcase(l, e) for e in entries):
            problems.append(f"UNACCEPTED: {l}")
    for e in entries:
        if not any(fnmatch.fnmatchcase(l, e) for l in lines):
            problems.append(f"STALE accept line (matches nothing): {e}")
    return problems


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--base", help="git ref of the version users have (default: the newest desktop-v* tag)")
    ap.add_argument("--data", default=str(DEFAULT_DATA), help="a desktop data dir to copy (read-only)")
    ap.add_argument("--accept", help="the differences this release intends (see the module doc)")
    ap.add_argument("--version", help="the version being released; must match the accept file")
    args = ap.parse_args()
    base = args.base or subprocess.run(["git", "describe", "--tags", "--abbrev=0", "--match", "desktop-v*"],
                                       cwd=REPO, capture_output=True, text=True, check=True).stdout.strip()
    data = Path(os.path.expanduser(args.data))
    for need in ("market.sqlite", "user.sqlite"):
        if not (data / need).exists():
            sys.exit(f"FATAL: {data / need} missing; the regression diff needs real data (fail closed)")
    with tempfile.TemporaryDirectory(prefix="regdiff-") as tmp:
        work = Path(tmp)
        wt = work / "base"
        subprocess.run(["git", "worktree", "add", "-q", "--detach", str(wt), base], cwd=REPO, check=True)
        try:
            snapshot(data, work / "snap")
            a = run_side(wt, work / "snap", work, "base")
            b = run_side(REPO, work / "snap", work, "new")
        finally:
            subprocess.run(["git", "worktree", "remove", "--force", str(wt)], cwd=REPO)
    print(f"regression diff: {base} -> working tree, data {data}")
    print(f"  compared {len(a['values'])} currencies, {len(a['cards'])} price cards, "
          f"{len(a['market_table'])} market rows, {sum(len(v) for v in a['hold'].values())} hold rows, "
          f"{len(a['loops'])} exchange-only loops, {len(a['routes']['pool'])} pool routes, {len(a['convert'])} conversions")
    if len(a["values"]) < 50 or len(a["loops"]) < 10 or not any(a["hold"].values()):
        sys.exit("FATAL: too little data to compare (fewer than 50 currencies / 10 loops, or no Hold rows); fail closed")
    lines = diff(a, b)
    if not lines:
        print("  NO DIFFERENCES")
        return
    print(f"  {len(lines)} DIFFERENCE(S):")
    for l in lines:
        print("   ", l)
    if args.accept or args.version:
        problems = check_accept(lines, args.accept, args.version)
        if not problems:
            print(f"  all {len(lines)} accepted for {args.version} ({args.accept})")
            return
        print("  NOT ACCEPTED:")
        for p in problems:
            print("   ", p)
    sys.exit(1)


if __name__ == "__main__":
    main()
