# Donor `node_modules` symlinks make workspace imports resolve in the donor, not the worktree

- **Trap:** A fresh worktree had no `node_modules`, so its `node_modules` and each package's `node_modules` were symlinked from a recent sibling worktree. `pnpm -r run build` then failed everywhere with `Cannot find module '@opensand/shared'`, even after `shared` reported `Done`.
- **Root Cause:** pnpm's workspace links are relative (`@opensand/shared -> ../../../shared`). Following a symlinked `node_modules` directory resolves those links against the donor tree, whose packages have no `dist`, so TypeScript read the donor's package metadata instead of this worktree's freshly built output.
- **Rule:** Restore dependencies in a fresh worktree with `pnpm install --offline --frozen-lockfile` (the pnpm store is local). Never symlink a whole `node_modules` directory from another worktree when the build must type-check workspace packages.
