#!/bin/bash
# One lint step by name, from the repo root. ops/lint.sh is the caller; this file is the one list of
# what each step runs. Every tool gets its config from ops/lint/ explicitly and its file list from git.
set -euo pipefail
cd "$(dirname "$0")/../.."

case "${1:-}" in
  suppressions) node ops/lint/no-suppressions.mjs ;;
  toolchain) ops/lint/toolchain.sh ;;
  guard) node ops/lint/guard.mjs ;;
  self-tests)
    node --test "ops/lint/*.test.mjs"
    .venv-test/bin/python -m pytest ops/lint -q -p no:cacheprovider
    ;;
  ruff | ruff-format | pyright | flake8-async | vulture) ops/lint/python-steps.sh "$1" ;;
  eslint | oxlint | stylelint | tsc | knip | html | lockfiles) ops/lint/js-steps.sh "$1" ;;
  tokens) node frontend/scripts/lint-style.mjs ;;
  shell | shfmt | docker | actions | yaml | json | installer | markdown | links | typos | editorconfig | secrets)
    ops/lint/infra-steps.sh "$1"
    ;;
  *)
    echo "unknown lint step: ${1:-<none>} (see STEPS in ops/lint.sh)" >&2
    exit 2
    ;;
esac
