#!/usr/bin/env python3
"""Drive the seed TEST ENV on shazam through the scenarios the live run has not reached on its own
(docs/bugs/2026-09-28-partial-sync-data.md), against real poe2scout, and grade each one.

    python3 ops/seedtest-scenarios.py            # all scenarios
    python3 ops/seedtest-scenarios.py catchup    # one (catchup, repeat, noop, frozen, withdrawn, guard, restart)
    python3 ops/seedtest-scenarios.py status     # what poe2scout has finished vs each league's cut

It only ever touches the TEST ENV: the `poe2-seedtest-backend` container and /home/shazam/seedtest
(a copy of production's DB, a publisher that archives instead of uploading). Production's backend, DB,
cron line and the market-seed-latest release are never read for writing. Every command goes through
`sshshazambom`. Each scenario sets a state in the test DB, runs the REAL poll (app/seedready.poll) and
the REAL publisher inside the test container, checks the outcome and the poe2scout request count, and
leaves the test DB consistent (the poll itself repairs what the scenario broke).

Scenarios:
  catchup    poe2scout finishing a day: N items per league get mid-day values for the cut day and the
             last publish is rewound a day. The poll must fetch exactly those items, restore the cut,
             and the publisher must archive an upgraded seed.
  repeat     an immediate second poll fetches nothing (no spam while nothing changed).
  noop       a second publisher run the same day, nothing newer: no archive.
  frozen     items whose history stopped days ago (the old price-floor bug) are fetched once.
  withdrawn  a row poe2scout does not report is removed by the refetch, not shipped.
  guard      a current league with no verified day makes the publisher fail loudly, archive nothing.
  restart    (opt-in: `restart`) a container restart repeats no poll work.
"""
from __future__ import annotations

import base64
import json
import re
import subprocess
import sys
import time

CONTAINER = "poe2-seedtest-backend"
ROOT = "/home/shazam/seedtest"
PUBLISH = (f"sudo env SEED_REPO={ROOT} SEED_CONTAINER={CONTAINER} SEED_UPLOADER={ROOT}/bin/archive-seed.sh "
           f"GH_TOKEN=unused {ROOT}/bin/publish-market-snapshot.sh")
N_CATCHUP, N_FROZEN = 25, 5
QUIET_MINUTES = {range(45, 60), range(0, 2)}      # the test cron (:47) and hourly poll drift (~:50)


# ------------------------------------------------------------------ shazam plumbing
def sh(cmd: str, check: bool = True) -> subprocess.CompletedProcess:
    r = subprocess.run(["bash", "-lc", f"sshshazambom {cmd}"], capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"{cmd[:80]}… exited {r.returncode}: {r.stderr[-400:]}")
    return r


def inside_full(py: str) -> subprocess.CompletedProcess:
    """Run a python snippet inside the TEST container (cwd /app, DATA_DIR=/data = the test DB)."""
    b64 = base64.b64encode(py.encode()).decode()
    return sh(f"sudo docker exec {CONTAINER} sh -c \"'echo {b64} | base64 -d > /tmp/scn.py && python /tmp/scn.py'\"", check=False)


def inside(py: str) -> str:
    r = inside_full(py)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-800:])
    return r.stdout


def result(out: str):
    for line in out.splitlines():
        if line.startswith("RESULT "):
            return json.loads(line[7:])
    raise RuntimeError(f"no RESULT line in:\n{out[-800:]}")


PRELUDE = """
import asyncio, json, logging, sys
sys.path.insert(0, "/app")
logging.basicConfig(level=logging.INFO, stream=sys.stderr)
from app import db, seedready as sr, gateway
LEAGUES = db.kv_get("lh_current") or []
def out(x): print("RESULT " + json.dumps(x, default=str))
"""


def poll() -> tuple[dict, dict]:
    """Run one real poll; returns (per-league result, poe2scout requests by kind)."""
    r = inside_full(PRELUDE + """
async def m():
    try: return await sr.poll()
    finally: await gateway.client().aclose()
out(asyncio.run(m()))
""")
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-800:])
    reqs = {"history": 0, "listing": 0, "other": 0}
    for line in r.stderr.splitlines():
        if "api.poe2scout.com" in line:
            reqs["history" if "DailyStatsHistory" in line else "listing" if "ByCategory" in line else "other"] += 1
    return result(r.stdout), reqs


def publish() -> subprocess.CompletedProcess:
    return sh(PUBLISH, check=False)


def cuts() -> dict:
    return result(inside(PRELUDE + 'out({lg: db.kv_get(f"seed_cut:{lg}") for lg in LEAGUES})'))


def prev_day(day: str) -> str:
    import datetime
    return (datetime.date.fromisoformat(day) - datetime.timedelta(days=1)).isoformat()


# ------------------------------------------------------------------ grading
FAILS: list[str] = []


def check(ok: bool, what: str) -> None:
    print(f"    {'PASS' if ok else 'FAIL'}  {what}")
    if not ok:
        FAILS.append(what)


def preflight() -> dict:
    names = sh("sudo docker ps --format {{.Names}}").stdout.split()
    if CONTAINER not in names:
        raise SystemExit(f"{CONTAINER} is not running — the test env is down")
    minute = time.gmtime().tm_min
    if any(minute in r for r in QUIET_MINUTES):
        raise SystemExit(f"it is :{minute:02d} UTC — too close to the test env's own hourly publish/poll; "
                         f"run between :02 and :44")
    busy = result(inside(PRELUDE + """
import urllib.request
out(json.load(urllib.request.urlopen("http://127.0.0.1:8000/api/backfill")))"""))
    if busy.get("running"):
        raise SystemExit(f"the test env's crawl is running ({busy.get('league')} {busy.get('pct')}%) — try later")
    c = cuts()
    if not c or any(v is None or v.get("day") is None for v in c.values()):
        raise SystemExit(f"no verified day yet for every league: {c}")
    return c


# ------------------------------------------------------------------ scenarios
def s_catchup(base: dict) -> None:
    print(f"\n[catchup] {N_CATCHUP} items per league get mid-day values for their cut day; last publish rewound a day")
    picked = result(inside(PRELUDE + f"""
picked = {{}}
for lg in LEAGUES:
    day = db.kv_get(f"seed_cut:{{lg}}")["day"]
    with db.tx() as c:
        ids = [r[0] for r in c.execute("SELECT item_id FROM league_daily WHERE league=? AND day=? AND volume>3 ORDER BY item_id LIMIT {N_CATCHUP}", (lg, day))]
        c.executemany("UPDATE league_daily SET volume=volume/3, average=average*0.9 WHERE league=? AND item_id=? AND day=?", [(lg, i, day) for i in ids])
    picked[lg] = ids
prev = json.load(open("/data/market-seed.published-cut"))
prev["cuts"] = {{lg: str(__import__("datetime").date.fromisoformat(v) - __import__("datetime").timedelta(days=1)) for lg, v in prev["cuts"].items()}}
json.dump(prev, open("/data/market-seed.published-cut", "w"))
out(picked)"""))
    res, reqs = poll()
    for lg, ids in picked.items():
        r = res.get(lg, {})
        check(r.get("fetched") == len(ids) and not r.get("failed"), f"{lg}: fetched exactly the {len(ids)} rolled-back items (got {r.get('fetched')}, failed {r.get('failed')})")
        check(r.get("cut") == base[lg]["day"] and not r.get("stale"), f"{lg}: cut back to {base[lg]['day']} with nothing stale (got {r.get('cut')}, stale {len(r.get('stale') or [])})")
    check(reqs["history"] == sum(len(v) for v in picked.values()), f"item requests = rolled-back items only ({reqs['history']})")
    p = publish()
    check(p.returncode == 0 and "ARCHIVED" in p.stdout, "publisher archived an upgraded seed")
    m = re.search(r'ARCHIVED \(not uploaded\): (\S+) (\{.*\})', p.stdout)
    if m:
        got = json.loads(m.group(2))["cuts"]
        check(got == {lg: base[lg]["day"] for lg in base}, f"archived seed ends on each league's cut ({got})")
        verify_archive(m.group(1).rstrip("/"))


def verify_archive(path: str) -> None:
    out = inside(PRELUDE + """
import gzip, shutil, sqlite3
with gzip.open("/data/market-seed.sqlite.gz") as fi, open("/tmp/scn.sqlite", "wb") as fo: shutil.copyfileobj(fi, fo)
c = sqlite3.connect("/tmp/scn.sqlite")
cur = json.loads(c.execute("select value from kv_ops where key='lh_current'").fetchone()[0])
res = {"fp": c.execute("select count(*) from kv_ops where key like 'seed_fp:%'").fetchone()[0], "ok": c.execute("pragma quick_check").fetchone()[0], "leagues": {}}
for lg in cur:
    cut = json.loads(c.execute("select value from kv_ops where key=?", (f"seed_cut:{lg}",)).fetchone()[0])["day"]
    res["leagues"][lg] = [cut, c.execute("select max(day) from league_daily where league=?", (lg,)).fetchone()[0]]
import os; os.remove("/tmp/scn.sqlite")
out(res)""")
    r = result(out)
    check(r["ok"] == "ok", "archived seed passes quick_check")
    check(r["fp"] == 0, "no seed_fp bookkeeping in the seed")
    for lg, (cut, last) in r["leagues"].items():
        check(last == cut, f"{lg}: last shipped day {last} == cut {cut}")


def s_repeat(base: dict) -> None:
    print("\n[repeat] an immediate second poll")
    res, reqs = poll()
    check(all(r.get("fetched") == 0 for r in res.values()), f"fetched nothing ({ {lg: r.get('fetched') for lg, r in res.items()} })")
    check(reqs["history"] == 0, f"no item requests, listing only ({reqs})")


def s_noop(base: dict) -> None:
    print("\n[noop] a second publisher run with nothing newer")
    before = sh(f"sudo ls -1 {ROOT}/published").stdout.split()
    p = publish()
    after = sh(f"sudo ls -1 {ROOT}/published").stdout.split()
    check(p.returncode == 0 and "nothing newer" in p.stdout, "publisher says nothing newer and exits 0")
    check(before == after, "no new archive")


def s_frozen(base: dict) -> None:
    print(f"\n[frozen] {N_FROZEN} items per league lose their last 5 days (history that stopped)")
    picked = result(inside(PRELUDE + f"""
import datetime
picked = {{}}
for lg in LEAGUES:
    day = db.kv_get(f"seed_cut:{{lg}}")["day"]
    since = str(datetime.date.fromisoformat(day) - datetime.timedelta(days=4))
    with db.tx() as c:
        ids = [r[0] for r in c.execute("SELECT item_id FROM league_daily WHERE league=? AND day=? ORDER BY item_id DESC LIMIT {N_FROZEN}", (lg, day))]
        c.executemany("DELETE FROM league_daily WHERE league=? AND item_id=? AND day>=?", [(lg, i, since) for i in ids])
    picked[lg] = ids
out(picked)"""))
    res, reqs = poll()
    for lg, ids in picked.items():
        r = res.get(lg, {})
        check(r.get("fetched") == len(ids) and r.get("cut") == base[lg]["day"], f"{lg}: fetched the {len(ids)} frozen items once, cut {r.get('cut')}")
    check(reqs["history"] == sum(len(v) for v in picked.values()), f"item requests = frozen items only ({reqs['history']})")


def s_withdrawn(base: dict) -> None:
    print("\n[withdrawn] a row poe2scout does not report is planted inside the window")
    planted = result(inside(PRELUDE + """
async def m():
    try:
        planted = {}
        for lg in LEAGUES:
            listing = await sr._listing(lg)
            through = sr.final_through(listing)
            days = sr._days(min(d for v in listing.values() for d in v), through)
            with db.q() as c:
                tracked = {r[0] for r in c.execute("SELECT DISTINCT item_id FROM league_daily WHERE league=?", (lg,))}
            for item in sorted(tracked & set(listing)):
                gap = [d for d in days if d not in listing[item]]
                if gap and listing[item]:
                    with db.tx() as c:
                        c.execute("INSERT OR REPLACE INTO league_daily VALUES (?,?,?,1.0,1.0,1)", (lg, item, gap[0]))
                    planted[lg] = [item, gap[0]]
                    break
        return planted
    finally:
        await gateway.client().aclose()
out(asyncio.run(m()))"""))
    if not planted:
        check(False, "found a thin item/day to plant a row on")
        return
    res, _ = poll()
    for lg, (item, day) in planted.items():
        gone = result(inside(PRELUDE + f'''
with db.q() as c: out(c.execute("SELECT COUNT(*) FROM league_daily WHERE league=? AND item_id=? AND day=?", ({lg!r}, {item}, {day!r})).fetchone()[0])'''))
        check(gone == 0, f"{lg}: planted row for item {item} on {day} removed by the refetch")
        check(res[lg].get("cut") == base[lg]["day"], f"{lg}: cut still {base[lg]['day']} ({res[lg].get('cut')})")


def s_guard(base: dict) -> None:
    lg = sorted(base)[0]
    print(f"\n[guard] {lg} loses its verified day")
    saved = result(inside(PRELUDE + f'v = db.kv_get("seed_cut:{lg}")\nwith db.tx() as c: c.execute("DELETE FROM kv_ops WHERE key=?", ("seed_cut:{lg}",))\nout(v)'))
    try:
        before = sh(f"sudo ls -1 {ROOT}/published").stdout.split()
        p = publish()
        after = sh(f"sudo ls -1 {ROOT}/published").stdout.split()
        check(p.returncode != 0 and "no verified day" in (p.stdout + p.stderr), "publisher fails loudly naming the league")
        check(before == after, "nothing archived")
    finally:
        inside(PRELUDE + f"db.kv_set('seed_cut:{lg}', json.loads({json.dumps(json.dumps(saved))}))\nout(1)")
        check(cuts()[lg] == saved, "verified day restored")


def s_restart(base: dict) -> None:
    print("\n[restart] container restart, then a poll")
    sh(f"sudo docker restart {CONTAINER}")
    for _ in range(60):                       # wait for startup and its crawl to finish
        time.sleep(15)
        r = inside_full(PRELUDE + 'import urllib.request\nout(json.load(urllib.request.urlopen("http://127.0.0.1:8000/api/backfill")))')
        if r.returncode == 0 and not result(r.stdout).get("running") and result(r.stdout).get("phase") == "done":
            break
    res, _ = poll()
    check(all(r.get("fetched") == 0 for r in res.values()), f"no repeated poll work after a restart ({ {lg: r.get('fetched') for lg, r in res.items()} })")


def status() -> None:
    out = inside(PRELUDE + """
async def m():
    try:
        rows = {}
        for lg in LEAGUES:
            listing = await sr._listing(lg)
            latest = max(d for v in listing.values() for d in v)
            rows[lg] = {"poe2scout_through": sr.final_through(listing), "latest_posted": latest, "cut": (db.kv_get(f"seed_cut:{lg}") or {}).get("day")}
        return rows
    finally:
        await gateway.client().aclose()
out(asyncio.run(m()))""")
    for lg, r in result(out).items():
        print(f"  {lg}: poe2scout finished {r['poe2scout_through']} (latest posted {r['latest_posted']}); test seed cut {r['cut']}")


SCENARIOS = {"catchup": s_catchup, "repeat": s_repeat, "noop": s_noop, "frozen": s_frozen,
             "withdrawn": s_withdrawn, "guard": s_guard, "restart": s_restart}
DEFAULT = ["catchup", "repeat", "noop", "frozen", "withdrawn", "guard"]


def main() -> None:
    want = sys.argv[1:] or DEFAULT
    if want == ["status"]:
        status()
        return
    unknown = [w for w in want if w not in SCENARIOS]
    if unknown:
        raise SystemExit(f"unknown scenario(s) {unknown}; choose from {list(SCENARIOS)} or status")
    base = preflight()
    print("verified days before:", {lg: v["day"] for lg, v in base.items()})
    for w in want:
        try:
            SCENARIOS[w](base)
        except Exception as exc:          # a broken scenario is a failure, not a crash of the rest
            check(False, f"{w}: {type(exc).__name__}: {str(exc)[:300]}")
    print(f"\n{'ALL PASSED' if not FAILS else f'{len(FAILS)} FAILED'}")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
