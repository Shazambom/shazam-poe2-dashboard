#!/usr/bin/env bash
set -euo pipefail

owner_for_step() {
  case "$1" in
    pyright) printf 'pyright' ;;
    ruff | ruff-format | flake8-async | vulture) printf 'ruff' ;;
    *)
      printf 'Usage: %s [--list] {ruff|ruff-format|pyright|flake8-async|vulture}\n' "$0" >&2
      exit 2
      ;;
  esac
}

run_step() {
  local owner="$1"
  shift
  local -a files=()
  local file=""
  while IFS= read -r -d '' file; do
    files+=("./$file")
  done < <(node ops/lint/files.mjs "$owner")
  if [[ -n "${files[*]-}" ]]; then
    "$@" "${files[@]}"
  fi
}

ruff_check() {
  .venv-lint/bin/ruff check --config ops/lint/ruff.toml --ignore-noqa --no-fix "$@"
}

ruff_format() {
  .venv-lint/bin/ruff format --config ops/lint/ruff.toml --check "$@"
}

pyright_check() {
  ops/lint/node_modules/.bin/pyright -p ops/lint/pyrightconfig.json \
    --pythonpath .venv-test/bin/python --warnings "$@"
}

flake8_async() {
  .venv-lint/bin/flake8-async --asyncio --disable-noqa \
    --enable=ASYNC200,ASYNC231,ASYNC232 --disable= \
    '--async200-blocking-calls=db.q->offload the query,db.tx->offload the transaction,db.kv_get->offload the read,db.kv_set->offload the write,sqlite3.connect->offload the operation' \
    "$@"
}

vulture_check() {
  local file
  local -a production=()
  for file in "$@"; do
    case "$file" in
      */tests/* | */test_*.py | */*_test.py | */conftest.py | ./ops/*/*) ;;
      ./backend/app/* | ./backend/sidecar/* | ./backend/run_desktop.py | ./ops/*.py | ./tools/*)
        production+=("$file")
        ;;
      *) ;;
    esac
  done
  if [[ -n "${production[*]-}" ]]; then
    .venv-lint/bin/vulture --min-confidence 100 "${production[@]}"
  fi
}

if [[ "${1-}" == "--list" && "$#" -eq 2 ]]; then
  node ops/lint/files.mjs "$(owner_for_step "$2")"
  exit 0
fi

case "${1-}" in
  ruff) run_step ruff ruff_check ;;
  ruff-format) run_step ruff ruff_format ;;
  pyright) run_step pyright pyright_check ;;
  flake8-async) run_step ruff flake8_async ;;
  vulture) run_step ruff vulture_check ;;
  *)
    printf 'Usage: %s [--list] {ruff|ruff-format|pyright|flake8-async|vulture}\n' "$0" >&2
    exit 2
    ;;
esac
