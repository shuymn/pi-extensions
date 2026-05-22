#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
README_PATH="${ROOT_DIR}/README.md"
PACKAGE_JSON_PATH="${ROOT_DIR}/package.json"
SCRIPT_PATH="${ROOT_DIR}/scripts/init-template.sh"

require_clean_worktree() {
  local status_output

  status_output="$(git status --short || true)"
  if [[ -n "${status_output}" ]]; then
    echo "working tree must be clean before template initialization" >&2
    exit 1
  fi
}

require_git_identity() {
  if ! git config user.name >/dev/null 2>&1; then
    echo "git user.name is not configured" >&2
    exit 1
  fi

  if ! git config user.email >/dev/null 2>&1; then
    echo "git user.email is not configured" >&2
    exit 1
  fi
}

detect_package_name() {
  if [[ "$#" -gt 0 ]] && [[ -n "$1" ]]; then
    printf "%s" "$1"
    return 0
  fi

  git remote get-url origin 2>/dev/null |
    sed 's|\.git$||' |
    awk -F/ '{print $NF}'
}

detect_github_actions_ref() {
  local refs count

  refs="$(
    find "${ROOT_DIR}/.github/workflows" -type f -name '*.yml' -exec \
      perl -ne 'print "$1\n" if m{uses:\s+shuymn/github-actions/\.github/workflows/[^@]+@([0-9a-f]{40})}' {} + 2>/dev/null |
      sort -u
  )"

  count="$(printf '%s\n' "${refs}" | sed '/^$/d' | wc -l | tr -d ' ')"

  if [[ "${count}" = "1" ]]; then
    printf "%s" "${refs}"
    return 0
  fi

  if [[ "${count}" = "0" ]]; then
    echo "failed to detect shuymn/github-actions workflow ref" >&2
    exit 1
  fi

  echo "multiple shuymn/github-actions workflow refs found:" >&2
  printf '%s\n' "${refs}" >&2
  exit 1
}

main() {
  local package_name github_actions_ref github_actions_setup_url

  cd "${ROOT_DIR}"

  require_clean_worktree
  require_git_identity

  package_name="$(detect_package_name "${1-}")"
  if [[ -z "${package_name}" ]]; then
    echo "failed to determine package name" >&2
    exit 1
  fi

  github_actions_ref="$(detect_github_actions_ref)"
  github_actions_setup_url="https://raw.githubusercontent.com/shuymn/github-actions/${github_actions_ref}/setup.sh"

  PACKAGE_NAME="${package_name}" perl -0pi -e 's/"name":\s*"bun-template"/"name": "$ENV{PACKAGE_NAME}"/' "${PACKAGE_JSON_PATH}"
  PACKAGE_NAME="${package_name}" perl -0pi -e 's/^# bun-template$/# $ENV{PACKAGE_NAME}/m' "${README_PATH}"
  perl -0pi -e 's/\n<!-- template:start -->.*?<!-- template:end -->\n/\n/s' "${README_PATH}"

  curl -fsSL "${github_actions_setup_url}" | bash -s -- --overwrite-workflows

  rm -f "${SCRIPT_PATH}"
  rmdir "${ROOT_DIR}/scripts" 2>/dev/null || true

  git add -A
  if ! git diff --cached --quiet; then
    git commit -m "chore: initialize from template"
  fi
}

main "$@"
