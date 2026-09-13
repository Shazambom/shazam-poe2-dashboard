#!/bin/bash
# Build the backend as a single local binary for the current OS (PyInstaller
# cannot cross-compile: run this on macOS for the mac binary, on Windows for
# the .exe). Output lands in desktop/backend-bin/.
set -euo pipefail
cd "$(dirname "$0")"

# Match the server's Python (3.12) — newer interpreters lack wheels for the pins.
PY=$(command -v python3.12 || command -v python3)
VENV=.venv-build
if [ ! -d "$VENV" ]; then "$PY" -m venv "$VENV"; fi
source "$VENV/bin/activate"
pip -q install -r ../backend/requirements.txt pyinstaller

pyinstaller --noconfirm --clean --onefile \
  --name poe2arb-backend \
  --paths ../backend \
  --add-data "../backend/data:data" \
  --collect-all pyrate_limiter \
  ../backend/run_desktop.py

mkdir -p backend-bin
cp "dist/poe2arb-backend$( [ "$(uname -s)" = "Windows_NT" ] && echo .exe || true )" backend-bin/
rm -rf build dist poe2arb-backend.spec
echo "backend-bin/ ready:"
ls -la backend-bin/
