#!/bin/bash
# The product test suites: backend pytest, feedback bot pytest, frontend and desktop node tests,
# and the React lifecycle tests. ops/run-tests.sh runs this after the lint gate; it also runs on
# its own.
#
# Python: uses the repo's .venv-test if present (see docs/dev-notes.md → Testing), else $PY/python3.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -x ".venv-test/bin/python" ]; then PY="$ROOT/.venv-test/bin/python"; else PY="${PY:-python3}"; fi
"$PY" -c "import pytest" 2> /dev/null || {
  echo "FATAL: pytest not installed for $PY (see docs/dev-notes.md → Testing)"
  exit 1
}

echo "== backend: pytest"
(cd backend && DATA_DIR="$(mktemp -d)" MARKET_SEED= "$PY" -m pytest tests -q -p no:cacheprovider)

echo "== feedback bot + opener: pytest"
(cd ops/feedback-bot && "$PY" -m pytest tests -q -p no:cacheprovider)

echo "== frontend: node tests"
node --test "frontend/test/*.test.mjs" # a glob, not the folder: Node 22 rejects a bare directory
node frontend/test/workspace-store.fuzzy.mjs

echo "== frontend: react lifecycle tests (vitest)"
npm --prefix frontend run test:ui

if [ -d desktop/test ]; then
  echo "== desktop: node tests"
  node --test "desktop/test/*.test.mjs"
fi

echo "== all tests passed"
