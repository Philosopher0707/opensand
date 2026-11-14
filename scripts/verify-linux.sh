#!/usr/bin/env bash
# Runs CI's ubuntu job locally: `pnpm install --frozen-lockfile`, then `SKIP_INSTALL=1 bash scripts/verify.sh`,
# inside node:22-bookworm on a standalone clone of the current branch (a worktree's .git points at a host path).
# Usage: scripts/verify-linux.sh            one run
#        RUNS=20 scripts/verify-linux.sh    N runs in fresh clones; prints pass/fail counts
# Exit code is verify's own: 0 only if every run passed, otherwise the first failing run's exit code.
# Committed work only: uncommitted changes are not in the clone.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNS="${RUNS:-1}"
IMAGE="${VERIFY_LINUX_IMAGE:-node:22-bookworm}"

command -v docker >/dev/null 2>&1 || { echo "verify-linux: docker is required" >&2; exit 1; }
[[ "$RUNS" =~ ^[1-9][0-9]*$ ]] || { echo "verify-linux: RUNS must be a positive integer" >&2; exit 1; }

BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
SHA="$(git -C "$ROOT" rev-parse HEAD)"
if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
  echo "verify-linux: warning: uncommitted changes are not tested (checking $SHA)" >&2
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/opensand-verify-linux.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
FIRST_FAIL=0
for ((i = 1; i <= RUNS; i++)); do
  CLONE="$WORK/run-$i"
  git clone --quiet --no-hardlinks "$ROOT" "$CLONE" || exit 1
  git -C "$CLONE" checkout --quiet --detach "$SHA" || exit 1
  echo "verify-linux: run $i/$RUNS on $BRANCH @ ${SHA:0:7} in $IMAGE"
  docker run --rm --privileged \
    -v "$CLONE:/work" -w /work \
    -e CI=1 -e DEBIAN_FRONTEND=noninteractive \
    "$IMAGE" bash -c '
      set -euo pipefail
      git config --global safe.directory "*"
      apt-get update -qq >/dev/null
      apt-get install -y -qq bubblewrap procps >/dev/null
      npm install -g --silent pnpm@10
      pnpm install --frozen-lockfile
      SKIP_INSTALL=1 bash scripts/verify.sh
    '
  status=$?
  if [[ $status -eq 0 ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    [[ $FIRST_FAIL -eq 0 ]] && FIRST_FAIL=$status
    echo "verify-linux: run $i FAILED (exit $status)" >&2
  fi
  rm -rf "$CLONE"
done

echo "verify-linux: $PASS passed, $FAIL failed, $RUNS total"
exit "$FIRST_FAIL"
