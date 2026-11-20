# Parallel sessions — next steps (plan only, 2026-11-21)

**Status: PLAN. No source code changed in this pass.**
Baseline: `71dd7e5`, scorecard ≈ **74%**, reporting threshold **>90%**.
Reference: `reference-parity-port` skill + OpenMausBot `main` facts recorded in `docs/parallel-sessions-parity-plan.md`.
Rule: every phase has a checkable `done_when`; no phase claims parity until the whole scorecard is remeasured at the end.

## 0. Where we actually are

Done: per-session runtime + aborts + generation fences, per-agent admission cap/queue, event tagging, SSE filter/replay, per-session cancel, resume cursor persistence, process-group kill, shutdown disposal, hard delegation bound, `scripts/ship_phase.sh`.

Remaining, with evidence from the current tree:

| Gap | Today | Target | Concrete evidence |
|---|---:|---:|---|
| Idle engine reaping | 0 | 90 | runtime session maps have no `lastUsedAt`; turn timeout only rejects the promise (`claude-runtime.ts:~212`), children stay warm forever |
| Live CLI event forwarding | partial | 95 | shim yields one final chunk (`provider-llm.ts:69-75`); driver `onEvent` is unused except cursor capture; adapter events (`claude-runtime.ts:103-135`) are discarded |
| Real fake-CLI end-to-end proof | 85 | 95 | current tests use fake coordinators; no test spawns 3 real CLIs and asserts 3 live PIDs |
| UI for parallel sessions | 90 (backend) | 95 | renderer has one `currentAssistantMessage` (`app.js:~4911`) and `selectSession` resets the feed (`app.js:~4181`); cross-session events are now ignored, but there is no per-session buffer |
| Queue persistence | 0 | 90 | `SessionAdmission` queue is in-memory; a restart loses queued sends |
| Per-session HOME/cwd isolation | 0 | 90 | spawn env is `{...process.env, ...input.environment}`; per-instance HOME exists only for login (`device-auth.ts:19,62-64`) |

## 1. Phases (dependency order)

```
N0 automation ──┬─ N1 idle reaper ──────┐
                ├─ N2 live CLI events ──┼─ N3 fake-CLI E2E ─┬─ N4 UI/visual check ─┐
                ├─ N5 queue persistence ─┤                    └─ N6 session HOME ───┤
                └─ N7 final gate + scorecard + report ◄────────────────────────────┘
```
N1, N2 and N5 are independent; N3 needs both N1 and N2; N4 and N6 need N3.

### N0 — Make the ship receipt update the scorecard automatically
- Add `scripts/log_phase.py`: read the JSON receipt from `ship_phase.sh`, update the measured table in `docs/parallel-sessions-parity-plan.md`, append `date · what · cause · rule` to `AGENTS_LEARNING.md` when given `--lesson`, and print the updated total.
- Usage becomes `SHIP_PATHS=... bash scripts/ship_phase.sh "title" N1 | python3 scripts/log_phase.py --phase N1`.
- No new dependency (stdlib `json`/`re` only). Fail closed: if the receipt status is not `ok`, exit non-zero and change nothing.
- **done_when:** a dry-run receipt updates only the intended table cells and leaves the pre-existing lockfile edit and untracked design doc alone.

### N1 — Idle engine reaper
- Add `lastUsedAt: number` to `ClaudeSession` / `CodexSession` / `AcpSession` (`claude-runtime.ts:~30`, `codex-runtime.ts:~31`, `acp-runtime.ts:~45`); stamp it on every `sendTurn`.
- One `setInterval` per runtime instance (60 s tick, `unref()`), `IDLE_MS` env-tunable (default 10 min, 30 s for unwatched), closes sessions with `closeSession()` when `pendingTurn == null` and idle exceeded; clear the timer in `dispose()`/`stopAll()`.
- Never reap a session with a pending turn or an open permission request.
- **done_when:** with `IDLE_MS=100`, a fake-CLI child is reaped while an active one survives; no timer keeps the test process alive; `pnpm test` green.

### N2 — Live CLI events into the session stream
- Extend `DriverLlmClientInput` with `onDriverEvent?: (event: unknown) => void` (`provider-llm.ts:16-22`); the shim subscribes to `instance.adapter.onEvent()` and forwards events alongside the existing `onEngineSession` cursor callback.
- `ipc-bridge.ts`: pass a callback that maps driver events to `DesktopEvent`s tagged with the emitting session id via `emitEvent(..., sessionId)`. Start with `tool.call`, `tool.result`, `reasoning.delta`, `session.started`; **do not** forward `text.delta` until the renderer dedupe is proven (the final `turn_complete` already carries the answer).
- Keep a single unsubscribe per shim lifetime; no event is forwarded after `close()`.
- **done_when:** fake-CLI test proves a tool event reaches the SSE stream tagged with the right `sessionId` before `turn_complete`, and a second session's tool event does not leak into the first.

### N3 — Hermetic fake-CLI end-to-end proof
- One self-contained test in `packages/desktop/test/` that writes three executable fake CLI scripts into a temp dir, points three provider instances at them, and drives real `POST /api/query` calls against a live `DesktopServer` (port 0, hermetic `HOME`).
- Assertions: 3 concurrent child PIDs for one agent; 3 interleaved token streams with distinct `sessionId`s; `/api/events?sessionId=X` shows only X; stop on X kills X's child and leaves the other two; second turn on X spawns with the saved resume cursor.
- This replaces "fake coordinator" evidence with protocol-level evidence and is the gate for N4/N6.
- **done_when:** suite green with 3 real PIDs observed; no orphan PID after the test.

### N4 — UI for parallel sessions + live browser check
- Renderer: keep the single active chat pane (see decision D1), but replace the one `currentAssistantMessage` with a per-session buffer map keyed by `event.sessionId`; `selectSession` renders that buffer, and `session_started` from a non-active session must never change `currentSessionId`.
- Add a small activity badge per session in the session list driven by `session_started` / `turn_complete` events, using the SSE replay buffer for reconnect.
- Verify with the real Electron app: open two sessions, send in both, confirm both buffers grow independently and no token lands in the wrong one.
- **done_when:** a browser/DevTools check (or document why no browser pane was available) confirms two concurrent sessions with correct routing; no cross-session text.

### N5 — Queue persistence (optional, low priority)
- Append `send.queued` rows to the session's `event-log.jsonl` with a `queueId`; on bridge boot, rehydrate into `SessionAdmission` with the existing 20-send bound; drop rows after a successful drain (idempotent by `queueId`).
- **done_when:** restart with a queued send → it is drained after a slot frees; duplicate replay does not send twice. If skipped, the scorecard keeps queue at 90 and reports it as a gap.

### N6 — Per-session HOME/cwd isolation (highest risk, do last)
- Reuse the session folder `~/.opensand/sessions/<id>/engine-home` (mode 0700). In the three spawn helpers, set `HOME` and the provider config vars (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, `KIMI_CODE_HOME`, `XDG_CONFIG_HOME`, per OpenMausBot `engine-homes/layout.ts:55-66`) into it, and strip workspace credentials from child env.
- **Auth sync first:** OpenSand sign-ins live per provider instance (`device-auth.ts:19,62-64`). Copy only allowlisted auth files from that home into the session home on first spawn; never log contents. Feature flag `OPENSAND_SESSION_HOME=1`, default **off** until the sync test passes.
- Optional per-session `workspace` in `meta.json`, path-validated before becoming child `cwd`.
- **done_when:** with the flag on, two sessions of one provider have distinct HOME/config dirs and both still run a signed-in engine; cwd guard rejects paths outside the allowed root. If the sync cannot be proven, keep the flag off and report isolation as an explicit dated risk, never silently accepted.

### N7 — Final gate and report
- `HOME=/tmp/opensand-hermetic-home pnpm build && pnpm test` (the real-home `autoApprove: true` CLI failure is environmental — see `AGENTS_LEARNING.md:11.11`); stop the live app before the pre-commit gate; restart and curl root + a filtered SSE route.
- Remeasure every scorecard row with evidence, update `docs/parallel-sessions-parity-plan.md`, record learning, and report only if total >90% with exact commands, commit hashes, live URL and an explicit remaining list.

## 2. Decisions genuinely yours (recommended defaults, proceed unless you override)

- **D1 — UI scope (DECIDED 2026-11-21):** (b) true multi-pane **Parallel Board** — a grid of independent session panes, each with its own live stream, input and cancel. The earlier single-pane default was rejected by the owner. Implement N4 as a grid, not a session switcher.
- **D2 — Live text deltas:** forward only tool/permission/reasoning events in N2 (recommended, avoids duplicate text); full token streaming needs the N4 buffer and is a follow-up.
- **D3 — Queue persistence:** optional N5; in-memory queue reported as a gap if skipped.
- **D4 — Per-session HOME:** keep flag off until auth sync is proven. Turning it on before that breaks saved logins.

## 3. Risks to carry into the work
- `detached` children are group leaders on POSIX; a CLI that intentionally daemonises will die with its group (intended, but worth a note in the test).
- CLI protocol paths are large (26 drivers); a driver whose adapter emits different event names will silently lose live events in N2 — assert against each runtime family at least once.
- Real sign-in credentials are operator-supplied; N6 cannot prove them, only the sync mechanics.
- `file:line` references are from the current checkout and drift with edits; re-read before each phase.

Skipped in this pass: no implementation, no build/test (plan only). Risk: D1/D2 defaults could be wrong for your intended UX — say the word before N4 starts.
