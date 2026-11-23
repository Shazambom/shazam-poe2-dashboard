#!/bin/bash
# Every offline lint step. No network, no product tests.
#
#   ./ops/lint.sh                 # the whole lint gate, as ops/run-tests.sh runs it
#   ./ops/lint.sh ruff pyright    # named steps only, for the fix loop
#
# Lint rules here are obeyed, not bypassed: there is no skip flag, no waiver file and no inline
# suppression (ops/lint/no-suppressions.mjs is the first step). One-time setup: ops/lint/setup.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

# The first three decide whether the rest can be trusted, so a full run stops if one of them fails:
# a suppression, a wrong tool version or a hole in coverage makes every later result meaningless.
FIRST=(suppressions toolchain guard)
REST=(self-tests ruff ruff-format pyright flake8-async vulture eslint oxlint stylelint tokens tsc knip
  html lockfiles shell shfmt docker actions yaml json installer markdown links typos editorconfig secrets)

failed=()

if [[ $# -gt 0 ]]; then
  for step in "$@"; do
    echo "== lint: ${step}"
    if ops/lint/step.sh "${step}"; then
      echo "   ok"
    else
      failed+=("${step}")
    fi
  done
else
  for step in "${FIRST[@]}"; do
    echo "== lint: ${step}"
    if ! ops/lint/step.sh "${step}"; then
      echo ""
      echo "✖ lint stopped at '${step}': fix it first, the later steps cannot be trusted until it passes."
      exit 1
    fi
  done
  for step in "${REST[@]}"; do
    echo "== lint: ${step}"
    if ops/lint/step.sh "${step}"; then
      echo "   ok"
    else
      failed+=("${step}")
    fi
  done
fi

echo ""
if [[ ${#failed[@]} -gt 0 ]]; then
  echo "✖ lint failed: ${failed[*]}"
  echo "  Fix the code each step names. Do not disable a rule or add an exemption; ask the owner."
  exit 1
fi
echo "✓ lint passed"
