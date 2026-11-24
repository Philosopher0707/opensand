# OS sandbox-hold tests must assert the platform's real behavior

- **Trap:** A fakes-only test for held engines expected `TRY_WRITE:EPERM` (the macOS sandbox denial) and passed locally on macOS, but failed Linux CI with `TRY_WRITE:ok`, breaking four stacked PRs.
- **Root Cause:** `agent_wrap.mjs` only wraps a read-only run in `sandbox-exec` on macOS when that binary exists; elsewhere plan mode relies on the engine's own advisory flags. The test asserted one platform's outcome unconditionally.
- **Rule:** When a behavior is platform-gated, assert both outcomes: `EPERM` when `process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")`, otherwise the engine's advisory result. Fixed in `packages/coordinator/test/external-engine-slices.test.ts` (`osHold.held` / `osHold.advisory`).
