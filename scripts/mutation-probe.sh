#!/usr/bin/env bash
# Mutation probe: proves a selftest can fail by breaking the code on purpose.
# Usage: scripts/mutation-probe.sh <file> <perl-substitution> -- <selftest command...>
#   e.g. scripts/mutation-probe.sh scripts/lib/worktree-safety.sh 's/-mmin "-\$window"/-mmin "+\$window"/' -- bash scripts/clean-disk-selftest.sh
# Steps: (1) baseline run must be GREEN, (2) the mutation must change the file and the run must be
# RED (mutant killed), (3) the file is restored byte-for-byte and the run must be GREEN again.
# Exit 0 only when all three hold; exit 1 when the mutant SURVIVED (the selftest is blind to it).
set -uo pipefail

if [[ $# -lt 4 || "$3" != "--" ]]; then
  echo "Usage: scripts/mutation-probe.sh <file> <perl-substitution> -- <command...>" >&2
  exit 2
fi
FILE="$1"
EXPR="$2"
shift 3

[[ -f "$FILE" ]] || { echo "FAIL: no such file: $FILE" >&2; exit 2; }
command -v perl >/dev/null 2>&1 || { echo "FAIL: perl is required" >&2; exit 2; }

BACKUP="$(mktemp "${TMPDIR:-/tmp}/opensand-mutation-probe.XXXXXX")"
cp -p "$FILE" "$BACKUP"
restore() { cp -p "$BACKUP" "$FILE"; rm -f "$BACKUP"; }
trap restore EXIT

run_cmd() {
  local out status=0
  out=$("$@" 2>&1 < /dev/null) || status=$?
  LAST_STATUS=$status
  LAST_OUT="$out"
}

echo "==> [probe] baseline: running '$*' on the unmutated file..."
run_cmd "$@"
if [[ "$LAST_STATUS" -ne 0 ]]; then
  echo "FAIL: baseline is not green (exit $LAST_STATUS); fix the selftest before probing" >&2
  echo "$LAST_OUT" | tail -15 | sed 's/^/    | /' >&2
  exit 1
fi
echo "GREEN baseline (exit 0)"

perl -0777 -pi -e "$EXPR" "$FILE"
if cmp -s "$FILE" "$BACKUP"; then
  echo "FAIL: mutation '$EXPR' did not change $FILE (pattern not found)" >&2
  exit 2
fi
echo "==> [probe] mutant applied to $FILE:"
diff "$BACKUP" "$FILE" | sed 's/^/    /'

run_cmd "$@"
if [[ "$LAST_STATUS" -eq 0 ]]; then
  echo "SURVIVED: the selftest stayed green with the mutant (exit 0); it cannot see this breakage" >&2
  exit 1
fi
echo "RED with mutant (exit $LAST_STATUS): mutant killed. First failures:"
echo "$LAST_OUT" | grep -E "^FAIL" | head -5 | sed 's/^/    | /'

cp -p "$BACKUP" "$FILE"
echo "==> [probe] restored $FILE; running again..."
run_cmd "$@"
if [[ "$LAST_STATUS" -ne 0 ]]; then
  echo "FAIL: not green after restore (exit $LAST_STATUS)" >&2
  echo "$LAST_OUT" | tail -15 | sed 's/^/    | /' >&2
  exit 1
fi
echo "GREEN after restore (exit 0)"
echo "PROBE OK: baseline GREEN, mutant RED, restored GREEN"
