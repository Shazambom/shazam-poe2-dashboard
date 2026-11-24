#!/usr/bin/env bash
set -euo pipefail

run_step() {
  git ls-files -z -co --deduplicate --exclude-standard -- '*.py' | (
    files=()
    while IFS= read -r -d '' file; do
      if [[ -f "$file" ]]; then
        files+=("./$file")
      fi
    done
    if [[ -n "${files[*]-}" ]]; then
      "$@" "${files[@]}"
    fi
  )
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
    '--async200-blocking-calls=db.q->offload the query,db.tx->offload the transaction,db.kv_get->offload the read,db.kv_set->offload the write,db.kv_update->offload the update,db.analyze->offload the operation,db.seed_market->offload the operation,db.get_capital->offload the read,db.capital_add->offload the write,db.set_capital->offload the write,db.sales_list->offload the read,db.sales_leagues->offload the read,db.sales_count->offload the read,db.sales_ingest->offload the write,sqlite3.connect->offload the operation' \
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

case "${1-}" in
  ruff) run_step ruff_check ;;
  ruff-format) run_step ruff_format ;;
  pyright) run_step pyright_check ;;
  flake8-async) run_step flake8_async ;;
  vulture) run_step vulture_check ;;
  *)
    printf 'Usage: %s {ruff|ruff-format|pyright|flake8-async|vulture}\n' "$0" >&2
    exit 2
    ;;
esac
