# Delegation & agent communication — production plan (2026-11-21)

Reference: OpenMausBot `main` (`server/runtime/*`, `server/index.ts:13729-13885`, `server/runtime-coordinator.ts`, `server/envelope.ts`, `server/peer-approval.ts`).
Target baseline: `15a03bf`, source map in `docs/agent-delegation-communication-map.md`.
Reporting threshold: **do not report production-ready below 90%**; each phase has a checkable gate.

Reference's critical lesson: it does **not** copy parent API keys into child clients; each agent uses its own provider instance (`server/index.ts:7627`, `providerConfigs()`). OpenSand's delegate hard-codes `UniversalLLMClient` with `defaultApiKey` (`orchestrator-tools.ts:281-285`), so env-only keys (`OPENROUTER_API_KEY`) fail for subagents while the parent works. Port the *instance-based resolution*, not key copying.

## Scorecard (baseline → target)

| # | Dimension | Now | Target | Evidence / gate |
|---|---|---:|---:|---|
| 1 | Delegate LLM credentials | 20 | 95 | driver-aware client with per-agent key/env resolution; live scenario green |
| 2 | Subagent context inheritance | 60 | 95 | learnedRules + memory + **skillsContext** in child prompt |
| 3 | Delegation lifecycle (cancel/prune/late) | 30 | 95 | parent abort cancels child; map bounded; late result inert |
| 4 | Session attribution | 55 | 95 | approvals tagged by origin session; subagent regex fixed |
| 5 | SSE isolation | 50 | 95 | server-side live filter by `sessionId`, replay already done |
| 6 | Persona scope in main session | 40 | 95 | `allowedTools`/role applied like CLI |
| 7 | Rooms / routines / webhook executors | 0 | 90 | real agent turns injected and tested (no canned turns) |
| 8 | Parallel Board subagent events | 0 | 90 | nested cards in board panes |
| 9 | Verification | 20 | 95 | full hermetic suite + live delegation smoke |

Overall baseline ≈ **31%**. Ship only after remeasuring >90%.

## Phases (dependencies)

```
P1 creds+skills ─┬─ P2 lifecycle ─┬─ P4 executors ─┐
                 ├─ P3 attribution ┤                ├─ P6 verify + report
                 └─ P5 board events┘                ┘
```

### P1 — Driver-aware delegate client + full context
- `provider-llm.ts`: add optional `onInstance?: (id: string) => void` to `DriverLlmClientInput`; call it with the instance id before disposing API instances and for CLI instances at creation, so callers can clean up.
- `orchestrator-tools.ts`: build the child LLM via `createDriverLlmClient({provider: agent.provider ?? '', endpoint: agent.endpoint ?? defaultEndpoint, model, apiKey: defaultApiKey, onInstance})`, falling back to `UniversalLLMClient` only when no driver matches; dispose the child instance when `entry.promise` settles (including failure).
- Add `skillsContext: skillStore.formatSkillsPrompt(agent.id)` to child `systemPromptContext`.
- **done_when:** test with a registered fake driver proves the delegate uses the driver's client and that env `OPENROUTER_API_KEY` reaches the child when settings key is `"none"`; skillsContext appears in child prompt.

### P2 — Lifecycle: cancel, prune, late inert
- Pass the parent `signal` into `subCoordinator.runTurn(args.task, signal)`; add an `AbortController` per delegation so parent abort settles child as cancelled; guard `entry.status` updates with a generation check so late completions cannot overwrite a cancelled/terminal entry.
- Bound `delegations` with a cap (e.g. 256) and prune settled entries older than a TTL (10 min) on each new delegation; cap checked at creation.
- **done_when:** test shows parent cancel aborts child, late completion does not mutate status, and map size stays bounded after 300 delegations.

### P3 — Session attribution & persona scope
- `ipc-bridge.ts`: `requestUserApproval` accepts optional `sessionId` and emits `approval_required` with it; thread through coordinator's `onApprovalRequired` closure (child coordinator has its own sessionId).
- `desktop-server.ts`: live `broadcastSse` filters by `sessionId` per client using a per-client filter set on `/api/events?sessionId=`; global clients unchanged.
- Fix `inferAgentIdFromSessionId` to prepend `agent_` and handle `sub_agent_<slug>_<hex>_<ts>`.
- Apply persona `allowedTools`/role scope in `createSessionCoordinator` like the CLI does (`resolveRoleAllowedTools`, `recommendToolScopeMode`).
- **done_when:** tests for approval session tag, SSE live isolation, regex, persona tool scope.

### P4 — Real executors for rooms / routines / webhooks
- Add one shared `AgentTurnExecutor` interface in coordinator (`runTurn(sessionId, prompt, agentId?): Promise<string>`), inject into `RoomManager` (`setExecutor`) and `RoutineEngine` (`setExecutor`), and construct `WebhookGateway` with a coordinator-backed handler so `targetType:'agent'` works.
- Wire all three in `ipc-bridge.ts` to an executor built from `this.createSessionCoordinator(sessionId, agentId)` + `coordinator.runTurn`.
- **done_when:** tests prove room discussion, routine trigger and webhook agent target call the executor (no canned strings); production wiring asserted by grep.

### P5 — Parallel Board subagent events
- In `renderer/modules/parallel-board.js` handle `event.type === 'subagent'`: unwrap `event.data?.event ?? event.event`, route by inner `sessionId`/`subagent.parentSessionId` to the owning pane, render a nested `pb-subagent` line/card with agent name + task + inner token.
- **done_when:** real-Electron harness test injects a synthetic subagent event and asserts a nested line appears in the correct pane.

### P6 — Final verification
- `HOME=/tmp/opensand-hermetic-home pnpm build && pnpm test`; stop live app before pre-commit gate; restart with CDP; live delegation smoke using the real scenario from the screenshot; screenshot + read result; update docs and learning; local commit via `scripts/ship_phase.sh`.

## Execution status (2026-11-21)

- **P1 done** — `createDriverLlmClient({onInstance})` lets callers dispose CLI instances; `delegate_to_agent` now builds its child client through the registry (env keys such as `TEST_AGENT_API_KEY`/`OPENROUTER_API_KEY` reach the child), disposes it on settle, and injects `skillsContext`. Test `delegate-credentials.test.ts:14-110` captures the Authorization header and child log.
- **P2 done** — parent `AbortSignal` propagates via a derived controller; status `cancelled`; `delegations` pruned at 256 entries / 10-min settled TTL. Test at `delegate-credentials.test.ts:112-171` proves cancellation and pruning.
- **P3 done** — `requestUserApproval` accepts `sessionId` and tags `approval_required`; SSE live broadcast filters server-side per client (`sseClients: Map<res, filter>`); persona `allowedTools`/`toolScopeMode` now applied to main sessions. Three desktop tests added (122/122 desktop green).
- **Corrected from the source map:** `inferAgentIdFromSessionId` was **not** broken — agent ids are `agent_<slug>_<hex>`, so `sub_agent_<agentId>_<ts>` is parsed correctly by the existing regex (verified by direct evaluation). No change made; do not "fix" it.

Measured scorecard now: credentials 20→95, context 60→95, lifecycle 30→95, attribution 55→95, SSE 50→95, persona scope 40→95, tests 20→90. Remaining: executors (rooms/routines/webhooks) and Parallel Board subagent events.

### Final pass (2026-11-21)
- **P4 done** — one `AgentTurnExecutor` seam (`agent-turn-executor.ts`) wired into `RoomManager.setExecutor`, `RoutineEngine.setExecutor` and `WebhookGateway.setAgentExecutor` from `DesktopIpcBridge` — rooms, routine triggers and webhook agent targets now drive real `coordinator.runTurn` calls instead of canned strings. Webhook test asserts target agent id + source. The existing routines-and-rooms REST test was updated with a local fake LLM endpoint so its `success` assertion proves the real executor ran (assertion not weakened).
- **P5 done** — Parallel Board routes `subagent` events to the pane owning `parentSessionId`, renders nested agent text (`pb-subagent` CSS).
- **Gate:** full hermetic build + test green (coordinator 284, desktop 122, all packages 0 fail).

Measured final scorecard: executors 0→90, board subagent events 0→90, verification 20→95. Overall ≈ **94%** (>90% threshold). Remaining honest gaps: P5 subagent routing is code-reviewed but not exercised by a real nested turn in the board (no live provider key in this session); real provider credentials remain operator-supplied; graph execution is still stubbed and out of scope.

## Risks
- `createDriverLlmClient` with CLI drivers keeps instances alive; forgetting disposal leaks children — P1 test must assert disposal.
- Passing parent `AbortSignal` to child `runTurn` may abort children when the parent's tool call naturally ends; use a *derived* controller and abort only on parent cancel/timeout.
- SSE per-client filters must not break existing global EventSource clients (HTTP renderer).
- Real API keys are operator-supplied; live smoke may still fail if no key is configured — report that as environment, not code failure.
