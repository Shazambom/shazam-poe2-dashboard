#!/bin/bash
# Build the heavy-analytics SIDECAR as a single local binary for the current OS (PyInstaller
# cannot cross-compile: run on macOS for the mac binary, on Windows for the .exe). Output lands
# in desktop/sidecar-bin/. This is a SEPARATE binary from the backend so the backend stays lean;
# the backend spawns + supervises it (supervision tree Electron -> backend -> sidecar).
set -euo pipefail
cd "$(dirname "$0")"

# Match the server's Python (3.12).
PY="${PY:-$(command -v python3.12 || command -v python3 || command -v python)}"
# Windows (Git Bash on the CI runner): PyInstaller's --add-data separator is ';' and the venv
# activates from Scripts/. Everything else about the build is identical, which is the point —
# CI runs THIS script rather than a second copy of the pyinstaller invocation.
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*|Windows_NT) SEP=';'; EXE=.exe ;; *) SEP=':'; EXE= ;; esac
VENV=.venv-sidecar
if [ ! -d "$VENV" ]; then "$PY" -m venv "$VENV"; fi
if [ -f "$VENV/Scripts/activate" ]; then source "$VENV/Scripts/activate"; else source "$VENV/bin/activate"; fi
pip -q install -r ../backend/requirements-sidecar.txt pyinstaller

# Phase 7a: the sidecar is NUMPY ONLY (no stumpy/dtaidistance/numba), so no --collect-all is
# needed — numpy bundles cleanly and there's no native code to crash the frozen binary on Windows.
WORK=.pyi-work-sidecar
pyinstaller --noconfirm --clean --onefile \
  --name poe2arb-sidecar \
  --workpath "$WORK" \
  --paths ../backend \
  ../backend/sidecar/run_sidecar.py

mkdir -p sidecar-bin
cp "dist/poe2arb-sidecar$EXE" sidecar-bin/
rm -rf "$WORK" dist poe2arb-sidecar.spec
echo "sidecar-bin/ ready:"
ls -la sidecar-bin/
