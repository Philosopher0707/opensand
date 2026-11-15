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

# make_workspace <dir> <kind>: kind is ok | failing | zero | second-run-fails
make_workspace() {
  local dir="$1" kind="$2"
  mkdir -p "$dir/scripts" "$dir/packages/good/src" "$dir/packages/target/src"
  cp "$VERIFY" "$dir/scripts/verify.sh"
  cp "$ROOT/scripts/sync-versions.js" "$dir/scripts/sync-versions.js"
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
    zero)    printf '{"name":"@fake/target","version":"1.0.0","scripts":{"build":"node -e 0","test":"node zero.mjs"}}\n' > "$dir/packages/target/package.json"
             echo "console.log('# tests 0');" > "$dir/packages/target/zero.mjs" ;;
    # Passes the first time and fails the second: proves the suite is run once, not twice.
    second-run-fails)
      printf "import test from 'node:test';\nimport fs from 'node:fs';\ntest('fails on a second run', () => {\n  if (fs.existsSync('.ran')) throw new Error('suite ran twice');\n  fs.writeFileSync('.ran', '1');\n});\n" > "$dir/packages/target/test.mjs" ;;
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

mkdir -p "$WORK"
expect healthy ok 0 "verify: ok"
expect failing-test failing 1 "verify error: Package @fake/target failed its tests" "✖ deliberately failing test" "opensand-verify/@fake__target.log"
expect single-run second-run-fails 0 "verify: ok"
expect zero-tests zero 1 "Package @fake/target has TypeScript sources in src/ but reported 0 tests!"

exit "$FAILED"
