# Copied pnpm node_modules: re-point broken symlinks at their realpath

- **Trap:** A fresh worktree seeded by `cp -Rc` from a donor worktree's
  `node_modules` (per the 2026-11-19-worktree-node-modules-resolve-into-donor-worktree
  lesson) still failed to build `shared`/`coordinator`: `Cannot find module
  '.../packages/shared/node_modules/typescript/bin/tsc'`. Some links resolved,
  others didn't.
- **Root Cause:** `cp -Rc` copies symlinks verbatim. pnpm's links are relative
  paths written for the *original* checkout's directory depth (often an even
  earlier donor), so inside the new worktree most point at paths that do not
  exist; the few that survive do so by luck of matching depth.
- **Rule:** After copying a pnpm `node_modules` tree into a worktree, run one
  pass over every symlink: for each broken link, read its realpath *as resolved
  in the donor*, and re-create the link with that absolute target. Verify with
  a build of the deepest dependency first (`shared`, then `coordinator`) before
  building the package under work.
