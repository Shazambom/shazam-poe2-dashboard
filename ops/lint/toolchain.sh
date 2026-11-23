#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
VERSIONS_FILE="$SCRIPT_DIR/tool-versions"

brew_formula() {
  case "$1" in
    typos) printf '%s\n' "typos-cli" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

installed_version() {
  local tool="$1"
  local raw=""
  case "$tool" in
    shellcheck)
      raw=$(shellcheck --version)
      printf '%s\n' "$raw" | awk '/^version:/ { print $2; exit }'
      ;;
    shfmt)
      raw=$(shfmt --version)
      printf '%s\n' "${raw#v}"
      ;;
    hadolint)
      raw=$(hadolint --version)
      printf '%s\n' "${raw##* }"
      ;;
    actionlint)
      raw=$(actionlint -version)
      printf '%s\n' "${raw%%$'\n'*}"
      ;;
    zizmor)
      raw=$(zizmor --version)
      printf '%s\n' "${raw##* }"
      ;;
    gitleaks)
      raw=$(gitleaks version)
      printf '%s\n' "${raw#v}"
      ;;
    editorconfig-checker)
      raw=$(editorconfig-checker -version)
      printf '%s\n' "${raw#v}"
      ;;
    lychee)
      raw=$(lychee --version)
      printf '%s\n' "${raw##* }"
      ;;
    typos)
      raw=$(typos --version)
      printf '%s\n' "${raw##* }"
      ;;
    makensis)
      raw=$(makensis -VERSION)
      printf '%s\n' "${raw#v}"
      ;;
    *)
      printf 'toolchain: unknown tool %s\n' "$tool" >&2
      return 1
      ;;
  esac
}

failed=0
count=0

while read -r tool expected extra; do
  if [ -z "$tool" ] || [ "${tool#\#}" != "$tool" ]; then
    continue
  fi
  if [ -n "${extra:-}" ] || [ -z "${expected:-}" ]; then
    printf 'toolchain: invalid line in %s: %s %s %s\n' "$VERSIONS_FILE" "$tool" "${expected:-}" "${extra:-}" >&2
    exit 1
  fi
  count=$((count + 1))
  formula=$(brew_formula "$tool")
  if command -v "$tool" > /dev/null 2>&1; then
    actual=$(installed_version "$tool")
    if [ "$actual" != "$expected" ]; then
      printf 'toolchain: %s version %s != expected %s — run: brew install %s\n' "$tool" "$actual" "$expected" "$formula" >&2
      failed=1
    fi
  else
    printf 'toolchain: %s not installed (expected %s) — run: brew install %s\n' "$tool" "$expected" "$formula" >&2
    failed=1
  fi
done < "$VERSIONS_FILE"

if [ "$count" -eq 0 ]; then
  printf 'toolchain: %s contains no tools\n' "$VERSIONS_FILE" >&2
  exit 1
fi

exit "$failed"
