#!/usr/bin/env bash
# OpenSand scripts catalog validator
# Enforces:
#   1. Every script in scripts/ (*.sh, *.js, *.ts, *.bash, *.zsh) is documented in scripts/README.md.
#   2. No stale/nonexistent scripts are cataloged in scripts/README.md.
#   3. All cataloged shell scripts (*.sh) have executable permission (test -x).
#   4. Gate and critical release scripts (pr-gate.sh, release.sh, clean-disk.sh, verify.sh, check-scripts-catalog.sh)
#      have a corresponding hermetic selftest (*-selftest.sh) on disk.
#   5. CONTRIBUTING.md names every required workflow step (the save and merge-gate commands), so an agent
#      that reads the contributor guide is told to run them.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS_DIR="${OPENSAND_SCRIPTS_DIR:-$ROOT/scripts}"
CATALOG_FILE="${OPENSAND_CATALOG_FILE:-$SCRIPTS_DIR/README.md}"
CONTRIBUTING_FILE="${OPENSAND_CONTRIBUTING_FILE:-$ROOT/CONTRIBUTING.md}"
REQUIRED_WORKFLOW_STEPS=("scripts/worktree.sh save" "scripts/pr-gate.sh")

if [[ ! -f "$CATALOG_FILE" ]]; then
  echo "FAIL: scripts catalog file not found: $CATALOG_FILE" >&2
  exit 1
fi

FAILED=0

# --- Check 1: Every script on disk is cataloged ---
echo "==> [Check 1/5] Checking that all scripts on disk are cataloged in $(basename "$CATALOG_FILE")..."
for filepath in "$SCRIPTS_DIR"/*; do
  [[ -f "$filepath" ]] || continue
  filename="$(basename "$filepath")"

  # Only check script files
  case "$filename" in
    *.sh|*.js|*.ts|*.bash|*.zsh)
      if ! grep -qF "$filename" "$CATALOG_FILE"; then
        echo "FAIL: script '$filename' exists on disk but is not cataloged in $CATALOG_FILE" >&2
        FAILED=1
      fi
      ;;
    *)
      # Ignore non-script files (e.g. README.md, .gitignore)
      ;;
  esac
done

# --- Check 2: No stale or nonexistent scripts in catalog ---
echo "==> [Check 2/5] Checking that all scripts in $(basename "$CATALOG_FILE") exist on disk..."
CATALOGED_SCRIPTS=$(grep -oE '`[a-zA-Z0-9_-]+\.(sh|js|ts|bash|zsh)`' "$CATALOG_FILE" | tr -d '`' | sort -u || true)
for script_name in $CATALOGED_SCRIPTS; do
  if [[ ! -f "$SCRIPTS_DIR/$script_name" ]]; then
    echo "FAIL: catalog lists '$script_name', but it does not exist in $SCRIPTS_DIR" >&2
    FAILED=1
  fi
done

# --- Check 3: Cataloged shell scripts have executable permission ---
echo "==> [Check 3/5] Checking that cataloged shell scripts are executable..."
for script_name in $CATALOGED_SCRIPTS; do
  case "$script_name" in
    *.sh)
      if [[ -f "$SCRIPTS_DIR/$script_name" && ! -x "$SCRIPTS_DIR/$script_name" ]]; then
        echo "FAIL: cataloged script '$script_name' is not executable (missing +x)" >&2
        FAILED=1
      fi
      ;;
  esac
done

# --- Check 4: Gate & critical release scripts have selftests ---
echo "==> [Check 4/5] Checking that gate and critical release scripts have selftests..."
GATE_SCRIPTS=("pr-gate.sh" "release.sh" "clean-disk.sh" "verify.sh" "check-scripts-catalog.sh")

for gate in "${GATE_SCRIPTS[@]}"; do
  if [[ -f "$SCRIPTS_DIR/$gate" ]]; then
    base="${gate%.sh}"
    selftest="${base}-selftest.sh"
    if [[ ! -f "$SCRIPTS_DIR/$selftest" ]]; then
      echo "FAIL: gate script '$gate' lacks required selftest '$selftest' in $SCRIPTS_DIR" >&2
      FAILED=1
    fi
  fi
done

# --- Check 5: CONTRIBUTING.md names the required workflow steps ---
echo "==> [Check 5/5] Checking that $(basename "$CONTRIBUTING_FILE") names the required workflow steps..."
if [[ ! -f "$CONTRIBUTING_FILE" ]]; then
  echo "FAIL: contributor guide not found: $CONTRIBUTING_FILE" >&2
  FAILED=1
else
  for step in "${REQUIRED_WORKFLOW_STEPS[@]}"; do
    if ! grep -qF "$step" "$CONTRIBUTING_FILE"; then
      echo "FAIL: $CONTRIBUTING_FILE does not name the required workflow step '$step'" >&2
      FAILED=1
    fi
  done
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "FAIL: scripts catalog validation failed." >&2
  exit 1
fi

echo "PASS: scripts catalog is complete, valid, shell scripts are executable, all gate scripts have selftests, and the contributor guide names the workflow steps."
exit 0
