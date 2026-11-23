#!/bin/bash
# One-time install of the lint tools on this Mac. Run again after ops/lint/package-lock.json,
# ops/lint/requirements*.txt or ops/lint/tool-versions change. The gate itself never installs:
# ops/lint/toolchain.sh only checks versions and prints what to run.
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "== node lint tools (ops/lint/package-lock.json)"
npm ci --prefix ops/lint

echo "== python lint tools (.venv-lint)"
python3.12 -m venv .venv-lint
.venv-lint/bin/pip install --quiet -r ops/lint/requirements.txt

echo "== test environment (.venv-test)"
python3.12 -m venv .venv-test
.venv-test/bin/pip install --quiet -r ops/lint/requirements-test.txt

echo "== homebrew tools"
brew install shellcheck shfmt hadolint actionlint zizmor gitleaks editorconfig-checker lychee typos-cli makensis
ops/lint/toolchain.sh

echo "== lint tools ready: ./ops/lint.sh"
