#!/usr/bin/env bash
# Hermetic selftest for scripts/brief-row.sh (no network, no repo writes).
# Exercises:
#   1. Usage / bad row refusal (exit 2)
#   2. Done row refusal (exit 3)
#   3. Pending row drafting (exit 0) and brief-lint passage
#   4. HTTP METHOD taken from code (req.method === 'PATCH') when comment disagrees (POST)
#   5. Request-body validation line extraction (if (!body....)) for every route method (PATCH and POST)
#   6. Stdout output mode when --out is omitted
#   7. Registry pattern in emitted Scope (data/<feature>.ts, data.ts intersection & spread, views/registry.ts, never Shell.tsx, css at end)
#   8. Legacy line ranges from code (app.js VIEW CONTROLLER & index.html view / modals)
#   9. Element IDs from legacy view and modals listed
#  10. Mutation test: lint-brief fails and rejects any brief with "TODO"
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BRIEF_ROW="${BRIEF_ROW_SCRIPT:-$SCRIPT_DIR/brief-row.sh}"
LINT="${LINT_BRIEF_SCRIPT:-$SCRIPT_DIR/lint-brief.sh}"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/opensand-brief-row-selftest.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

FAILED=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; FAILED=1; }

FIXTURE_INVENTORY="$TMP_DIR/phase5-view-inventory.md"
FIXTURE_SERVER="$TMP_DIR/desktop-server.ts"
FIXTURE_APP="$TMP_DIR/app.js"
FIXTURE_HTML="$TMP_DIR/index.html"

cat > "$FIXTURE_INVENTORY" <<'INVENT'
# Phase 5 View Inventory

| # | Feature | `app.js` lines | `index.html` | Shell component that replaces it | Status | What is missing |
|---|---|---|---|---|---|---|
| 10 | **Widget** (view, toggle) | L900–920 | `viewWidget` L950 | `WidgetView.tsx` | none | Must not overflow |
| 11 | **DoneItem** (view) | L200–220 | `viewDone` L60 | `DoneView.tsx` | done | Already completed |
| 12 | **Gadget** (view, create) | L800–820 | `viewGadget` L850, `addGadgetModal` L860 | `GadgetView.tsx` | none | |
INVENT

cat > "$FIXTURE_APP" <<'APP'
// Test fixture app.js

// --- Widget API ---
async function toggleWidget() {
  return fetch('/api/widget/toggle');
}

// --- WIDGET VIEW CONTROLLER ---
async function refreshWidget() {
  const btn = document.getElementById('btnWidgetAction');
  const grid = document.getElementById('widgetGrid');
}

// --- Gadget API ---
async function createGadget() {
  return fetch('/api/gadget');
}

// --- GADGET VIEW CONTROLLER ---
async function refreshGadget() {
  const g = document.getElementById('gadgetGrid');
}

// --- Gadget creation
const btnSaveGadget = document.getElementById('btnSaveGadget');

// --- NEXT VIEW CONTROLLER ---
APP

cat > "$FIXTURE_HTML" <<'HTML'
<!-- Test fixture index.html -->
<div id="viewWidget" class="view-panel">
  <button id="btnWidgetAction">Action</button>
  <div id="widgetGrid"></div>
</div>
<!-- View 2 -->
<div id="viewGadget" class="view-panel">
  <div id="gadgetGrid"></div>
</div>
<!-- Modals -->
<div class="modal-overlay hidden" id="addGadgetModal">
  <input id="gadgetTitle" />
  <input id="gadgetUsername" />
  <button id="btnSaveGadget">Save</button>
</div>
HTML

cat > "$FIXTURE_SERVER" <<'SERVER'
// Test fixture server

// API: POST /api/widget/toggle
if (pathname === '/api/widget/toggle' && req.method === 'PATCH') {
  const body = await this.readJsonBody(req);
  if (!body.state) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return;
  }
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
export OPENSAND_APP_FILE="$FIXTURE_APP"
export OPENSAND_HTML_FILE="$FIXTURE_HTML"
export OPENSAND_LINT_SCRIPT="$LINT"

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

# 5. Request-body validation line picked up for every route, including PATCH (not just POST)
if grep -qF "if (!body.state)" "$OUT_BRIEF"; then
  pass "server body check extracted for non-POST route (PATCH /api/widget/toggle)"
else
  fail "PATCH route server body check missing in $OUT_BRIEF"
fi

OUT_GADGET="$TMP_DIR/row12.md"
run_cmd 12 --out "$OUT_GADGET"
if [[ "$LAST_STATUS" -ne 0 ]]; then
  fail "row 12 failed (exit $LAST_STATUS): $LAST_OUT"
elif grep -qF "if (!body.title || !body.username)" "$OUT_GADGET"; then
  pass "server body check extracted for POST route (POST /api/gadget)"
else
  fail "POST route server body check missing in $OUT_GADGET"
fi

# 6. Stdout output mode when --out is omitted
run_cmd 10
if [[ "$LAST_STATUS" -eq 0 ]] && grep -qF "## Goal" <<<"$LAST_OUT" && grep -qF "PATCH /api/widget/toggle" <<<"$LAST_OUT"; then
  pass "stdout mode emits brief without --out"
else
  fail "stdout mode failed: $LAST_OUT"
fi

# 7. Registry pattern described in Scope, matching shell-component-map.md §6, and TODO-free
if ! grep -qF "TODO" "$OUT_BRIEF"; then
  pass "emitted brief is completely TODO-free"
else
  fail "emitted brief still contains TODO: $(grep -n 'TODO' "$OUT_BRIEF")"
fi

if grep -qF "data/widget.ts" "$OUT_BRIEF" &&    grep -qF "WidgetData" "$OUT_BRIEF" &&    grep -qF "widgetData(bridge, http)" "$OUT_BRIEF" &&    grep -qF "ShellData" "$OUT_BRIEF" &&    grep -qF "windowBridgeData()" "$OUT_BRIEF" &&    grep -qF "views/registry.ts" "$OUT_BRIEF" &&    grep -qF "VIEW_COMPONENTS" "$OUT_BRIEF" &&    grep -qF "Do NOT edit \`Shell.tsx\`" "$OUT_BRIEF" &&    grep -qF "END of the file only" "$OUT_BRIEF"; then
  pass "Scope describes registry pattern (data/widget.ts, data.ts intersection/spread, registry.ts, never Shell.tsx, css at end)"
else
  fail "Scope does not match registry pattern requirements"
fi

if grep -qF "cd ~/dev/_scratch/opensand-base && git fetch origin" "$OUT_BRIEF" && \
   grep -qF "Never run anything in \`~/dev/opensand\`" "$OUT_BRIEF"; then
  pass "emitted brief has base-clone start line in Scope and owner checkout prohibition in Fixed Rules"
else
  fail "base-clone start line or owner checkout prohibition missing in brief"
fi

# 8. Legacy line ranges from code (app.js VIEW CONTROLLER and index.html view / modals)
# In FIXTURE_APP, WIDGET VIEW CONTROLLER is lines 8-18 (not inventory table's L900-920)
if grep -qF "refreshWidget" "$OUT_BRIEF" && grep -qF "L8" "$OUT_BRIEF"; then
  pass "legacy controller line range taken from code, not inventory table"
else
  fail "legacy controller line range not from code: $(grep -n 'packages/desktop/renderer/app.js' "$OUT_BRIEF")"
fi

# In FIXTURE_HTML, #viewWidget is line 2 (not inventory table's L950)
if grep -qF "#viewWidget L2" "$OUT_BRIEF" || grep -qF "\`#viewWidget\` L2" "$OUT_BRIEF"; then
  pass "legacy view line taken from index.html code, not inventory table"
else
  fail "legacy view line not from index.html: $(grep -n 'viewWidget' "$OUT_BRIEF")"
fi

# 9. Element IDs from legacy view and modals listed
if grep -qF "btnWidgetAction" "$OUT_BRIEF" && grep -qF "widgetGrid" "$OUT_BRIEF"; then
  pass "element IDs from legacy view panel extracted (#btnWidgetAction, #widgetGrid)"
else
  fail "element IDs missing from view panel extraction"
fi

if grep -qF "gadgetTitle" "$OUT_GADGET" && grep -qF "gadgetUsername" "$OUT_GADGET" && grep -qF "btnSaveGadget" "$OUT_GADGET"; then
  pass "element IDs from legacy modals extracted (#gadgetTitle, #gadgetUsername, #btnSaveGadget)"
else
  fail "element IDs missing from modal extraction"
fi

# 10. Mutation test: brief with injected "TODO" fails lint-brief and brief-row
MUTANT_BRIEF="$TMP_DIR/mutant-row10.md"
cp "$OUT_BRIEF" "$MUTANT_BRIEF"
echo "TODO: unfinished task placeholder" >> "$MUTANT_BRIEF"

MUTANT_LINT_OUT="$("$LINT" "$MUTANT_BRIEF" 2>&1)" || MUTANT_LINT_STATUS=$?
if [[ "${MUTANT_LINT_STATUS:-0}" -eq 1 ]] && grep -qF "contains unresolved TODO" <<<"$MUTANT_LINT_OUT"; then
  pass "mutation test: mutant brief with injected TODO caught and rejected by lint-brief (exit 1)"
else
  fail "mutation test: mutant brief with injected TODO was not rejected: $MUTANT_LINT_OUT (exit ${MUTANT_LINT_STATUS:-0})"
fi

# 11. Real repository verification: Row 18 lists GET/POST/DELETE /api/attachments and Row 19 lists /api/agents, /api/tasks, /api/templates
unset OPENSAND_DESKTOP_SERVER_FILE OPENSAND_APP_FILE OPENSAND_HTML_FILE
REAL_INVENTORY_FIXTURE="$TMP_DIR/real-phase5-inventory.md"
# In case rows 18 or 19 were marked done as development progresses, unmark them in our test fixture so brief-row does not exit 3 on done rows
sed -E 's/(\|( 18 | 19 )\|.*\|) done \|/\1  \|/' "$ROOT/docs/design/phase5-view-inventory.md" > "$REAL_INVENTORY_FIXTURE"
export OPENSAND_INVENTORY_FILE="$REAL_INVENTORY_FIXTURE"
OUT_ROW18="$TMP_DIR/row18.md"
OUT_ROW19="$TMP_DIR/row19.md"

run_cmd 18 --out "$OUT_ROW18"
if [[ "$LAST_STATUS" -ne 0 ]]; then
  fail "row 18 brief generation failed (exit $LAST_STATUS): $LAST_OUT"
elif grep -qF "GET /api/attachments" "$OUT_ROW18" && \
     grep -qF "POST /api/attachments" "$OUT_ROW18" && \
     grep -qF "DELETE /api/attachments/:id" "$OUT_ROW18"; then
  pass "Row 18 still lists GET/POST/DELETE /api/attachments"
else
  fail "Row 18 missing expected attachment routes in $OUT_ROW18"
fi

run_cmd 19 --out "$OUT_ROW19"
if [[ "$LAST_STATUS" -ne 0 ]]; then
  fail "row 19 brief generation failed (exit $LAST_STATUS): $LAST_OUT"
elif grep -qF "/api/agents" "$OUT_ROW19" && \
     grep -qF "/api/templates" "$OUT_ROW19" && \
     grep -qF "/api/tasks" "$OUT_ROW19"; then
  pass "Row 19 lists /api/agents and /api/templates routes"
else
  fail "Row 19 missing expected routes in $OUT_ROW19"
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "FAIL: brief-row selftest failed" >&2
  exit 1
fi
echo "PASS: brief-row selftest ok"
exit 0
