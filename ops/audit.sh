#!/bin/bash
# Known-vulnerability audits of every dependency set. Needs the network, so it is not part of
# ops/lint.sh; ops/run-tests.sh runs it, and a failed lookup fails the gate.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

for manifest in backend/requirements.txt backend/requirements-sidecar.txt \
  ops/feedback-bot/requirements-bot.txt ops/feedback-bot/requirements-opener.txt \
  ops/lint/requirements.txt ops/lint/requirements-test.txt; do
  echo "== audit: ${manifest}"
  .venv-lint/bin/pip-audit --strict -r "${manifest}"
done

for package in frontend desktop ops/lint; do
  echo "== audit: ${package}/package-lock.json"
  npm --prefix "${package}" audit --package-lock-only --audit-level=low
done

echo "== audits passed"
