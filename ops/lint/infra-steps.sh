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

step_shell() {
  local all_sh=()
  local other_sh=()
  local build_sh=()
  local f=""
  while IFS= read -r -d '' f; do
    if [ -f "$f" ]; then
      case "$f" in
        desktop/build-backend.sh | desktop/build-sidecar.sh)
          all_sh+=("$f")
          build_sh+=("$f")
          ;;
        *.sh)
          all_sh+=("$f")
          other_sh+=("$f")
          ;;
        *) ;;
      esac
    fi
  done < <(git ls-files -co --exclude-standard -z)

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
  local files=()
  local f=""
  while IFS= read -r -d '' f; do
    if [ -f "$f" ]; then
      case "$f" in
        *.sh) files+=("$f") ;;
        *) ;;
      esac
    fi
  done < <(git ls-files -co --exclude-standard -z)

  require_non_empty "shfmt" "${#files[@]}"
  shfmt -d -i 2 -ci -bn -sr "${files[@]}"
}

step_docker() {
  local files=()
  local f=""
  local base=""
  while IFS= read -r -d '' f; do
    if [ -f "$f" ]; then
      base="${f##*/}"
      case "$base" in
        Dockerfile | Dockerfile.*) files+=("$f") ;;
        *) ;;
      esac
    fi
  done < <(git ls-files -co --exclude-standard -z)

  require_non_empty "docker" "${#files[@]}"
  hadolint --config ops/lint/hadolint.yaml "${files[@]}"
}

step_actions() {
  local workflows=()
  local zizmor_files=()
  local f=""
  while IFS= read -r -d '' f; do
    if [ -f "$f" ]; then
      case "$f" in
        .github/workflows/*.yml | .github/workflows/*.yaml)
          workflows+=("$f")
          zizmor_files+=("$f")
          ;;
        .github/dependabot.yml | .github/dependabot.yaml)
          zizmor_files+=("$f")
          ;;
        *) ;;
      esac
    fi
  done < <(git ls-files -co --exclude-standard -z)

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
  local all_yaml=()
  local workflows=()
  local dependabot=()
  local compose=()
  local f=""
  while IFS= read -r -d '' f; do
    if [ -f "$f" ]; then
      case "$f" in
        *.yml | *.yaml)
          all_yaml+=("$f")
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
          ;;
        *) ;;
      esac
    fi
  done < <(git ls-files -co --exclude-standard -z)

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
  local files=()
  local f=""
  while IFS= read -r -d '' f; do
    if [ -f "$f" ]; then
      case "$f" in
        *.json | *.ndjson) files+=("$f") ;;
        *) ;;
      esac
    fi
  done < <(git ls-files -co --exclude-standard -z)

  require_non_empty "json" "${#files[@]}"
  .venv-lint/bin/python ops/lint/json_check.py "${files[@]}"
}

step_installer() {
  local files=()
  local f=""
  while IFS= read -r -d '' f; do
    if [ -f "$f" ]; then
      case "$f" in
        *.nsh | *.nsi) files+=("$f") ;;
        *) ;;
      esac
    fi
  done < <(git ls-files -co --exclude-standard -z)

  require_non_empty "installer" "${#files[@]}"
  makensis -V2 ops/lint/installer-check.nsi
}

step_markdown() {
  local files=()
  local f=""
  while IFS= read -r -d '' f; do
    if [ -f "$f" ]; then
      case "$f" in
        *.md) files+=("$f") ;;
        *) ;;
      esac
    fi
  done < <(git ls-files -co --exclude-standard -z)

  require_non_empty "markdown" "${#files[@]}"
  ops/lint/node_modules/.bin/markdownlint-cli2 --config ops/lint/.markdownlint-cli2.jsonc "${files[@]}"
}

step_links() {
  local files=()
  local f=""
  while IFS= read -r -d '' f; do
    if [ -f "$f" ]; then
      case "$f" in
        *.md) files+=("$f") ;;
        *) ;;
      esac
    fi
  done < <(git ls-files -co --exclude-standard -z)

  require_non_empty "links" "${#files[@]}"
  lychee --config ops/lint/lychee.toml --root-dir "$PWD" -- "${files[@]}"
}

step_typos() {
  local files=()
  local f=""
  while IFS= read -r -d '' f; do
    if [ -f "$f" ]; then
      files+=("$f")
    fi
  done < <(git ls-files -co --exclude-standard -z)

  require_non_empty "typos" "${#files[@]}"
  typos --isolated --no-ignore --config ops/lint/typos.toml --force-exclude --file-list <(printf '%s\n' "${files[@]}")
}

step_editorconfig() {
  local files=()
  local f=""
  while IFS= read -r -d '' f; do
    if [ -f "$f" ]; then
      files+=("$f")
    fi
  done < <(git ls-files -co --exclude-standard -z)

  require_non_empty "editorconfig" "${#files[@]}"
  editorconfig-checker -config ops/lint/ecrc.json "${files[@]}"
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

if [ "$#" -ne 1 ]; then
  printf 'usage: %s shell|shfmt|docker|actions|yaml|json|installer|markdown|links|typos|editorconfig|secrets\n' "$0" >&2
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
