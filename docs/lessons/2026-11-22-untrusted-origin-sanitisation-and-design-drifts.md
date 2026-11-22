# Untrusted origin sanitisation strips path slashes to underscores

- **Trap:** Expecting `origin` in `<data_source type="file" origin="...">` to preserve nested directory slashes (e.g. `repo:packages/coordinator/AGENTS.md`) as drafted in design doc §2.3 causes test assertions to fail.
- **Root Cause:** `sanitiseOrigin` in `packages/shared/src/untrusted-text.ts` replaces characters outside `[A-Za-z0-9_.:-]` with `_`, so path separators `/` are sanitised to `_` (producing `repo:packages_coordinator_AGENTS.md`). Additionally, design doc §7.1 included modifying `inspector-model.ts`, which is off-limits in Step 1 scope.
- **Rule:** Always verify against real runtime behaviour of `sanitiseOrigin` when checking origin attributes. Follow verified codebase boundaries over speculative design drafts.
