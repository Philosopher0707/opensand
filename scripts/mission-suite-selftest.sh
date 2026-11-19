#!/usr/bin/env bash
# Hermetic selftest for scripts/mission-suite.sh: argument handling, exit codes,
# and the fixture contract (every check names its target first).
# Runs no build and no mission, so it is safe in the pre-commit gate.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/mission-suite.sh"
FIXTURES="$ROOT/evals/mission-suite"

fail() { echo "FAIL: $*" >&2; exit 1; }

run() { set +e; OUT="$("$@" 2>&1)"; CODE=$?; set -e; }

echo "==> [1/4] --help exits 0 and shows the target flag"
run bash "$SCRIPT" --help
[[ $CODE -eq 0 ]] || fail "--help exited $CODE"
grep -q -- "--target local" <<<"$OUT" || fail "--help does not mention --target local"

echo "==> [2/4] unknown targets and ssh without its host exit 2 with a reason"
run bash "$SCRIPT" --target bogus
[[ $CODE -eq 2 ]] || fail "unknown target exited $CODE, want 2"
grep -q "unknown target 'bogus'" <<<"$OUT" || fail "unknown target has no clear message"

unset OPENSAND_SSH_TARGET
run bash "$SCRIPT" --target ssh
[[ $CODE -eq 2 ]] || fail "--target ssh without OPENSAND_SSH_TARGET exited $CODE, want 2"
grep -q "OPENSAND_SSH_TARGET" <<<"$OUT" || fail "the ssh refusal does not name OPENSAND_SSH_TARGET"

echo "==> [3/4] every fixture is valid JSON with rounds and a target-prefixed check"
for name in verified false-claim repair budget changed-lines; do
  file="$FIXTURES/$name.json"
  [[ -f "$file" ]] || fail "missing fixture $file"
  node -e '
    const f = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (!Array.isArray(f.rounds) || f.rounds.length === 0) throw new Error("rounds missing");
    if (typeof f.title !== "string" || typeof f.initialQuery !== "string") throw new Error("title/initialQuery missing");
    if (!String(f.checkCommand).startsWith("printf '\''target=%s\\n'\''")) throw new Error("check does not name the target first");
    if (typeof f.maxRepairs !== "number") throw new Error("maxRepairs missing");
  ' "$file" || fail "fixture $name breaks the contract"
done

echo "==> [4/4] an unavailable target is refused before any build runs"
STUB_BIN="$(mktemp -d)"
trap 'rm -rf "$STUB_BIN"' EXIT
cat > "$STUB_BIN/pnpm" <<'STUB'
#!/usr/bin/env bash
touch "${PNPM_STUB_MARKER:?}"
STUB
chmod +x "$STUB_BIN/pnpm"
PNPM_STUB_MARKER="$STUB_BIN/called"
set +e
OUT="$(env -u OPENSAND_SSH_TARGET PNPM_STUB_MARKER="$PNPM_STUB_MARKER" PATH="$STUB_BIN:$PATH" bash "$SCRIPT" --target ssh 2>&1)"
CODE=$?
set -e
[[ $CODE -eq 2 ]] || fail "--target ssh exited $CODE, want 2"
[[ ! -f "$STUB_BIN/called" ]] || fail "the suite built before refusing the target"

echo "mission-suite-selftest: ok"
