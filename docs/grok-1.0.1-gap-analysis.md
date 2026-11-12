# Grok Bot 1.0.1 → OpenSand gap analysis

Compared against `main` at `69f0009`, using the v1.0.1 static teardown in
`grokbot-teardown/ARCHITECTURE.md` (evidence IDs `ev_8c99ed…`, `ev_822643…`). Read-only analysis:
no Grok Bot code is copied here; every item is either already built independently or described as a
behaviour to implement.

## Already covered

| Grok Bot 1.0.1 mechanism | OpenSand today | Evidence |
| --- | --- | --- |
| Typed tool results: `*Result` / `*Error` messages instead of strings | `ToolExecutionResult {status: ok \| error \| permission_pending, error.code}` | `packages/shared/src/types.ts:30` |
| Per-call approval with `needsApproval` / rejection | `permission_pending` + `approvalId`, standing allowlist, chaining rejection | `packages/local-exec-daemon/src/tool-registry.ts:455`, `daemon.ts:157` |
| Policy engine with allow / deny / require-approval ordering | deny → approval → allow → default, with audit log and presets | `packages/local-exec-daemon/src/policy-engine.ts:118` |
| OS sandbox profiles, network denied by default | `read-only` / `workspace-write` / `full`, `(deny network*)` unless `allowNetwork` | `packages/local-exec-daemon/src/sandbox/macos-profile.ts:55` |
| Workspace containment (`PATH_OUTSIDE_WORKSPACE`) | `resolveAndValidatePath` blocks traversal before file ops | `packages/local-exec-daemon/src/file-ops.ts:38` |
| Interactive stdin (`stdin_ready`, `WRITE_SHELL_STDIN`) | PTY sessions: spawn / write / read / kill | `packages/local-exec-daemon/src/pty-*.ts` |
| Claude-Code-shaped hooks (`PreToolUse`, `PostToolUse`, `SubagentStart`, `Stop`) | same names, with permission/user_message/updated_input results | `packages/coordinator/src/hooks.ts:8` |
| Daemon supervision: state file, generation, heartbeat, supervisor pulse | `LocalExecDaemon` state manager with 5 s heartbeat | `packages/local-exec-daemon/src/daemon.ts:34`, `state-manager.ts` |
| Turn cancellation (`ExecServerAbort`) | **added in this change** (see below) | `command-runner.ts` |
| Subagent await timeout as a result (`SubagentAwaitStillRunning`) | **added in this change** (see below) | `orchestrator-tools.ts` |

## Implemented in this change

### 1. Cancelling a turn kills the running command

Grok Bot aborts a long tool call mid-stream (`ExecServerAbort`). Before this change OpenSand checked
`signal` only between model steps, so `exec_command` kept running to its timeout after the user
cancelled.

- `ToolExecutionContext.signal` — `packages/local-exec-daemon/src/tool-registry.ts`
- `runCommandOperation(input, { signal })` kills the child (SIGTERM, then SIGKILL after 2 s) and
  resolves with `aborted: true`; engages before spawn when already aborted —
  `packages/local-exec-daemon/src/command-runner.ts`
- Turn signal forwarded at both tool-execution sites — `packages/coordinator/src/coordinator.ts:408,451`
- Tests: `command-runner.test.ts` — "kills a running command when the turn is cancelled" and
  "does not spawn when the signal is already aborted".

### 2. Non-blocking delegation and `await_agent`

Grok Bot's `TASK_V2` / `AWAIT_TASK` pair treats a timeout as `still_running`, not an error, and lets
several children run at once. OpenSand's `delegate_to_agent` blocked until the child finished.

- `delegate_to_agent` accepts `background` and `timeout_ms`; on timeout it returns
  `{status: "still_running", subagent.sessionId}` and the child keeps working.
- New `await_agent` tool returns `completed` / `failed` / `still_running` / `not_found`.
- Delegations live in a per-registry map; a background promise never surfaces an unhandled rejection.
- Test: `agent-store.test.ts` — "delegate_to_agent timeout returns still_running, and await_agent
  collects the result" (mock endpoint answers after 250 ms, delegation timeout 50 ms).

Verification: `pnpm --filter @opensand/local-exec-daemon test` → 87 pass;
`pnpm --filter @opensand/coordinator test` → 203 pass before the new test, 204 after.

## Still open, ranked by value / effort (status 2026-11-12)

1. **Sandbox denials as data. Done.** `ExecCommandOutput.sandboxDenials: SandboxDenial[]`
   (`{ kind: "file" | "network", path?, detail }`), parsed from stderr by
   `local-exec-daemon/src/sandbox/denials.ts` and set only for sandboxed commands that failed.
   sandbox-exec prints nothing for a refused access, so the parser reads the formats programs
   actually print (bash/coreutils/git `x: Operation not permitted`, Python `PermissionError`, Node
   `EPERM`; on Linux, bubblewrap's `Read-only file system` / `EROFS`), resolves relative paths against the cwd, dedupes, and caps at 20. A DNS failure counts
   as a network denial only when the profile denied the network. Tests:
   `test/sandbox-denials.test.ts` (including a real sandboxed write outside the workspace).
2. **Denial reason taxonomy. Done**, as one cross-cutting field rather than per-family codes:
   `ToolExecutionResult.error.reason: DenialReason` (`shared/src/types.ts`) with
   `user_rejected | approval_required | policy | hook | not_authorized | workspace_escape |
   safety_gate`. Existing `code` strings are unchanged. Two failures that used to be a generic
   `EXECUTION_ERROR` now have their own codes: `PATH_OUTSIDE_WORKSPACE` and `SAFETY_GATE_BLOCKED`
   (`local-exec-daemon/src/denial-errors.ts`).
3. **Prose auto-run rules. Designed, not built:** `docs/design/prose-policy-rules.md`. Compile once
   at authoring time into ordinary `PolicyRule`s, dry-run against the audit log, save disabled
   until the user turns the rule on; no model at tool-call time. To be built when a user asks for it.
4. **Network allowlist / `networkPolicyStrict`. Will not build.** macOS `sandbox-exec` can allow or
   deny the whole network, not filter by hostname. A host allowlist would need a local proxy that
   every tool honours, and a tool can simply skip the proxy. The boolean `allowNetwork` stays, and
   the limit is documented here rather than faked.
5. **Agent store etag / lock / tombstones. Not needed.** The event log and single-writer session
   lock cover the local case; revisit only if stores sync across machines.
6. **Context cache keyed by pinned tree SHA. Out of scope.** A retrieval feature, not tool parity.

## Limits of this analysis

- The v1.0.1 side is static evidence only; runtime ordering (e.g. whether abort is delivered before or
  after the child's exit) is inferred.
- Tool counts and names differ by design; parity was judged per mechanism, not per message schema.
- Everything above is behaviour-level. No Grok Bot implementation detail (identifiers, prompt text,
  protocol bytes) was transplanted.
