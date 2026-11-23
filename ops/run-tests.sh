#!/bin/bash
# The gate every deploy script runs BEFORE it touches anything remote (owner directive 2026-09-16:
# tests live in the deploy scripts, not in GitHub Actions). Exits nonzero on the first failing part,
# so a deploy/publish aborts before a rsync, a tag push, or a release upload.
#
#   ./ops/run-tests.sh    # lint, dependency audits, then every product test suite
#
# It takes no arguments: there is no way to skip a part. For the fix loop run a part on its own:
# ./ops/lint.sh [step...] or ./ops/tests.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

if [[ $# -gt 0 ]]; then
  echo "FATAL: ops/run-tests.sh takes no arguments (got: $*)" >&2
  exit 2
fi

ops/lint.sh
ops/audit.sh
ops/tests.sh
