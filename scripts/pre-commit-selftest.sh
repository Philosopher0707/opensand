set -euo pipefail

# Hermetic selftest for scripts/pre-commit.sh
# Tests:
#   1. A commit whose staged changes are clean is allowed (exit 0)
#   2-6. Each blocked secret pattern refuses the commit (exit 1): sk-, sk-or-,
#        ghp_, AKIA + 16, and a PEM private key block
#   7. A refusal names the file and line and never prints the matched value
#   8-9. The hook run from outside the repo (no scripts/ folder there) allows a
#        clean commit and refuses an sk- key, so it loads its library from its
#        own directory, not from the repo being committed
#   10. Staged and untracked PNG test artifacts are refused
#   11. ALLOW_BINARY_ARTIFACTS=1 allows an intentional PNG with a warning
#
# Fake keys are built at runtime from short pieces, so no complete key literal
# exists in this file (GitHub push protection rejects one on push).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/opensand-precommit-selftest.XXXXXX")
cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT

FAILED=0

new_fixture() {
  local dir
  dir=$(mktemp -d "$WORK/repo.XXXXXX")
  mkdir -p "$dir/scripts/lib"
  cp "$ROOT/scripts/pre-commit.sh" "$dir/scripts/pre-commit.sh"
  cp "$ROOT/scripts/lib/worktree-safety.sh" "$dir/scripts/lib/worktree-safety.sh"
  git -C "$dir" init -q
  git -C "$dir" config user.email selftest@example.invalid
  git -C "$dir" config user.name "Pre-commit Selftest"
  printf 'seed\n' > "$dir/seed.txt"
  git -C "$dir" add seed.txt
  git -C "$dir" commit -q -m seed
  echo "$dir"
}

# run_hook <dir> [allow-binary]: runs the hook with the slow build/test steps replaced.
run_hook() {
  local dir="$1" allow_binary="${2:-0}"
  ( cd "$dir" && ALLOW_BINARY_ARTIFACTS="$allow_binary" OPENSAND_PRECOMMIT_BUILD_CMD=true OPENSAND_PRECOMMIT_TEST_CMD=true bash scripts/pre-commit.sh 2>&1 )
}

# expect_clean <label>: a harmless staged change must commit.
expect_clean() {
  local label="$1" dir status=0 out
  dir=$(new_fixture)
  printf 'harmless\n' > "$dir/clean.txt"
  git -C "$dir" add clean.txt
  out=$(run_hook "$dir") || status=$?
  if [ "$status" -ne 0 ]; then
    echo "FAIL $label: clean commit was refused (exit $status)"
    echo "$out" | sed 's/^/    | /'
    FAILED=1
    return
  fi
  echo "PASS $label (exit 0)"
}

write_png() {
  printf '\211PNG\r\n\032\n\0fixture' > "$1"
}

# expect_png_blocked <label> <path> <staged|untracked>: a PNG artifact must
# refuse the commit and name its path.
expect_png_blocked() {
  local label="$1" path="$2" mode="$3" dir status=0 out
  dir=$(new_fixture)
  mkdir -p "$(dirname "$dir/$path")"
  write_png "$dir/$path"
  if [[ "$mode" == "staged" ]]; then
    git -C "$dir" add -- "$path"
  fi
  out=$(run_hook "$dir") || status=$?
  if [[ "$status" -ne 1 ]]; then
    echo "FAIL $label: exit $status, wanted 1"
    echo "$out" | sed 's/^/    | /'
    FAILED=1
    return
  fi
  if ! echo "$out" | grep -qF "$path" || ! echo "$out" | grep -qF "PNG"; then
    echo "FAIL $label: refusal does not name the PNG path"
    echo "$out" | sed 's/^/    | /'
    FAILED=1
    return
  fi
  echo "PASS $label (exit 1, PNG path named)"
}

# expect_png_allowed <label> <path> <staged|untracked>: the explicit binary
# override must allow an intentional PNG and print a warning.
expect_png_allowed() {
  local label="$1" path="$2" mode="$3" dir status=0 out
  dir=$(new_fixture)
  mkdir -p "$(dirname "$dir/$path")"
  write_png "$dir/$path"
  if [[ "$mode" == "staged" ]]; then
    git -C "$dir" add -- "$path"
  fi
  out=$(run_hook "$dir" 1) || status=$?
  if [[ "$status" -ne 0 ]]; then
    echo "FAIL $label: exit $status, wanted 0"
    echo "$out" | sed 's/^/    | /'
    FAILED=1
    return
  fi
  if ! echo "$out" | grep -qF "ALLOW_BINARY_ARTIFACTS=1"; then
    echo "FAIL $label: override warning is missing"
    echo "$out" | sed 's/^/    | /'
    FAILED=1
    return
  fi
  echo "PASS $label (exit 0, override warned)"
}

# expect_blocked <label> <secret>: the secret on line 2 must refuse the commit,
# name the file and line, and never echo the value.
expect_blocked() {
  local label="$1" secret="$2" dir status=0 out
  dir=$(new_fixture)
  printf 'first line\nsecret=%s\n' "$secret" > "$dir/leak.txt"
  git -C "$dir" add leak.txt
  out=$(run_hook "$dir") || status=$?

  if [ "$status" -ne 1 ]; then
    echo "FAIL $label: exit $status, wanted 1"
    echo "$out" | sed 's/^/    | /'
    FAILED=1
    return
  fi
  if ! echo "$out" | grep -qF "leak.txt:2:"; then
    echo "FAIL $label: refusal does not name leak.txt:2"
    echo "$out" | sed 's/^/    | /'
    FAILED=1
    return
  fi
  if [[ "$out" == *"$secret"* ]]; then
    echo "FAIL $label: refusal printed the matched value"
    FAILED=1
    return
  fi
  echo "PASS $label (exit 1, file and line named, value withheld)"
}

# run_outside <dir>: runs THIS checkout's hook by absolute path from a git repo
# that has no scripts/ folder. The hook must load its scan library from its own
# directory; loading it from the repo being committed would fail here.
run_outside() {
  local dir="$1"
  ( cd "$dir" && OPENSAND_PRECOMMIT_BUILD_CMD=true OPENSAND_PRECOMMIT_TEST_CMD=true bash "$ROOT/scripts/pre-commit.sh" 2>&1 )
}

# expect_outside_clean: a harmless change from outside the repo must commit.
expect_outside_clean() {
  local dir status=0 out
  dir=$(mktemp -d "$WORK/outside.XXXXXX")
  git -C "$dir" init -q
  printf 'harmless\n' > "$dir/clean.txt"
  git -C "$dir" add clean.txt
  out=$(run_outside "$dir") || status=$?
  if [ "$status" -ne 0 ]; then
    echo "FAIL outside-repo-clean-allowed: clean commit was refused (exit $status)"
    echo "$out" | sed 's/^/    | /'
    FAILED=1
    return
  fi
  echo "PASS outside-repo-clean-allowed (exit 0)"
}

# expect_outside_blocked: a secret staged in a repo outside this checkout must
# refuse the commit, name the file and line, and never echo the value.
expect_outside_blocked() {
  local secret="$1" dir status=0 out
  dir=$(mktemp -d "$WORK/outside.XXXXXX")
  git -C "$dir" init -q
  printf 'first line\nsecret=%s\n' "$secret" > "$dir/leak.txt"
  git -C "$dir" add leak.txt
  out=$(run_outside "$dir") || status=$?
  if [ "$status" -ne 1 ]; then
    echo "FAIL outside-repo-blocked: exit $status, wanted 1"
    echo "$out" | sed 's/^/    | /'
    FAILED=1
    return
  fi
  if ! echo "$out" | grep -qF "leak.txt:2:"; then
    echo "FAIL outside-repo-blocked: refusal does not name leak.txt:2"
    echo "$out" | sed 's/^/    | /'
    FAILED=1
    return
  fi
  if [[ "$out" == *"$secret"* ]]; then
    echo "FAIL outside-repo-blocked: refusal printed the matched value"
    FAILED=1
    return
  fi
  echo "PASS outside-repo-blocked (exit 1, file and line named, value withheld)"
}

tail30=$(printf 'a%.0s' {1..30})
tail36=$(printf 'b%.0s' {1..36})

sk_prefix="sk-"
skor_prefix="sk-or-"
ghp_prefix="ghp_"
akia_prefix="AKIA"
pem_begin="-----BEGIN "
pem_end="PRIVATE KEY-----"

expect_clean "clean-commit-allowed"
expect_png_blocked "blocks-staged-artifact-png" "packages/desktop/artifacts/shot.png" staged
expect_png_blocked "blocks-staged-docs-png" "docs/screenshot.png" staged
expect_png_blocked "blocks-uppercase-staged-png" "packages/desktop/artifacts/shot.PNG" staged
expect_png_blocked "blocks-untracked-artifact-png" "packages/desktop/artifacts/shot.png" untracked
expect_png_blocked "blocks-untracked-root-png" "screenshot.png" untracked
expect_png_allowed "allows-intentional-png-with-override" "docs/screenshot.png" staged
expect_png_allowed "allows-untracked-png-with-override" "docs/screenshot.png" untracked
expect_blocked "blocks-sk" "${sk_prefix}${tail30}"
expect_blocked "blocks-sk-or" "${skor_prefix}v1-${tail36}"
expect_blocked "blocks-ghp" "${ghp_prefix}${tail36}"
expect_blocked "blocks-akia" "${akia_prefix}ABCDEFGHIJKLMNOP"
expect_blocked "blocks-private-key" "${pem_begin}RSA ${pem_end}"

expect_outside_clean
expect_outside_blocked "${sk_prefix}${tail30}"

if [ "$FAILED" -eq 0 ]; then
  echo "ALL PRE-COMMIT SELFTESTS PASSED."
fi

exit "$FAILED"
