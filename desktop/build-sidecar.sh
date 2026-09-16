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

# --collect-all stumpy is REQUIRED: at runtime stumpy.cache enumerates its own package dir to
# discover njit functions; onefile mode has no source on disk unless we bundle it as data
# (validated during the Phase-6 spike — without it the frozen binary FileNotFoundErrors on import).
WORK=.pyi-work-sidecar
pyinstaller --noconfirm --clean --onefile \
  --name poe2arb-sidecar \
  --workpath "$WORK" \
  --paths ../backend \
  --collect-all stumpy \
  ../backend/sidecar/run_sidecar.py

mkdir -p sidecar-bin
cp "dist/poe2arb-sidecar$( [ "$(uname -s)" = "Windows_NT" ] && echo .exe || true )" sidecar-bin/
rm -rf "$WORK" dist poe2arb-sidecar.spec
echo "sidecar-bin/ ready:"
ls -la sidecar-bin/
