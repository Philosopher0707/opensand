#!/usr/bin/env bash
# Hermetic selftest for scripts/quality-scores.sh and its harness: red/green over
# all 12 fixtures, false-done, tamper, preflight refusals, and output schema.
# Runs no model, builds nothing, and contacts no account.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() { echo "FAIL: $*" >&2; exit 1; }
run() { set +e; OUT="$("$@" 2>&1)"; CODE=$?; set -e; }

echo "==> [1/3] --help exits 0 and names the engine and model flags"
run bash scripts/quality-scores.sh --help
[[ $CODE -eq 0 ]] || fail "--help exited $CODE"
grep -q -- "--engine" <<<"$OUT" || fail "--help does not mention --engine"
grep -q -- "--model" <<<"$OUT" || fail "--help does not mention --model"

echo "==> [2/3] harness selftest (red/green, false-done, tamper, schema)"
node evals/quality-scores/selftest.mjs

echo "==> [3/3] a paid endpoint is refused before any build runs"
STUB_BIN="$(mktemp -d "${TMPDIR:-/tmp}/qs-stub.XXXXXX")"
trap 'rm -rf "$STUB_BIN"' EXIT
cat > "$STUB_BIN/pnpm" <<'STUB'
#!/usr/bin/env bash
touch "${PNPM_STUB_MARKER:?}"
STUB
chmod +x "$STUB_BIN/pnpm"
PNPM_STUB_MARKER="$STUB_BIN/called"
run env -u OPENROUTER_API_KEY PNPM_STUB_MARKER="$PNPM_STUB_MARKER" PATH="$STUB_BIN:$PATH" \
  bash scripts/quality-scores.sh --engine native --model gpt-4o --base-url https://api.openai.com/v1 --control-only
[[ $CODE -eq 2 ]] || fail "paid endpoint exited $CODE, want 2"
grep -q 'refusing endpoint' <<<"$OUT" || fail "paid endpoint refusal has no clear message"
[[ ! -f "$STUB_BIN/called" ]] || fail "the script built before refusing the endpoint"

echo "quality-scores-selftest: ok"
