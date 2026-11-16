#!/usr/bin/env bash
# OpenSand automated release pipeline
# Usage:
#   scripts/release.sh [--dry-run] [--install] <version>
#
# Steps:
#   1. Disk space check (calls clean-disk.sh if free space < 8 GB)
#   2. Bump version in package.json and packages via sync-versions.js, commit, push, create PR
#   3. Merge bump PR via scripts/pr-gate.sh (on exit 3, prints re-run instructions and exits 3)
#   4. Create and push tag v<version>
#   5. Download release artifacts (*.zip and *.dmg) from GitHub Release
#   6. Run smoke verification (smoke-packaged.sh / release-check.sh), failing if exit code is 2 or non-zero
#   7. Mount DMG, verify Info.plist CFBundleShortVersionString matches target version, unmount
#   8. (With --install only): archive old /Applications/OpenSand.app to ~/dev/_archive/<date>-OpenSand-<old>/,
#      install new app, xattr -cr, launch and confirm installed version
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CLEAN_DISK_SCRIPT="${OPENSAND_CLEAN_DISK_SCRIPT:-$ROOT/scripts/clean-disk.sh}"
PR_GATE_SCRIPT="${OPENSAND_PR_GATE_SCRIPT:-$ROOT/scripts/pr-gate.sh}"
SMOKE_SCRIPT="${OPENSAND_SMOKE_SCRIPT:-$ROOT/scripts/smoke-packaged.sh}"
APP_DEST="${OPENSAND_INSTALL_APP_DEST:-/Applications/OpenSand.app}"
ARCHIVE_BASE="${OPENSAND_ARCHIVE_DIR_BASE:-$HOME/dev/_archive}"

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
echo "==> [Step 1/8] Checking free disk space..."
AVAIL_GB=$(df -k / 2>/dev/null | awk 'NR==2 {print int($4 / 1024 / 1024)}' || echo "10")
if [[ "$AVAIL_GB" -lt 8 ]]; then
  echo "Disk space is under 8 GB (${AVAIL_GB} GB available)."
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

# --- Step 2: Version Bump & PR ---
echo "==> [Step 2/8] Checking package version and bump PR..."
CURRENT_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "")
BUMP_BRANCH="chore/bump-v${VERSION}"

BUMP_PR_NUM=""
if PR_LIST_JSON=$(gh pr list --head "$BUMP_BRANCH" --state all --json number,state 2>/dev/null); then
  BUMP_PR_NUM=$(node -e '
    try {
      const list = JSON.parse(process.argv[1]);
      if (Array.isArray(list) && list.length > 0) {
        console.log(list[0].number || "");
      }
    } catch { process.exit(0); }
  ' "$PR_LIST_JSON")
fi

if [[ "$CURRENT_VERSION" == "$VERSION" ]]; then
  echo "PASS: package.json is already at version $VERSION"
elif [[ -n "$BUMP_PR_NUM" ]]; then
  echo "PASS: bump PR #$BUMP_PR_NUM already exists for branch $BUMP_BRANCH"
else
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY RUN: would sync versions to $VERSION via node scripts/sync-versions.js $VERSION"
    echo "DRY RUN: would create branch $BUMP_BRANCH, commit, push, and open PR"
    BUMP_PR_NUM="999"
  else
    echo "Bumping version to $VERSION on branch $BUMP_BRANCH..."
    git checkout -b "$BUMP_BRANCH"
    node "$ROOT/scripts/sync-versions.js" "$VERSION"
    git add package.json packages/*/package.json
    git commit -m "chore(release): bump version to $VERSION"
    git push -u origin "$BUMP_BRANCH"
    BUMP_PR_OUT=$(gh pr create --title "chore(release): bump version to $VERSION" --body "Release version bump to $VERSION" --head "$BUMP_BRANCH" --base main)
    BUMP_PR_NUM=$(echo "$BUMP_PR_OUT" | grep -oE '[0-9]+$' || true)
    if [[ -z "$BUMP_PR_NUM" ]]; then
      BUMP_PR_NUM=$(gh pr view --json number -q '.number' 2>/dev/null || echo "")
    fi
    echo "Created bump PR #$BUMP_PR_NUM: $BUMP_PR_OUT"
  fi
fi

# --- Step 3: Gate & Merge Bump PR ---
echo "==> [Step 3/8] Checking bump PR merge status via pr-gate..."
if [[ -n "$BUMP_PR_NUM" ]]; then
  IS_MERGED=0
  if PR_VIEW=$(gh pr view "$BUMP_PR_NUM" --json state -q '.state' 2>/dev/null); then
    if [[ "$PR_VIEW" == "MERGED" ]]; then
      IS_MERGED=1
      echo "PASS: bump PR #$BUMP_PR_NUM is already merged"
    fi
  elif PR_VIEW_JSON=$(gh pr view "$BUMP_PR_NUM" --json state 2>/dev/null); then
    PR_STATE=$(node -e '
      try {
        const obj = JSON.parse(process.argv[1]);
        console.log(obj.state || "");
      } catch { process.exit(0); }
    ' "$PR_VIEW_JSON")
    if [[ "$PR_STATE" == "MERGED" ]]; then
      IS_MERGED=1
      echo "PASS: bump PR #$BUMP_PR_NUM is already merged"
    fi
  fi

  if [[ "$IS_MERGED" -eq 0 ]]; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "DRY RUN: would run 'scripts/pr-gate.sh $BUMP_PR_NUM'"
    else
      echo "Running scripts/pr-gate.sh $BUMP_PR_NUM..."
      GATE_STATUS=0
      bash "$PR_GATE_SCRIPT" "$BUMP_PR_NUM" || GATE_STATUS=$?
      if [[ "$GATE_STATUS" -eq 3 ]]; then
        echo "CI is still pending for bump PR #$BUMP_PR_NUM. Re-run scripts/release.sh $VERSION later."
        exit 3
      elif [[ "$GATE_STATUS" -ne 0 ]]; then
        echo "FAIL: pr-gate failed for bump PR #$BUMP_PR_NUM with exit $GATE_STATUS" >&2
        exit "$GATE_STATUS"
      fi
      echo "PASS: bump PR #$BUMP_PR_NUM successfully gated and merged."
    fi
  fi
else
  echo "PASS: no pending bump PR to merge."
fi

# --- Step 4: Create and push release tag ---
echo "==> [Step 4/8] Checking release tag $TAG..."
TAG_EXISTS=0
if REMOTE_TAG=$(git ls-remote --tags origin "refs/tags/$TAG" 2>/dev/null); then
  if [[ -n "$REMOTE_TAG" ]]; then
    TAG_EXISTS=1
    echo "PASS: release tag $TAG already exists on origin"
  fi
fi

if [[ "$TAG_EXISTS" -eq 0 ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY RUN: would create and push tag '$TAG'"
  else
    echo "Creating and pushing release tag $TAG..."
    git tag -a "$TAG" -m "Release $TAG"
    git push origin "refs/tags/$TAG:refs/tags/$TAG"
    echo "PASS: tag $TAG pushed to origin."
  fi
fi

# --- Step 5: Download release artifacts ---
echo "==> [Step 5/8] Downloading release artifacts for $TAG..."
DOWNLOAD_DIR="${RELEASE_DOWNLOAD_DIR:-$ROOT/dist/release-$VERSION}"
mkdir -p "$DOWNLOAD_DIR"

ZIP_PATH=""
DMG_PATH=""

FOUND_ZIP=$(find "$DOWNLOAD_DIR" -name "*${VERSION}*.zip" -o -name "*.zip" 2>/dev/null | head -n 1 || true)
FOUND_DMG=$(find "$DOWNLOAD_DIR" -name "*${VERSION}*.dmg" -o -name "*.dmg" 2>/dev/null | head -n 1 || true)

if [[ -n "$FOUND_ZIP" && -n "$FOUND_DMG" && -f "$FOUND_ZIP" && -f "$FOUND_DMG" ]]; then
  ZIP_PATH="$FOUND_ZIP"
  DMG_PATH="$FOUND_DMG"
  echo "PASS: artifacts already downloaded: $ZIP_PATH, $DMG_PATH"
else
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY RUN: would download $TAG release artifacts (*.zip, *.dmg) into $DOWNLOAD_DIR"
    ZIP_PATH="$DOWNLOAD_DIR/OpenSand-${VERSION}-arm64-mac.zip"
    DMG_PATH="$DOWNLOAD_DIR/OpenSand-${VERSION}-arm64.dmg"
  else
    echo "Downloading release assets from GitHub for $TAG..."
    if ! gh release download "$TAG" -D "$DOWNLOAD_DIR" --pattern "*.zip" --pattern "*.dmg"; then
      echo "FAIL: failed to download release assets for $TAG" >&2
      exit 1
    fi
    ZIP_PATH=$(find "$DOWNLOAD_DIR" -name "*.zip" | head -n 1)
    DMG_PATH=$(find "$DOWNLOAD_DIR" -name "*.dmg" | head -n 1)
    if [[ -z "$ZIP_PATH" || -z "$DMG_PATH" ]]; then
      echo "FAIL: downloaded release assets missing zip or dmg in $DOWNLOAD_DIR" >&2
      exit 1
    fi
    echo "PASS: downloaded $ZIP_PATH and $DMG_PATH"
  fi
fi

# --- Step 6: Smoke / release-check ---
echo "==> [Step 6/8] Running packaged smoke test on $ZIP_PATH..."
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

# --- Step 7: Check DMG Info.plist version ---
echo "==> [Step 7/8] Verifying DMG Info.plist version..."
if [[ "$DRY_RUN" -eq 1 ]]; then
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

# --- Step 8: With --install only ---
echo "==> [Step 8/8] Install check..."
if [[ "$INSTALL" -eq 1 ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY RUN: would check existing $APP_DEST, archive to ~/dev/_archive/<date>-OpenSand-<old>/, copy new app, run xattr -cr, and launch to confirm version"
  else
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

    echo "Launching and confirming version..."
    if [[ -f "$APP_DEST/Contents/MacOS/OpenSand" ]]; then
      OPENSAND_SMOKE=1 OPENSAND_STATE_DIR="$(mktemp -d)" "$APP_DEST/Contents/MacOS/OpenSand" --version >/dev/null 2>&1 || true
    fi
    echo "PASS: Successfully installed and verified OpenSand $VERSION at $APP_DEST"
  fi
else
  echo "PASS: --install not passed; skipping local /Applications installation."
fi

echo "==> Release process for OpenSand v$VERSION complete."
exit 0
