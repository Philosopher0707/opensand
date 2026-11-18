#!/usr/bin/env bash
# Hermetic selftest for scripts/check-doc-links.sh (temp docs tree, no network).
# Point CHECK_DOC_LINKS_SCRIPT at a mutant copy to prove a case sees the breakage.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="${CHECK_DOC_LINKS_SCRIPT:-$SCRIPT_DIR/check-doc-links.sh}"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/opensand-doc-links-selftest.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

FAILED=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; FAILED=1; }

LAST_OUT=""
LAST_STATUS=0
run_check() { # <dir>
  LAST_OUT="$(CHECK_DOC_LINKS_DIR="$1" "$CHECK" 2>&1)"
  LAST_STATUS=$?
}

GOOD="$TMP_DIR/good"
BAD="$TMP_DIR/bad"
EMPTY="$TMP_DIR/empty"
mkdir -p "$GOOD/sub" "$BAD" "$EMPTY"

cat > "$GOOD/target.md" <<'EOF'
# Heading
EOF
: > "$GOOD/img.png"
cat > "$GOOD/sub/other.md" <<'EOF'
[up](../target.md)
EOF
cat > "$GOOD/good.md" <<'EOF'
# Good links
[target](target.md)
[anchored](target.md#heading)
[external](https://example.invalid/x)
[anchor](#local)
![image](img.png)
[sub](sub/other.md)
EOF
cat > "$GOOD/code.md" <<'EOF'
Example only:
```
[not-a-link](missing.md)
```
EOF
cat > "$BAD/broken.md" <<'EOF'
# Broken
[missing](missing.md)
EOF

run_check "$GOOD"
if [[ "$LAST_STATUS" -eq 0 ]] && grep -qF "5 local doc links resolve" <<<"$LAST_OUT"; then
  pass "valid relative, anchored, external, image and subdir links pass; fenced code ignored"
else
  fail "good docs tree (exit $LAST_STATUS): $LAST_OUT"
fi

run_check "$BAD"
if [[ "$LAST_STATUS" -eq 1 ]] && grep -qF "broken.md:2" <<<"$LAST_OUT" && grep -qF "missing.md" <<<"$LAST_OUT"; then
  pass "broken local link is named with file and line"
else
  fail "broken docs tree (exit $LAST_STATUS): $LAST_OUT"
fi

run_check "$EMPTY"
if [[ "$LAST_STATUS" -eq 0 ]]; then pass "empty docs tree passes"; else fail "empty docs tree: $LAST_OUT"; fi

run_check "$TMP_DIR/absent"
if [[ "$LAST_STATUS" -eq 2 ]] && grep -qF "docs directory not found" <<<"$LAST_OUT"; then
  pass "missing docs dir is a usage error"
else
  fail "missing docs dir (exit $LAST_STATUS): $LAST_OUT"
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "FAIL: check-doc-links selftest failed" >&2
  exit 1
fi
echo "PASS: check-doc-links selftest ok"
