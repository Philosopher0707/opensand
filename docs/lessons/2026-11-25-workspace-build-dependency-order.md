# Build workspace dependencies before a leaf package

## Notes

- **Trap:** Building `@opensand/coordinator` immediately after installing a clean worktree failed with a cascade of unresolved workspace imports.

- **Root Cause:** The dependent packages' `dist` declarations had not been generated in the fresh worktree; pnpm installation alone does not build workspace packages.

- **Rule:** Build workspace dependencies in graph order before the touched package's baseline type check, or use the repository's dependency-aware recursive build.
