#!/usr/bin/env bash
# Hermetic selftest for scripts/engine-smoke.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT_UNDER_TEST="$REPO_ROOT/scripts/engine-smoke.sh"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/opensand-engine-smoke-selftest.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

echo "==> Case 1: --help exits 0 with usage instructions"
HELP_OUT=$("$SCRIPT_UNDER_TEST" --help)
if ! echo "$HELP_OUT" | grep -q "Usage: scripts/engine-smoke.sh"; then
  echo "FAIL: Expected usage message from --help" >&2
  exit 1
fi
if echo "$HELP_OUT" | grep -q -- "--engine"; then
  echo "FAIL: --help should not list removed --engine flag" >&2
  exit 1
fi

echo "==> Case 2: Nonexistent path exits 1 with informative error"
set +e
ERR_OUT=$("$SCRIPT_UNDER_TEST" "$WORK/does-not-exist" 2>&1)
EXIT_CODE=$?
set -e
if [[ "$EXIT_CODE" -ne 1 ]]; then
  echo "FAIL: Expected exit code 1 for nonexistent path, got $EXIT_CODE" >&2
  exit 1
fi
if ! echo "$ERR_OUT" | grep -q "engine-smoke error"; then
  echo "FAIL: Expected 'engine-smoke error' message, got: $ERR_OUT" >&2
  exit 1
fi

echo "==> Case 3: Empty directory (no .app bundle) exits 1"
set +e
ERR_OUT=$("$SCRIPT_UNDER_TEST" "$WORK" 2>&1)
EXIT_CODE=$?
set -e
if [[ "$EXIT_CODE" -ne 1 ]]; then
  echo "FAIL: Expected exit code 1 for empty directory, got $EXIT_CODE" >&2
  exit 1
fi

echo "==> Case 4: Legacy bundle lacking OPENSAND_STATE_DIR fails closed before launch (exit 2)"
LEGACY_APP="$WORK/Legacy.app"
mkdir -p "$LEGACY_APP/Contents/MacOS" "$LEGACY_APP/Contents/Resources/app/dist/src"
MOCK_EXEC="$LEGACY_APP/Contents/MacOS/OpenSand"
cat << 'SH' > "$MOCK_EXEC"
#!/bin/bash
exit 0
SH
chmod +x "$MOCK_EXEC"
echo 'console.log("no state flag in old bundle");' > "$LEGACY_APP/Contents/Resources/app/dist/src/main.js"

MOCK_HOST_STATE="$WORK/mock-host-state"
mkdir -p "$MOCK_HOST_STATE"
echo "baseline" > "$MOCK_HOST_STATE/data.txt"

set +e
LEGACY_OUT=$(OPENSAND_HOST_STATE_DIR="$MOCK_HOST_STATE" "$SCRIPT_UNDER_TEST" "$LEGACY_APP" 2>&1)
EXIT_CODE=$?
set -e
if [[ "$EXIT_CODE" -ne 2 ]]; then
  echo "FAIL: Expected exit code 2 for legacy bundle, got $EXIT_CODE. Output: $LEGACY_OUT" >&2
  exit 1
fi
if ! echo "$LEGACY_OUT" | grep -q "predates isolated state support"; then
  echo "FAIL: Expected legacy refusal message, got: $LEGACY_OUT" >&2
  exit 1
fi
if [[ ! -f "$MOCK_HOST_STATE/data.txt" ]] || [[ "$(cat "$MOCK_HOST_STATE/data.txt")" != "baseline" ]]; then
  echo "FAIL: Host state was modified or corrupted by legacy run" >&2
  exit 1
fi

echo "==> Case 5: Content hash guard detects host state modifications"
DIRTY_APP="$WORK/Dirty.app"
mkdir -p "$DIRTY_APP/Contents/MacOS" "$DIRTY_APP/Contents/Resources/app/dist/src"
MOCK_DIRTY_EXEC="$DIRTY_APP/Contents/MacOS/OpenSand"
cat << 'SH' > "$MOCK_DIRTY_EXEC"
#!/bin/bash
# Malicious/buggy app writes to host state dir during run
if [[ -n "${OPENSAND_HOST_STATE_DIR:-}" ]]; then
  echo "rogue write" >> "$OPENSAND_HOST_STATE_DIR/data.txt"
fi
exit 0
SH
chmod +x "$MOCK_DIRTY_EXEC"
echo 'const s = process.env.OPENSAND_STATE_DIR;' > "$DIRTY_APP/Contents/Resources/app/dist/src/main.js"

MOCK_HOST_STATE2="$WORK/mock-host-state-2"
mkdir -p "$MOCK_HOST_STATE2"
echo "clean" > "$MOCK_HOST_STATE2/data.txt"

set +e
DIRTY_OUT=$(OPENSAND_HOST_STATE_DIR="$MOCK_HOST_STATE2" "$SCRIPT_UNDER_TEST" "$DIRTY_APP" 2>&1)
EXIT_CODE=$?
set -e
if [[ "$EXIT_CODE" -ne 1 ]]; then
  echo "FAIL: Expected exit code 1 when host state content changes, got $EXIT_CODE" >&2
  exit 1
fi
if ! echo "$DIRTY_OUT" | grep -q "content changed during engine smoke test"; then
  echo "FAIL: Expected content changed error, got: $DIRTY_OUT" >&2
  exit 1
fi

echo "==> Case 6: App log failure summary redacts fake tokens and API keys"
FAIL_APP="$WORK/FailLog.app"
mkdir -p "$FAIL_APP/Contents/MacOS" "$FAIL_APP/Contents/Resources/app/dist/src"
MOCK_FAIL_EXEC="$FAIL_APP/Contents/MacOS/OpenSand"
FAKE_SK_SAMPLE="sk-""1234567890abcdef1234567890"
FAKE_GH_SAMPLE="ghp_""abcdefghijklmnopqrstuvwxyz123456"
FAKE_KEY_FIELD="api""_key"
FAKE_VAL="sample_token_content"
cat << SH > "$MOCK_FAIL_EXEC"
#!/bin/bash
echo "Error connecting with \$FAKE_SK_SAMPLE and \$FAKE_GH_SAMPLE"
echo "Header Authorization: Bearer secret-bearer-token-1234567890"
echo "config: {\"\$FAKE_KEY_FIELD\": \"\$FAKE_VAL\"}"
exit 1
SH
chmod +x "$MOCK_FAIL_EXEC"
echo 'const s = process.env.OPENSAND_STATE_DIR;' > "$FAIL_APP/Contents/Resources/app/dist/src/main.js"

set +e
REDACT_OUT=$("$SCRIPT_UNDER_TEST" "$FAIL_APP" 2>&1)
EXIT_CODE=$?
set -e
if [[ "$EXIT_CODE" -ne 1 ]]; then
  echo "FAIL: Expected exit code 1 for prematurely exiting app, got $EXIT_CODE" >&2
  exit 1
fi
if echo "$REDACT_OUT" | grep -q "\$FAKE_SK_SAMPLE"; then
  echo "FAIL: Leaked raw sk- API key in output!" >&2
  exit 1
fi
if echo "$REDACT_OUT" | grep -q "\$FAKE_GH_SAMPLE"; then
  echo "FAIL: Leaked raw ghp_ token in output!" >&2
  exit 1
fi
if echo "$REDACT_OUT" | grep -q "secret-bearer-token-1234567890"; then
  echo "FAIL: Leaked raw bearer token in output!" >&2
  exit 1
fi
if echo "$REDACT_OUT" | grep -q "$FAKE_VAL"; then
  echo "FAIL: Leaked raw config api_key in output!" >&2
  exit 1
fi
if ! echo "$REDACT_OUT" | grep -q "REDACTED"; then
  echo "FAIL: Expected redacted placeholder in output, got: $REDACT_OUT" >&2
  exit 1
fi

echo "==> Case 7: Child environment scrubs *_API_KEY, *_TOKEN, and credential variables"
ENV_APP="$WORK/EnvCheck.app"
mkdir -p "$ENV_APP/Contents/MacOS" "$ENV_APP/Contents/Resources/app/dist/src"
MOCK_ENV_EXEC="$ENV_APP/Contents/MacOS/OpenSand"
cat << 'SH' > "$MOCK_ENV_EXEC"
#!/bin/bash
env > "$OPENSAND_TEST_ENV_LOG"
exit 1
SH
chmod +x "$MOCK_ENV_EXEC"
echo 'const s = process.env.OPENSAND_STATE_DIR;' > "$ENV_APP/Contents/Resources/app/dist/src/main.js"

ENV_LOG="$WORK/captured_child_env.txt"
set +e
OPENSAND_TEST_ENV_LOG="$ENV_LOG" TEST_API_KEY="secret-api-key-value" OPENAI_API_KEY="sk-openai-secret" GITHUB_TOKEN="ghp_github-secret" ANTHROPIC_SECRET="anthropic-secret"   "$SCRIPT_UNDER_TEST" "$ENV_APP" >/dev/null 2>&1
EXIT_CODE=$?
set -e

if [[ ! -f "$ENV_LOG" ]]; then
  echo "FAIL: Child environment log was not written" >&2
  exit 1
fi

if grep -q "TEST_API_KEY=" "$ENV_LOG"; then
  echo "FAIL: TEST_API_KEY was not scrubbed from child environment!" >&2
  exit 1
fi
if grep -q "OPENAI_API_KEY=" "$ENV_LOG"; then
  echo "FAIL: OPENAI_API_KEY was not scrubbed from child environment!" >&2
  exit 1
fi
if grep -q "GITHUB_TOKEN=" "$ENV_LOG"; then
  echo "FAIL: GITHUB_TOKEN was not scrubbed from child environment!" >&2
  exit 1
fi
if grep -q "ANTHROPIC_SECRET=" "$ENV_LOG"; then
  echo "FAIL: ANTHROPIC_SECRET was not scrubbed from child environment!" >&2
  exit 1
fi

echo "==> Case 8: clean environment (env -i, macOS Bash 3.2) still launches the app"
CLEAN_APP="$WORK/CleanEnv.app"
mkdir -p "$CLEAN_APP/Contents/MacOS" "$CLEAN_APP/Contents/Resources/app/dist/src" "$WORK/clean-home"
CLEAN_MARKER="$WORK/clean-env-launched.txt"
cat << 'SH' > "$CLEAN_APP/Contents/MacOS/OpenSand"
#!/bin/bash
printf 'launched\n' > "$SMOKE_LAUNCH_MARKER"
exit 0
SH
chmod +x "$CLEAN_APP/Contents/MacOS/OpenSand"
echo 'const s = process.env.OPENSAND_STATE_DIR;' > "$CLEAN_APP/Contents/Resources/app/dist/src/main.js"

# /bin/bash is 3.2 on macOS: with `set -u` an empty UNSET_ARGS expansion aborts
# before launch. A clean environment has none of the variables that seed it.
CLEAN_PATH="$(dirname "$(command -v node)"):/usr/bin:/bin:/usr/sbin:/sbin"
set +e
CLEAN_OUT=$(env -i \
  PATH="$CLEAN_PATH" \
  HOME="$WORK/clean-home" \
  SMOKE_LAUNCH_MARKER="$CLEAN_MARKER" \
  /bin/bash "$SCRIPT_UNDER_TEST" "$CLEAN_APP" 2>&1)
EXIT_CODE=$?
set -e

if echo "$CLEAN_OUT" | grep -q "unbound variable"; then
  echo "FAIL: clean environment aborted on an unset array before launch: $CLEAN_OUT" >&2
  exit 1
fi
if [[ ! -f "$CLEAN_MARKER" ]]; then
  echo "FAIL: app was never launched in a clean environment (exit $EXIT_CODE): $CLEAN_OUT" >&2
  exit 1
fi

echo "==> Case 9: bundle without dist/src/main.js fails closed before launch (exit 2)"
NO_MAIN_APP="$WORK/NoMainJs.app"
mkdir -p "$NO_MAIN_APP/Contents/MacOS" "$NO_MAIN_APP/Contents/Resources/app/dist/src"
NO_MAIN_MARKER="$WORK/no-main-launched.txt"
cat << 'SH' > "$NO_MAIN_APP/Contents/MacOS/OpenSand"
#!/bin/bash
printf 'launched\n' > "$SMOKE_LAUNCH_MARKER"
exit 0
SH
chmod +x "$NO_MAIN_APP/Contents/MacOS/OpenSand"

set +e
NO_MAIN_OUT=$(SMOKE_LAUNCH_MARKER="$NO_MAIN_MARKER" "$SCRIPT_UNDER_TEST" "$NO_MAIN_APP" 2>&1)
EXIT_CODE=$?
set -e
if [[ "$EXIT_CODE" -ne 2 ]]; then
  echo "FAIL: Expected exit code 2 for a bundle without main.js, got $EXIT_CODE: $NO_MAIN_OUT" >&2
  exit 1
fi
if [[ -f "$NO_MAIN_MARKER" ]]; then
  echo "FAIL: app was launched despite the missing dist/src/main.js" >&2
  exit 1
fi
if ! echo "$NO_MAIN_OUT" | grep -q "predates isolated state support"; then
  echo "FAIL: Expected preflight refusal message, got: $NO_MAIN_OUT" >&2
  exit 1
fi

echo "PASS: engine-smoke-selftest.sh passed all 9 hermetic checks."
exit 0
