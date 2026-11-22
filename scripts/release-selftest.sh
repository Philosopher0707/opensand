set -euo pipefail

# Hermetic selftest for scripts/release.sh
# Covers:
#   1. Dry-run execution showing all 8 steps
#   1b. Disk guard measures the writable data volume (df stub), not /
#   2. Missing argument / invalid flag handling
#   3. Pending CI on bump PR (exit 3 with re-run instructions)
#   4. Failed bump PR gate (non-zero failure)
#   5. Smoke test failure (exits with code 2)
#   6. DMG Info.plist version mismatch (exits 1)
#   7. Resume behavior (skips merged PR, existing tag, existing artifacts)
#   8. Install behavior (archives old app, unpacks new app, verifies installed version)
#   9. Release notes grouped from merged PR titles, with each PR number
#  12. Post-install health check failure halts the release with exit 2
#  13. Post-install health check is invoked on the installed app at --install time
#  18. Stale bump PR base is rebased in release.sh, which exits 3 with re-run instructions

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_SCRIPT="$ROOT/scripts/release.sh"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/opensand-release-selftest.XXXXXX")
BIN_DIR="$WORK/bin"
mkdir -p "$BIN_DIR"

cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT

# Hermetic gh mock (no shebang to avoid Endpoint Security AUTH_EXEC trap)
cat << 'EOS' > "$BIN_DIR/gh"
case "$1" in
  pr)
    case "$2" in
      list)
        if printf '%s\n' "$@" | grep -qx 'merged'; then
          if [ -f "$TEST_CASE_DIR/merged_prs.json" ]; then
            cat "$TEST_CASE_DIR/merged_prs.json"
          else
            echo "[]"
          fi
        elif [ -f "$TEST_CASE_DIR/pr_list.json" ]; then
          cat "$TEST_CASE_DIR/pr_list.json"
        else
          echo "[]"
        fi
        exit 0
        ;;
      view)
        if [ -f "$TEST_CASE_DIR/pr_view.json" ]; then
          cat "$TEST_CASE_DIR/pr_view.json"
        else
          echo '{"state":"OPEN"}'
        fi
        exit 0
        ;;
      create)
        echo "https://github.com/Philosopher0707/opensand/pull/42"
        exit 0
        ;;
      update-branch)
        printf '%s\n' "$*" >> "$TEST_CASE_DIR/pr_update_branch.log"
        exit 0
        ;;
    esac
    ;;
  release)
    case "$2" in
      edit)
        tag="$3"
        shift 3
        notes_file=""
        while [ $# -gt 0 ]; do
          if [ "$1" = "--notes-file" ]; then
            notes_file="$2"
            shift 2
          else
            shift
          fi
        done
        echo "gh release edit $tag" >> "$TEST_CASE_DIR/release_edit.log"
        cp "$notes_file" "$TEST_CASE_DIR/release_notes_applied.md"
        exit 0
        ;;
      download)
        printf '%s\n' "$*" >> "$TEST_CASE_DIR/download_args.log"
        tag="$3"
        dest_dir=""
        shift 3
        while [ $# -gt 0 ]; do
          if [ "$1" = "-D" ]; then
            dest_dir="$2"
            shift 2
          else
            shift
          fi
        done
        # Failure injection: count attempts, and fail until the configured deadline
        # (simulates release.yml publishing the assets after release.sh has started).
        call_file="$TEST_CASE_DIR/download_calls"
        calls=0
        [ -f "$call_file" ] && calls=$(cat "$call_file")
        calls=$((calls + 1))
        echo "$calls" > "$call_file"
        if [ -f "$TEST_CASE_DIR/download_auth_error" ]; then
          echo "HTTP 401: Bad credentials (https://api.github.com/graphql)" >&2
          exit 1
        fi
        if [ -f "$TEST_CASE_DIR/download_fail_until" ]; then
          fail_until=$(cat "$TEST_CASE_DIR/download_fail_until")
          if [ "$calls" -le "$fail_until" ]; then
            echo "release not found" >&2
            exit 1
          fi
        fi
        mkdir -p "$dest_dir"
        echo "mock zip content" > "$dest_dir/OpenSand-0.1.11-arm64-mac.zip"
        echo "mock dmg content" > "$dest_dir/OpenSand-0.1.11-arm64.dmg"
        echo "mock AppImage content" > "$dest_dir/OpenSand-0.1.11-x86_64.AppImage"
        echo "mock deb content" > "$dest_dir/OpenSand_0.1.11_amd64.deb"
        exit 0
        ;;
    esac
    ;;
esac
exit 0
EOS
chmod +x "$BIN_DIR/gh"

# Hermetic hdiutil mock
cat << 'EOS' > "$BIN_DIR/hdiutil"
printf '%s\n' "$*" >> "$TEST_CASE_DIR/hdiutil_calls.log"
case "$1" in
  attach)
    mountpoint=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "-mountpoint" ]; then
        mountpoint="$2"
        shift 2
      else
        shift
      fi
    done
    if [ -n "$mountpoint" ] && [ -d "$TEST_CASE_DIR/mock_dmg_app" ]; then
      mkdir -p "$mountpoint"
      cp -R "$TEST_CASE_DIR/mock_dmg_app/"* "$mountpoint/" 2>/dev/null || true
    fi
    exit 0
    ;;
  detach)
    exit 0
    ;;
esac
exit 0
EOS
chmod +x "$BIN_DIR/hdiutil"

# Hermetic git mock wrapper
cat << 'EOS' > "$BIN_DIR/git"
case "$1" in
  ls-remote)
    for arg in "$@"; do
      if [ "$arg" = "--tags" ]; then
        if [ -f "$TEST_CASE_DIR/tag_exists" ]; then
          printf "abcdef1234567890\trefs/tags/v0.1.11\n"
        fi
        exit 0
      fi
    done
    if [ "$2" = "origin" ] && [ "$3" = "refs/heads/main" ] && [ -f "$TEST_CASE_DIR/main_sha" ]; then
      cat "$TEST_CASE_DIR/main_sha"
      exit 0
    fi
    /usr/bin/git "$@"
    ;;
  tag)
    echo "git tag $*" >> "$TEST_CASE_DIR/git_tag.log"
    exit 0
    ;;
  push)
    echo "git push $*" >> "$TEST_CASE_DIR/git_push.log"
    exit 0
    ;;
  checkout|add|commit)
    exit 0
    ;;
  *)
    /usr/bin/git "$@"
    ;;
esac
EOS
chmod +x "$BIN_DIR/git"

# Hermetic mock pr-gate script
cat << 'EOS' > "$WORK/mock-pr-gate.sh"
if [ -f "$TEST_CASE_DIR/pr_gate_exit" ]; then
  code=$(cat "$TEST_CASE_DIR/pr_gate_exit")
  exit "$code"
fi
exit 0
EOS

# Hermetic mock smoke-packaged script
cat << 'EOS' > "$WORK/mock-smoke.sh"
if [ -f "$TEST_CASE_DIR/smoke_exit" ]; then
  code=$(cat "$TEST_CASE_DIR/smoke_exit")
  exit "$code"
fi
exit 0
EOS

# Hermetic mock Linux smoke script
cat << 'EOS' > "$WORK/mock-smoke-linux.sh"
printf '%s\n' "$*" > "$TEST_CASE_DIR/linux_smoke_args.log"
if [ -f "$TEST_CASE_DIR/linux_smoke_exit" ]; then
  code=$(cat "$TEST_CASE_DIR/linux_smoke_exit")
  exit "$code"
fi
exit 0
EOS
chmod +x "$WORK/mock-smoke-linux.sh"

# Hermetic mock post-install health check
cat << 'EOS' > "$WORK/mock-health.sh"
printf '%s %s\n' "$1" "$2" > "$TEST_CASE_DIR/health_check_args.log"
if [ -f "$TEST_CASE_DIR/health_exit" ]; then
  code=$(cat "$TEST_CASE_DIR/health_exit")
  exit "$code"
fi
exit 0
EOS

create_mock_app() {
  local target_dir="$1"
  local ver="$2"
  mkdir -p "$target_dir/Contents/MacOS"
  cat << PLIST > "$target_dir/Contents/Info.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleShortVersionString</key>
    <string>$ver</string>
</dict>
</plist>
PLIST
  echo "# mock binary" > "$target_dir/Contents/MacOS/OpenSand"
  chmod +x "$target_dir/Contents/MacOS/OpenSand"
}

FAILED=0

run_test() {
  local label="$1"
  local expected_exit="$2"
  shift 2
  local dir="$WORK/$label"
  mkdir -p "$dir"

  # Default mock dmg app
  if [ ! -d "$dir/mock_dmg_app" ]; then
    create_mock_app "$dir/mock_dmg_app/OpenSand.app" "0.1.11"
  fi

  local out status=0
  out=$(
    PATH="$BIN_DIR:$PATH" \
    TEST_CASE_DIR="$dir" \
    OPENSAND_PR_GATE_SCRIPT="$WORK/mock-pr-gate.sh" \
    OPENSAND_SMOKE_SCRIPT="$WORK/mock-smoke.sh" \
    OPENSAND_LINUX_SMOKE_SCRIPT="$WORK/mock-smoke-linux.sh" \
    OPENSAND_RELEASE_OS="${CASE_OS:-$(uname -s)}" \
    OPENSAND_HEALTH_CHECK_SCRIPT="$WORK/mock-health.sh" \
    OPENSAND_INSTALL_APP_DEST="$dir/Applications/OpenSand.app" \
    OPENSAND_ARCHIVE_DIR_BASE="$dir/archive" \
    RELEASE_DOWNLOAD_DIR="$dir/download" \
    RELEASE_DOWNLOAD_POLL_SECONDS=1 \
    RELEASE_DOWNLOAD_TIMEOUT_SECONDS=10 \
    bash "$RELEASE_SCRIPT" "$@" 2>&1
  ) || status=$?
  printf '%s\n' "$out" > "$dir/run.out"

  if [ "$status" -ne "$expected_exit" ]; then
    echo "FAIL $label: exit $status, wanted $expected_exit"
    echo "$out" | sed 's/^/    | /'
    FAILED=1
    return
  fi

  echo "PASS $label (exit $status)"
}

# --- Case 1: Dry run prints all 8 steps ---
dir="$WORK/case1-dry-run"
mkdir -p "$dir"
out=$(bash "$RELEASE_SCRIPT" --dry-run 0.1.11 2>&1)
for step in 1 2 3 4 5 6 7 8 9; do
  if ! grep -q "\[Step $step/9\]" <<< "$out"; then
    echo "FAIL case1-dry-run: missing Step $step"
    FAILED=1
  fi
done
if [ "$FAILED" -eq 0 ]; then
  echo "PASS case1-dry-run: all 9 steps verified"
fi

# --- Case 1b: disk guard measures the writable data volume, not / ---
dir="$WORK/case1b-disk-volume"
mkdir -p "$dir/bin"
# Stub df logs the path it was asked about and answers only for the writable data volume
# (/System/Volumes/Data on macOS, $HOME on Linux CI); every other path reports 0 free.
cat << 'EOS' > "$dir/bin/df"
printf '%s\n' "$2" >> "$DF_STUB_LOG"
echo "Filesystem     1024-blocks      Used Available Capacity  Mounted on"
if [ "$2" = "/System/Volumes/Data" ] || { [ -n "${DF_STUB_HOME:-}" ] && [ "$2" = "$DF_STUB_HOME" ]; }; then
  echo "/dev/disk99    1000000    900000   10000000    90%    $2"
else
  echo "/dev/disk98    1000000    900000          0   100%    $2"
fi
exit 0
EOS
chmod +x "$dir/bin/df"
export DF_STUB_HOME="$HOME"
DF_STUB_LOG="$dir/df_paths.log"
: > "$DF_STUB_LOG"
out=$(PATH="$dir/bin:$PATH" DF_STUB_LOG="$DF_STUB_LOG" bash "$RELEASE_SCRIPT" --dry-run 0.1.11 2>&1) || true
printf '%s\n' "$out" > "$dir/run.out"
expected_vol="/System/Volumes/Data"
if [ ! -d "$expected_vol" ]; then expected_vol="$HOME"; fi
if ! grep -q "PASS: disk space is sufficient (9 GB available)" <<< "$out"; then
  echo "FAIL case1b-disk-volume: Step 1 did not read 9 GB from the data volume"
  echo "$out" | sed -n '/Step 1\/9/,+3p' | sed 's/^/    | /'
  FAILED=1
fi
if ! grep -qxF "$expected_vol" "$DF_STUB_LOG"; then
  echo "FAIL case1b-disk-volume: disk guard did not measure $expected_vol (df saw: $(tr '\n' ' ' < "$DF_STUB_LOG"))"
  FAILED=1
fi
if grep -qxF "/" "$DF_STUB_LOG"; then
  echo "FAIL case1b-disk-volume: disk guard measured the read-only system snapshot /"
  FAILED=1
fi
if [ "$FAILED" -eq 0 ]; then
  echo "PASS case1b-disk-volume: disk guard measured $expected_vol, not /"
fi

# --- Case 2: Argument validation ---
dir="$WORK/case2-missing-args"
run_test "case2-missing-args" 1
run_test "case2-bad-flag" 1 --not-a-flag 0.1.11

# --- Case 3: Pending CI on bump PR -> exit 3 ---
dir="$WORK/case3-pending-ci"
mkdir -p "$dir"
echo '[{"number": 42, "state": "OPEN"}]' > "$dir/pr_list.json"
echo '{"state": "OPEN"}' > "$dir/pr_view.json"
echo "3" > "$dir/pr_gate_exit"
run_test "case3-pending-ci" 3 0.1.11

# --- Case 4: Failed CI on bump PR -> exit 1 ---
dir="$WORK/case4-failed-ci"
mkdir -p "$dir"
echo '[{"number": 42, "state": "OPEN"}]' > "$dir/pr_list.json"
echo '{"state": "OPEN"}' > "$dir/pr_view.json"
echo "1" > "$dir/pr_gate_exit"
run_test "case4-failed-ci" 1 0.1.11

# --- Case 5: Smoke test failure -> exit 2 ---
dir="$WORK/case5-smoke-failure"
mkdir -p "$dir"
echo '[{"number": 42, "state": "MERGED"}]' > "$dir/pr_list.json"
echo '{"state": "MERGED"}' > "$dir/pr_view.json"
echo "1" > "$dir/smoke_exit"
run_test "case5-smoke-failure" 2 0.1.11

# --- Case 6: DMG Info.plist version mismatch -> exit 1 ---
dir="$WORK/case6-dmg-mismatch"
mkdir -p "$dir"
echo '[{"number": 42, "state": "MERGED"}]' > "$dir/pr_list.json"
echo '{"state": "MERGED"}' > "$dir/pr_view.json"
create_mock_app "$dir/mock_dmg_app/OpenSand.app" "0.1.10"
run_test "case6-dmg-mismatch" 1 0.1.11

# --- Case 7: Resume behavior (skips completed steps) ---
dir="$WORK/case7-resume"
mkdir -p "$dir/download"
touch "$dir/tag_exists"
echo '[{"number": 42, "state": "MERGED"}]' > "$dir/pr_list.json"
echo '{"state": "MERGED"}' > "$dir/pr_view.json"
echo "existing zip" > "$dir/download/OpenSand-0.1.11-arm64-mac.zip"
echo "existing dmg" > "$dir/download/OpenSand-0.1.11-arm64.dmg"
create_mock_app "$dir/mock_dmg_app/OpenSand.app" "0.1.11"
run_test "case7-resume" 0 0.1.11

# --- Case 8: Install behavior (archives old app, installs new app) ---
dir="$WORK/case8-install"
mkdir -p "$dir/download" "$dir/Applications"
touch "$dir/tag_exists"
echo '[{"number": 42, "state": "MERGED"}]' > "$dir/pr_list.json"
echo '{"state": "MERGED"}' > "$dir/pr_view.json"
create_mock_app "$dir/Applications/OpenSand.app" "0.1.10"

# Create a zip containing OpenSand.app 0.1.11
zip_app_dir="$dir/pack/OpenSand.app"
create_mock_app "$zip_app_dir" "0.1.11"
(cd "$dir/pack" && zip -q -r "$dir/download/OpenSand-0.1.11-arm64-mac.zip" OpenSand.app)
echo "mock dmg" > "$dir/download/OpenSand-0.1.11-arm64.dmg"
create_mock_app "$dir/mock_dmg_app/OpenSand.app" "0.1.11"

run_test "case8-install" 0 --install 0.1.11

# Verify old app was archived and new app installed
if [ ! -d "$dir/archive"/*-OpenSand-0.1.10 ]; then
  echo "FAIL case8-install: expected old app to be archived"
  FAILED=1
fi
new_ver=$(grep -A 1 CFBundleShortVersionString "$dir/Applications/OpenSand.app/Contents/Info.plist" | grep string | sed 's/.*<string>\(.*\)<\/string>.*/\1/')
if [ "$new_ver" != "0.1.11" ]; then
  echo "FAIL case8-install: installed version is $new_ver, wanted 0.1.11"
  FAILED=1
fi
if ! grep -qF "$dir/Applications/OpenSand.app 0.1.11" "$dir/health_check_args.log" 2>/dev/null; then
  echo "FAIL case8-install: post-install health check was not called with the installed app and version"
  FAILED=1
fi

# --- Case 9: Release assets published late (release.yml still building) -> retry, then succeed ---
dir="$WORK/case9-late-assets"
mkdir -p "$dir"
touch "$dir/tag_exists"
echo '[{"number": 42, "state": "MERGED"}]' > "$dir/pr_list.json"
echo '{"state": "MERGED"}' > "$dir/pr_view.json"
echo "2" > "$dir/download_fail_until"
create_mock_app "$dir/mock_dmg_app/OpenSand.app" "0.1.11"
run_test "case9-late-assets" 0 0.1.11
calls=$(cat "$dir/download_calls" 2>/dev/null || echo 0)
if [ "$calls" -lt 3 ]; then
  echo "FAIL case9-late-assets: expected at least 3 download attempts, saw $calls"
  FAILED=1
else
  echo "PASS case9-late-assets: retried $calls times and succeeded"
fi

# --- Case 10: Unauthenticated gh -> fail fast, never retry ---
dir="$WORK/case10-auth-failure"
mkdir -p "$dir"
touch "$dir/tag_exists"
echo '[{"number": 42, "state": "MERGED"}]' > "$dir/pr_list.json"
echo '{"state": "MERGED"}' > "$dir/pr_view.json"
touch "$dir/download_auth_error"
create_mock_app "$dir/mock_dmg_app/OpenSand.app" "0.1.11"
run_test "case10-auth-failure" 1 0.1.11
auth_calls=$(cat "$dir/download_calls" 2>/dev/null || echo 0)
if [ "$auth_calls" -ne 1 ]; then
  echo "FAIL case10-auth-failure: expected exactly 1 download attempt, saw $auth_calls"
  FAILED=1
elif ! grep -q "GH_TOKEN" "$dir/run.out" 2>/dev/null; then
  echo "FAIL case10-auth-failure: failure message does not name GH_TOKEN"
  FAILED=1
else
  echo "PASS case10-auth-failure: failed after 1 attempt without retrying"
fi

# --- Case 11: Release notes grouped from merged PR titles, each line with its PR number ---
dir="$WORK/case11-release-notes"
mkdir -p "$dir"
touch "$dir/tag_exists"
echo '[{"number": 42, "state": "MERGED"}]' > "$dir/pr_list.json"
echo '{"state": "MERGED"}' > "$dir/pr_view.json"
cat > "$dir/merged_prs.json" << 'EOS'
[
  {"number": 110, "title": "fix(release): retry asset download until dmg and zip are published", "mergedAt": "2099-01-04T00:00:00Z"},
  {"number": 109, "title": "feat: generate release notes from merged PRs", "mergedAt": "2099-01-03T00:00:00Z"},
  {"number": 108, "title": "docs: release timing lesson", "mergedAt": "2099-01-02T00:00:00Z"},
  {"number": 107, "title": "chore: tidy scripts", "mergedAt": "2099-01-01T00:00:00Z"},
  {"number": 5, "title": "feat: older than the previous tag", "mergedAt": "2000-01-01T00:00:00Z"}
]
EOS
create_mock_app "$dir/mock_dmg_app/OpenSand.app" "0.1.11"
run_test "case11-release-notes" 0 0.1.11
applied="$dir/release_notes_applied.md"
if [ ! -f "$applied" ]; then
  echo "FAIL case11-release-notes: release body was never set"
  FAILED=1
else
  expected=(
    "## Features"
    "## Fixes"
    "## Docs"
    "## Other"
    "- feat: generate release notes from merged PRs (#109)"
    "- fix(release): retry asset download until dmg and zip are published (#110)"
    "- docs: release timing lesson (#108)"
    "- chore: tidy scripts (#107)"
  )
  for needle in "${expected[@]}"; do
    if ! grep -qF -- "$needle" "$applied"; then
      echo "FAIL case11-release-notes: notes are missing '$needle'"
      FAILED=1
    fi
  done
  if grep -qF "(#5)" "$applied"; then
    echo "FAIL case11-release-notes: notes include a PR merged before the previous tag"
    FAILED=1
  fi
  if ! grep -q "gh release edit v0.1.11" "$dir/release_edit.log" 2>/dev/null; then
    echo "FAIL case11-release-notes: release body was not applied to v0.1.11"
    FAILED=1
  fi
  if [ "$FAILED" -eq 0 ]; then
    echo "PASS case11-release-notes: grouped feat/fix/docs/other with PR numbers, previous-tag boundary respected"
  fi
fi

# --- Case 12: post-install health check failure -> exit 2 ---
dir="$WORK/case12-health-failure"
mkdir -p "$dir/download" "$dir/Applications"
touch "$dir/tag_exists"
echo '[{"number": 42, "state": "MERGED"}]' > "$dir/pr_list.json"
echo '{"state": "MERGED"}' > "$dir/pr_view.json"
echo "1" > "$dir/health_exit"
zip_app_dir="$dir/pack/OpenSand.app"
create_mock_app "$zip_app_dir" "0.1.11"
(cd "$dir/pack" && zip -q -r "$dir/download/OpenSand-0.1.11-arm64-mac.zip" OpenSand.app)
echo "mock dmg" > "$dir/download/OpenSand-0.1.11-arm64.dmg"
create_mock_app "$dir/mock_dmg_app/OpenSand.app" "0.1.11"
run_test "case12-health-failure" 2 --install 0.1.11

# --- Case 13: Linux branch smokes the .deb and skips macOS-only hdiutil ---
dir="$WORK/case13-linux-success"; mkdir -p "$dir"
touch "$dir/tag_exists"
echo '[{"number": 42, "state": "MERGED"}]' > "$dir/pr_list.json"
echo '{"state": "MERGED"}' > "$dir/pr_view.json"
CASE_OS=Linux
run_test "case13-linux-success" 0 0.1.11
CASE_OS=""
if ! grep -qF "OpenSand_0.1.11_amd64.deb" "$dir/linux_smoke_args.log" 2>/dev/null; then
  echo "FAIL case13-linux-success: smoke-linux.sh was not called with the .deb"
  FAILED=1
fi
if [ -f "$dir/hdiutil_calls.log" ]; then
  echo "FAIL case13-linux-success: hdiutil was called on Linux"
  FAILED=1
fi

# --- Case 14: Linux smoke failure halts with exit 2 ---
dir="$WORK/case14-linux-smoke-failure"; mkdir -p "$dir"
touch "$dir/tag_exists"
echo '[{"number": 42, "state": "MERGED"}]' > "$dir/pr_list.json"
echo '{"state": "MERGED"}' > "$dir/pr_view.json"
echo "1" > "$dir/linux_smoke_exit"
CASE_OS=Linux
run_test "case14-linux-smoke-failure" 2 0.1.11
CASE_OS=""
if ! grep -q "FAIL: Linux smoke test failed" "$dir/run.out" 2>/dev/null; then
  echo "FAIL case14-linux-smoke-failure: no Linux smoke failure message"
  FAILED=1
fi

# --- Case 15: all four artifact patterns requested from gh (macOS branch) ---
dir="$WORK/case15-download-patterns"; mkdir -p "$dir"
touch "$dir/tag_exists"
echo '[{"number": 42, "state": "MERGED"}]' > "$dir/pr_list.json"
echo '{"state": "MERGED"}' > "$dir/pr_view.json"
run_test "case15-download-patterns" 0 0.1.11
for pattern in '*.zip' '*.dmg' '*.AppImage' '*.deb'; do
  if ! grep -qF -- "$pattern" "$dir/download_args.log" 2>/dev/null; then
    echo "FAIL case15-download-patterns: missing download pattern $pattern"
    FAILED=1
  fi
done

# --- Case 16: dry run advertises all four artifact patterns ---
out=$(bash "$RELEASE_SCRIPT" --dry-run 0.1.11 2>&1)
for pattern in '*.zip' '*.dmg' '*.AppImage' '*.deb'; do
  if ! grep -qF -- "$pattern" <<< "$out"; then
    echo "FAIL case16-dry-run-patterns: dry run is missing $pattern"
    FAILED=1
  fi
done
if [ "$FAILED" -eq 0 ]; then
  echo "PASS case16-dry-run-patterns: dry run names all four artifact patterns"
fi

# --- Case 17: Linux resume reuses an already downloaded .deb ---
dir="$WORK/case17-linux-resume"; mkdir -p "$dir/download"
touch "$dir/tag_exists"
echo '[{"number": 42, "state": "MERGED"}]' > "$dir/pr_list.json"
echo '{"state": "MERGED"}' > "$dir/pr_view.json"
echo "existing deb" > "$dir/download/OpenSand_0.1.11_amd64.deb"
CASE_OS=Linux
run_test "case17-linux-resume" 0 0.1.11
CASE_OS=""
if [ -f "$dir/download_args.log" ]; then
  echo "FAIL case17-linux-resume: re-downloaded assets on resume"
  FAILED=1
fi

# --- Case 18: Stale bump PR base -> rebase via gh, exit 3, never run the gate ---
dir="$WORK/case18-stale-base"; mkdir -p "$dir"
echo '[{"number": 42, "state": "OPEN"}]' > "$dir/pr_list.json"
echo '{"state": "OPEN", "baseRefOid": "1111111111111111111111111111111111111111"}' > "$dir/pr_view.json"
printf '%s\t%s\n' "2222222222222222222222222222222222222222" "refs/heads/main" > "$dir/main_sha"
echo "1" > "$dir/pr_gate_exit" # would fail if the gate were run on the stale base
run_test "case18-stale-base" 3 0.1.11
if ! grep -qxF "pr update-branch 42 --rebase" "$dir/pr_update_branch.log" 2>/dev/null; then
  echo "FAIL case18-stale-base: did not call 'gh pr update-branch 42 --rebase'"
  echo "  saw: $(cat "$dir/pr_update_branch.log" 2>/dev/null || echo '(no calls)')"
  FAILED=1
fi
if grep -q "Running scripts/pr-gate.sh" "$dir/run.out"; then
  echo "FAIL case18-stale-base: ran pr-gate on a stale base"
  FAILED=1
fi
if [ "$FAILED" -eq 0 ]; then
  echo "PASS case18-stale-base: rebased stale base, exited 3 without running the gate"
fi

if [ "$FAILED" -eq 0 ]; then
  echo "ALL RELEASE SELFTESTS PASSED."
fi

exit "$FAILED"
