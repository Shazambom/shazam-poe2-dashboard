#!/bin/bash
# Build the heavy-analytics SIDECAR as a single local binary for the current OS (PyInstaller
# cannot cross-compile: run on macOS for the mac binary, on Windows for the .exe). Output lands
# in desktop/sidecar-bin/. This is a SEPARATE binary from the backend so the backend stays lean;
# the backend spawns + supervises it (supervision tree Electron -> backend -> sidecar).
set -euo pipefail
cd "$(dirname "$0")"

# Match the server's Python (3.12).
PY=$(command -v python3.12 || command -v python3)
VENV=.venv-sidecar
if [ ! -d "$VENV" ]; then "$PY" -m venv "$VENV"; fi
source "$VENV/bin/activate"
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
cp "dist/poe2arb-sidecar$( [ "$(uname -s)" = "Windows_NT" ] && echo .exe || true )" sidecar-bin/
rm -rf "$WORK" dist poe2arb-sidecar.spec
echo "sidecar-bin/ ready:"
ls -la sidecar-bin/
