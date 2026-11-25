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

# make_workspace <dir> <kind>: kind is ok | failing | zero | second-run-fails | parallel-ok | parallel-failing | lint-brief-failing | lessons-stale | lessons-merge-failing | dead-exports-failing | raw-errors-failing
make_workspace() {
  local dir="$1" kind="$2"
  mkdir -p "$dir/scripts" "$dir/docs" "$dir/packages/good/src" "$dir/packages/target/src"
  cp "$VERIFY" "$dir/scripts/verify.sh"
  cp "$ROOT/scripts/sync-versions.js" "$dir/scripts/sync-versions.js"
  # The repo checkers verify.sh calls have their own selftests; here they are stubs, and the lessons
  # and lint-brief ones fail on demand so the wiring in verify.sh is tested.
  printf '#!/usr/bin/env bash\nexit 0\n' > "$dir/scripts/check-scripts-catalog.sh"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$dir/scripts/check-doc-links.sh"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$dir/scripts/check-real-window-nav.sh"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$dir/scripts/check-hidden-window-spawns.sh"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$dir/scripts/check-test-teardown.sh"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$dir/scripts/check-engine-wrapper-sync.sh"
  printf '#!/usr/bin/env bash\n[[ -f "$(dirname "$0")/../.dead-exports-fail" ]] && { echo "FAIL: new dead export" >&2; exit 1; }\nexit 0\n' > "$dir/scripts/check-dead-exports.sh"
  printf '#!/usr/bin/env bash\n[[ -f "$(dirname "$0")/../.raw-errors-fail" ]] && { echo "FAIL: new raw error" >&2; exit 1; }\nexit 0\n' > "$dir/scripts/check-raw-errors.sh"
  printf '#!/usr/bin/env bash\n[[ -f "$(dirname "$0")/../.lessons-stale" ]] && { echo "FAIL: docs/lessons/INDEX.md is stale. Run: bash scripts/lessons-index.sh" >&2; exit 1; }\nexit 0\n' > "$dir/scripts/lessons-index.sh"
  printf '#!/usr/bin/env bash\n[[ -f "$(dirname "$0")/../.lessons-merge-fail" ]] && { echo "FAIL: generated lessons-index rebase merge" >&2; exit 1; }\nexit 0\n' > "$dir/scripts/lessons-index-merge-selftest.sh"
  printf '#!/usr/bin/env bash\n[[ -f "$(dirname "$0")/../.lint-brief-fail" ]] && { echo "FAIL: docs/brief-template.md missing sections: Goal" >&2; exit 1; }\nexit 0\n' > "$dir/scripts/lint-brief.sh"
  printf '# Bot brief template\n\nGoal: the outcome.\n\nDone when: the finish line.\n\nScope: what may be touched.\n\nReport back with: the proof.\n' > "$dir/docs/brief-template.md"

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
    lessons-merge-failing) printf "import test from 'node:test';\ntest('target passes', () => {});\n" > "$dir/packages/target/test.mjs"
             touch "$dir/.lessons-merge-fail" ;;
    lint-brief-failing) printf "import test from 'node:test';\ntest('target passes', () => {});\n" > "$dir/packages/target/test.mjs"
             touch "$dir/.lint-brief-fail" ;;
    dead-exports-failing) printf "import test from 'node:test';\ntest('target passes', () => {});\n" > "$dir/packages/target/test.mjs"
             touch "$dir/.dead-exports-fail" ;;
    raw-errors-failing) printf "import test from 'node:test';\ntest('target passes', () => {});\n" > "$dir/packages/target/test.mjs"
             touch "$dir/.raw-errors-fail" ;;
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

# expect_docs_only <label> <code-change 0|1> <want-skip 0|1>: a fake pull_request event drives
# the docs-only detection; the code-change variant must still run the full build/test suite.
expect_docs_only() {
  local label="$1" code_change="$2" want_skip="$3"
  local dir="$WORK/$label" base out status ok=1
  make_workspace "$dir" ok
  (
    cd "$dir"
    git init -q
    git config user.email test@example.com
    git config user.name test
    git add -A && git commit -qm base
    base=$(git rev-parse HEAD)
    mkdir -p docs
    echo "docs note" > docs/note.md
    [[ "$code_change" -eq 1 ]] && echo 'export const c = 1;' > packages/good/src/c.ts
    git add -A && git commit -qm change
    printf '{"pull_request":{"base":{"sha":"%s"}}}' "$base" > event.json
    GITHUB_EVENT_NAME=pull_request GITHUB_EVENT_PATH="$dir/event.json" SKIP_INSTALL=1 TMPDIR="$dir/tmp" bash scripts/verify.sh > out.txt 2>&1
    echo $? > status.txt
  )
  status=$(cat "$dir/status.txt")
  out=$(cat "$dir/out.txt")
  [[ "$status" -eq 0 ]] || ok=0
  if [[ "$want_skip" -eq 1 ]]; then
    grep -qF "skipping build and tests" <<<"$out" || ok=0
    grep -qF "verify: ok" <<<"$out" && ok=0
  else
    grep -qF "verify: ok" <<<"$out" || ok=0
    grep -qF "skipping build and tests" <<<"$out" && ok=0
  fi
  if [[ "$ok" -eq 1 ]]; then
    echo "PASS $label (exit $status, skip=$want_skip)"
  else
    echo "FAIL $label: skip=$want_skip exit=$status"
    sed 's/^/    | /' "$dir/out.txt"
    FAILED=1
  fi
}


# expect_affected_packages <label> <event> <target> <missing_base 0|1> <verify_all 0|1> <want_coord_test 0|1> <want_desktop_test 0|1> <want_desktop_skip 0|1>

# expect_release_docs_only <label>: proves RELEASE_TAG on a docs-only diff fails closed to full build+tests

# expect_wildcard_selftest_handling: verifies that changed scripts matching wildcard patterns do not accidentally trigger glob expansion across other selftests
expect_wildcard_selftest_handling() {
  local label="wildcard-selftest-handling"
  local dir="$WORK/$label" base out status ok=1

  make_workspace "$dir" ok
  mkdir -p "$dir/packages/desktop/src"
  printf "{\"name\":\"@opensand/desktop\",\"version\":\"1.0.0\",\"scripts\":{\"build\":\"node -e 0\",\"test\":\"node --test test.mjs\"}}\n" > "$dir/packages/desktop/package.json"
  echo "export const d = 1;" > "$dir/packages/desktop/src/d.ts"
  printf "import test from 'node:test';\ntest('desktop passes', () => {});\n" > "$dir/packages/desktop/test.mjs"

  # Create literal wildcard and space-named selftests plus an extra sentinel
  star_st="$dir/scripts/*-selftest.sh"
  printf "#!/usr/bin/env bash\necho \"running star selftest\"\nexit 0\n" > "$star_st"
  space_st="$dir/scripts/space name-selftest.sh"
  printf "#!/usr/bin/env bash\necho \"running space selftest\"\nexit 0\n" > "$space_st"
  extra_st="$dir/scripts/extra-selftest.sh"
  printf "#!/usr/bin/env bash\necho \"running extra sentinel selftest\"\nexit 0\n" > "$extra_st"
  chmod +x "$star_st" "$space_st" "$extra_st"

  (
    cd "$dir"
    git init -q
    git config user.email test@example.com
    git config user.name test
    git add -A && git commit -qm base
    base=$(git rev-parse HEAD)

    # Only modify *-selftest.sh and space name-selftest.sh; extra-selftest.sh is untouched
    echo "# edit star" >> "$star_st"
    echo "# edit space" >> "$space_st"
    git add -A && git commit -qm "edit wildcard and space selftests"

    printf "{\"pull_request\":{\"base\":{\"sha\":\"%s\"}}}" "$base" > event.json
    GITHUB_EVENT_NAME=pull_request GITHUB_EVENT_PATH="$dir/event.json" SKIP_INSTALL=1 TMPDIR="$dir/tmp" bash scripts/verify.sh > out.txt 2>&1
    echo $? > status.txt
  )

  status=$(cat "$dir/status.txt")
  out=$(cat "$dir/out.txt")
  [[ "$status" -eq 0 ]] || ok=0

  grep -qF "verify: running script selftest scripts/*-selftest.sh..." <<<"$out" || ok=0
  grep -qF "running star selftest" <<<"$out" || ok=0
  grep -qF "verify: running script selftest scripts/space name-selftest.sh..." <<<"$out" || ok=0
  grep -qF "running space selftest" <<<"$out" || ok=0

  # extra sentinel selftest must NOT run!
  if grep -qF "extra-selftest.sh" <<<"$out"; then
    ok=0
  fi
  if grep -qF "extra sentinel selftest" <<<"$out"; then
    ok=0
  fi
  grep -qF "verify: ok" <<<"$out" || ok=0

  if [[ "$ok" -eq 1 ]]; then
    echo "PASS $label (exit $status)"
  else
    echo "FAIL $label: exit $status, unquoted or unintended selftest ran"
    sed 's/^/    | /' "$dir/out.txt"
    FAILED=1
  fi
}

# expect_rename_code_to_docs: verifies that renaming source code into docs/ does not trigger docs-only skip
expect_rename_code_to_docs() {
  local label="$1"
  local dir="$WORK/$label" base out status ok=1
  make_workspace "$dir" ok
  (
    cd "$dir"
    git init -q
    git config user.email test@example.com
    git config user.name test
    git add -A && git commit -qm base
    base=$(git rev-parse HEAD)

    mkdir -p docs
    git mv packages/good/src/a.ts docs/a.md
    git add -A && git commit -qm "rename code to docs"

    printf "{\"pull_request\":{\"base\":{\"sha\":\"%s\"}}}" "$base" > event.json
    GITHUB_EVENT_NAME=pull_request GITHUB_EVENT_PATH="$dir/event.json" SKIP_INSTALL=1 TMPDIR="$dir/tmp" bash scripts/verify.sh > out.txt 2>&1
    echo $? > status.txt
  )
  status=$(cat "$dir/status.txt")
  out=$(cat "$dir/out.txt")
  [[ "$status" -eq 0 ]] || ok=0
  grep -qF "verify: ok" <<<"$out" || ok=0
  if grep -qF "skipping build and tests" <<<"$out"; then
    ok=0
  fi
  if ! grep -qF "@fake/good" <<<"$out"; then
    ok=0
  fi
  if [[ "$ok" -eq 1 ]]; then
    echo "PASS $label (exit $status)"
  else
    echo "FAIL $label: code-to-docs rename skipped build/tests or failed"
    sed 's/^/    | /' "$dir/out.txt"
    FAILED=1
  fi
}

expect_release_docs_only() {
  local label="$1"
  local dir="$WORK/$label" base out status ok=1

  make_workspace "$dir" ok
  mkdir -p "$dir/packages/desktop/src"
  printf "{\"name\":\"@opensand/desktop\",\"version\":\"1.0.0\",\"scripts\":{\"build\":\"node -e 0\",\"test\":\"node --test test.mjs\"}}\n" > "$dir/packages/desktop/package.json"
  echo "export const d = 1;" > "$dir/packages/desktop/src/d.ts"
  printf "import test from 'node:test';\ntest('desktop passes', () => {});\n" > "$dir/packages/desktop/test.mjs"

  (
    cd "$dir"
    git init -q
    git config user.email test@example.com
    git config user.name test
    git add -A && git commit -qm base
    base=$(git rev-parse HEAD)

    mkdir -p docs
    echo "docs note" > docs/note.md
    git add -A && git commit -qm "docs only"

    printf "{\"pull_request\":{\"base\":{\"sha\":\"%s\"}}}" "$base" > event.json
    GITHUB_EVENT_NAME=pull_request GITHUB_EVENT_PATH="$dir/event.json" RELEASE_TAG="v1.0.0" SKIP_INSTALL=1 TMPDIR="$dir/tmp" bash scripts/verify.sh > out.txt 2>&1
    echo $? > status.txt
  )

  status=$(cat "$dir/status.txt")
  out=$(cat "$dir/out.txt")
  [[ "$status" -eq 0 ]] || ok=0

  # Must NOT skip build and tests
  grep -qF "skipping build and tests" <<<"$out" && ok=0
  # Must test desktop
  grep -qF "verify: testing package @opensand/desktop" <<<"$out" || ok=0
  grep -qF "verify: ok" <<<"$out" || ok=0

  if [[ "$ok" -eq 1 ]]; then
    echo "PASS $label (exit $status)"
  else
    echo "FAIL $label: exit $status, release tag on docs-only did not run full suite"
    sed 's/^/    | /' "$dir/out.txt"
    FAILED=1
  fi
}

expect_affected_packages() {
  local label="$1" event="$2" target="$3" missing_base="$4" verify_all="$5"
  local want_coord_test="$6" want_desktop_test="$7" want_desktop_skip="$8"
  local dir="$WORK/$label" base out status ok=1

  make_workspace "$dir" ok
  mkdir -p "$dir/packages/coordinator/src" "$dir/packages/desktop/src"
  printf "{\"name\":\"@opensand/coordinator\",\"version\":\"1.0.0\",\"scripts\":{\"build\":\"node -e 0\",\"test\":\"node --test test.mjs\"}}\n" > "$dir/packages/coordinator/package.json"
  echo "export const c = 1;" > "$dir/packages/coordinator/src/c.ts"
  printf "import test from 'node:test';\ntest('coordinator passes', () => {});\n" > "$dir/packages/coordinator/test.mjs"

  printf "{\"name\":\"@opensand/desktop\",\"version\":\"1.0.0\",\"dependencies\":{\"@opensand/coordinator\":\"workspace:*\"},\"scripts\":{\"build\":\"node -e 0\",\"test\":\"node --test test.mjs\"}}\n" > "$dir/packages/desktop/package.json"
  echo "export const d = 1;" > "$dir/packages/desktop/src/d.ts"
  printf "import test from 'node:test';\ntest('desktop passes', () => {});\n" > "$dir/packages/desktop/test.mjs"

  (
    cd "$dir"
    git init -q
    git config user.email test@example.com
    git config user.name test
    git add -A && git commit -qm base
    base=$(git rev-parse HEAD)

    if [[ "$target" == "desktop" ]]; then
      echo "export const d2 = 2;" >> packages/desktop/src/d.ts
    elif [[ "$target" == "coordinator" ]]; then
      echo "export const c2 = 2;" >> packages/coordinator/src/c.ts
    fi
    git add -A && git commit -qm "change on $target"

    if [[ "$missing_base" -eq 1 ]]; then
      GITHUB_EVENT_NAME="$event" VERIFY_ALL="$verify_all" SKIP_INSTALL=1 TMPDIR="$dir/tmp" bash scripts/verify.sh > out.txt 2>&1
    else
      printf "{\"pull_request\":{\"base\":{\"sha\":\"%s\"}}}" "$base" > event.json
      GITHUB_EVENT_NAME="$event" GITHUB_EVENT_PATH="$dir/event.json" VERIFY_ALL="$verify_all" SKIP_INSTALL=1 TMPDIR="$dir/tmp" bash scripts/verify.sh > out.txt 2>&1
    fi
    echo $? > status.txt
  )

  status=$(cat "$dir/status.txt")
  out=$(cat "$dir/out.txt")
  [[ "$status" -eq 0 ]] || ok=0

  if [[ "$want_coord_test" -eq 1 ]]; then
    grep -qF "verify: testing package @opensand/coordinator" <<<"$out" || ok=0
  fi

  if [[ "$want_desktop_test" -eq 1 ]]; then
    grep -qF "verify: testing package @opensand/desktop" <<<"$out" || ok=0
  fi

  if [[ "$want_desktop_skip" -eq 1 ]]; then
    grep -qF "verify: skipping package @opensand/desktop" <<<"$out" || ok=0
    grep -qF "verify: testing package @opensand/desktop" <<<"$out" && ok=0
  fi

  grep -qF "verify: ok" <<<"$out" || ok=0

  if [[ "$ok" -eq 1 ]]; then
    echo "PASS $label (exit $status)"
  else
    echo "FAIL $label: exit $status, coord_test=$want_coord_test desktop_test=$want_desktop_test desktop_skip=$want_desktop_skip"
    sed 's/^/    | /' "$dir/out.txt"
    FAILED=1
  fi
}

mkdir -p "$WORK"
expect healthy ok 0 "verify: ok"
expect failing-test failing 1 "verify error: Package @fake/target failed its tests" "✖ deliberately failing test" "verify error: Log directory:" "opensand-verify." "/@fake__target.log"
expect single-run second-run-fails 0 "verify: ok"
expect zero-tests zero 1 "Package @fake/target has TypeScript sources in src/ but reported 0 tests!"
expect lessons-stale lessons-stale 1 "FAIL: docs/lessons/INDEX.md is stale"
expect lessons-merge-failing lessons-merge-failing 1 "FAIL: generated lessons-index rebase merge"
expect lint-brief-failing lint-brief-failing 1 "FAIL: docs/brief-template.md missing sections: Goal"
expect dead-exports-failing dead-exports-failing 1 "FAIL: new dead export"
expect raw-errors-failing raw-errors-failing 1 "FAIL: new raw error"
expect_parallel_runs
expect_docs_only docs-only-skip 0 1
expect_docs_only docs-and-code-runs-full 1 0
expect_affected_packages desktop-change-runs-full pull_request desktop 0 0 1 1 0
expect_affected_packages coordinator-pr-skips-desktop pull_request coordinator 0 0 1 0 1
expect_affected_packages push-main-runs-full push coordinator 0 0 1 1 0
expect_affected_packages missing-base-sha-fails-closed pull_request coordinator 1 0 1 1 0
expect_affected_packages verify-all-forces-full pull_request coordinator 0 1 1 1 0
expect_release_docs_only release-docs-only-runs-full
expect_wildcard_selftest_handling
expect_rename_code_to_docs rename-code-to-docs-runs-tests

if [[ -f "$ROOT/scripts/proof-selftest.sh" ]]; then
  echo "==> Running proof-selftest.sh..."
  bash "$ROOT/scripts/proof-selftest.sh" || FAILED=1
fi

exit "$FAILED"
