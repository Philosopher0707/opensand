#!/usr/bin/env bash
# Hermetic selftest for scripts/pr-gate-batch.sh: a stub PR gate on PR_GATE_CMD, no gh/network.
# Cases: ordered happy path, stop on first failure, live-lock contention, custom-lock
# isolation/cleanup, and stale-lock eviction.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BATCH="${PR_GATE_BATCH_SCRIPT:-$ROOT/scripts/pr-gate-batch.sh}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/opensand-pr-gate-batch-selftest.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
FAILED=0

mkdir -p "$WORK/bin" "$WORK/home"

# No shebang: macOS Endpoint Security can deadlock a freshly generated #! script (AGENTS_LEARNING).
cat > "$WORK/bin/pr-gate-stub" <<'EOS'
printf 'CALL %s\n' "$*" >> "$PR_GATE_LOG"
if [ -d "${OPENSAND_MERGE_TRAIN_LOCK:-/nonexistent}" ]; then
  printf 'LOCK present %s\n' "$*" >> "$PR_GATE_LOG"
else
  printf 'LOCK absent %s\n' "$*" >> "$PR_GATE_LOG"
fi
fail_pr="${PR_GATE_FAIL_PR:-}"
if [ -n "$fail_pr" ]; then
  case " $* " in
    *" $fail_pr "*)
      echo "stub: PR $fail_pr failed" >&2
      exit "${PR_GATE_FAIL_CODE:-7}"
      ;;
  esac
fi
echo "stub: PASS $*"
EOS
chmod +x "$WORK/bin/pr-gate-stub"

fail() { echo "FAIL: $*"; FAILED=1; }

# "-" means no override (exercise the default ~/.opensand path under the sandbox HOME).
run_batch() {
  local lock_path="$1"
  shift
  if [[ "$lock_path" == "-" ]]; then
    HOME="$WORK/home" PR_GATE_CMD="$WORK/bin/pr-gate-stub" PR_GATE_LOG="$WORK/gate.log" \
      bash "$BATCH" "$@"
  else
    HOME="$WORK/home" OPENSAND_MERGE_TRAIN_LOCK="$lock_path" \
      PR_GATE_CMD="$WORK/bin/pr-gate-stub" PR_GATE_LOG="$WORK/gate.log" \
      bash "$BATCH" "$@"
  fi
}

assert_calls() {
  local expected="$1"
  local actual
  actual="$(grep '^CALL ' "$WORK/gate.log" 2>/dev/null || true)"
  if [[ "$actual" != "$expected" ]]; then
    fail "gate calls: expected [$expected], got [$actual]"
  fi
}

echo "==> case 1: happy path, PRs processed in order, default lock cleaned"
: > "$WORK/gate.log"
rm -rf "$WORK/home/.opensand/merge-train.lock"
OUT="$(run_batch - 11 22 33 2>&1)"; RC=$?
[[ "$RC" -eq 0 ]] || fail "case 1 exit $RC: $OUT"
assert_calls "$(printf 'CALL 11\nCALL 22\nCALL 33')"
[[ "$(grep -c '^LOCK absent' "$WORK/gate.log" 2>/dev/null || true)" -eq 3 ]] || fail "case 1 did not delegate all 3 PRs"
[[ ! -e "$WORK/home/.opensand/merge-train.lock" ]] || fail "case 1 left the default lock behind"

echo "==> case 2: stop on first failure (later PR never runs), lock cleaned"
: > "$WORK/gate.log"
rm -rf "$WORK/custom-lock"
export PR_GATE_FAIL_PR=22 PR_GATE_FAIL_CODE=7
OUT="$(run_batch "$WORK/custom-lock" 11 22 33 2>&1)"; RC=$?
unset PR_GATE_FAIL_PR PR_GATE_FAIL_CODE
[[ "$RC" -eq 7 ]] || fail "case 2 exit $RC (expected gate's 7): $OUT"
assert_calls "$(printf 'CALL 11\nCALL 22')"
printf '%s\n' "$OUT" | grep -q "stopping the train" || fail "case 2 did not report the stop: $OUT"
[[ ! -e "$WORK/custom-lock" ]] || fail "case 2 left the lock behind after failure"

echo "==> case 3: live lock contention is refused without touching any PR"
: > "$WORK/gate.log"
mkdir -p "$WORK/contended-lock"
printf '{"pid":%s,"trainId":"other","startTime":%s,"host":"other","token":"foreign"}\n' \
  "$$" "$(date +%s)" > "$WORK/contended-lock/payload.json"
BEFORE="$(cat "$WORK/contended-lock/payload.json")"
OUT="$(run_batch "$WORK/contended-lock" 66 2>&1)"; RC=$?
[[ "$RC" -eq 1 ]] || fail "case 3 exit $RC (expected 1): $OUT"
printf '%s\n' "$OUT" | grep -q "merge train lock active" || fail "case 3 did not name the active lock: $OUT"
[[ ! -s "$WORK/gate.log" ]] || fail "case 3 ran a gate while the lock was held"
[[ "$(cat "$WORK/contended-lock/payload.json")" == "$BEFORE" ]] || fail "case 3 overwrote a foreign lock"
[[ -d "$WORK/contended-lock" ]] || fail "case 3 removed a foreign lock"
rm -rf "$WORK/contended-lock"

echo "==> case 4: custom lock is used and cleaned, default path untouched"
: > "$WORK/gate.log"
rm -rf "$WORK/custom-lock" "$WORK/home/.opensand/merge-train.lock"
OUT="$(run_batch "$WORK/custom-lock" 44 2>&1)"; RC=$?
[[ "$RC" -eq 0 ]] || fail "case 4 exit $RC: $OUT"
assert_calls "CALL 44"
grep -q '^LOCK present 44$' "$WORK/gate.log" || fail "case 4 did not hold the custom lock during the gate"
[[ ! -e "$WORK/custom-lock" ]] || fail "case 4 left the custom lock behind"
[[ ! -e "$WORK/home/.opensand/merge-train.lock" ]] || fail "case 4 created the default lock"

echo "==> case 5: stale lock (dead holder) is evicted and the train proceeds"
: > "$WORK/gate.log"
mkdir -p "$WORK/stale-lock"
printf '{"pid":99999999,"trainId":"gone","startTime":%s,"host":"gone","token":"stale"}\n' \
  "$(date +%s)" > "$WORK/stale-lock/payload.json"
OUT="$(run_batch "$WORK/stale-lock" 55 2>&1)"; RC=$?
[[ "$RC" -eq 0 ]] || fail "case 5 exit $RC: $OUT"
printf '%s\n' "$OUT" | grep -q "evicting stale merge train lock" || fail "case 5 did not report eviction: $OUT"
assert_calls "CALL 55"
[[ ! -e "$WORK/stale-lock" ]] || fail "case 5 left the stale lock behind"

if [[ "$FAILED" -ne 0 ]]; then
  echo "FAIL: pr-gate-batch selftest failed"
  exit 1
fi
echo "PASS: pr-gate-batch selftest (5 cases)"
