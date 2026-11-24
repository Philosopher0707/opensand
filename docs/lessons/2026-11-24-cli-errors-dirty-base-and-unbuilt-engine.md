# A dirty base clone blocks worktree.sh, and CLI tests need the engine built

- **Trap:** `scripts/worktree.sh new cli-errors-model` refused to run because the reusable base clone
  held an untracked lessons doc written earlier that day. Separately, a CLI-only test run showed two
  `mission.test.ts` failures about a missing `packages/engine/dist/src/index.js`, even though no CLI
  source caused them.
- **Root Cause:** `ensure_base` calls `is_worktree_dirty`, which treats any `git status --porcelain`
  output — including untracked files — as dirty and refuses to proceed. The mission tests load the
  engine bundle from disk at runtime, so a fresh worktree has no engine build until that package is
  compiled.
- **Rule:** When the shared base clone is dirty, set `OPENSAND_BASE_DIR` to a fresh scratch path for
  `worktree.sh new` instead of touching the unfamiliar file. Build `@opensand/engine` before reading
  a CLI-only test result. Restore a mutation probe from a `cp` backup verified with `diff -q`, never
  with `git checkout --`, which would also discard the uncommitted feature edit.
