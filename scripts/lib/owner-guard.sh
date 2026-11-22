#!/usr/bin/env bash
# OpenSand owner checkout protection guard
# Shared helper sourced by scripts/worktree.sh and scripts/pr-gate.sh.
#
# Rules:
#   - Refuses (exit 4) when run from or against the owner's checkout ($HOME/dev/opensand),
#     preventing bots from modifying the owner's active development checkout.
#   - Resolves git common directory via `git rev-parse --path-format=absolute --git-common-dir`.
#   - Override allowed ONLY when OPENSAND_OWNER=1.
#   - Protected checkout path overridable for tests via OPENSAND_PROTECTED_CHECKOUT.

assert_not_owner_checkout() {
  local caller="${1:-$(basename "${BASH_SOURCE[1]:-$0}")}"

  if [[ "${OPENSAND_OWNER:-0}" == "1" ]]; then
    return 0
  fi

  local protected_raw="${OPENSAND_PROTECTED_CHECKOUT:-$HOME/dev/opensand}"
  local protected_git
  if [[ "$protected_raw" == */.git ]]; then
    protected_git="$protected_raw"
  else
    protected_git="${protected_raw%/}/.git"
  fi

  local canon_protected
  canon_protected="$(cd "$protected_git" 2>/dev/null && pwd -P || echo "$protected_git")"

  local common_dirs=()
  local cwd_common root_common

  cwd_common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [[ -n "$cwd_common" ]]; then
    common_dirs+=("$cwd_common")
  fi

  if [[ -n "${ROOT:-}" && -d "$ROOT" ]]; then
    root_common="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
    if [[ -n "$root_common" && "$root_common" != "$cwd_common" ]]; then
      common_dirs+=("$root_common")
    fi
  fi

  for cdir in "${common_dirs[@]}"; do
    local canon_cdir
    canon_cdir="$(cd "$cdir" 2>/dev/null && pwd -P || echo "$cdir")"
    if [[ "$cdir" == "$protected_git" || "$canon_cdir" == "$canon_protected" ]]; then
      echo "$caller: refusing to run from the owner's checkout; use ~/dev/_scratch/opensand-base" >&2
      exit 4
    fi
  done

  return 0
}

# Allow direct execution: bash scripts/lib/owner-guard.sh <caller>
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  assert_not_owner_checkout "$@"
fi
