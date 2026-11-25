#!/usr/bin/env bash
# Register the generated lessons-index merge driver for the current repository.
# Usage: scripts/setup-git.sh
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
if [[ ! -x "$ROOT/scripts/lessons-index.sh" ]]; then
  echo "FAIL: scripts/lessons-index.sh is missing or not executable in $ROOT" >&2
  exit 1
fi

git config --local merge.lessons-index.driver 'scripts/lessons-index.sh --merge %B > %A'
echo "Configured lessons-index merge driver in $ROOT"
