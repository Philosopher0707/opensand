# Parallel-session functioning — design & parity plan (2026-11-20)

**Status: DESIGN ONLY — no source code changed in this pass.**
Reference: OpenMausBot `main` (`/Users/philosopher/active/workspace/OpenMausBot`).
Target: OpenSand `feat/agent-settings-ui` at `958f63f`.
Method: `reference-parity-port` skill — reference facts and target gaps are read from source with `file:line`, not from docs or comments.

## 0. Scope decision (read this first)

"Parallel session" in OpenMausBot does **not** mean one CLI process shared by many chats. The parallel unit is a **thread** of a bot: one conversation, one live engine child process, one cwd, one set of IPC sockets, one resume cursor. Multiple threads of the same bot run at the same time, bounded by a per-bot cap. `SessionRegistry` (`server/sessions.ts:222`) is *auth only* — unrelated.

OpenSand's nearest equivalent to a bot thread is a **chat session** (`~/.opensand/sessions/<id>/`, `meta.json`, `event-log.jsonl`). So this design ports thread semantics onto OpenSand chat sessions: **several chat sessions may have in-flight turns at once; each owns its coordinator, abort controller, engine child, event stream and resume cursor.** It does not add bots, rooms, or a new session type.

Non-goal inherited from the reference: subagents are **not** first-class parallel sessions there (all engines report `subagents: false`, `server/runtime/capabilities.ts:55-64`, and Claude subagent narration is dropped at `server/drivers/claude.ts:1491-1494`). OpenSand's `delegate_to_agent` already goes further; we keep it but bound it (§8).

## 1. Parity scorecard (current → target)

Report threshold: **do not report parity as achieved below 90%**. Each dimension 0–100%.

| # | Dimension | Now | Target | Evidence / gate |
|---|---|---:|---:|---|
| 1 | Per-session state ownership (no global turn slot) | 40 | 100 | `coordinatorMap` exists but four globals win: `ipc-bridge.ts:102-110`; no concurrent-turn test |
| 2 | One engine child per session, reusable across turns | 30 | 95 | runtimes have `Map<threadId, Session>` (`claude-runtime.ts:58`, `codex-runtime.ts:63`, `acp-runtime.ts:72`) but the chat shim pins one random thread id (`provider-llm.ts:49`) created once per coordinator (`ipc-bridge.ts:554`) |
| 3 | Concurrency cap + admission/queue | 0 | 95 | `engineAdmission?` is declared at `shared/types.ts:611` and never called; `capabilities.queueing` is metadata only |
| 4 | `sessionId`+`turnId` event tagging, SSE filter + replay | 20 | 95 | driver events carry `threadId` (`claude-runtime.ts:103`), but the shim drops them (`provider-llm.ts:47-78`); `DesktopEvent.sessionId` comes from a global (`ipc-bridge.ts:425-433`); one unfiltered SSE stream (`desktop-server.ts:273-282,381-394`) |
| 5 | Engine resume-cursor persistence | 25 | 95 | type + driver support (`shared/types.ts:608`, `claude-runtime.ts:152`, `acp-runtime.ts:226`, `codex-runtime.ts:221`) but the app path never supplies or saves it; `meta.json` has no cursor (`ipc-bridge.ts:490-505`) |
| 6 | Per-session cancel + process-tree kill + shutdown disposal | 35 | 95 | one global `AbortController` (`ipc-bridge.ts:110,665-698`); `interruptTurn` exists but unwired (`claude-runtime.ts:279-284`); direct-child SIGTERM only, no `detached`; no `disposeAll()` on quit (`main.ts:94-96`) |
| 7 | Idle child reaping | 0 | 90 | children live until exit; turn timeout only rejects the promise (`claude-runtime.ts:212-215`) |
| 8 | Bounded nested sessions | 50 | 95 | depth 3 gates streaming only (`coordinator.ts:496-500`); nested turns still run |
| 9 | Concurrency tests + live verification | 10 | 95 | `ipc-bridge.test.ts:448-471` proves two *coordinators*, not two concurrent turns; no SSE/replay/resume/reaper test |

**Overall today: ≈ 23%.** Target ≥ 90% before reporting done. The threshold is a gate, not a vibe — each phase has a checkable `done_when` below.

## 2. Reference mechanism → OpenSand mapping

| OpenMausBot mechanism | Reference (file:line) | OpenSand today (file:line) |
|---|---|---|
| Thread = parallel unit, `randomUUID()` | `contracts.ts:610`, `store.ts:2192` | session id `session_<ts>_<hex>` `ipc-bridge.ts:519`; `SessionSummary` `shared/types.ts:688-696` |
| Per-thread engine child, warm reuse | `procs.ts:193-239`, `claude.ts:1328,1367` | children in runtime maps, one per shim/client `provider-llm.ts:48-78` |
| Per-bot cap, RAM-derived, floor 3 / ceiling 16 | `bot-thread-limits.ts:6-24` | none |
| Admission decision before first `await` + generation fence | `admission.ts:94-159`, `index.ts:11692` | hook declared, never called `shared/types.ts:611` |
| Persisted queue + drain | `steer-queue.ts`, `bot-messages.ts:434` | none |
| Per-thread cwd + engine HOME/config remap, 0700 | `bot-cwd.ts:9-25`, `engine-homes.ts:28-109`, `layout.ts:55-121` | cwd `process.cwd()`/`config.workspace` `codex-runtime.ts:226`, `acp-runtime.ts:231`; per-instance HOME only for login `device-auth.ts:62-64` |
| Per-thread sockets, MCP config, tokens | `claude.ts:408-441,1254-1256,1306-1308` | none for chat turns |
| Events tagged `{threadId,turnId}`, one SSE, replay by `Last-Event-ID` | `claude.ts:955-961`, `index.ts:4743-4762,14826-14874` | tags dropped, no filter, no replay |
| Resume cursor captured on `session.started` and reused | `index.ts:6437-6440,8467-8468`, `resume-recovery.ts:16-45` | emitted by driver `claude-runtime.ts:103` but discarded |
| Interrupt → abort → process-tree kill, 5 s escalate | `bot-messages.ts:735-759`, `index.ts:2269-2285`, `procs.ts:207-212` | global abort; direct-child SIGTERM `claude-runtime.ts:81-88` |
| Idle reaper | `session-idle.ts:46-85` | none |
| Nested threads as ordinary rows with `parentId`, report composed back | `coordinator.ts:30-69`, `runtime-coordinator.ts:226-272,593-600` | `delegate_to_agent` `orchestrator-tools.ts:242-386` with parent event sink |

**What is genuinely reusable in OpenSand already** (no new abstractions needed): `coordinatorMap` (`ipc-bridge.ts:104`), `engineAdmission` on `SendTurnInput` (`shared/types.ts:611`), `resumeCursor` (`shared/types.ts:608`), adapter `onEvent`/`interruptTurn`/`enginePid`/`hasSession` (`shared/types.ts:574-581`), `providerRegistry.disposeAll()` (`provider-registry.ts:117-123`), `writeSessionMeta()` (`ipc-bridge.ts:490-505`), and the per-thread runtime maps. The work is mostly **removing global state and connecting existing seams**, not adding machinery.

## 3. Concurrency semantics

- Cap is **per agent** (`agentId`), the OpenSand analogue of "per bot": `maxConcurrentSessionsPerAgent`, default 3, ceiling 16, floor 1 (no plans/Starter clamp in OpenSand — do not invent one).
- Admission is a **decision made before the first `await`**, not a semaphore: count sessions of that agent with an in-flight turn, then start / steer / queue. A generation counter fences a Stop racing a dispatch (reference `index.ts:11692`).
- Queue is bounded (20 sends/session) and drained on child exit; overflow returns a typed `{ queued:false, reason:"capacity" }` and emits a user-visible event. In-memory in P2; disk persistence is P8 (optional) because sessions already have an append-only log.
- API-backed drivers (OpenRouter, Anthropic, OpenAI-compatible) have no child process; they are bounded by HTTP, not by the cap — **count only sessions with an engine child** for admission, matching the reference where the cap protects engine processes.
- Nested/delegated turns bypass the agent cap (they may be awaited by a parent turn), matching `maxConcurrentChildThreads` at reference `bot-thread-limits.ts:28-30`.

## 4. Design — concrete changes

No new dependency. Types go in `@opensand/shared`; state stays in the desktop bridge; the server stays plain `node:http`.

### P1 — One state owner (root fix)

Add `SessionRuntime` next to `SessionSummary` in `shared/src/types.ts`:

```ts
interface SessionRuntime {
  sessionId: string;
  agentId?: string;
  coordinator: AgentCoordinator;
  abort: AbortController;
  threadId?: string;      // engine child identity
  resumeCursor?: unknown; // last `session.started` id
  generation: number;     // Stop-vs-dispatch fence
  lastActive: number;
}
```

In `ipc-bridge.ts:102-110` replace `coordinator`, `activeAgentId`, `currentSessionId`, `activeAbortController` with `sessionRuntimes: Map<string, SessionRuntime>`, keyed as today by `${sessionId}:${agentId ?? 'default'}` (`:443-445`). Keep `getCoordinator()` as an alias to the most recently touched entry so existing callers (`desktop-server.ts:1655`) and tests (`ipc-bridge.test.ts:448-471`) keep working. `emitEvent()`/`dispatchTurnEvent()` (`:425,622-655`) take the emitting session id as a parameter — never read a global slot.

`sendQuery(query, sessionId, agentId)` (`:657-689`) and `cancelTurn(sessionId?)` (`:691-698`) use that entry's own `AbortController`. Double-submit then aborts only that session.

*Done when:* two simultaneous `sendQuery` calls with different session ids produce two live `runTurn` promises, distinct abort signals, and events tagged with the correct session id; `ipc-bridge.test.ts` still green.

### P2 — Admission + queue

Call the already-declared `engineAdmission(start, joining)` from `createSessionCoordinator`/`sendQuery` **before** the first `await` that spawns an engine child; increment generation on Stop. Implement the counter/queue in one small `session-admission.ts` module in `packages/desktop/src/` (pure function + bounded queue, unit-testable). Expose `threads.maxConcurrentPerAgent` in settings next to existing provider settings (no new config framework).

*Done when:* fake-CLI test with cap 2 and 3 sessions of one agent shows 2 live PIDs, the third queued, then drained on first exit; Stop does not kill the wrong turn.

### P3 — Engine child reuse + live streaming + resume

Extend `DriverLlmClientInput` (`provider-llm.ts:16-22`) with `threadId`, `resumeCursor`, `onEvent`, `onCursor`. `createTextStreamShim` (`:48-78`) uses the supplied thread id instead of `randomUUID()`, passes `resumeCursor`/`sessionReset` into `sendTurn` (`:62-68`), subscribes to `instance.adapter.onEvent()` instead of discarding events, and forwards `{type:"session.started", sessionId}` to `onCursor`. `createSessionCoordinator` persists the cursor into `meta.json` (`writeSessionMeta`, `:490-505`) and reuses the same `threadId` for the session's next turn.

*Done when:* a turn's `text.delta`/`tool.call` events reach the UI live (not one final chunk), and after restart the next turn calls the fake CLI with `--resume <cursor>` / `session/load` / `thread/resume`.

### P4 — Per-session isolation

Reuse the existing session folder: `<sessions>/<id>/engine-home` with mode `0700`; in the spawn helpers (`claude-runtime.ts:162-163`, `codex-runtime.ts:118-119`, `acp-runtime.ts:132-134`) set `HOME` and the provider config vars listed in reference `layout.ts:55-66` (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, `KIMI_CODE_HOME`, `XDG_CONFIG_HOME`, …) to that folder, and strip workspace credentials (`credential-env.ts:4` in the reference) from the child env. Derive any permission socket path from `threadId` rather than a global. Optional `workspace` in `meta.json` becomes the child `cwd`, path-validated.

**Auth gotcha (must handle, not skip):** OpenSand stores sign-ins per *provider instance* home (`device-auth.ts:62-64`). Moving engine HOME per session would force a re-login in every new session unless sign-in state is synced into the session home (reference does this in `engine-homes.ts:54-69` via `forSpawn()`). Decision: default per-session HOME **off** until the sync exists; enable it per provider when the sync test passes. Recommended default is documented as an explicit dated risk, never silent.

*Done when:* with the flag on, two sessions of the same provider have different `HOME`/config dirs and both still have a working signed-in engine; cwd guard rejects a path outside the allowed root.

### P5 — Event multiplexing, SSE filter/replay, renderer routing

- Add `turnId` to `TurnEvent`/`DesktopEvent` (`shared/types.ts:373-383,712-718`) where the driver supplies it (Codex already tracks it, `codex-runtime.ts:261`).
- `desktop-server.ts`: per-session bounded ring buffer (500 events) in the bridge; `GET /api/events?sessionId=<id>&after=<seq>` filters and replays; bare `/api/events` unchanged for compatibility (`broadcastSse` `:273-282`, route `:381-394`).
- Renderer `app.js:5072-5099`: append token/tool events to the buffer of `event.sessionId`, not to one `currentAssistantMessage`; stop switching global session on `session_started`. Keep `activeSessionId` for display only. Subagent cards key off `parentSessionId` (already present in `orchestrator-tools.ts:308-329`).
- Per-session cancel: `POST /api/cancel` accepts `{sessionId}` (`desktop-server.ts:412-418`), threaded through `main.ts:183`, `preload.cts:33-34`, `app.js:175-185`.

*Done when:* SSE with `sessionId` returns only that session's events and replays after `after`; two concurrent sessions' tokens land in two separate message lists; cancel stops only the named session.

### P6 — Cancellation, reaping, nested bound

On cancel/delete: bump generation, abort that session's controller, call `adapter.interruptTurn(threadId)`, then 5 s stdin-end grace before SIGKILL. Add `detached: true` at the three spawn sites and kill the process group (`process.kill(-pid)`), despite the ponytail rule — this is the reference's correctness requirement, not speculative hardening. On app quit call `providerRegistry.disposeAll()` (`main.ts:94-96` → `desktop-server.ts:245-270` → `ipc-bridge.ts:227-254`). One `setInterval` reaper (60 s tick, 10 min idle, 30 s for unwatched sessions), cleared on `close()`. Enforce `MAX_DELEGATION_DEPTH = 3` as a hard refusal (not just a streaming gate, `coordinator.ts:496-500`).

*Done when:* Stop-isolates-one test with real child PIDs; quit leaves zero engine children; reaper closes one idle child and leaves an active one; depth-4 delegation returns a refusal.

### P7 — Verify and ship

`pnpm build` + `pnpm test` until all packages green; stop the live Electron app before the pre-commit gate (known flaky `window-harness` test, `AGENTS_LEARNING.md:191-194`); use `OPENSAND_ALLOW_BLANKET=1` rather than `--no-verify` if the blanket guard misfires on the deliberately unstaged `pnpm-lock.yaml`; stage only explicit paths, leaving the pre-existing lockfile edit and `docs/design/opensand-next.md` untouched; local commit only. Append `date · what happened · cause · rule now` to `AGENTS_LEARNING.md` and `~/SKILLS/LESSONS.md`; update this doc's scorecard with measured values.

### P8 — Optional (only if time permits)

Persist the admission queue to the session's `event-log.jsonl` so queued sends survive restart, matching `steer-queue.ts`. This is the one reference capability deliberately deferred; report it as a gap if not done.

## 5. Phase dependencies

```
P0 design (this doc)
 └─ P1 state owner ──┬─ P2 admission/queue ──┬─ P6 cancel/reap/bound ──┐
                    ├─ P3 child+resume ──────┤                        ├─ P7 verify+commit
                    ├─ P4 isolation (needs P3; auth-sync decision) ────┤
                    └─ P5 SSE+renderer (needs P1) ─────────────────────┘
```

P2, P3, P4 and P5 touch different seams; they can be built in that order but each must have its own test and small commit. No phase changes another phase's files without a note.

## 6. Tests (fake CLIs, not config shape)

Per the skill: assert spawn argv, handshake/method order, id correlation, completion, permission answers and streamed text with self-contained executable scripts in a temp dir.

1. **3-session parallelism** — 3 sessions, one agent, cap 4 → 3 live fake-CLI PIDs and 3 interleaved token streams with distinct `sessionId`s.
2. **Cap + queue** — cap 2 → third queued, drained on exit; overflow bounded.
3. **Stop isolation** — stop session A while B runs → only A's child dies; generation fence blocks a late dispatch.
4. **Event routing + replay** — SSE filter by `sessionId`, `after=<seq>` replay, no cross-session leakage; renderer buffers separate (DOM/state assertion in a jsdom-free unit of the buffer function).
5. **Resume** — after `session.started` cursor is saved to `meta.json`; new coordinator spawns with `--resume`/`session/load`/`thread/resume`.
6. **Isolation** — distinct per-session HOME env values; credentials stripped; auth-sync works when flag on.
7. **Reaper / quit / nested bound** — idle child closed, active child kept; no orphan PIDs after quit; depth-4 refusal.

Never weaken an assertion to get green. If the Electron `window-harness` test flakes, rerun in isolation with the app stopped and say so — do not bypass.

## 7. Risks / explicit non-goals

- **No code was changed or tested in this pass.** All `file:line` references are from the current checkout and drift with edits; re-verify at implementation time.
- The reference itself is a moving repo (`main` at `516ca7598`); pins are to what was read today, not to a stamped tag.
- Per-session HOME is off by default until auth sync is proven — until then parity on isolation dimension 4 stays partial and the scorecard must say so.
- Streaming from CLI drivers currently yields one final chunk (`provider-llm.ts:69-75`); P3 changes that path, so a driver whose `sendTurn` ignores `resumeCursor` would silently lose resume parity — the resume test must cover each runtime family (Claude, Codex, ACP) at least once.
- No worktrees per session (reference has none); no new bot/thread model; no cross-process global concurrency primitive; no tool-result injection into CLI turns (neither codebase has that wire — see `docs/provider-parity-plan.md` residual pass).
- A real "self-improvement" loop (SIM) runs at session start (`ipc-bridge.ts:567-583`); if many sessions start at once it will run many SIM cycles. P2 admission must cover session creation, not only turns, or parallel starts will stampede the memory store.

## 8. Open decisions (recommended defaults; say the word to change)

1. **Cap default** — 3 per agent, ceiling 16, no plan clamp. (Reference derives from RAM; OpenSand is local-first, so a fixed 3 is simpler and safe.)
2. **Per-session HOME** — off until sign-in sync is implemented and tested; then on for CLI drivers only. (Avoids breaking saved logins.)
3. **Queue persistence** — P8 optional; in-memory queue is acceptable for v1 if reported as a gap.
4. **Session creation concurrency** — include `runSIMCycle` under the same cap (recommended) to avoid memory-store stampede.

## Implementation status (2026-11-20, first build pass)

Delivered in this pass (local commit via `scripts/ship_phase.sh`):
- **P1** — `SessionRuntimeRegistry` + per-session abort and generation fence in `DesktopIpcBridge`; events tagged from the emitting coordinator; focused-session globals kept only as compatibility aliases for single-session APIs.
- **P2** — `SessionAdmission`: per-agent cap (default 3, ceiling 16, env-tunable), bounded FIFO queue (default 20), synchronous admission before coordinator work, slot keyed by session so re-submits do not double-release.
- **P3 (partial)** — stable `threadId` / `resumeCursor` passed through `createDriverLlmClient` and persisted in `meta.json`; engine `session.started` callback saves the new cursor. Live CLI event streaming is **not** forwarded yet.
- **P5** — `GET /api/events?sessionId=&after=` filters and replays from a bounded 500-event per-session buffer; bare route unchanged; per-session `POST /api/cancel`; renderer ignores events from a different open session.
- **P6 (partial)** — per-session cancel aborts only that session; queued sends for it are removed. Process-group kill, idle reaper and hard delegation depth bound are **not** done.
- **Automation** — `scripts/ship_phase.sh` runs build + full test + staged secret scan + explicit-path staging + commit and emits a JSON receipt.

Measured scorecard after this pass (honest, below the 90% reporting threshold):

| Dimension | Before | Now | Remaining gap |
|---|---:|---:|---|
| Per-session state ownership | 40 | 90 | focused globals still serve single-session APIs |
| Child per session + reuse | 30 | 70 | thread id/cursor reused; no live CLI event forwarding, API sessions have no child |
| Cap + admission/queue | 0 | 95 | queue is in-memory only |
| Event tagging + SSE | 20 | 90 | renderer still has one chat pane, not a per-session view |
| Resume cursor persistence | 25 | 75 | not verified against a real CLI in this pass |
| Cancel + kill | 35 | 55 | no process-group kill or provider disposal on quit |
| Idle reaping | 0 | 0 | none |
| Nested bound | 50 | 50 | unchanged |
| Concurrency tests | 10 | 85 | fake-coordinator + SSE tests, no real fake-CLI spawn test |

**Overall ≈ 68%.** Do not call this parity complete. Next pass: P6 kill/reaper/delegation bound, P3 live CLI events, P4 isolation (auth sync first), then fake-CLI end-to-end proof and a live two-session browser check.

## Implementation status (2026-11-21, cleanup pass)

- **P6 (mostly done)** — `proc-tree.ts`: POSIX children are spawned `detached` and killed as a process group (SIGTERM, 5 s SIGKILL escalation); Windows falls back to the direct child. `DesktopIpcBridge.close()` now calls `providerRegistry.disposeAll()` so CLI children do not survive app quit. `delegate_to_agent` beyond depth 3 is refused and the refusal is materialized in the transcript instead of silently running an unbounded child.
- **Tests** — `proc-tree-and-depth.test.ts`: real child+grandchild group kill and a depth-4 refusal through the coordinator's actual tool execution path.
- **Gate quirk (observed)** — the CLI `defaults to standard environment` test reads the real `~/.opensand/config.json`; with the user's `autoApprove: true` it fails (`true !== false`). Full suite is green with `HOME=/tmp/opensand-hermetic-home` (all packages, 0 fail). This is environmental and pre-existing; the test was not weakened.

Updated scorecard: cancel/kill 55 → **75** (idle reaper still missing); nested bound 50 → **95**; concurrency tests 85 → **90**. **Overall ≈ 74%.** Still below the 90% reporting threshold. Remaining: idle reaper, live CLI event forwarding, per-session HOME isolation (auth sync first), and a real two-session browser check.
