#!/usr/bin/env bash
# Hermetic selftest for scripts/status-report.sh. Stubs gh with recorded JSON (no network).
# Cases: normal day + N-hours filter, no merges, red main CI, gh not signed in, --json.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/status-report.sh"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/opensand-status-selftest.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT
BIN_DIR="$TMP_DIR/bin"
mkdir -p "$BIN_DIR"

FAILED=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; FAILED=1; }
assert_eq() {
  if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1 (got '$2', want '$3')"; fi
}
assert_has() {
  if grep -qF -- "$3" <<<"$2"; then pass "$1"; else fail "$1 (missing '$3')"; fi
}
assert_lacks() {
  if grep -qF -- "$3" <<<"$2"; then fail "$1 (unexpected '$3')"; else pass "$1"; fi
}

# Stub gh: no shebang (ENOEXEC fallback via sh), so no dynamic-interpreter exec on macOS.
cat > "$BIN_DIR/gh" <<'EOS'
FIX="${GH_FIXTURE:-}"
if [ "${1:-}" = "auth" ] && [ "${2:-}" = "status" ]; then
  if [ -f "$FIX/signed_out" ]; then
    echo "You are not logged into any GitHub hosts. Run 'gh auth login'." >&2
    exit 1
  fi
  exit 0
fi
case "${1:-}" in
  pr)
    if [ "${2:-}" = "list" ]; then
      if [ "${4:-}" = "merged" ]; then f="$FIX/merged.json"; else f="$FIX/open.json"; fi
      if [ -f "$f" ]; then cat "$f"; else echo '[]'; fi
      exit 0
    fi
    ;;
  run)
    if [ -f "$FIX/run.json" ]; then cat "$FIX/run.json"; else echo '[]'; fi
    exit 0
    ;;
  release)
    if [ -f "$FIX/release.txt" ]; then cat "$FIX/release.txt"; else echo "none"; fi
    exit 0
    ;;
esac
echo "stub gh: unhandled command: $*" >&2
exit 1
EOS
chmod +x "$BIN_DIR/gh"

iso_ago_min() {
  python3 -c 'import datetime,sys; print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(minutes=int(sys.argv[1]))).strftime("%Y-%m-%dT%H:%M:%SZ"))' "$1"
}
RECENT="$(iso_ago_min 6)"
OLD="$(iso_ago_min 4320)" # 72 h

NORMAL="$TMP_DIR/normal"
mkdir -p "$NORMAL"
cat > "$NORMAL/merged.json" <<EOF
[
  {"number":201,"title":"Recent fix","mergedAt":"$RECENT","mergeCommit":{"oid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}},
  {"number":200,"title":"Old fix","mergedAt":"$OLD","mergeCommit":{"oid":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}
]
EOF
cat > "$NORMAL/open.json" <<'EOF'
[
  {"number":202,"title":"Green PR","mergeStateStatus":"CLEAN","statusCheckRollup":[{"conclusion":"SUCCESS"}]},
  {"number":203,"title":"Red behind PR","mergeStateStatus":"BEHIND","statusCheckRollup":[{"conclusion":"FAILURE"}]}
]
EOF
cat > "$NORMAL/run.json" <<'EOF'
[{"status":"completed","conclusion":"success","displayTitle":"CI","url":"https://example.invalid/run/1"}]
EOF
echo "v0.1.11" > "$NORMAL/release.txt"

NOMERGE="$TMP_DIR/nomerge"
mkdir -p "$NOMERGE"
echo '[]' > "$NOMERGE/merged.json"
cp "$NORMAL/open.json" "$NOMERGE/open.json"
cp "$NORMAL/run.json" "$NOMERGE/run.json"
cp "$NORMAL/release.txt" "$NOMERGE/release.txt"

RED="$TMP_DIR/red"
mkdir -p "$RED"
cp "$NORMAL/merged.json" "$RED/merged.json"
cp "$NORMAL/open.json" "$RED/open.json"
cat > "$RED/run.json" <<'EOF'
[{"status":"completed","conclusion":"failure","displayTitle":"CI","url":"https://example.invalid/run/2"}]
EOF
cp "$NORMAL/release.txt" "$RED/release.txt"

OUT="$TMP_DIR/out"
ERR="$TMP_DIR/err"
run_case() { # <fixture-dir> [args...]
  local dir="$1"; shift
  GH_FIXTURE="$dir" PATH="$BIN_DIR:$PATH" bash "$SCRIPT" "$@" >"$OUT" 2>"$ERR"
  echo $?
}

echo "==> [1/5] normal day (incl. N-hours filter)"
RC="$(run_case "$NORMAL")"
assert_eq "normal: exit 0" "$RC" "0"
assert_has "normal: recent merged PR" "$(cat "$OUT")" "#201 Recent fix"
assert_lacks "normal: 72h-old PR filtered out" "$(cat "$OUT")" "#200 Old fix"
assert_has "normal: green open PR" "$(cat "$OUT")" "#202 Green PR — CI: GREEN, behind main: no"
assert_has "normal: red behind open PR" "$(cat "$OUT")" "#203 Red behind PR — CI: FAILING, behind main: yes"
assert_has "normal: main CI" "$(cat "$OUT")" "success / completed"
assert_has "normal: release" "$(cat "$OUT")" "v0.1.11"
assert_has "normal: disk" "$(cat "$OUT")" "free of"
RC96="$(run_case "$NORMAL" --hours 96)"
assert_eq "96h: exit 0" "$RC96" "0"
assert_has "96h: old PR now included" "$(cat "$OUT")" "#200 Old fix"

echo "==> [2/5] no merges"
RCN="$(run_case "$NOMERGE")"
assert_eq "no-merges: exit 0" "$RCN" "0"
assert_has "no-merges: heading" "$(cat "$OUT")" "## Merged PRs (0)"
assert_has "no-merges: none line" "$(cat "$OUT")" "- none"

echo "==> [3/5] red main CI"
RCR="$(run_case "$RED")"
assert_eq "red-CI: exit 0 (report, not error)" "$RCR" "0"
assert_has "red-CI: conclusion shown" "$(cat "$OUT")" "failure / completed"

echo "==> [4/5] gh not signed in"
touch "$NORMAL/signed_out"
RCS="$(run_case "$NORMAL")"
assert_eq "not-signed-in: non-zero exit" "$([ "$RCS" -ne 0 ] && echo nonzero)" "nonzero"
assert_has "not-signed-in: clear error" "$(cat "$ERR")" "gh is not signed in"
rm -f "$NORMAL/signed_out"

echo "==> [5/5] --json output"
RCJ="$(run_case "$NORMAL" --json)"
assert_eq "json: exit 0" "$RCJ" "0"
python3 -m json.tool "$OUT" >/dev/null 2>&1 && pass "json: parses with python3 -m json.tool" || fail "json: python3 -m json.tool rejected output"
assert_eq "json: merged count is 1" "$(jq '.merged_prs | length' "$OUT")" "1"
assert_eq "json: behind_main true" "$(jq '.open_prs[1].behind_main' "$OUT")" "true"
assert_eq "json: ci_state FAILING" "$(jq -r '.open_prs[1].ci_state' "$OUT")" "FAILING"
assert_eq "json: latest release" "$(jq -r '.latest_release' "$OUT")" "v0.1.11"

if [[ "$FAILED" -ne 0 ]]; then
  echo "FAIL: status-report selftest failed ($FAILED check(s))." >&2
  exit 1
fi
echo "PASS: status-report selftest (all cases)."
exit 0
