#!/bin/bash
# Build the backend as a single local binary for the current OS (PyInstaller
# cannot cross-compile: run this on macOS for the mac binary, on Windows for
# the .exe). Output lands in desktop/backend-bin/.
set -euo pipefail
cd "$(dirname "$0")"

# Match the server's Python (3.12) — newer interpreters lack wheels for the pins.
PY="${PY:-$(command -v python3.12 || command -v python3 || command -v python)}"
# Windows (Git Bash on the CI runner): PyInstaller's --add-data separator is ';' and the venv
# activates from Scripts/. Everything else about the build is identical, which is the point —
# CI runs THIS script rather than a second copy of the pyinstaller invocation.
case "$(uname -s)" in MINGW* | MSYS* | CYGWIN* | Windows_NT)
  SEP=';'
  EXE=.exe
  ;;
*)
  SEP=':'
  EXE=
  ;;
esac
VENV=.venv-build
if [ ! -d "$VENV" ]; then "$PY" -m venv "$VENV"; fi
if [ -f "$VENV/Scripts/activate" ]; then source "$VENV/Scripts/activate"; else source "$VENV/bin/activate"; fi
pip -q install -r ../backend/requirements.txt pyinstaller

# IMPORTANT: override ONLY --workpath. PyInstaller's default workpath is ./build —
# which is our RESOURCES dir (icons + installer.nsh); it once wrote there and the
# cleanup deleted those files. dist/ and the .spec stay at the default (CWD) so the
# relative --add-data path still resolves; we just never touch build/.
WORK=.pyi-work
pyinstaller --noconfirm --clean --onefile \
  --name poe2arb-backend \
  --workpath "$WORK" \
  --paths ../backend \
  --add-data "../backend/data${SEP}data" \
  --collect-all pyrate_limiter \
  --hidden-import sidecar.run_sidecar \
  --hidden-import sidecar.runner \
  --hidden-import sidecar.analytics.discords \
  --hidden-import sidecar.analytics.arc \
  --exclude-module tkinter \
  --exclude-module _tkinter \
  --exclude-module unittest \
  --exclude-module pydoc \
  --exclude-module doctest \
  --exclude-module test \
  --exclude-module lib2to3 \
  --exclude-module idlelib \
  --exclude-module curses \
  --exclude-module pip \
  --exclude-module setuptools \
  --exclude-module pkg_resources \
  --exclude-module distutils \
  --exclude-module xmlrpc \
  --exclude-module ftplib \
  --exclude-module imaplib \
  --exclude-module smtplib \
  --exclude-module poplib \
  --exclude-module pdb \
  --exclude-module bdb \
  --exclude-module profile \
  --exclude-module cProfile \
  --exclude-module turtle \
  --exclude-module numpy.testing \
  --exclude-module numpy.tests \
  --exclude-module numpy._core.tests \
  --exclude-module numpy.f2py \
  --exclude-module numpy.distutils \
  --exclude-module numpy.doc \
  --exclude-module uvloop \
  --exclude-module httptools \
  --exclude-module websockets \
  --exclude-module watchfiles \
  --exclude-module yaml \
  --exclude-module dotenv \
  ../backend/run_desktop.py

mkdir -p backend-bin
rm -f "backend-bin/poe2arb-backend$EXE"
cp "dist/poe2arb-backend$EXE" backend-bin/
rm -rf "$WORK" dist poe2arb-backend.spec
# Smoke-run the frozen sidecar dispatch path, clean idle exit, and full HTTP boot.
"backend-bin/poe2arb-backend$EXE" --sidecar --selftest
python - "backend-bin/poe2arb-backend$EXE" << 'PY'
import os, shutil, socket, subprocess, sys, tempfile, time, urllib.request

exe = os.path.abspath(sys.argv[1])
tmp = tempfile.mkdtemp(prefix="arbiter-bin-smoke-")
try:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = os.environ.copy()
    env.update({
        "DATA_DIR": tmp,
        "MARKET_SEED": "",
        "PORT": str(port),
        "POE2_DISABLE_POLL": "1",
        "POE2_DISABLE_SIDECAR": "1",
    })
    # Write child output to a file rather than an unread PIPE (a noisy cold-boot log >64KB deadlocks PIPE).
    boot_log = os.path.join(tmp, "boot.log")
    with open(boot_log, "wb") as logf:
        proc = subprocess.Popen(
            [exe],
            stdin=subprocess.PIPE,
            stdout=logf,
            stderr=subprocess.STDOUT,
            env=env,
        )
        try:
            deadline = time.monotonic() + 20.0
            healthy = False
            while time.monotonic() < deadline:
                if proc.poll() is not None:
                    logf.flush()
                    out = open(boot_log, encoding="utf-8", errors="replace").read()[-4000:]
                    raise RuntimeError(f"frozen backend exited early rc={proc.returncode}:\n{out}")
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1.0) as r:
                        if r.status == 200:
                            healthy = True
                            break
                except Exception:
                    time.sleep(0.2)
            if not healthy:
                logf.flush()
                out = open(boot_log, encoding="utf-8", errors="replace").read()[-4000:]
                raise RuntimeError(f"frozen backend did not become healthy within 20s:\n{out}")
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/status", timeout=5.0) as r:
                if r.status != 200:
                    raise RuntimeError(f"/api/status returned {r.status}")
            proc.terminate()
            proc.wait(timeout=10.0)
            print(f"frozen backend HTTP boot smoke OK (port {port})")
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5.0)

    # Also verify frozen --sidecar exits cleanly on stdin close (parent-watchdog path, no SIGABRT).
    sc_env = os.environ.copy()
    sc_env.update({"DATA_DIR": tmp, "MARKET_DB": os.path.join(tmp, "market.sqlite")})
    sc = subprocess.Popen(
        [exe, "--sidecar"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=sc_env,
    )
    try:
        time.sleep(0.8)
        if sc.poll() is not None and sc.returncode != 0:
            out = sc.stdout.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"frozen sidecar crashed early rc={sc.returncode}:\n{out}")
        sc.stdin.close()
        rc = sc.wait(timeout=10.0)
        if rc != 0:
            out = sc.stdout.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"frozen sidecar exited rc={rc} on stdin close:\n{out}")
        print("frozen sidecar parent-watchdog smoke OK (rc=0)")
    finally:
        if sc.poll() is None:
            sc.kill()
            sc.wait(timeout=5.0)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
PY
echo "backend-bin/ ready:"
ls -la backend-bin/
