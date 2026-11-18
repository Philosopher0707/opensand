# A new shared type builds everywhere but the coordinator

- **Trap:** Adding `ModelCallUsage` to `packages/shared/src/types.ts` and importing it from
  `packages/coordinator/src/llm-client.ts` compiled `@opensand/shared` cleanly, then failed the
  coordinator build with `Module './types.js' has no exported member 'ModelCallUsage'`.
- **Root Cause:** `packages/coordinator/src/types.ts` is a compatibility shim that re-exports shared
  types by an explicit name list, not `export *`. A type that is exported from shared is invisible
  through that shim until it is named there.
- **Rule:** When the coordinator needs a new shared type, add it to the explicit re-export list in
  `packages/coordinator/src/types.ts` in the same change, then build the coordinator
  (`pnpm --filter @opensand/coordinator build`), not only shared.
