#!/usr/bin/env bash
# JavaScript, CSS, HTML and lockfile lint steps, one per call:
#
#   ops/lint/js-steps.sh [--list] eslint|oxlint|stylelint|tsc|knip|html|lockfiles
#
# Every file list comes from ops/lint/files.mjs (backed by git ls-files), never from a tool's own
# discovery, and every tool is given its config under ops/lint/ explicitly. A step that finds nothing
# to lint fails: an empty list means the selection is wrong.
# Install the tools first: npm ci --prefix ops/lint
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
readonly ROOT
cd "${ROOT}"
readonly LINT="ops/lint"
readonly BIN="${LINT}/node_modules/.bin"

WORK="$(mktemp -d)"
readonly WORK
trap 'rm -rf "${WORK}"' EXIT

FILES=()

# collect_step <owner> [ERE]: set FILES from ops/lint/files.mjs <owner>, optionally filtered by ERE.
collect_step() {
  local owner="$1" pattern="${2:-}" path
  FILES=()
  while IFS= read -r -d '' path; do
    if [[ -z "${pattern}" || "${path}" =~ ${pattern} ]]; then
      FILES+=("${path}")
    fi
  done < <(node "${LINT}/files.mjs" "${owner}")
  if [[ "${#FILES[@]}" -eq 0 ]]; then
    echo "js-steps: no files match ${owner} ${pattern}; the file selection is wrong" >&2
    return 1
  fi
}

collect_tsc_desktop() {
  collect_step eslint '^desktop/(src/.+\.js|scripts/.+\.mjs|test/.+\.mjs)$'
  # The EE2 port's esbuild entry imports `@/…` paths that exist only in EE2's checkout during
  # desktop/scripts/sync-ee2.mjs; like the goldens spec, it is not part of the desktop project.
  local kept=() file
  for file in "${FILES[@]}"; do
    [[ "${file}" == desktop/src/vendor/ee2-query/entry.js ]] || kept+=("${file}")
  done
  FILES=("${kept[@]}")
}

step_eslint() {
  collect_step eslint
  "${BIN}/eslint" --config "${LINT}/eslint.config.mjs" --max-warnings 0 "${FILES[@]}"
}

step_oxlint() {
  collect_step eslint '^frontend/src/.+\.jsx$'
  "${BIN}/oxlint" --config "${LINT}/oxlintrc.json" --disable-nested-config --deny-warnings \
    --report-unused-disable-directives-severity=error "${FILES[@]}"
}

step_stylelint() {
  collect_step stylelint
  "${BIN}/stylelint" --config "${LINT}/stylelint.config.mjs" --ignore-disables --max-warnings 0 "${FILES[@]}"
}

# Both projects run even when the first fails, so one call reports every diagnostic.
step_tsc() {
  local status=0
  # The strict pilot: its roots are the files tsconfig.frontend.json names; tsc follows their imports.
  "${BIN}/tsc" --project "${LINT}/tsconfig.frontend.json" --pretty false || status=1
  collect_tsc_desktop
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
  collect_step html
  "${BIN}/html-validate" --config "${LINT}/htmlvalidate.json" --max-warnings 0 "${FILES[@]}"
}

step_lockfiles() {
  local file status=0
  collect_step json '^(frontend|desktop|ops/lint)/package-lock\.json$'
  for file in "${FILES[@]}"; do
    "${BIN}/lockfile-lint" --path "${file}" --type npm --allowed-hosts npm \
      --validate-https --validate-integrity --validate-package-names || status=1
  done
  return "${status}"
}

list_step() {
  case "$1" in
    eslint) collect_step eslint ;;
    oxlint) collect_step eslint '^frontend/src/.+\.jsx$' ;;
    stylelint) collect_step stylelint ;;
    html) collect_step html ;;
    lockfiles) collect_step json '^(frontend|desktop|ops/lint)/package-lock\.json$' ;;
    tsc)
      local frontend_files=() path
      while IFS= read -r -d '' path; do
        frontend_files+=("${path}")
      done < <(node -e '
        const fs = require("node:fs")
        const path = require("node:path")
        const root = process.argv[1]
        const lintDir = path.join(root, "ops/lint")
        const cfg = JSON.parse(fs.readFileSync(path.join(lintDir, "tsconfig.frontend.json"), "utf8"))
        for (const f of cfg.files || []) {
          process.stdout.write(path.relative(root, path.resolve(lintDir, f)).split(path.sep).join("/") + "\0")
        }
      ' "${ROOT}")
      collect_tsc_desktop
      FILES=("${frontend_files[@]}" "${FILES[@]}")
      ;;
    *)
      usage
      return 2
      ;;
  esac
  printf '%s\0' "${FILES[@]}"
}

usage() {
  echo "usage: ops/lint/js-steps.sh [--list] eslint|oxlint|stylelint|tsc|knip|html|lockfiles" >&2
}

main() {
  if [[ "$#" -eq 2 && "$1" == "--list" ]]; then
    list_step "$2"
    return 0
  fi
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
