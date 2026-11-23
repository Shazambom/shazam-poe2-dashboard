#!/usr/bin/env bash
# JavaScript, CSS, HTML and lockfile lint steps, one per call:
#
#   ops/lint/js-steps.sh eslint|oxlint|stylelint|tsc|knip|html|lockfiles
#
# Every file list comes from git (tracked and untracked files that are not ignored and still exist),
# never from a tool's own discovery, and every tool is given its config under ops/lint/ explicitly.
# A step that finds nothing to lint fails: an empty list means the selection is wrong.
# Install the tools first: npm ci --prefix ops/lint
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
readonly ROOT
cd "${ROOT}"
readonly LINT="ops/lint"
readonly BIN="${LINT}/node_modules/.bin"

# Generated upstream code and byte-exact data: never parsed by a syntax-aware linter.
readonly NOT_LINTED='^(desktop/src/vendor/ee2-query/(vendor|data)/|desktop/test/(fixtures|goldens)/|frontend/test/goldens/|frontend/src/data/regex/)'

WORK="$(mktemp -d)"
readonly WORK
trap 'rm -rf "${WORK}"' EXIT

FILES=()

# collect <ERE>: set FILES to the files git knows about whose path matches the expression.
collect() {
  local pattern="$1" path
  git ls-files -co --exclude-standard -z > "${WORK}/ls-files"
  FILES=()
  while IFS= read -r -d '' path; do
    if [[ -f "${path}" && "${path}" =~ ${pattern} && ! "${path}" =~ ${NOT_LINTED} ]]; then
      FILES+=("${path}")
    fi
  done < "${WORK}/ls-files"
  if [[ "${#FILES[@]}" -eq 0 ]]; then
    echo "js-steps: no files match ${pattern}; the file selection is wrong" >&2
    return 1
  fi
}

step_eslint() {
  collect '^(frontend/(src|test|scripts)/.+\.(js|jsx|mjs)|frontend/vite\.config\.js|desktop/(src|test)/.+\.(js|mjs)|desktop/scripts/.+\.(mjs|ts)|ops/.+\.mjs)$'
  "${BIN}/eslint" --config "${LINT}/eslint.config.mjs" --max-warnings 0 "${FILES[@]}"
}

step_oxlint() {
  collect '^frontend/src/.+\.jsx$'
  "${BIN}/oxlint" --config "${LINT}/oxlintrc.json" --disable-nested-config --deny-warnings \
    --report-unused-disable-directives-severity=error "${FILES[@]}"
}

step_stylelint() {
  collect '^frontend/.+\.css$'
  "${BIN}/stylelint" --config "${LINT}/stylelint.config.mjs" --ignore-disables --max-warnings 0 "${FILES[@]}"
}

# Both projects run even when the first fails, so one call reports every diagnostic.
step_tsc() {
  local status=0
  # The strict pilot: its roots are the two files the config names; tsc follows their imports.
  "${BIN}/tsc" --project "${LINT}/tsconfig.frontend.json" --pretty false || status=1
  collect '^desktop/(src/.+\.js|scripts/.+\.mjs|test/.+\.mjs)$'
  node -e '
    const [root, ...files] = process.argv.slice(1)
    process.stdout.write(JSON.stringify({
      extends: root + "/ops/lint/tsconfig.desktop.json",
      include: [],
      files: files.map((f) => root + "/" + f),
    }))
  ' "${ROOT}" "${FILES[@]}" > "${WORK}/tsconfig.desktop.json"
  "${BIN}/tsc" --project "${WORK}/tsconfig.desktop.json" --pretty false || status=1
  return "${status}"
}

# knip analyses frontend and desktop together, so a module used only by the other tree counts as
# used. It needs a package.json at its root, which is ops/lint; knip.json names the two trees.
step_knip() {
  "${BIN}/knip" --directory "${LINT}" --config knip.json --workspace ../../frontend --workspace ../../desktop \
    --no-progress --treat-config-hints-as-errors
}

step_html() {
  collect '^frontend/.+\.html$'
  "${BIN}/html-validate" --config "${LINT}/htmlvalidate.json" --max-warnings 0 "${FILES[@]}"
}

step_lockfiles() {
  local file status=0
  collect '^(frontend|desktop|ops/lint)/package-lock\.json$'
  for file in "${FILES[@]}"; do
    "${BIN}/lockfile-lint" --path "${file}" --type npm --allowed-hosts npm \
      --validate-https --validate-integrity --validate-package-names || status=1
  done
  return "${status}"
}

usage() {
  echo "usage: ops/lint/js-steps.sh eslint|oxlint|stylelint|tsc|knip|html|lockfiles" >&2
}

main() {
  if [[ "$#" -ne 1 ]]; then
    usage
    return 2
  fi
  case "$1" in
    eslint) step_eslint ;;
    oxlint) step_oxlint ;;
    stylelint) step_stylelint ;;
    tsc) step_tsc ;;
    knip) step_knip ;;
    html) step_html ;;
    lockfiles) step_lockfiles ;;
    *)
      usage
      return 2
      ;;
  esac
}

main "$@"
