#!/usr/bin/env bash
set -euo pipefail

SECRETS_TMPDIR=""

cleanup_secrets_tmpdir() {
  if [ -n "$SECRETS_TMPDIR" ] && [ -d "$SECRETS_TMPDIR" ]; then
    rm -rf "$SECRETS_TMPDIR"
  fi
}

trap cleanup_secrets_tmpdir EXIT

require_non_empty() {
  local label="$1"
  local count="$2"
  if [ "$count" -eq 0 ]; then
    printf 'infra-steps: %s received an empty file list\n' "$label" >&2
    exit 1
  fi
}

STEP_FILES=()

collect_step() {
  local owner="$1"
  local f=""
  STEP_FILES=()
  while IFS= read -r -d '' f; do
    STEP_FILES+=("$f")
  done < <(node ops/lint/files.mjs "$owner")
  require_non_empty "$owner" "${#STEP_FILES[@]}"
}

collect_json() {
  local f=""
  local seen=$'\n'
  STEP_FILES=()
  while IFS= read -r -d '' f; do
    STEP_FILES+=("$f")
    seen+="${f}"$'\n'
  done < <(node ops/lint/files.mjs json)
  # Also keep validating not-linted .json/.ndjson fixtures and goldens so coverage never drops.
  while IFS= read -r -d '' f; do
    if [ -f "$f" ]; then
      case "$f" in
        *.json | *.ndjson)
          if [[ "$seen" != *$'\n'"$f"$'\n'* ]]; then
            STEP_FILES+=("$f")
            seen+="${f}"$'\n'
          fi
          ;;
        *) ;;
      esac
    fi
  done < <(git ls-files -co --exclude-standard -z)
  require_non_empty "json" "${#STEP_FILES[@]}"
}

step_shell() {
  collect_step shell
  local all_sh=("${STEP_FILES[@]}")
  local other_sh=()
  local build_sh=()
  local f=""
  for f in "${all_sh[@]}"; do
    case "$f" in
      desktop/build-backend.sh | desktop/build-sidecar.sh)
        build_sh+=("$f")
        ;;
      *)
        other_sh+=("$f")
        ;;
    esac
  done

  require_non_empty "shell (all scripts)" "${#all_sh[@]}"
  require_non_empty "shell (non-build scripts)" "${#other_sh[@]}"
  require_non_empty "shell (build scripts)" "${#build_sh[@]}"

  local failed=0
  if ! bash -n "${all_sh[@]}"; then
    failed=1
  fi
  if ! shellcheck --rcfile=ops/lint/shellcheckrc -S style "${other_sh[@]}"; then
    failed=1
  fi
  if ! shellcheck --rcfile=ops/lint/shellcheckrc -S style -e SC1091 "${build_sh[@]}"; then
    failed=1
  fi
  return "$failed"
}

step_shfmt() {
  collect_step shell
  shfmt -d -i 2 -ci -bn -sr "${STEP_FILES[@]}"
}

step_docker() {
  collect_step docker
  hadolint --config ops/lint/hadolint.yaml "${STEP_FILES[@]}"
}

step_actions() {
  collect_step actions
  local workflows=("${STEP_FILES[@]}")
  local zizmor_files=("${workflows[@]}")
  local f=""
  while IFS= read -r -d '' f; do
    case "$f" in
      .github/dependabot.yml | .github/dependabot.yaml)
        zizmor_files+=("$f")
        ;;
      *) ;;
    esac
  done < <(node ops/lint/files.mjs yaml)

  require_non_empty "actions (workflows)" "${#workflows[@]}"
  require_non_empty "actions (zizmor)" "${#zizmor_files[@]}"

  local failed=0
  if ! actionlint "${workflows[@]}"; then
    failed=1
  fi
  if ! zizmor --offline --no-ignores --config ops/lint/zizmor.yml "${zizmor_files[@]}"; then
    failed=1
  fi
  return "$failed"
}

step_yaml() {
  collect_step yaml
  local all_yaml=("${STEP_FILES[@]}")
  local workflows=()
  local dependabot=()
  local compose=()
  local f=""
  for f in "${all_yaml[@]}"; do
    case "$f" in
      .github/workflows/*.yml | .github/workflows/*.yaml)
        workflows+=("$f")
        ;;
      .github/dependabot.yml | .github/dependabot.yaml)
        dependabot+=("$f")
        ;;
      docker-compose.yml | docker-compose.*.yml | compose.yml | compose.*.yml)
        compose+=("$f")
        ;;
      *) ;;
    esac
  done

  require_non_empty "yaml (all)" "${#all_yaml[@]}"
  require_non_empty "yaml (workflows)" "${#workflows[@]}"
  require_non_empty "yaml (dependabot)" "${#dependabot[@]}"
  require_non_empty "yaml (compose)" "${#compose[@]}"

  local failed=0
  if ! .venv-lint/bin/yamllint -s -c ops/lint/yamllint.yml "${all_yaml[@]}"; then
    failed=1
  fi
  if ! .venv-lint/bin/check-jsonschema --builtin-schema vendor.github-workflows "${workflows[@]}"; then
    failed=1
  fi
  if ! .venv-lint/bin/check-jsonschema --builtin-schema vendor.dependabot "${dependabot[@]}"; then
    failed=1
  fi
  if ! .venv-lint/bin/check-jsonschema --builtin-schema vendor.compose-spec "${compose[@]}"; then
    failed=1
  fi
  return "$failed"
}

step_json() {
  collect_json
  .venv-lint/bin/python ops/lint/json_check.py "${STEP_FILES[@]}"
}

step_installer() {
  collect_step installer
  makensis -V2 ops/lint/installer-check.nsi
}

step_markdown() {
  collect_step markdown
  ops/lint/node_modules/.bin/markdownlint-cli2 --config ops/lint/.markdownlint-cli2.jsonc "${STEP_FILES[@]}"
}

step_links() {
  collect_step markdown
  lychee --config ops/lint/lychee.toml --root-dir "$PWD" -- "${STEP_FILES[@]}"
}

step_typos() {
  collect_step typos
  typos --isolated --no-ignore --config ops/lint/typos.toml --force-exclude --file-list <(printf '%s\n' "${STEP_FILES[@]}")
}

step_editorconfig() {
  collect_step editorconfig
  editorconfig-checker -config ops/lint/ecrc.json "${STEP_FILES[@]}"
}

step_secrets() {
  local files=()
  local f=""
  while IFS= read -r -d '' f; do
    if [ -f "$f" ]; then
      files+=("$f")
    fi
  done < <(git ls-files -co --exclude-standard -z)

  require_non_empty "secrets" "${#files[@]}"

  local repo_root="$PWD"
  local failed=0
  if ! gitleaks git --no-banner --ignore-gitleaks-allow --config ops/lint/gitleaks.toml .; then
    failed=1
  fi

  SECRETS_TMPDIR=$(mktemp -d)
  printf '%s\0' "${files[@]}" | tar --null -T - -cf - | tar -C "$SECRETS_TMPDIR" -xf -
  if ! (cd "$SECRETS_TMPDIR" && gitleaks dir --no-banner --ignore-gitleaks-allow --config "$repo_root/ops/lint/gitleaks.toml" .); then
    failed=1
  fi
  rm -rf "$SECRETS_TMPDIR"
  SECRETS_TMPDIR=""

  return "$failed"
}

list_step() {
  case "$1" in
    shell | shfmt) collect_step shell ;;
    docker) collect_step docker ;;
    actions) collect_step actions ;;
    yaml) collect_step yaml ;;
    json) collect_json ;;
    installer) collect_step installer ;;
    markdown | links) collect_step markdown ;;
    typos) collect_step typos ;;
    editorconfig) collect_step editorconfig ;;
    *)
      printf 'infra-steps: unknown list step: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  printf '%s\0' "${STEP_FILES[@]}"
}

if [ "$#" -eq 2 ] && [ "$1" = "--list" ]; then
  list_step "$2"
  exit 0
fi

if [ "$#" -ne 1 ]; then
  printf 'usage: %s [--list] shell|shfmt|docker|actions|yaml|json|installer|markdown|links|typos|editorconfig|secrets\n' "$0" >&2
  exit 2
fi

case "$1" in
  shell) step_shell ;;
  shfmt) step_shfmt ;;
  docker) step_docker ;;
  actions) step_actions ;;
  yaml) step_yaml ;;
  json) step_json ;;
  installer) step_installer ;;
  markdown) step_markdown ;;
  links) step_links ;;
  typos) step_typos ;;
  editorconfig) step_editorconfig ;;
  secrets) step_secrets ;;
  *)
    printf 'infra-steps: unknown step: %s\n' "$1" >&2
    exit 2
    ;;
esac
