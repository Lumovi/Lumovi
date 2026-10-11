#!/usr/bin/env bash
# Runs one of the scripts that judge a pull request, as main has it, not as the pull request does:
#
#   scripts/judge.sh ci-changes.ts            what the run needs
#   scripts/judge.sh borrow-coverage.ts       what's borrowed for the coverage gate
#   scripts/judge.sh check-coverage.ts <file> the gate
#   scripts/judge.sh main-is-green.ts         whether main is red
#   scripts/judge.sh changelog.ts check       its changelog entry
#
# So a pull request can't pass itself by changing its judge: a change to one of these is proven
# by its own tests, and judges from the merge on. (This file and the workflow are the pull
# request's own all the same, as a workflow's always are: a change to either is read as one.)
#
# In a pull request's run the checkout is its merge commit, whose first parent is main (the
# checkout needs `fetch-depth: 2`). A script main doesn't have yet is the pull request's own;
# so is everything on main itself and in a run by hand.
set -euo pipefail

name=$1
shift
if [ "${GITHUB_EVENT_NAME:-}" = pull_request ] && git cat-file -e "HEAD^1:scripts/$name" 2> /dev/null; then
  # Beside each other, and inside the checkout: they find each other and the packages they use.
  mkdir -p .from-main
  for judge in ci-changes.ts borrow-coverage.ts check-coverage.ts main-is-green.ts changelog.ts; do
    git show "HEAD^1:scripts/$judge" > ".from-main/$judge" 2> /dev/null || rm -f ".from-main/$judge"
  done
  echo "(scripts/$name as main has it)"
  exec node ".from-main/$name" "$@"
fi
exec node "scripts/$name" "$@"
