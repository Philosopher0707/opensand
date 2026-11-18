# Daemon tests fail on a fresh worktree until @opensand/shared is built

- **Trap:** `pnpm build` and `pnpm test` in `packages/local-exec-daemon` failed in a fresh worktree with `Cannot find module '@opensand/shared'`, and every test file reported `test failed`.
- **Root Cause:** The daemon imports `@opensand/shared` through the workspace link, and the link resolves to `packages/shared/dist`, which a fresh checkout does not have.
- **Rule:** Build the shared package before the daemon: `pnpm --filter @opensand/shared build`, then the daemon build and tests. Run this from the repo root after `pnpm install` in any new worktree.
