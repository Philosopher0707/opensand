#!/usr/bin/env bash
# Ordered batch merge train: run a list of PRs through scripts/pr-gate.sh under one global
# lock, stopping at the first failure so a failed PR cannot leave a half-applied train behind.
# Usage: scripts/pr-gate-batch.sh [--dry-run] [--batch-size N] <PR-number>...
#
# Candidate selection (gh pr list --label rigel-pass) is the caller's job: pass the ordered
# PR numbers this train should process. OPENSAND_MERGE_TRAIN_LOCK overrides the lock directory
# (default ~/.opensand/merge-train.lock); PR_GATE_CMD overrides the gate executable for tests.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$ROOT/scripts"

source "$SCRIPT_DIR/lib/owner-guard.sh"
assert_not_owner_checkout "pr-gate-batch.sh"

cd "$ROOT"

LOCK_DIR="${OPENSAND_MERGE_TRAIN_LOCK:-$HOME/.opensand/merge-train.lock}"
GATE="${PR_GATE_CMD:-$SCRIPT_DIR/pr-gate.sh}"
GATE_ARGS=()
DRY_RUN=0
BATCH_SIZE=0
PRS=()
USAGE="Usage: scripts/pr-gate-batch.sh [--dry-run] [--batch-size N] <PR-number>..."

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --batch-size)
      if [[ $# -lt 2 || ! "$2" =~ ^[1-9][0-9]*$ ]]; then
        echo "FAIL: --batch-size needs a positive whole number" >&2
        echo "$USAGE" >&2
        exit 1
      fi
      BATCH_SIZE="$2"
      shift 2
      ;;
    -h|--help)
      echo "$USAGE"
      exit 0
      ;;
    *)
      if [[ "$1" =~ ^[0-9]+$ ]]; then
        PRS+=("$1")
        shift
      else
        echo "FAIL: unknown argument: $1" >&2
        echo "$USAGE" >&2
        exit 1
      fi
      ;;
  esac
done

if [[ ${#PRS[@]} -eq 0 ]]; then
  echo "FAIL: missing PR numbers" >&2
  echo "$USAGE" >&2
  exit 1
fi
if [[ "$BATCH_SIZE" -gt 0 && "$BATCH_SIZE" -lt "${#PRS[@]}" ]]; then
  PRS=("${PRS[@]:0:$BATCH_SIZE}")
fi
if [[ "$DRY_RUN" -eq 1 ]]; then
  GATE_ARGS+=(--dry-run)
fi

if [[ ! -x "$GATE" ]]; then
  echo "FAIL: PR gate is not executable: $GATE (set PR_GATE_CMD)" >&2
  exit 1
fi

TRAIN_ID="$(date +%Y%m%d-%H%M%S)-$$"
LOCK_TOKEN="$$-$TRAIN_ID"
LOCK_HELD=0

release_lock() {
  [[ "$LOCK_HELD" -eq 1 ]] || return 0
  local on_disk=""
  if [[ -f "$LOCK_DIR/payload.json" ]]; then
    on_disk="$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$LOCK_DIR/payload.json" 2>/dev/null || true)"
  fi
  # No payload means our own write failed; a matching token proves the lock is still ours.
  if [[ -z "$on_disk" || "$on_disk" == "$LOCK_TOKEN" ]]; then
    rm -f "$LOCK_DIR/payload.json" || true
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
  LOCK_HELD=0
}
trap release_lock EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Only a lock with no payload, a dead holder, or an age over 30 min can be safely evicted.
evict_stale_lock() {
  echo "WARN: evicting stale merge train lock at $LOCK_DIR ($1)" >&2
  rm -f "$LOCK_DIR/payload.json" || true
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

mkdir -p "$(dirname "$LOCK_DIR")"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  PAYLOAD="$LOCK_DIR/payload.json"
  if [[ ! -f "$PAYLOAD" ]]; then
    evict_stale_lock "no payload"
  else
    HOLDER_PID="$(sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$PAYLOAD" 2>/dev/null || true)"
    STARTED="$(sed -n 's/.*"startTime":\([0-9][0-9]*\).*/\1/p' "$PAYLOAD" 2>/dev/null || true)"
    AGE=0
    if [[ "$STARTED" =~ ^[0-9]+$ ]]; then
      AGE=$(( $(date +%s) - STARTED ))
    fi
    if [[ "$HOLDER_PID" =~ ^[0-9]+$ ]] && ! kill -0 "$HOLDER_PID" 2>/dev/null; then
      evict_stale_lock "holder pid $HOLDER_PID is gone"
    elif [[ "$AGE" -gt 1800 ]]; then
      evict_stale_lock "age ${AGE}s exceeds 1800s"
    else
      echo "FAIL: merge train lock active: $LOCK_DIR (holder pid ${HOLDER_PID:-unknown}, age ${AGE}s)" >&2
      exit 1
    fi
  fi
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "FAIL: merge train lock active: $LOCK_DIR (could not re-acquire after stale eviction)" >&2
    exit 1
  fi
fi

LOCK_HELD=1
printf '{"pid":%s,"trainId":"%s","startTime":%s,"host":"%s","token":"%s"}\n' \
  "$$" "$TRAIN_ID" "$(date +%s)" "$(hostname)" "$LOCK_TOKEN" > "$LOCK_DIR/payload.json"

echo "==> Merge train $TRAIN_ID: ${#PRS[@]} PR(s) in order: ${PRS[*]}"
for pr in "${PRS[@]}"; do
  echo "==> [train] PR #$pr through $GATE"
  if "$GATE" ${GATE_ARGS[@]+"${GATE_ARGS[@]}"} "$pr"; then
    echo "PASS: [train] PR #$pr completed"
  else
    rc=$?
    echo "FAIL: [train] PR #$pr failed with exit $rc; stopping the train (later PRs not processed)" >&2
    exit "$rc"
  fi
done
echo "PASS: merge train $TRAIN_ID completed ${#PRS[@]} PR(s)"
