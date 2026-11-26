#!/usr/bin/env bash
# Hermetic integration test for direct-tag release preflight, artifact validation,
# and the absence of a version-bump branch/PR round trip.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/opensand-direct-tag-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

FIXTURE="$WORK/repo"
mkdir -p "$FIXTURE/scripts/lib" "$FIXTURE/scripts/test" "$FIXTURE/packages/desktop" "$WORK/mock-bin"
cp "$ROOT/scripts/release.sh" "$ROOT/scripts/release-check.sh" "$FIXTURE/scripts/"
cp "$ROOT/scripts/sync-versions.js" "$FIXTURE/scripts/"
cp "$ROOT/scripts/lib/free-space.sh" "$FIXTURE/scripts/lib/"
cat > "$FIXTURE/package.json" <<'JSON'
{"name":"opensand-test","version":"1.2.3","type":"module"}
JSON
cat > "$FIXTURE/packages/desktop/package.json" <<'JSON'
{"name":"@opensand/desktop","version":"1.2.3"}
JSON
cat > "$FIXTURE/scripts/smoke-linux.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ -f "${1:-}" ]]
echo "fake Linux smoke passed: $1"
SH
chmod +x "$FIXTURE/scripts/smoke-linux.sh"

# Exercise the exact shared artifact gates with positive and negative fixtures.
ARTIFACTS="$WORK/artifacts"
mkdir -p "$ARTIFACTS"
printf 'fixture binary\n' > "$ARTIFACTS/OpenSand_1.2.3_amd64.deb"
printf 'fixture image\n' > "$ARTIFACTS/OpenSand-1.2.3-x86_64.AppImage"
(cd "$ARTIFACTS" && shasum -a 256 *.AppImage *.deb > SHA256SUMS.txt)
bash "$FIXTURE/scripts/release-check.sh" --verify-checksums "$ARTIFACTS" linux >/dev/null || fail "valid checksum manifest was rejected"
cp "$ARTIFACTS/SHA256SUMS.txt" "$WORK/SHA256SUMS-complete.txt"
(cd "$ARTIFACTS" && shasum -a 256 OpenSand_1.2.3_amd64.deb > SHA256SUMS.txt)
if bash "$FIXTURE/scripts/release-check.sh" --verify-checksums "$ARTIFACTS" linux >/dev/null 2>&1; then
  fail "checksum manifest that omitted a published AppImage was accepted"
fi
cp "$WORK/SHA256SUMS-complete.txt" "$ARTIFACTS/SHA256SUMS.txt"
pass "checksum manifest must cover exactly every published platform artifact"
MAC_ARTIFACTS="$WORK/mac-artifacts"
mkdir -p "$MAC_ARTIFACTS"
printf 'disk image\n' > "$MAC_ARTIFACTS/OpenSand-1.2.3-arm64.dmg"
printf 'mac archive\n' > "$MAC_ARTIFACTS/OpenSand-1.2.3-arm64-mac.zip"
(cd "$MAC_ARTIFACTS" && shasum -a 256 *.dmg *.zip > SHA256SUMS.txt)
bash "$FIXTURE/scripts/release-check.sh" --verify-checksums "$MAC_ARTIFACTS" mac >/dev/null || fail "valid macOS checksum manifest was rejected"
cp "$MAC_ARTIFACTS/SHA256SUMS.txt" "$WORK/mac-SHA256SUMS-complete.txt"
(cd "$MAC_ARTIFACTS" && shasum -a 256 *.dmg > SHA256SUMS.txt)
if bash "$FIXTURE/scripts/release-check.sh" --verify-checksums "$MAC_ARTIFACTS" mac >/dev/null 2>&1; then
  fail "macOS checksum manifest that omitted the ZIP was accepted"
fi
cp "$WORK/mac-SHA256SUMS-complete.txt" "$MAC_ARTIFACTS/SHA256SUMS.txt"
pass "macOS checksum manifest must cover exactly every published platform artifact"
printf '<plist><dict><key>CFBundleShortVersionString</key><string>1.2.3</string><key>CFBundleVersion</key><string>1.2.3</string></dict></plist>\n' > "$WORK/Info.plist"
bash "$FIXTURE/scripts/release-check.sh" --verify-info-plist 1.2.3 "$WORK/Info.plist" >/dev/null || fail "matching Info.plist was rejected"
sed 's/<string>1.2.3<\/string><key>CFBundleVersion/<string>9.9.9<\/string><key>CFBundleVersion/' "$WORK/Info.plist" > "$WORK/Info-mismatch.plist"
if bash "$FIXTURE/scripts/release-check.sh" --verify-info-plist 1.2.3 "$WORK/Info-mismatch.plist" >/dev/null 2>&1; then
  fail "Info.plist version mismatch was accepted"
fi
pass "Info.plist short/build version mismatch fails closed"

# Mutation probe: removing the version comparison must make the mismatch assertion red.
MUTANT="$WORK/release-check-mutant.sh"
sed 's/if \[\[ "$SHORT_VERSION" != "$VERSION" || "$BUILD_VERSION" != "$VERSION" \]\]; then/if false; then/' "$FIXTURE/scripts/release-check.sh" > "$MUTANT"
if ! bash "$MUTANT" --verify-info-plist 1.2.3 "$WORK/Info-mismatch.plist" >/dev/null 2>&1; then
  fail "mutation probe setup failed: mutated verifier still rejected mismatch"
fi
# The test assertion is the expected-failure contract: it must itself reject the mutant.
assert_mismatch_rejected() {
  local verifier="$1"
  bash "$verifier" --verify-info-plist 1.2.3 "$WORK/Info-mismatch.plist" >/dev/null 2>&1 && return 1
  return 0
}
if assert_mismatch_rejected "$MUTANT"; then
  fail "mutation probe did not turn the mismatch assertion red"
fi
pass "mutation probe: removing the Info.plist guard is detected"

# A checksum mutation must also be rejected.
printf 'tampered binary\n' >> "$ARTIFACTS/OpenSand_1.2.3_amd64.deb"
if bash "$FIXTURE/scripts/release-check.sh" --verify-checksums "$ARTIFACTS" linux >/dev/null 2>&1; then
  fail "tampered artifact checksum was accepted"
fi
pass "artifact checksum mismatch fails closed"

# Set up a local bare origin and run the actual release script in dry-run mode.
git init -q --bare "$WORK/origin.git"
git -C "$FIXTURE" init -q -b main
git -C "$FIXTURE" config user.name "Release Test"
git -C "$FIXTURE" config user.email "release-test@example.invalid"
git -C "$FIXTURE" add package.json packages scripts
git -C "$FIXTURE" commit -qm "fixture"
git -C "$FIXTURE" remote add origin "$WORK/origin.git"
git -C "$FIXTURE" push -q -u origin main
MAIN_COMMIT=$(git -C "$FIXTURE" rev-parse HEAD)
if (cd "$FIXTURE" && bash scripts/release-check.sh --verify-main-ci "$MAIN_COMMIT" refs/heads/main 123 >/dev/null); then
  pass "release tag commit on main with a successful CI run is accepted"
else
  fail "verified main commit was rejected"
fi
if (cd "$FIXTURE" && bash scripts/release-check.sh --verify-main-ci "$MAIN_COMMIT" refs/heads/main "" >/dev/null 2>&1); then
  fail "main commit without a successful CI run was accepted"
fi
git -C "$FIXTURE" checkout -q -b topic/unverified
printf 'unmerged commit\n' > "$FIXTURE/topic.txt"
git -C "$FIXTURE" add topic.txt
git -C "$FIXTURE" commit -qm "unmerged topic"
OFF_MAIN_COMMIT=$(git -C "$FIXTURE" rev-parse HEAD)
git -C "$FIXTURE" checkout -q main
if (cd "$FIXTURE" && bash scripts/release-check.sh --verify-main-ci "$OFF_MAIN_COMMIT" refs/heads/main 456 >/dev/null 2>&1); then
  fail "off-main tag commit was accepted for fallback release"
fi
pass "tag commits off main and commits without successful main CI fail closed"
CI_GUARD_LINES=()
while IFS=: read -r line _; do CI_GUARD_LINES+=("$line"); done < <(rg -n -- 'release-check\.sh --verify-main-ci' "$ROOT/.github/workflows/release.yml")
ARTIFACT_DOWNLOAD_LINES=()
while IFS=: read -r line _; do ARTIFACT_DOWNLOAD_LINES+=("$line"); done < <(rg -n -- 'gh run download' "$ROOT/.github/workflows/release.yml")
[[ ${#CI_GUARD_LINES[@]} -eq 2 && ${#ARTIFACT_DOWNLOAD_LINES[@]} -eq 2 ]] || fail "release workflow must guard both platform artifact paths"
for index in 0 1; do
  (( CI_GUARD_LINES[index] < ARTIFACT_DOWNLOAD_LINES[index] )) || fail "a platform can attempt artifact fallback before main/CI validation"
done
[[ $(rg -c --no-filename -- 'gh run list .*--event push --branch main --commit' "$ROOT/.github/workflows/release.yml") -eq 2 ]] || fail "both artifact lookups must select successful push CI runs on main"
pass "both platforms validate main membership and successful main CI before staged-artifact fallback"
if bash "$FIXTURE/scripts/release-check.sh" --preflight 1.2.4 >/dev/null 2>&1; then
  fail "preflight accepted a version that is not synchronized across package manifests"
fi
pass "release preflight rejects a target version that is not merged and synchronized"

# A symlinked checkout must not turn --preflight into a no-op (macOS /tmp -> /private/tmp).
ln -s "$FIXTURE" "$WORK/symlink-checkout"
if SYMLINK_OUTPUT=$(bash "$WORK/symlink-checkout/scripts/release-check.sh" --preflight 1.2.4 2>&1); then
  fail "preflight accepted a mismatched version through a symlinked checkout"
fi
[[ "$SYMLINK_OUTPUT" == *"Version consistency check FAILED"* ]] || fail "symlinked preflight failed for the wrong reason: $SYMLINK_OUTPUT"
pass "release preflight rejects a mismatched version through a symlinked checkout"

# Mock external commands so any attempt to create a PR is visible and cannot succeed silently.
cat > "$WORK/mock-bin/gh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_CALL_LOG"
if [[ "$1 $2" == "pr create" || "$1" == "pr-gate.sh" ]]; then exit 99; fi
if [[ "$1 $2" == "pr list" ]]; then echo '[]'; exit 0; fi
exit 0
SH
chmod +x "$WORK/mock-bin/gh"
export GH_CALL_LOG="$WORK/gh-calls.log"
export PATH="$WORK/mock-bin:$PATH"
export OPENSAND_RELEASE_OS=Linux
export OPENSAND_LINUX_SMOKE_SCRIPT="$FIXTURE/scripts/smoke-linux.sh"
export RELEASE_DOWNLOAD_DIR="$WORK/dryrun-download"
DRY_OUTPUT=$(bash "$FIXTURE/scripts/release.sh" --dry-run 1.2.4 2>&1) || fail "release.sh --dry-run failed: $DRY_OUTPUT"
git -C "$FIXTURE" show-ref --verify --quiet refs/heads/main || fail "dry-run changed current branch"
[[ -z "$(git -C "$FIXTURE" tag --list)" ]] || fail "dry-run created a tag"
[[ ! -s "$GH_CALL_LOG" ]] || fail "dry-run called GitHub CLI: $(cat "$GH_CALL_LOG")"
[[ "$DRY_OUTPUT" == *"no branch, bump PR, or pr-gate is used"* ]] || fail "dry-run did not report direct-tag behavior"
pass "release.sh --dry-run completes without creating a branch, tag, PR, or invoking gh"

# Now execute the real direct-tag path against the local bare remote with staged fixtures.
rm -f "$GH_CALL_LOG"
REAL_ARTIFACTS="$WORK/release-artifacts"
mkdir -p "$REAL_ARTIFACTS"
printf 'release binary\n' > "$REAL_ARTIFACTS/OpenSand_1.2.3_amd64.deb"
printf 'release image\n' > "$REAL_ARTIFACTS/OpenSand-1.2.3-x86_64.AppImage"
(cd "$REAL_ARTIFACTS" && shasum -a 256 *.deb *.AppImage > SHA256SUMS.txt)
export RELEASE_DOWNLOAD_DIR="$REAL_ARTIFACTS"
export OPENSAND_LINUX_SMOKE_SCRIPT="$FIXTURE/scripts/smoke-linux.sh"
bash "$FIXTURE/scripts/release.sh" 1.2.3 > "$WORK/release-output.log" 2>&1 || {
  cat "$WORK/release-output.log" >&2
  git -C "$FIXTURE" status --short >&2
  fail "direct-tag release simulation failed"
}
if ! bash "$FIXTURE/scripts/release.sh" 1.2.3 > "$WORK/release-resume.log" 2>&1; then
  cat "$WORK/release-resume.log" >&2
  fail "release retry with an existing matching tag failed"
fi
rg -q 'resuming release checks' "$WORK/release-resume.log" || fail "release retry did not resume the matching existing tag"
git --git-dir="$WORK/origin.git" show-ref --verify --quiet refs/tags/v1.2.3 || fail "direct-tag flow did not push v1.2.3"
[[ "$(git -C "$FIXTURE" branch --show-current)" == main ]] || fail "release flow changed branches"
if rg -q 'pr create|pr-gate' "$GH_CALL_LOG" 2>/dev/null; then fail "release flow invoked a bump PR path"; fi
pass "direct-tag flow pushes v1.2.3 without creating or merging a bump PR"

echo "release-direct-tag: all checks passed."
