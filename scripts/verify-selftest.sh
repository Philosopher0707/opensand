#!/usr/bin/env bash
# Checks verify.sh on a throwaway workspace: a failing test is named in the output, a package with
# sources but no tests trips the zero-test guard, and a healthy workspace passes.
# Usage: scripts/verify-selftest.sh            (VERIFY_SCRIPT=<path> to test another copy of verify.sh)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFY="${VERIFY_SCRIPT:-$ROOT/scripts/verify.sh}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/opensand-verify-selftest.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
FAILED=0

# make_workspace <dir> <kind>: kind is ok | failing | zero | second-run-fails | parallel-ok | parallel-failing
make_workspace() {
  local dir="$1" kind="$2"
  mkdir -p "$dir/scripts" "$dir/packages/good/src" "$dir/packages/target/src"
  cp "$VERIFY" "$dir/scripts/verify.sh"
  cp "$ROOT/scripts/sync-versions.js" "$dir/scripts/sync-versions.js"
  # The two checkers verify.sh calls have their own selftests; here they are stubs, and the lessons
  # one fails on demand so the wiring in verify.sh is tested.
  printf '#!/usr/bin/env bash\nexit 0\n' > "$dir/scripts/check-scripts-catalog.sh"
  printf '#!/usr/bin/env bash\n[[ -f "$(dirname "$0")/../.lessons-stale" ]] && { echo "FAIL: docs/lessons/INDEX.md is stale. Run: bash scripts/lessons-index.sh" >&2; exit 1; }\nexit 0\n' > "$dir/scripts/lessons-index.sh"

  printf '{"name":"root","version":"1.0.0","private":true,"type":"module"}\n' > "$dir/package.json"
  printf 'packages:\n  - "packages/*"\n' > "$dir/pnpm-workspace.yaml"
  printf '{"name":"@fake/good","version":"1.0.0","scripts":{"build":"node -e 0","test":"node --test test.mjs"}}\n' > "$dir/packages/good/package.json"
  echo 'export const a = 1;' > "$dir/packages/good/src/a.ts"
  printf "import test from 'node:test';\ntest('good passes', () => {});\n" > "$dir/packages/good/test.mjs"
  printf '{"name":"@fake/target","version":"1.0.0","scripts":{"build":"node -e 0","test":"node --test test.mjs"}}\n' > "$dir/packages/target/package.json"
  echo 'export const b = 1;' > "$dir/packages/target/src/b.ts"
  case "$kind" in
    ok)      printf "import test from 'node:test';\ntest('target passes', () => {});\n" > "$dir/packages/target/test.mjs" ;;
    failing) printf "import test from 'node:test';\nimport assert from 'node:assert';\ntest('deliberately failing test', () => { assert.equal(1, 2); });\n" > "$dir/packages/target/test.mjs" ;;
    lessons-stale) printf "import test from 'node:test';\ntest('target passes', () => {});\n" > "$dir/packages/target/test.mjs"
             touch "$dir/.lessons-stale" ;;
    zero)    printf '{"name":"@fake/target","version":"1.0.0","scripts":{"build":"node -e 0","test":"node zero.mjs"}}\n' > "$dir/packages/target/package.json"
             echo "console.log('# tests 0');" > "$dir/packages/target/zero.mjs" ;;
    # Passes the first time and fails the second: proves the suite is run once, not twice.
    second-run-fails)
      printf "import test from 'node:test';\nimport fs from 'node:fs';\ntest('fails on a second run', () => {\n  if (fs.existsSync('.ran')) throw new Error('suite ran twice');\n  fs.writeFileSync('.ran', '1');\n});\n" > "$dir/packages/target/test.mjs" ;;
    parallel-ok)
      cat << 'EOF' > "$dir/packages/target/test.mjs"
import test from "node:test";
import fs from "node:fs";
test("target passes", async () => {
  const b = process.env.BARRIER_DIR;
  if (b) {
    fs.writeFileSync(`${b}/pass_ready`, "1");
    for (let i = 0; i < 100 && !fs.existsSync(`${b}/fail_ready`); i++) {
      await new Promise(r => setTimeout(r, 20));
    }
    await new Promise(r => setTimeout(r, 80));
  }
});
EOF
      ;;
    parallel-failing)
      cat << 'EOF' > "$dir/packages/target/test.mjs"
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
test("deliberately failing test", async () => {
  const b = process.env.BARRIER_DIR;
  if (b) {
    fs.writeFileSync(`${b}/fail_ready`, "1");
    for (let i = 0; i < 100 && !fs.existsSync(`${b}/pass_ready`); i++) {
      await new Promise(r => setTimeout(r, 20));
    }
    await new Promise(r => setTimeout(r, 40));
  }
  assert.equal(1, 2);
});
EOF
      ;;
  esac
}

# expect <label> <kind> <expected exit> <required output substring>...
expect() {
  local label="$1" kind="$2" want="$3"; shift 3
  local dir="$WORK/$label" out status
  make_workspace "$dir" "$kind"
  out=$(cd "$dir" && SKIP_INSTALL=1 TMPDIR="$dir/tmp" bash scripts/verify.sh 2>&1 < /dev/null)
  status=$?
  local ok=1
  [[ "$status" -eq "$want" ]] || ok=0
  for needle in "$@"; do
    grep -qF -- "$needle" <<<"$out" || ok=0
  done
  if [[ "$ok" -eq 1 ]]; then
    echo "PASS $label (exit $status)"
  else
    echo "FAIL $label: exit $status, wanted $want, needed: $*"
    echo "$out" | sed 's/^/    | /'
    FAILED=1
  fi
}

expect_parallel_runs() {
  local label="parallel-runs"
  local shared_tmp="$WORK/parallel-shared-tmp"
  mkdir -p "$shared_tmp"
  local dir_pass="$WORK/parallel-pass"
  local dir_fail="$WORK/parallel-fail"
  make_workspace "$dir_pass" parallel-ok
  make_workspace "$dir_fail" parallel-failing

  local out_pass="$WORK/out-pass.log"
  local out_fail="$WORK/out-fail.log"

  (cd "$dir_pass" && SKIP_INSTALL=1 TMPDIR="$shared_tmp" BARRIER_DIR="$shared_tmp" bash scripts/verify.sh > "$out_pass" 2>&1 < /dev/null) &
  local pid_pass=$!
  (cd "$dir_fail" && SKIP_INSTALL=1 TMPDIR="$shared_tmp" BARRIER_DIR="$shared_tmp" bash scripts/verify.sh > "$out_fail" 2>&1 < /dev/null) &
  local pid_fail=$!

  local status_pass=0 status_fail=0
  wait "$pid_pass" || status_pass=$?
  wait "$pid_fail" || status_fail=$?

  local ok=1
  [[ "$status_pass" -eq 0 ]] || ok=0
  [[ "$status_fail" -eq 1 ]] || ok=0

  grep -qF "verify: ok" "$out_pass" || ok=0
  if grep -qF "verify error:" "$out_pass"; then ok=0; fi

  grep -qF "verify error: Package @fake/target failed its tests" "$out_fail" || ok=0
  grep -qF "✖ deliberately failing test" "$out_fail" || ok=0
  grep -qF "verify error: Log directory:" "$out_fail" || ok=0
  grep -qF "opensand-verify." "$out_fail" || ok=0

  local fail_log
  fail_log=$(grep -E 'verify error: Full output: ' "$out_fail" | awk '{print $NF}')
  if [[ -z "$fail_log" || ! -f "$fail_log" ]]; then
    ok=0
  else
    # Clobber check: failing log must contain its own failure, and must NOT contain target passes from the parallel run
    grep -qF "deliberately failing test" "$fail_log" || ok=0
    if grep -qF "target passes" "$fail_log"; then
      ok=0
    fi
  fi

  if [[ "$ok" -eq 1 ]]; then
    echo "PASS $label (pass exit $status_pass, fail exit $status_fail)"
  else
    echo "FAIL $label: pass exit $status_pass (wanted 0), fail exit $status_fail (wanted 1)"
    echo "--- pass output ---"
    cat "$out_pass" | sed 's/^/    | /'
    echo "--- fail output ---"
    cat "$out_fail" | sed 's/^/    | /'
    if [[ -n "${fail_log:-}" && -f "${fail_log:-}" ]]; then
      echo "--- fail log ($fail_log) ---"
      cat "$fail_log" | sed 's/^/    | /'
    fi
    FAILED=1
  fi
}

mkdir -p "$WORK"
expect healthy ok 0 "verify: ok"
expect failing-test failing 1 "verify error: Package @fake/target failed its tests" "✖ deliberately failing test" "verify error: Log directory:" "opensand-verify." "/@fake__target.log"
expect single-run second-run-fails 0 "verify: ok"
expect zero-tests zero 1 "Package @fake/target has TypeScript sources in src/ but reported 0 tests!"
expect lessons-stale lessons-stale 1 "FAIL: docs/lessons/INDEX.md is stale"
expect_parallel_runs


if [[ -f "$ROOT/scripts/proof-selftest.sh" ]]; then
  echo "==> Running proof-selftest.sh..."
  bash "$ROOT/scripts/proof-selftest.sh" || FAILED=1
fi

exit "$FAILED"
