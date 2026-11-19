# A worktree's node_modules symlink resolves workspace packages into the donor worktree

- **Trap:** Phase 7 S4 linked its `node_modules` from the merged S1 worktree (the
  full-disk rule). `pnpm --filter @opensand/engine build` then failed with
  TS2305: `@opensand/local-exec-daemon` has no exported member
  `AttemptWorktrees` — a class S2 added after S1's install.
- **Root Cause:** The per-package `node_modules` inside the donor holds the
  workspace links too, so every `@opensand/*` import resolved into the DONOR
  worktree's package sources and builds, not the current worktree's. Builds
  "only read node_modules" is true for third-party deps, not for workspace
  packages that the current slice has changed or depends on freshly.
- **Rule:** After linking `node_modules` across worktrees, check whether the
  slice imports workspace packages that changed since the donor was built
  (`git diff origin/main <donor> -- packages/*/src` is enough of a hint). If so,
  replace the per-package `node_modules` of the packages you touch with a real
  copy (`cp -Rc`, APFS clone, near-zero cost) so the relative `@opensand/*`
  links resolve inside the current worktree, and build the dependency packages
  there first.
