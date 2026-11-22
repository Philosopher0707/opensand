# Worktree dependencies copied from another branch have stale workspace links

**Trap:** After creating a scratch worktree and copying `node_modules` from the main checkout (which sat on a different branch), `pnpm --filter @opensand/desktop... run build` failed with `Cannot find module '@opensand/protocol'` and `@opensand/engine` in packages whose donor install did not list those dependencies.

**Root Cause:** The donor checkout's per-package `node_modules` reflect that branch's `package.json`, not `origin/main`'s, so workspace symlinks added on main were absent even though the root pnpm store was shared.

**Rule:** After copying donor `node_modules` into a worktree, derive every `@opensand/*` link from each destination `package.json` (dependency and devDependency keys) instead of trusting the copied links; build workspace packages with `pnpm --filter <app>... run build` before real-window tests.
