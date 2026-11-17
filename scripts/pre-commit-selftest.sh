set -euo pipefail

# Hermetic selftest for the staged secret scan in scripts/pre-commit.sh
# Tests:
#   1. A commit whose staged changes are clean is allowed (exit 0)
#   2-6. Each blocked pattern refuses the commit (exit 1): sk-, sk-or-, ghp_,
#        AKIA + 16, and a PEM private key block
#   7. A refusal names the file and line and never prints the matched value
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
  local dir="$WORK/repo"
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

# run_hook <dir>: runs the hook with the slow build/test steps replaced.
run_hook() {
  local dir="$1"
  ( cd "$dir" && OPENSAND_PRECOMMIT_BUILD_CMD=true OPENSAND_PRECOMMIT_TEST_CMD=true bash scripts/pre-commit.sh 2>&1 )
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

tail30=$(printf 'a%.0s' {1..30})
tail36=$(printf 'b%.0s' {1..36})

sk_prefix="sk-"
skor_prefix="sk-or-"
ghp_prefix="ghp_"
akia_prefix="AKIA"
pem_begin="-----BEGIN "
pem_end="PRIVATE KEY-----"

expect_clean "clean-commit-allowed"
expect_blocked "blocks-sk" "${sk_prefix}${tail30}"
expect_blocked "blocks-sk-or" "${skor_prefix}v1-${tail36}"
expect_blocked "blocks-ghp" "${ghp_prefix}${tail36}"
expect_blocked "blocks-akia" "${akia_prefix}ABCDEFGHIJKLMNOP"
expect_blocked "blocks-private-key" "${pem_begin}RSA ${pem_end}"

if [ "$FAILED" -eq 0 ]; then
  echo "ALL PRE-COMMIT SELFTESTS PASSED."
fi

exit "$FAILED"
