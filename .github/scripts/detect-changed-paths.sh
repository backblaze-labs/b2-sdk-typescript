#!/usr/bin/env bash
set -euo pipefail

emit_outputs() {
  local code_changed="$1"
  local docs_changed="$2"

  {
    echo "code=$code_changed"
    echo "docs=$docs_changed"
  } >> "${GITHUB_OUTPUT:-/dev/stdout}"
}

if [ "${EVENT_NAME:-}" != "pull_request" ]; then
  emit_outputs true false
  exit 0
fi

base_sha="${BASE_SHA:-}"
head_sha="${HEAD_SHA:-}"
if [ -z "$base_sha" ] || [ -z "$head_sha" ]; then
  echo "::warning::Missing pull request base/head SHA; running full suite." >&2
  emit_outputs true false
  exit 0
fi

changed_files="${CHANGED_FILES_PATH:-changed-files.txt}"
if ! git diff --no-renames --name-only "$base_sha...$head_sha" > "$changed_files"; then
  echo "::warning::Unable to detect changed files; running full suite." >&2
  emit_outputs true false
  exit 0
fi

is_docs_path() {
  local path="$1"

  [[ "$path" == docs/* ]] && return 0
  [[ "$path" == adr/*.md ]] && return 0
  [[ "$path" == *.md ]] && return 0
  return 1
}

code=false
docs=false
while IFS= read -r file; do
  [ -n "$file" ] || continue
  case "$file" in
    README.md | CHANGELOG.md | RELEASE.md)
      code=true
      continue
      ;;
  esac
  if is_docs_path "$file"; then
    docs=true
  else
    code=true
  fi
done < "$changed_files"

emit_outputs "$code" "$docs"
