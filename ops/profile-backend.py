#!/usr/bin/env python3
"""Repeatable backend microbenchmark and PyInstaller archive inspector for Arbiter.

Always runs against a disposable copy of market.sqlite inside a temporary DATA_DIR
(never touches ~/Library/Application Support/Arbiter/data).

Modes:
  1. Compute microbenchmarks (default):
     DATA_DIR=/tmp/... .venv-test/bin/python ops/profile-backend.py [--db path/to/market.sqlite] [--runs 5]
  2. PyInstaller binary contaminant & size inspection:
     desktop/.venv-build/bin/python ops/profile-backend.py --pyi-inspect desktop/backend-bin/poe2arb-backend
"""
from __future__ import annotations

import argparse
import gzip
import importlib
import json
import math
import os
import resource
import shutil
import sqlite3
import statistics
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Packages known to be pulled in only when a dev/audit venv leaks into PyInstaller.
CONTAMINANT_TOP_LEVEL = {
    "PIL",
    "aiohappyeyeballs",
    "aiohttp",
    "aiosignal",
    "attr",
    "attrs",
    "boolean",
    "cachecontrol",
    "charset_normalizer",
    "cyclonedx",
    "discord",
    "filelock",
    "frozenlist",
    "license_expression",
    "markdown_it",
    "mdurl",
    "msgpack",
    "multidict",
    "nacl",
    "opentelemetry",
    "packageurl",
    "pip_api",
    "pip_audit",
    "pip_requirements_parser",
    "pkg_resources",
    "platformdirs",
    "propcache",
    "pygments",
    "requests",
    "rich",
    "sortedcontainers",
    "toml",
    "urllib3",
    "yarl",
}


def inspect_pyinstaller(bin_path: Path) -> dict:
    """Break down a PyInstaller --onefile binary by subsystem and flag venv contaminants."""
    try:
        from PyInstaller.archive.readers import CArchiveReader
    except ImportError as exc:
        return {"available": False, "error": f"PyInstaller not importable: {exc}"}

    if not bin_path.exists():
        return {"available": False, "error": f"Binary not found: {bin_path}"}

    arch = CArchiveReader(str(bin_path))
    groups: dict[str, int] = {}
    contam_native_bytes = 0
    pil_markers = (
        "libjpeg",
        "libtiff",
        "libwebp",
        "libopenjp2",
        "liblcms",
        "libxcb",
        "libavif",
        "libbrotli",
        "libharfbuzz",
        "libfreetype",
        "libpng",
    )

    for name, (_pos, dlen, _ulen, _flag, _typcd) in arch.toc.items():
        if name.startswith("PIL") or any(m in name for m in pil_markers):
            key = "PIL/Pillow (contaminant)"
            contam_native_bytes += dlen
        elif name.startswith(("aiohttp", "multidict", "yarl", "frozenlist", "propcache")):
            key = "aiohttp stack (contaminant)"
            contam_native_bytes += dlen
        elif name.startswith(("discord", "nacl")):
            key = "discord/nacl (contaminant)"
            contam_native_bytes += dlen
        elif name.startswith(("charset_normalizer", "opentelemetry", "attrs-", "rich", "pygments")):
            key = "other contaminants"
            contam_native_bytes += dlen
        elif name.startswith("cryptography") or "libcrypto" in name or "libssl" in name or "_rust.abi3" in name:
            key = "cryptography/ssl"
        elif name.startswith("numpy") or "openblas" in name or "libgfortran" in name or "libquadmath" in name:
            key = "numpy"
        elif name.startswith("pydantic"):
            key = "pydantic_core"
        elif name == "PYZ.pyz":
            key = "PYZ.pyz"
        elif name.startswith(("Python.framework", "libpython", "python", "lib-dynload")):
            key = "python-runtime"
        else:
            key = "other"
        groups[key] = groups.get(key, 0) + dlen

    pyz_groups: dict[str, int] = {}
    pyz_contam_pkgs: dict[str, int] = {}
    if "PYZ.pyz" in arch.toc:
        pyz_arch = arch.open_embedded_archive("PYZ.pyz")
        for name, (_ispkg, _pos, length) in pyz_arch.toc.items():
            pkg = name.split(".")[0]
            pyz_groups[pkg] = pyz_groups.get(pkg, 0) + length
            if pkg in CONTAMINANT_TOP_LEVEL:
                pyz_contam_pkgs[pkg] = pyz_contam_pkgs.get(pkg, 0) + length

    contam_pyz_bytes = sum(pyz_contam_pkgs.values())
    total_contam_bytes = contam_native_bytes + contam_pyz_bytes

    return {
        "available": True,
        "sizeBytes": bin_path.stat().st_size,
        "groupsMB": {k: round(v / 1048576, 2) for k, v in sorted(groups.items(), key=lambda x: -x[1])},
        "contaminantNativeMB": round(contam_native_bytes / 1048576, 2),
        "contaminantPyzMB": round(contam_pyz_bytes / 1048576, 2),
        "contaminantTotalMB": round(total_contam_bytes / 1048576, 2),
        "contaminantPackagesKB": {
            k: round(v / 1024, 1) for k, v in sorted(pyz_contam_pkgs.items(), key=lambda x: -x[1])[:15]
        },
        "topPyzPackagesKB": {
            k: round(v / 1024, 1) for k, v in sorted(pyz_groups.items(), key=lambda x: -x[1])[:15]
        },
    }


def resolve_market_db(explicit_db: str | None, tmp_dir: Path) -> tuple[Path, str]:
    """Copy or decompress a market.sqlite snapshot into tmp_dir without touching the source."""
    dst = tmp_dir / "market.sqlite"
    if explicit_db:
        src = Path(explicit_db).expanduser().resolve()
        if not src.exists():
            raise FileNotFoundError(f"Explicit --db not found: {src}")
        if src.suffix == ".gz":
            with gzip.open(src, "rb") as fin, open(dst, "wb") as fout:
                shutil.copyfileobj(fin, fout)
        else:
            shutil.copy2(src, dst)
        return dst, str(src)

    candidates = [
        Path.home() / "Library" / "Application Support" / "Arbiter" / "data" / "market.sqlite",
        ROOT / "data" / "market.sqlite",
        ROOT / "desktop" / "market-seed" / "market-seed.sqlite.gz",
    ]
    for src in candidates:
        if src.exists():
            if src.suffix == ".gz":
                with gzip.open(src, "rb") as fin, open(dst, "wb") as fout:
                    shutil.copyfileobj(fin, fout)
            else:
                shutil.copy2(src, dst)
            return dst, str(src)
    raise FileNotFoundError("No market.sqlite or market-seed.sqlite.gz found; pass --db <path>.")


def run_benchmarks(db_arg: str | None, runs: int) -> dict:
    tmp_dir = Path(tempfile.mkdtemp(prefix="arbiter-prof-py-"))
    try:
        db_copy, db_source = resolve_market_db(db_arg, tmp_dir)

        # Must configure DATA_DIR before importing app.* (config.py creates DATA_DIR at import time).
        os.environ["DATA_DIR"] = str(tmp_dir)
        os.environ["MARKET_SEED"] = ""
        os.environ["POE2_DISABLE_POLL"] = "1"
        os.environ["POE2_DISABLE_SIDECAR"] = "1"
        sys.path.insert(0, str(ROOT / "backend"))

        t_import0 = time.perf_counter()
        from app import db, digest, holdscore, inflation, leaguearc, liquidity, settings
        import app.arbitrage
        board_mod = sys.modules["app.arbitrage.board"]
        graph_mod = sys.modules["app.arbitrage.graph"]
        routes_mod = sys.modules["app.arbitrage.routes"]
        import_boot_ms = round((time.perf_counter() - t_import0) * 1000, 1)

        with db.q() as c:
            league, n_league, max_hour = c.execute(
                "SELECT league, COUNT(*), MAX(hour) FROM digest_markets "
                "GROUP BY league ORDER BY COUNT(*) DESC LIMIT 1"
            ).fetchone()
            n_digest_all = c.execute("SELECT COUNT(*) FROM digest_markets").fetchone()[0]
            n_daily = c.execute("SELECT COUNT(*) FROM league_daily").fetchone()[0]

        age_h = max(0.0, (time.time() - (max_hour or 0)) / 3600.0)
        # Ensure the snapshot always populates the full graph even when testing an older DB.
        digest_max_age_h = max(24, int(math.ceil(age_h)) + 2)
        settings.save_settings({"league": league, "digest_max_age_h": digest_max_age_h})

        def flush_all() -> None:
            for mod in (digest, holdscore, leaguearc, inflation, board_mod, graph_mod, routes_mod):
                for attr in dir(mod):
                    v = getattr(mod, attr)
                    if isinstance(v, dict) and ("cache" in attr.lower() or attr.startswith("_c") or attr == "_CACHE"):
                        v.clear()
                    if hasattr(v, "cache_clear"):
                        v.cache_clear()
            holdscore.invalidate()

        def bench(fn, n: int = runs, flush: bool = False):
            times = []
            res = None
            for _ in range(n):
                if flush:
                    flush_all()
                t0 = time.perf_counter()
                res = fn()
                times.append((time.perf_counter() - t0) * 1000)
            return res, {
                "firstMs": round(times[0], 1),
                "medMs": round(statistics.median(times), 1),
                "minMs": round(min(times), 1),
                "runs": n,
            }

        ops: dict[str, dict] = {}
        cold_runs = max(2, min(3, runs))

        rates, ops["digest.latest_rates(24h)"] = bench(
            lambda: digest.latest_rates(league, digest_max_age_h), n=runs, flush=True
        )
        ops["digest.latest_rates(24h)"]["edges"] = len(rates)

        g, ops["Graph.build()"] = bench(lambda: graph_mod.Graph.build(), n=runs, flush=True)
        g = graph_mod.cached_graph()
        if len(g.adj) == 0:
            raise RuntimeError(
                f"Graph.build() produced 0 nodes (league={league}, max_age_h={digest_max_age_h}, age_h={age_h:.1f})"
            )
        ops["Graph.build()"]["nodes"] = len(g.adj)

        b, ops["board._board(24h)"] = bench(lambda: board_mod._board(24, {}), n=runs, flush=False)
        rows = b.get("rows") or []
        card_ids = [r["id"] for r in rows[:12]] or [
            "divine", "chaos", "exalted", "annul", "vaal", "regal",
            "chance", "alchemy", "mirror", "hinekora", "gcp", "artificer",
        ]
        ops["board._board(24h)"]["rows"] = len(rows)

        cs, ops["board.cards(12, 24h)"] = bench(lambda: board_mod.cards(card_ids, 24), n=runs, flush=False)
        ops["board.cards(12, 24h)"]["cards"] = len(cs)

        def find_routes_cold():
            for attr in dir(routes_mod):
                v = getattr(routes_mod, attr)
                if isinstance(v, dict) and ("cache" in attr.lower() or attr.startswith("_c")):
                    v.clear()
            return routes_mod._find_routes(None, None)

        r_out, ops["routes._find_routes(default)"] = bench(find_routes_cold, n=cold_runs, flush=False)
        ops["routes._find_routes(default)"]["candidates"] = r_out.get("total_candidates", 0)
        ops["routes._find_routes(default)"]["routes"] = len(r_out.get("routes", []))
        rv = r_out["ref_values"]

        r_vaal, ops["liquidity.realizable(1000 vaal)"] = bench(
            lambda: liquidity.realizable(g, rv, "vaal", 1000.0), n=runs, flush=False
        )
        ops["liquidity.realizable(1000 vaal)"]["realizableRef"] = round(float(r_vaal.get("realizable_ref") or 0), 1)

        r_annul, ops["liquidity.realizable(50 annul)"] = bench(
            lambda: liquidity.realizable(g, rv, "annul", 50.0), n=runs, flush=False
        )
        ops["liquidity.realizable(50 annul)"]["realizableRef"] = round(float(r_annul.get("realizable_ref") or 0), 1)

        h_cold, ops["holdscore.leaderboard(cold)"] = bench(
            lambda: holdscore.leaderboard("3d", "all", "divine"), n=cold_runs, flush=True
        )
        ops["holdscore.leaderboard(cold)"]["items"] = len(h_cold.get("items") or h_cold.get("rows") or [])

        h_warm, ops["holdscore.leaderboard(Currency,warm)"] = bench(
            lambda: holdscore.leaderboard("3d", "Currency", "divine"), n=runs, flush=False
        )
        ops["holdscore.leaderboard(Currency,warm)"]["items"] = len(h_warm.get("items") or h_warm.get("rows") or [])

        arc_out, ops["leaguearc.arc_for(Divine Orb,cold)"] = bench(
            lambda: leaguearc.arc_for("Divine Orb", "divine"), n=cold_runs, flush=True
        )
        ops["leaguearc.arc_for(Divine Orb,cold)"]["historyPoints"] = len(arc_out.get("history") or [])
        _, ops["leaguearc.arc_for(Divine Orb,warm)"] = bench(
            lambda: leaguearc.arc_for("Divine Orb", "divine"), n=runs, flush=False
        )

        for anc in ("lock", "divine", "mirror"):
            inf, ops[f"inflation.compute({anc},336h)"] = bench(
                lambda a=anc: inflation.compute(a, 336), n=cold_runs, flush=True
            )
            ops[f"inflation.compute({anc},336h)"]["series"] = len(inf.get("series") or [])

        # macOS ru_maxrss is in bytes; Linux is in kilobytes.
        ru = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        peak_rss_mb = round(ru / (1048576 if sys.platform == "darwin" else 1024), 1)

        return {
            "db": {
                "source": db_source,
                "sizeMB": round(db_copy.stat().st_size / 1048576, 1),
                "league": league,
                "leagueDigestRows": n_league,
                "totalDigestRows": n_digest_all,
                "leagueDailyRows": n_daily,
                "digestAgeHours": round(age_h, 1),
                "digestMaxAgeH": digest_max_age_h,
            },
            "importBootMs": import_boot_ms,
            "peakRssMB": peak_rss_mb,
            "ops": ops,
        }
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Arbiter repeatable backend microbenchmark & PyInstaller inspector")
    parser.add_argument("--db", help="Path to market.sqlite or market-seed.sqlite.gz")
    parser.add_argument("--runs", type=int, default=5, help="Iterations per benchmark (default: 5)")
    parser.add_argument("--pyi-inspect", help="Inspect a PyInstaller --onefile binary instead of running compute benchmarks")
    args = parser.parse_args()

    if args.pyi_inspect:
        result = inspect_pyinstaller(Path(args.pyi_inspect).resolve())
    else:
        result = run_benchmarks(args.db, max(2, args.runs))

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
