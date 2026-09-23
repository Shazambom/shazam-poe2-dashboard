"""The opener supervisor: watches SPOOL/in/ and, per file, runs the cell as a throwaway child under
rlimits and a wall clock, then writes SPOOL/out/<name>/result.json for the bot. The cell's exit
code is the verdict: 0 OK, 2 QUARANTINE, anything else (a crash, a kill) REFUSE. The supervisor
itself never parses a report. Network isolation is the container's (network_mode: none)."""
from __future__ import annotations

import json
import os
import re
import resource
import subprocess
import sys
import time
from pathlib import Path

RLIMITS = {
    resource.RLIMIT_AS: 512 * 1024 * 1024,     # address space
    resource.RLIMIT_CPU: 20,                    # seconds
    resource.RLIMIT_FSIZE: 64 * 1024 * 1024,   # one output file
    resource.RLIMIT_NPROC: 0,                   # no fork
    resource.RLIMIT_NOFILE: 16,
}
WALL_S = 30
SHORT_ID = re.compile(r"^[0-9A-HJ-NP-Z]{6}$")
DEFAULT_CELL = [sys.executable, "-m", "opener.cell"]


def _limits():
    for k, v in RLIMITS.items():
        try:
            resource.setrlimit(k, (v, v))
        except (ValueError, OSError):
            pass


def _short_id(outdir: Path) -> str:
    try:
        sid = json.loads((outdir / "report.json").read_text())["manifest"]["shortId"]
        return sid if isinstance(sid, str) and SHORT_ID.match(sid) else ""
    except Exception:
        return ""


def run_one(in_path: Path, outdir: Path, cell_argv=None, wall_s: float = WALL_S) -> dict:
    in_path, outdir = Path(in_path), Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    argv = list(cell_argv or DEFAULT_CELL) + [str(in_path), str(outdir)]
    env = {"PATH": os.environ.get("PATH", ""), "PYTHONPATH": str(Path(__file__).resolve().parents[1]), "HOME": str(outdir)}
    try:
        p = subprocess.run(argv, preexec_fn=_limits, timeout=wall_s, env=env, cwd=str(outdir),
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        code, err = p.returncode, p.stderr.decode(errors="replace")[-200:]
    except subprocess.TimeoutExpired:
        code, err = -1, "wall clock"
    except Exception as e:                                   # spawn failure
        code, err = -1, str(e)[:200]
    if code == 0:
        result = {"status": "OK", "shortId": _short_id(outdir), "reason": ""}
    elif code == 2:
        result = {"status": "QUARANTINE", "shortId": "", "reason": "not a readable report"}
    else:
        result = {"status": "REFUSE", "shortId": "", "reason": f"cell exit {code}: {err.strip()}"[:200]}
    tmp = outdir / "result.json.tmp"
    tmp.write_text(json.dumps(result))
    os.replace(tmp, outdir / "result.json")                 # atomic: the bot's poll never sees a half file
    try:
        in_path.unlink()
    except FileNotFoundError:
        pass
    return result


def watch(spool: Path, poll_s: float = 1.0) -> None:
    inbox, outbox = spool / "in", spool / "out"
    inbox.mkdir(parents=True, exist_ok=True)
    outbox.mkdir(parents=True, exist_ok=True)
    print(f"[opener] watching {inbox}", flush=True)
    while True:
        for f in sorted(inbox.glob("*.gz")):
            name = f.stem
            if not re.fullmatch(r"[0-9]{1,32}", name):      # the bot names spool files by thread id
                f.unlink(missing_ok=True)
                continue
            r = run_one(f, outbox / name)
            print(f"[opener] {name}: {r['status']} {r['reason']}", flush=True)
        time.sleep(poll_s)


if __name__ == "__main__":
    watch(Path(os.environ.get("SPOOL", "/spool")))
