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
cp "dist/poe2arb-backend$EXE" backend-bin/
rm -rf "$WORK" dist poe2arb-backend.spec
# Smoke-run the frozen sidecar dispatch path in the build environment.
"backend-bin/poe2arb-backend$EXE" --sidecar --selftest
echo "backend-bin/ ready:"
ls -la backend-bin/
