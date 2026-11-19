# A worktree's node_modules can be symlinked from a merged sibling on a full disk

- **Trap:** Phase 7 S2 had to start on a disk 99% full (3.6 GiB free). `worktree.sh new`
  creates the worktree but no `node_modules`, and a fresh `pnpm install` in the worktree
  costs ~164 MB (root plus every package). Phase 7 S1 had already paid that cost in its
  own worktree, and `pnpm -r build` fails with "Local package.json exists, but
  node_modules missing" when only the root link exists — every `packages/*` needs one too.
- **Root Cause:** pnpm workspaces install `node_modules` per package, and worktrees don't
  share them; on a nearly full disk an extra full install per slice is pure waste.
- **Rule:** Before symlinking, confirm the lockfile didn't move:
  `git diff origin/main <merged-branch> -- pnpm-lock.yaml '**/package.json'` must be empty.
  Then symlink root and per-package: `ln -s <sibling>/node_modules <worktree>/node_modules`
  and the same for each `packages/*/node_modules` that the sibling has. Builds only read
  `node_modules` (tsc -b writes `dist/`), so links are safe. If a build fails oddly or the
  lockfile moved, fall back to `cp -Rc` (APFS clone, near-zero real cost) instead.
