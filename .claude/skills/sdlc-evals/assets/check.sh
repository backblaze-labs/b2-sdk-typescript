#!/bin/bash
# Grades one eval run. Usage: check.sh <eval.json> <result.json>
# Run from the root of the checkout the agent worked in. Needs jq and git.
set -u
eval_file=$1
result_file=$2

name=$(jq -r '.name' "$eval_file")
export EVALS=$(cd "$(dirname "$eval_file")" && pwd)   # checks may call helpers kept beside the evals

# Runs a check as $CHECK_AS when set, so evaluated code cannot reach the grader.
run_check() {
  if [ -n "${CHECK_AS:-}" ]; then
    sudo -u "$CHECK_AS" -H env EVALS="$EVALS" bash -c "$1"
  else
    bash -c "$1"
  fi
}

# Files changed outside the folders/files the eval allows (Git-ignored files don't show up).
# The run controls .git, so git runs unprivileged with fsmonitor off, and a checkout
# that cannot be inspected is reported instead of read as clean.
strays() {
  local listing
  if ! listing=$(run_check 'git -c core.fsmonitor=false status --porcelain --untracked-files=all' 2>&1); then
    echo "       could not inspect the checkout: $(head -1 <<<"$listing")"
    return
  fi
  cut -c4- <<<"$listing" | while read -r path; do
    [ -n "$path" ] || continue
    jq -e --arg p "$path" \
      'any(.may_change[]; . as $ok | $p == $ok or ($p | startswith($ok + "/")))' \
      "$eval_file" >/dev/null || echo "       $path"
  done
}

total=$(jq '.checks | length' "$eval_file")
passed=0
report=""

if [ "$(jq -r '.is_error' "$result_file" 2>/dev/null)" != "false" ]; then
  report="     the run ended in an error"$'\n'
elif [ -n "$(strays)" ]; then
  report="     the run changed files this eval does not allow:"$'\n'"$(strays)"$'\n'
else
  for ((i = 0; i < total; i++)); do
    label=$(jq -r ".checks[$i].name" "$eval_file")
    cmd=$(jq -r ".checks[$i].run" "$eval_file")
    if out=$(run_check "$cmd" 2>&1 </dev/null); then
      passed=$((passed + 1))
    else
      report+="     failed: $label"$'\n'
      [ -n "$out" ] && report+="$(head -3 <<<"$out" | sed 's/^/       /')"$'\n'
    fi
  done
  # a check must not have modified the tree either (Makefile, scripts)
  if [ -n "$(strays)" ]; then
    passed=0
    report+="     a check changed files this eval does not allow:"$'\n'"$(strays)"$'\n'
  fi
fi

# An eval with no checks proves nothing, so it never passes.
[ "$total" -gt 0 ] || report+="     the eval defines no checks"$'\n'

if [ "$total" -gt 0 ] && [ "$passed" -eq "$total" ]; then
  echo "PASS $name ($passed/$total checks)"
else
  echo "FAIL $name ($passed/$total checks)"
  printf '%s' "$report"
  exit 1
fi
