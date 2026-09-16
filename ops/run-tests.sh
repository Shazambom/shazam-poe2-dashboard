#!/bin/bash
# The test gate every deploy script runs BEFORE it touches anything remote (owner directive
# 2026-09-16: tests live in the deploy scripts, not in GitHub Actions). Exits nonzero on the
# first failure so a deploy/publish aborts before a rsync, a tag push, or a release upload.
#
#   ./ops/run-tests.sh            # backend pytest + frontend/desktop node tests + UI style lint
#
# Python: uses the repo's .venv-test if present (see docs/dev-notes.md → Testing), else $PY/python3.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -x ".venv-test/bin/python" ]; then PY="$ROOT/.venv-test/bin/python"; else PY="${PY:-python3}"; fi
"$PY" -c "import pytest" 2>/dev/null || { echo "FATAL: pytest not installed for $PY (see docs/dev-notes.md → Testing)"; exit 1; }

echo "== backend: pytest"
( cd backend && DATA_DIR="$(mktemp -d)" MARKET_SEED= "$PY" -m pytest tests -q -p no:cacheprovider )

echo "== frontend: node tests"
node --test frontend/test/
node frontend/test/workspace-store.fuzzy.mjs

if [ -d desktop/test ]; then
  echo "== desktop: node tests"
  node --test desktop/test/
fi

echo "== frontend: style lint"
node frontend/scripts/lint-style.mjs

echo "== all tests passed"
