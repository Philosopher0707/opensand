#!/usr/bin/env bash
# OpenSand automated release pipeline
# Usage:
#   scripts/release.sh [--dry-run] [--install] <version>
#
# Steps:
#   1. Disk space check (calls clean-disk.sh if free space < 8 GB)
#   2. Verify clean origin/main checkout and synchronized package versions
#   3. Create and push tag v<version> directly (no bump branch or PR)
#   4. Download release artifacts (*.zip and *.dmg) from GitHub Release
#   6. Generate release notes from PR titles merged since the previous tag, grouped by
#      conventional prefix (feat / fix / docs / other) with each PR number, and set them
#      as the GitHub release body
#   7. Run smoke verification (smoke-packaged.sh / release-check.sh), failing if exit code is 2 or non-zero
#   8. Mount DMG, verify Info.plist CFBundleShortVersionString matches target version, unmount
#   9. (With --install only): archive old /Applications/OpenSand.app to ~/dev/_archive/<date>-OpenSand-<old>/,
#      install new app, xattr -cr, then run a post-install health check proving the installed
#      app starts and answers with the expected version (install-health-check.sh)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Disk guard measures the writable data volume (DISK_PATH), not the read-only system snapshot
source "$ROOT/scripts/lib/free-space.sh"

CLEAN_DISK_SCRIPT="${OPENSAND_CLEAN_DISK_SCRIPT:-$ROOT/scripts/clean-disk.sh}"
SMOKE_SCRIPT="${OPENSAND_SMOKE_SCRIPT:-$ROOT/scripts/smoke-packaged.sh}"
LINUX_SMOKE_SCRIPT="${OPENSAND_LINUX_SMOKE_SCRIPT:-$ROOT/scripts/smoke-linux.sh}"
HEALTH_CHECK_SCRIPT="${OPENSAND_HEALTH_CHECK_SCRIPT:-$ROOT/scripts/install-health-check.sh}"
APP_DEST="${OPENSAND_INSTALL_APP_DEST:-/Applications/OpenSand.app}"
ARCHIVE_BASE="${OPENSAND_ARCHIVE_DIR_BASE:-$HOME/dev/_archive}"

# The release pipeline runs on both macOS and Linux. Overridable for the
# hermetic selftest; the host OS decides which smoke and DMG steps apply.
OS_NAME="${OPENSAND_RELEASE_OS:-$(uname -s)}"
IS_MACOS=0
IS_LINUX=0
case "$OS_NAME" in
  Darwin) IS_MACOS=1 ;;
  Linux) IS_LINUX=1 ;;
  *) echo "FAIL: unsupported release OS: $OS_NAME" >&2; exit 1 ;;
esac

DRY_RUN=0
INSTALL=0
RAW_VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --install)
      INSTALL=1
      shift
      ;;
    -h|--help)
      echo "Usage: scripts/release.sh [--dry-run] [--install] <version>"
      exit 0
      ;;
    *)
      if [[ -z "$RAW_VERSION" ]]; then
        RAW_VERSION="$1"
        shift
      else
        echo "FAIL: unexpected argument: $1" >&2
        echo "Usage: scripts/release.sh [--dry-run] [--install] <version>" >&2
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$RAW_VERSION" ]]; then
  echo "FAIL: missing version argument" >&2
  echo "Usage: scripts/release.sh [--dry-run] [--install] <version>" >&2
  exit 1
fi

VERSION="${RAW_VERSION#v}"
TAG="v$VERSION"

# --- Step 1: Disk Space Guard (< 8 GB) ---
echo "==> [Step 1/5] Checking free disk space..."
AVAIL_GB=$(df -k "$DISK_PATH" 2>/dev/null | awk 'NR==2 {print int($4 / 1024 / 1024)}' || echo "10")
if [[ "$AVAIL_GB" -lt 8 ]]; then
  echo "Disk space is under 8 GB (${AVAIL_GB} GB available on $DISK_PATH)."
  if [[ -f "$CLEAN_DISK_SCRIPT" ]]; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "DRY RUN: would run $CLEAN_DISK_SCRIPT --yes"
    else
      echo "Running $CLEAN_DISK_SCRIPT --yes..."
      bash "$CLEAN_DISK_SCRIPT" --yes || true
    fi
  else
    echo "Notice: scripts/clean-disk.sh not found, skipping disk cleanup."
  fi
else
  echo "PASS: disk space is sufficient (${AVAIL_GB} GB available)."
fi

# --- Step 2: Release preflight ---
echo "==> [Step 2/5] Checking release preflight for $TAG..."
if [[ "$DRY_RUN" -eq 1 ]]; then
  node "$ROOT/scripts/sync-versions.js" --check
  CURRENT_VERSION=$(node -p "require('./package.json').version")
  if [[ "$CURRENT_VERSION" != "$VERSION" ]]; then
    echo "DRY RUN: package manifests are consistently at $CURRENT_VERSION; a real $TAG release requires merging 'node scripts/sync-versions.js $VERSION' to main first."
  else
    echo "DRY RUN: version manifests match $VERSION."
  fi
  echo "DRY RUN: would require a clean checkout exactly at origin/main and run scripts/release-check.sh --preflight $VERSION before tagging"
else
  if ! git fetch origin; then
    echo "FAIL: git fetch origin failed before creating tag $TAG." >&2
    exit 1
  fi
  LOCAL_HEAD=$(git rev-parse HEAD)
  ORIGIN_MAIN=$(git rev-parse refs/remotes/origin/main 2>/dev/null || true)
  if [[ -z "$ORIGIN_MAIN" || "$LOCAL_HEAD" != "$ORIGIN_MAIN" ]]; then
    echo "FAIL: local HEAD ($LOCAL_HEAD) does not match origin/main (${ORIGIN_MAIN:-missing}); refusing to tag." >&2
    exit 1
  fi
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "FAIL: working tree is not clean; refusing to tag." >&2
    exit 1
  fi
  bash "$ROOT/scripts/release-check.sh" --preflight "$VERSION"
  if ! REMOTE_TAGS=$(git ls-remote --tags origin "refs/tags/$TAG" "refs/tags/$TAG^{}"); then
    echo "FAIL: unable to inspect remote tag $TAG." >&2
    exit 1
  fi
  echo "PASS: clean origin/main checkout and all package manifests match $VERSION."
fi

# --- Step 3: Create and push the release tag directly ---
echo "==> [Step 3/5] Checking release tag $TAG..."
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "DRY RUN: would create annotated tag '$TAG' at HEAD and push it to origin; no branch, bump PR, or pr-gate is used."
else
  REMOTE_TAG_COMMIT=$(printf '%s\n' "$REMOTE_TAGS" | awk -v ref="refs/tags/$TAG^{}" '$2 == ref {print $1}')
  if [[ -z "$REMOTE_TAG_COMMIT" ]]; then
    REMOTE_TAG_COMMIT=$(printf '%s\n' "$REMOTE_TAGS" | awk -v ref="refs/tags/$TAG" '$2 == ref {print $1}')
  fi
  LOCAL_TAG_COMMIT=$(git rev-parse -q --verify "refs/tags/$TAG^{commit}" 2>/dev/null || true)
  if [[ -n "$REMOTE_TAG_COMMIT" ]]; then
    if [[ -z "$LOCAL_TAG_COMMIT" ]]; then
      git fetch origin "refs/tags/$TAG:refs/tags/$TAG"
      LOCAL_TAG_COMMIT=$(git rev-parse "refs/tags/$TAG^{commit}")
    fi
    if [[ "$LOCAL_TAG_COMMIT" != "$LOCAL_HEAD" || "$REMOTE_TAG_COMMIT" != "$LOCAL_HEAD" ]]; then
      echo "FAIL: existing tag $TAG does not point to the verified origin/main commit $LOCAL_HEAD." >&2
      exit 1
    fi
    echo "PASS: existing remote tag $TAG points to verified origin/main commit $LOCAL_HEAD; resuming release checks."
  else
    if [[ -n "$LOCAL_TAG_COMMIT" && "$LOCAL_TAG_COMMIT" != "$LOCAL_HEAD" ]]; then
      echo "FAIL: local tag $TAG points to $LOCAL_TAG_COMMIT, expected $LOCAL_HEAD." >&2
      exit 1
    fi
    if [[ -z "$LOCAL_TAG_COMMIT" ]]; then
      git tag -a "$TAG" -m "Release $TAG"
    fi
    git push origin "refs/tags/$TAG:refs/tags/$TAG"
    echo "PASS: tag $TAG pushed to origin."
  fi
fi

# --- Step 5: Download release artifacts ---
echo "==> [Step 5/9] Downloading release artifacts for $TAG..."
DOWNLOAD_DIR="${RELEASE_DOWNLOAD_DIR:-$ROOT/dist/release-$VERSION}"
mkdir -p "$DOWNLOAD_DIR"

# Clean up any leftover files from another version so they can never collide or be mistaken for artifacts
find "$DOWNLOAD_DIR" -type f ! -name "*${VERSION}*" -delete 2>/dev/null || true

ZIP_PATH=""; DMG_PATH=""; APPIMAGE_PATH=""; DEB_PATH=""

find_versioned() { find "$DOWNLOAD_DIR" -type f -name "*${VERSION}*$1" -print 2>/dev/null | head -n 1 || true; }
find_any() { find "$DOWNLOAD_DIR" -type f -name "$1" -print 2>/dev/null | head -n 1 || true; }
pick() { local v="$1" a="$2"; [[ -n "$v" ]] && printf '%s' "$v" || printf '%s' "$a"; }

FOUND_ZIP=$(pick "$(find_versioned '.zip')" "$(find_any '*.zip')")
FOUND_DMG=$(pick "$(find_versioned '.dmg')" "$(find_any '*.dmg')")
FOUND_APPIMAGE=$(pick "$(find_versioned '.AppImage')" "$(find_any '*.AppImage')")
FOUND_DEB=$(pick "$(find_versioned '.deb')" "$(find_any '*.deb')")

ARTIFACTS_PRESENT=0
if [[ "$IS_MACOS" -eq 1 ]]; then
  if [[ -n "$FOUND_ZIP" && -n "$FOUND_DMG" ]]; then ARTIFACTS_PRESENT=1; fi
else
  if [[ -n "$FOUND_DEB" ]]; then ARTIFACTS_PRESENT=1; fi
fi

if [[ "$ARTIFACTS_PRESENT" -eq 1 ]]; then
  ZIP_PATH="$FOUND_ZIP"; DMG_PATH="$FOUND_DMG"
  APPIMAGE_PATH="$FOUND_APPIMAGE"; DEB_PATH="$FOUND_DEB"
  echo "PASS: artifacts already downloaded: zip=$ZIP_PATH dmg=$DMG_PATH AppImage=$APPIMAGE_PATH deb=$DEB_PATH"
else
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY RUN: would download $TAG release artifacts (*.zip, *.dmg, *.AppImage, *.deb) into $DOWNLOAD_DIR"
    ZIP_PATH="$DOWNLOAD_DIR/OpenSand-${VERSION}-arm64-mac.zip"
    DMG_PATH="$DOWNLOAD_DIR/OpenSand-${VERSION}-arm64.dmg"
    APPIMAGE_PATH="$DOWNLOAD_DIR/OpenSand-${VERSION}-x86_64.AppImage"
    DEB_PATH="$DOWNLOAD_DIR/OpenSand_${VERSION}_amd64.deb"
  else
    # Pushing the tag starts the async release.yml builds (macOS and Linux, ~4-5 min);
    # until softprops/action-gh-release runs there is no release to download. Retry
    # until the assets exist (AGENTS_LEARNING: release asset download race).
    DOWNLOAD_TIMEOUT_SECONDS="${RELEASE_DOWNLOAD_TIMEOUT_SECONDS:-600}"
    DOWNLOAD_POLL_SECONDS="${RELEASE_DOWNLOAD_POLL_SECONDS:-15}"
    MAX_ATTEMPTS=$(( DOWNLOAD_TIMEOUT_SECONDS / DOWNLOAD_POLL_SECONDS + 1 ))
    ATTEMPT=0
    # Empty download directory before fresh download so no stale or partial files collide
    find "$DOWNLOAD_DIR" -type f -delete 2>/dev/null || true
    echo "Downloading release assets from GitHub for $TAG (up to ${DOWNLOAD_TIMEOUT_SECONDS}s)..."
    while :; do
      ATTEMPT=$((ATTEMPT + 1))
      DOWNLOAD_ERR=""
      DOWNLOAD_ERR=$(gh release download "$TAG" -D "$DOWNLOAD_DIR" --clobber \
        --pattern "*.zip" --pattern "*.dmg" --pattern "*.AppImage" --pattern "*.deb" 2>&1) || true

      ZIP_PATH=$(find_any '*.zip'); DMG_PATH=$(find_any '*.dmg')
      APPIMAGE_PATH=$(find_any '*.AppImage'); DEB_PATH=$(find_any '*.deb')
      READY=0
      if [[ "$IS_MACOS" -eq 1 ]]; then
        if [[ -n "$ZIP_PATH" && -n "$DMG_PATH" ]]; then READY=1; fi
      else
        if [[ -n "$DEB_PATH" ]]; then READY=1; fi
      fi
      if [[ "$READY" -eq 1 ]]; then
        echo "PASS: downloaded zip=$ZIP_PATH dmg=$DMG_PATH AppImage=$APPIMAGE_PATH deb=$DEB_PATH (attempt $ATTEMPT)"
        break
      fi

      # An auth failure never fixes itself by retrying: fail now, naming the fix.
      if [[ "$DOWNLOAD_ERR" =~ (HTTP 40[13]|Bad credentials|authentication|GH_TOKEN|not logged in|gh auth login) ]]; then
        echo "FAIL: cannot download release assets for $TAG: GitHub CLI is not authenticated." >&2
        echo "  gh said: $DOWNLOAD_ERR" >&2
        echo "  Export a token with release scope before re-running, e.g. 'export GH_TOKEN=\$(gh auth token)'." >&2
        exit 1
      fi

      if [[ "$ATTEMPT" -ge "$MAX_ATTEMPTS" ]]; then
        echo "FAIL: release assets for $TAG did not appear within ${DOWNLOAD_TIMEOUT_SECONDS}s ($ATTEMPT attempts)." >&2
        echo "  Last error: ${DOWNLOAD_ERR:-no error output}" >&2
        echo "  The release.yml build may have failed; check https://github.com/Philosopher0707/opensand/actions/workflows/release.yml" >&2
        echo "  The script is idempotent: fix the build and re-run 'scripts/release.sh $VERSION'." >&2
        exit 1
      fi

      echo "  assets for $TAG not published yet (attempt $ATTEMPT/$MAX_ATTEMPTS); retrying in ${DOWNLOAD_POLL_SECONDS}s..."
      sleep "$DOWNLOAD_POLL_SECONDS"
    done
  fi
fi

# Group PR titles merged since the previous tag under conventional-release headings, newest
# first, one line per PR with its number. Prints markdown to stdout.
generate_release_notes() {
  local prev_tag="$1"
  local pr_json cutoff
  pr_json=$(gh pr list --state merged --base main --limit 200 --json number,title,mergedAt 2>/dev/null || echo "[]")
  cutoff=""
  if [[ -n "$prev_tag" ]]; then
    cutoff=$(git log -1 --format=%cI "$prev_tag" 2>/dev/null || true)
  fi
  node -e '
const titles = { feat: "Features", fix: "Fixes", docs: "Docs", other: "Other" };
const sections = { feat: [], fix: [], docs: [], other: [] };
let prs = [];
try { prs = JSON.parse(process.argv[1] || "[]"); } catch { prs = []; }
const cutoff = process.argv[2] || "";
for (const pr of Array.isArray(prs) ? prs : []) {
  if (!pr || typeof pr.title !== "string" || pr.number === undefined) continue;
  if (cutoff && pr.mergedAt && String(pr.mergedAt) < cutoff) continue;
  const m = /^(feat|fix|docs)(\([^)]*\))?!?:/.exec(pr.title);
  sections[m ? m[1] : "other"].push("- " + pr.title + " (#" + pr.number + ")");
}
const lines = [];
for (const group of ["feat", "fix", "docs", "other"]) {
  if (sections[group].length === 0) continue;
  lines.push("## " + titles[group], "", ...sections[group], "");
}
console.log(lines.join("\n").trim());
' "$pr_json" "$cutoff"
}

# --- Step 6: Release notes from merged PR titles ---
echo "==> [Step 6/9] Writing release notes for $TAG..."
NOTES_FILE="$DOWNLOAD_DIR/RELEASE_NOTES-$VERSION.md"
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "DRY RUN: would group PRs merged since the previous tag into feat/fix/docs/other and set them as the $TAG release body"
else
  if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
    PREV_TAG=$(git describe --tags --abbrev=0 --match 'v*' "$TAG^" 2>/dev/null || true)
  else
    PREV_TAG=$(git describe --tags --abbrev=0 --match 'v*' HEAD 2>/dev/null || true)
  fi
  generate_release_notes "$PREV_TAG" > "$NOTES_FILE"
  if [[ ! -s "$NOTES_FILE" ]]; then
    printf 'No pull requests merged since %s.\n' "${PREV_TAG:-the previous release}" > "$NOTES_FILE"
  fi
  cat "$NOTES_FILE"
  gh release edit "$TAG" --notes-file "$NOTES_FILE"
  echo "PASS: release notes for $TAG set from PRs merged since ${PREV_TAG:-the previous release}."
fi

# --- Step 7: Smoke / release-check ---
if [[ "$IS_LINUX" -eq 1 ]]; then
  echo "==> [Step 7/9] Running Linux packaged smoke test on $DEB_PATH..."
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY RUN: would run scripts/smoke-linux.sh on $DEB_PATH"
  else
    SMOKE_STATUS=0
    bash "$LINUX_SMOKE_SCRIPT" "$DEB_PATH" || SMOKE_STATUS=$?
    if [[ "$SMOKE_STATUS" -ne 0 ]]; then
      echo "FAIL: Linux smoke test failed for package $DEB_PATH (exit code: $SMOKE_STATUS)" >&2
      exit 2
    fi
    echo "PASS: Linux smoke test passed for $DEB_PATH"
  fi
else
  echo "==> [Step 7/9] Running packaged smoke test on $ZIP_PATH..."
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY RUN: would run scripts/smoke-packaged.sh on $ZIP_PATH"
  else
    SMOKE_STATUS=0
    bash "$SMOKE_SCRIPT" "$ZIP_PATH" || SMOKE_STATUS=$?
    if [[ "$SMOKE_STATUS" -ne 0 ]]; then
      echo "FAIL: smoke test failed for package $ZIP_PATH (exit code: $SMOKE_STATUS)" >&2
      exit 2
    fi
    echo "PASS: smoke test passed for $ZIP_PATH"
  fi
fi

# --- Step 7: Check DMG Info.plist version (macOS only) ---
echo "==> [Step 8/9] Verifying DMG Info.plist version..."
if [[ "$IS_LINUX" -eq 1 ]]; then
  echo "PASS: DMG Info.plist check skipped on $OS_NAME (macOS-only)."
elif [[ "$DRY_RUN" -eq 1 ]]; then
  echo "DRY RUN: would mount $DMG_PATH, read CFBundleShortVersionString from OpenSand.app/Contents/Info.plist, verify it equals $VERSION, and unmount"
else
  MOUNT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/opensand-dmg-mount.XXXXXX")
  echo "Attaching DMG at $MOUNT_DIR..."
  hdiutil attach "$DMG_PATH" -nobrowse -readonly -mountpoint "$MOUNT_DIR" >/dev/null

  PLIST_PATH="$MOUNT_DIR/OpenSand.app/Contents/Info.plist"
  if [[ ! -f "$PLIST_PATH" ]]; then
    APP_IN_MOUNT=$(find "$MOUNT_DIR" -name "*.app" -maxdepth 2 2>/dev/null | head -n 1 || true)
    if [[ -n "$APP_IN_MOUNT" ]]; then
      PLIST_PATH="$APP_IN_MOUNT/Contents/Info.plist"
    fi
  fi

  if [[ ! -f "$PLIST_PATH" ]]; then
    hdiutil detach "$MOUNT_DIR" -force >/dev/null 2>&1 || true
    rm -rf "$MOUNT_DIR"
    echo "FAIL: Info.plist not found in mounted DMG $DMG_PATH" >&2
    exit 1
  fi

  DMG_VER=$(node -e '
    const fs = require("fs");
    try {
      const content = fs.readFileSync(process.argv[1], "utf8");
      const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(content);
      if (m) {
        console.log(m[1].trim());
      } else {
        process.exit(1);
      }
    } catch {
      process.exit(1);
    }
  ' "$PLIST_PATH" 2>/dev/null || /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$PLIST_PATH" 2>/dev/null || "")

  hdiutil detach "$MOUNT_DIR" -force >/dev/null 2>&1 || true
  rm -rf "$MOUNT_DIR"

  if [[ "$DMG_VER" != "$VERSION" ]]; then
    echo "FAIL: DMG version mismatch: expected '$VERSION', got '$DMG_VER'" >&2
    exit 1
  fi
  echo "PASS: DMG Info.plist version verified as '$DMG_VER'"
fi

# --- Step 8: With --install only (macOS only) ---
# pgrep -f is unanchored, so select only PIDs whose executable is exactly the
# installed app binary; a stray process with the path in its arguments is ignored.
running_app_pids() {
  local pid comm
  for pid in $(pgrep -f "OpenSand\\.app/Contents/MacOS/OpenSand" 2>/dev/null || true); do
    comm=$(ps -o comm= -p "$pid" 2>/dev/null || true)
    if [[ "$comm" == "$APP_DEST/Contents/MacOS/OpenSand" ]]; then
      printf '%s\n' "$pid"
    fi
  done
}

PROBE_HEADER_FILE=""
cleanup_probe_header() {
  if [[ -n "$PROBE_HEADER_FILE" ]]; then
    rm -f "$PROBE_HEADER_FILE"
  fi
}
trap cleanup_probe_header EXIT

echo "==> [Step 9/9] Install check..."
if [[ "$IS_LINUX" -eq 1 ]]; then
  echo "PASS: local /Applications install skipped on $OS_NAME (macOS-only)."
elif [[ "$INSTALL" -eq 1 ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY RUN: would check existing $APP_DEST, archive to ~/dev/_archive/<date>-OpenSand-<old>/, copy new app, run xattr -cr, and run install-health-check.sh to prove it starts and answers"
  else
    # 1. Quit any running OpenSand gracefully, wait up to 15s, then kill -TERM
    echo "Stopping any running OpenSand app gracefully..."
    QUIT_TIMEOUT="${OPENSAND_QUIT_TIMEOUT_SECONDS:-15}"
    RUNNING_PIDS=$(running_app_pids)
    if [[ -n "$RUNNING_PIDS" ]]; then
      echo "Found running OpenSand process; requesting graceful quit..."
      osascript -e 'tell application "OpenSand" to quit' 2>/dev/null || true
      QUIT_DEADLINE=$(( $(date +%s) + QUIT_TIMEOUT ))
      while (( $(date +%s) < QUIT_DEADLINE )); do
        RUNNING_PIDS=$(running_app_pids)
        if [[ -z "$RUNNING_PIDS" ]]; then
          break
        fi
        sleep 0.5
      done

      RUNNING_PIDS=$(running_app_pids)
      if [[ -n "$RUNNING_PIDS" ]]; then
        echo "OpenSand still running after ${QUIT_TIMEOUT}s; sending SIGTERM to OpenSand.app process..."
        for pid in $RUNNING_PIDS; do
          kill -TERM "$pid" 2>/dev/null || true
        done
        for ((step=1; step<=10; step++)); do
          RUNNING_PIDS=$(running_app_pids)
          if [[ -z "$RUNNING_PIDS" ]]; then
            break
          fi
          sleep 0.5
        done
      fi
    else
      echo "No running OpenSand process detected."
    fi

    if [[ -d "$APP_DEST" ]]; then
      PLIST="$APP_DEST/Contents/Info.plist"
      OLD_VER=$(node -e '
        const fs = require("fs");
        try {
          const content = fs.readFileSync(process.argv[1], "utf8");
          const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(content);
          console.log(m ? m[1].trim() : "unknown");
        } catch { console.log("unknown"); }
      ' "$PLIST" 2>/dev/null || echo "unknown")
      DATE=$(date +%Y-%m-%d)
      ARCHIVE_DEST="$ARCHIVE_BASE/${DATE}-OpenSand-${OLD_VER}"
      echo "Archiving existing app to $ARCHIVE_DEST..."
      mkdir -p "$ARCHIVE_DEST"
      cp -R "$APP_DEST" "$ARCHIVE_DEST/"
      rm -rf "$APP_DEST"
      echo "Archived old app version $OLD_VER to $ARCHIVE_DEST"
    fi

    echo "Installing new OpenSand.app to $APP_DEST..."
    UNPACK_TMP=$(mktemp -d "${TMPDIR:-/tmp}/opensand-install.XXXXXX")
    unzip -q "$ZIP_PATH" -d "$UNPACK_TMP"
    SRC_APP=$(find "$UNPACK_TMP" -name "OpenSand.app" -maxdepth 3 2>/dev/null | head -n 1 || true)
    if [[ -z "$SRC_APP" || ! -d "$SRC_APP" ]]; then
      echo "FAIL: OpenSand.app not found in unpacked zip $ZIP_PATH" >&2
      rm -rf "$UNPACK_TMP"
      exit 1
    fi
    mkdir -p "$(dirname "$APP_DEST")"
    cp -R "$SRC_APP" "$APP_DEST"
    rm -rf "$UNPACK_TMP"

    echo "Running xattr -cr $APP_DEST..."
    xattr -cr "$APP_DEST" 2>/dev/null || true

    INSTALLED_VER=$(node -e '
      const fs = require("fs");
      try {
        const content = fs.readFileSync(process.argv[1] + "/Contents/Info.plist", "utf8");
        const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(content);
        console.log(m ? m[1].trim() : "");
      } catch { console.log(""); }
    ' "$APP_DEST" 2>/dev/null || echo "")

    if [[ "$INSTALLED_VER" != "$VERSION" ]]; then
      echo "FAIL: Installed app version ($INSTALLED_VER) does not match target ($VERSION)" >&2
      exit 1
    fi

    echo "Running post-install health check on $APP_DEST..."
    HEALTH_STATUS=0
    bash "$HEALTH_CHECK_SCRIPT" "$APP_DEST" "$VERSION" || HEALTH_STATUS=$?
    if [[ "$HEALTH_STATUS" -ne 0 ]]; then
      echo "FAIL: post-install health check failed for $APP_DEST (exit code: $HEALTH_STATUS)" >&2
      exit 2
    fi
    echo "PASS: Successfully installed OpenSand $VERSION at $APP_DEST; health check proved it starts and answers"

    # 2. Relaunch the new bundle with open -a
    echo "Relaunching new OpenSand bundle with open -a $APP_DEST..."
    env -u ELECTRON_RUN_AS_NODE open -a "$APP_DEST"

    # 3. Probe running process: find port (same way app publishes) and token (~/.opensand/server.token without printing)
    echo "Probing running OpenSand process on local API..."
    PROBE_TIMEOUT="${OPENSAND_RESTART_PROBE_TIMEOUT_SECONDS:-30}"
    PROBE_DEADLINE=$(( $(date +%s) + PROBE_TIMEOUT ))
    PROBE_OK=0
    PROBE_ERR=""

    while (( $(date +%s) < PROBE_DEADLINE )); do
      STATE_DIR="${OPENSAND_STATE_DIR:-$HOME/.opensand}"

      # Header goes in a 0600 file so the token never appears in curl's argv.
      # The token lives in a private name that is never exported and is unset
      # immediately: a caller's exported TOKEN keeps its export attribute
      # through plain assignment and would otherwise reach curl's environment.
      if [[ -z "$PROBE_HEADER_FILE" && -f "$STATE_DIR/server.token" ]]; then
        unset _OS_PROBE_TOKEN
        export -n _OS_PROBE_TOKEN 2>/dev/null || true
        _OS_PROBE_TOKEN=$(tr -d '\r\n' < "$STATE_DIR/server.token")
        if [[ -n "$_OS_PROBE_TOKEN" ]]; then
          OLD_UMASK=$(umask)
          umask 077
          PROBE_HEADER_FILE=$(mktemp "${TMPDIR:-/tmp}/opensand-probe-header.XXXXXX")
          umask "$OLD_UMASK"
          printf 'Authorization: Bearer %s\n' "$_OS_PROBE_TOKEN" > "$PROBE_HEADER_FILE"
        fi
        unset _OS_PROBE_TOKEN
      fi

      PORT="${OPENSAND_PROBE_PORT:-}"
      if [[ -z "$PORT" && -f "$STATE_DIR/server.port" ]]; then
        PORT=$(tr -d '\r\n' < "$STATE_DIR/server.port")
      fi
      if [[ -z "$PORT" ]]; then
        APP_PID=$(running_app_pids | head -n 1)
        if [[ -n "$APP_PID" ]]; then
          PORT=$(lsof -a -p "$APP_PID" -iTCP -sTCP:LISTEN -Fn 2>/dev/null | grep -E '^n' | head -n 1 | sed 's/^n//' | awk -F: '{print $NF}' || true)
        fi
      fi
      if [[ -z "$PORT" ]]; then
        PORT="3456"
      fi

      if [[ -n "$PORT" ]]; then
        CURL_OPTS=(-s -w "\nHTTP_STATUS:%{http_code}" --connect-timeout 1 --max-time 2 --noproxy "*")
        if [[ -n "$PROBE_HEADER_FILE" ]]; then
          CURL_OPTS+=(-H "@$PROBE_HEADER_FILE")
        fi

        VER_RESP=$(curl "${CURL_OPTS[@]}" "http://127.0.0.1:$PORT/api/version" 2>/dev/null || true)
        VER_CODE=$(printf '%s\n' "$VER_RESP" | grep "HTTP_STATUS:" | cut -d: -f2)
        VER_BODY=$(printf '%s\n' "$VER_RESP" | sed '/HTTP_STATUS:/d')

        if [[ "$VER_CODE" == "200" ]]; then
          REPORTED_VER=$(printf '%s\n' "$VER_BODY" | node -e '
            const fs = require("fs");
            try {
              const d = JSON.parse(fs.readFileSync(0, "utf8"));
              console.log(d.app || d.version || "");
            } catch { console.log(""); }
          ' 2>/dev/null || echo "")

          CLEAN_REPORTED="${REPORTED_VER#v}"
          if [[ "$CLEAN_REPORTED" == "$VERSION" || "$REPORTED_VER" == "$TAG" ]]; then
            ENG_RESP=$(curl "${CURL_OPTS[@]}" "http://127.0.0.1:$PORT/api/engines/detect" 2>/dev/null || true)
            ENG_CODE=$(printf '%s\n' "$ENG_RESP" | grep "HTTP_STATUS:" | cut -d: -f2)
            ENG_BODY=$(printf '%s\n' "$ENG_RESP" | sed '/HTTP_STATUS:/d')

            if [[ "$ENG_CODE" == "200" ]]; then
              ENG_COUNT=$(printf '%s\n' "$ENG_BODY" | node -e '
                const fs = require("fs");
                try {
                  const d = JSON.parse(fs.readFileSync(0, "utf8"));
                  console.log(Array.isArray(d) ? d.length : 0);
                } catch { console.log(0); }
              ' 2>/dev/null || echo 0)

              if (( ENG_COUNT > 0 )); then
                PROBE_OK=1
                break
              else
                PROBE_ERR="GET /api/engines/detect returned 200 but engines list was empty"
              fi
            else
              PROBE_ERR="GET /api/engines/detect returned HTTP status ${ENG_CODE:-unknown}"
            fi
          else
            PROBE_ERR="GET /api/version reported stale version '${REPORTED_VER}', expected '${VERSION}' (${TAG})"
          fi
        else
          PROBE_ERR="GET /api/version returned HTTP status ${VER_CODE:-connection refused}"
        fi
      fi

      sleep 0.5
    done

    if [[ "$PROBE_OK" -ne 1 ]]; then
      echo "FAIL: Running OpenSand process restart probe failed after ${PROBE_TIMEOUT}s: ${PROBE_ERR:-no response on local server}" >&2
      exit 1
    fi
    echo "PASS: Running OpenSand process verified: /api/version matches $TAG and /api/engines/detect returned active engines"
  fi
else
  echo "PASS: --install not passed; skipping local /Applications installation."
fi

echo "==> Release process for OpenSand v$VERSION complete."
exit 0
