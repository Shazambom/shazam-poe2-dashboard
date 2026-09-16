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
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*|Windows_NT) SEP=';'; EXE=.exe ;; *) SEP=':'; EXE= ;; esac
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
  ../backend/run_desktop.py

mkdir -p backend-bin
cp "dist/poe2arb-backend$EXE" backend-bin/
rm -rf "$WORK" dist poe2arb-backend.spec
echo "backend-bin/ ready:"
ls -la backend-bin/
