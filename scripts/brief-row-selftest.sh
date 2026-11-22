#!/usr/bin/env bash
# Hermetic selftest for scripts/brief-row.sh (no network, no repo writes).
# Exercises:
#   1. Usage / bad row refusal (exit 2)
#   2. Done row refusal (exit 3)
#   3. Pending row drafting (exit 0) and brief-lint passage
#   4. HTTP METHOD taken from code (req.method === 'PATCH') when comment disagrees (POST)
#   5. Request-body validation line extraction (if (!body....)) within 8 lines
#   6. Stdout output mode when --out is omitted
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIEF_ROW="${BRIEF_ROW_SCRIPT:-$SCRIPT_DIR/brief-row.sh}"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/opensand-brief-row-selftest.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

FAILED=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; FAILED=1; }

FIXTURE_INVENTORY="$TMP_DIR/phase5-view-inventory.md"
FIXTURE_SERVER="$TMP_DIR/desktop-server.ts"

cat > "$FIXTURE_INVENTORY" <<'INVENT'
# Phase 5 View Inventory

| # | Feature | `app.js` lines | `index.html` | Shell component that replaces it | Status | What is missing |
|---|---|---|---|---|---|---|
| 10 | **Widget** (view, toggle) | L100–120 | `viewWidget` L50 | `WidgetView.tsx` | none | Must not overflow |
| 11 | **DoneItem** (view) | L200–220 | `viewDone` L60 | `DoneView.tsx` | done | Already completed |
| 12 | **Gadget** (view, create) | L300–320 | `viewGadget` L70 | `GadgetView.tsx` | none | |
INVENT

cat > "$FIXTURE_SERVER" <<'SERVER'
// Test fixture server

// API: POST /api/widget/toggle
if (pathname === '/api/widget/toggle' && req.method === 'PATCH') {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
  return;
}

// API: POST /api/gadget
if (pathname === '/api/gadget' && req.method === 'POST') {
  const body = await this.readJsonBody(req);
  if (!body.title || !body.username) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing title or username' }));
    return;
  }
  res.writeHead(201, { 'Content-Type': 'application/json' });
  return;
}
SERVER

export OPENSAND_INVENTORY_FILE="$FIXTURE_INVENTORY"
export OPENSAND_DESKTOP_SERVER_FILE="$FIXTURE_SERVER"

LAST_OUT=""
LAST_STATUS=0
run_cmd() {
  LAST_OUT="$("$BRIEF_ROW" "$@" 2>&1)"
  LAST_STATUS=$?
}

expect() { # <status> <substring|-> <name> <args...>
  local want_status="$1" want_text="$2" name="$3"
  shift 3
  run_cmd "$@"
  if [[ "$LAST_STATUS" -ne "$want_status" ]]; then
    fail "$name (exit $LAST_STATUS, want $want_status): $LAST_OUT"
    return
  fi
  if [[ "$want_text" != "-" ]] && ! grep -qF -- "$want_text" <<<"$LAST_OUT"; then
    fail "$name (missing '$want_text'): $LAST_OUT"
    return
  fi
  pass "$name"
}

# 1. Bad row / usage errors (exit 2)
expect 2 "Usage" "no arguments exits 2 with usage"
expect 2 "Usage" "non-numeric row exits 2 with usage" abc
expect 2 "Usage" "zero row exits 2 with usage" 0
expect 2 "Usage" "unknown flag exits 2 with usage" --foo
expect 2 "Usage" "--out missing argument exits 2 with usage" 10 --out
expect 2 "not found" "row not in inventory exits 2" 99

# 2. Done row refusal (exit 3)
expect 3 "already marked done" "done row exits 3" 11

# 3. Pending row drafting with --out (exit 0) and brief-lint passage
OUT_BRIEF="$TMP_DIR/row10.md"
expect 0 "PASS: $OUT_BRIEF has Goal, Done when, Scope, Report back" "pending row exits 0 and passes lint" 10 --out "$OUT_BRIEF"
if [[ ! -f "$OUT_BRIEF" ]]; then
  fail "output brief file was not created: $OUT_BRIEF"
else
  pass "output brief file created on disk"
fi

# 4. METHOD taken from code when comment disagrees (PATCH in code, POST in comment)
if grep -qF "PATCH /api/widget/toggle" "$OUT_BRIEF" && ! grep -qF "POST /api/widget/toggle" "$OUT_BRIEF"; then
  pass "METHOD taken from code (PATCH) when comment disagrees (POST)"
else
  fail "METHOD mismatch in output: $(grep -i 'widget/toggle' "$OUT_BRIEF")"
fi

# 5. Request-body validation line picked up within 8 lines
OUT_GADGET="$TMP_DIR/row12.md"
run_cmd 12 --out "$OUT_GADGET"
if [[ "$LAST_STATUS" -ne 0 ]]; then
  fail "row 12 failed (exit $LAST_STATUS): $LAST_OUT"
elif grep -qF "if (!body.title || !body.username)" "$OUT_GADGET"; then
  pass "request-body validation line extracted within 8 lines"
else
  fail "request-body validation line missing in $OUT_GADGET"
fi

# 6. Stdout output mode when --out is omitted
run_cmd 10
if [[ "$LAST_STATUS" -eq 0 ]] && grep -qF "## Goal" <<<"$LAST_OUT" && grep -qF "PATCH /api/widget/toggle" <<<"$LAST_OUT"; then
  pass "stdout mode emits brief without --out"
else
  fail "stdout mode failed: $LAST_OUT"
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "FAIL: brief-row selftest failed" >&2
  exit 1
fi
echo "PASS: brief-row selftest ok"
exit 0
