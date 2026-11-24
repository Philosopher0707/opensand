# Agent-UX gaps 1–5: build-ready design

Status: design only. All refs are on `origin/main` at `983d6a3` (2026-11-24). Source material:
`agentic-application-design-research.md`, `agentic-systems-and-ux-architecture.md`, and the
2026-11-24 gap analysis. Scope is gaps 1–5 only; gaps 6–12 stay open (see §7).

## 1. Where OpenSand lags (whole-system verdict)

The harness is strong: bounded loop, phase events, stall detection, capability gates, epoch-checked
approvals, append-only transcripts, partial-output timeouts. The UI is the weak surface: it *has*
the stream, tool cards, thought accordion and split canvas, but it throws away two things the
harness already emits — the approval payload (`chat-turn-model.ts:321` drops it) and any sense of
time (`Chat.tsx` has no clock, no "no output for Ns", no retry visibility). The result is a user
who is told "Waiting for your approval in the Inbox" (`Chat.tsx:132`) and cannot see, edit, or time
what the agent is doing. Three of the five gaps are **plumbing, not new machinery**: the events
and endpoints mostly exist; they are unwired to the renderer. Fix the wire before adding features.

Priority: (1+2) approval in-chat and editable → (4) every wait visible → (3) steer → (5)
same-error stop. Item 5 is a small core guard; it is last only because it needs no UI redesign.

## 2. Shared event/type additions (one-time, both core PRs)

`packages/shared/src/types.ts` — extend `TurnEvent` (167–179) and `DesktopEventType` (262–274):

```ts
type WaitKind = "model" | "tool" | "approval" | "compaction" | "rate_limit";
type TurnEvent =
  | /* …existing… */
  | { type: "wait_started"; waitId: string; kind: WaitKind; label: string; startedAt: number }
  | { type: "wait_ended"; waitId: string; endedAt: number }
  | { type: "retry_scheduled"; waitId: string; attempt: number; maxRetries: number;
      delayMs: number; status?: number }
  | { type: "steer_injected"; message: string; atIteration: number }
  | { type: "circuit_open"; toolName: string; errorHash: string; message: string };
```
`DesktopEventType` gains `'wait_started' | 'wait_ended' | 'retry_scheduled' | 'steer_injected' |
'circuit_open' | 'approval_resolved'`; `DesktopEvent` (276–282) is unchanged (typed `data`).
`approval_resolved` is already listened for at `renderer-next/src/data.ts:250` but never emitted —
this makes that listener real. Bridge forwarding stays in `ipc-bridge.ts:dispatchTurnEvent`
(740–780); add one `else if` branch per new type. No new IPC transport is needed: `bridge.on('event')`
→ SSE at `desktop-server.ts:128–130` → `data.ts:onTurnEvent` (121) already carries any event.

## 3. Gap 1+2 — inline, editable approval card

**What exists:** `approval_required` is emitted with the full `ToolApprovalRequest`
(`desktop/src/types.ts:9–19`) at `ipc-bridge.ts:956`; the queue endpoints are `desktop-server.ts:420–444`;
the renderer already has `approveTool` (with epoch) and `opensand:approvals_changed` (`data.ts:213–221,
243–263`). The chat reducer reduces the event to `{ type: "approval" }` and loses the payload
(`chat-turn-model.ts:64,321`), so the only visible text is `Chat.tsx:132`.

**Shapes:** extend `ChatTurnState` (`chat-turn-model.ts:40–47`) with `approval?: ToolApprovalRequest |
null`; change the action at :64 to `{ type: "approval"; request: ToolApprovalRequest | null }`.
Extend `ApprovalDecision` (`desktop/src/types.ts:32–36`) with
`action: 'approve_once'|'always_allow'|'reject'|'approve_modified'` and
`modifiedArgs?: Record<string, unknown>`. Add `approval_resolved` data
`{ approvalId: string; action: ApprovalDecision['action'] }`.

**Change points:** `chatEventAction` (`chat-turn-model.ts:321`) carries `event.data` into the action;
reducer (`chat-turn-model.ts:114+`) stores/clears it. New `<ApprovalCard>` beside `ToolCard` in
`Chat.tsx` (render at :643–680): exact command via `formatApprovalTarget`
(`src/shell/inbox-model.ts:22–53`), file paths + content for write/edit via `extractFileFromTool`
(`Chat.tsx:197–224`), and a monospace args block — no HTML diff engine, the args *are* the payload.
Buttons: Approve (`Cmd+Enter`), Deny (`Esc`), Edit. Edit fills a textarea with `JSON.stringify(args)`
and Approve sends `approve_modified` + parsed `modifiedArgs`. Replace the status at `Chat.tsx:132`
with "Approval needed — answer in the chat or Inbox." Keep `data.approveTool` as the single write
path so the epoch check at `ipc-bridge.ts:1075–1108` still holds.

**Edit safety:** `ipc-bridge.ts:151` changes `resolve: (approved: boolean)` to
`(outcome: { approved: boolean; modifiedArgs?: Record<string, unknown> })`, returned through
`requestUserApproval` → `onApprovalRequired` (`shared/src/types.ts:161`) into `coordinator.ts:491`.
At `coordinator.ts:493–515`, when `modifiedArgs` exist, re-run the gate block at :448–491 on the
*new* args (`getGates`, `evaluatePolicy`, `validateBashCommand`, nested-shell and shell_outside
checks). If the edit raises the risk tier, deny the override and re-prompt with a plain message;
otherwise pass `modifiedArgs` as `args` into `prepared.push` at :507–515. Never skip gates on an
edit. Emit `approval_resolved` from `approveTool` (`ipc-bridge.ts:1111–1124`) on every terminal
outcome; in `data.ts:213–221` dispatch the same `opensand:approvals_changed` window event, so
`Shell.tsx:491–494` (`onDecided`) and the chat reducer both clear — one decision, both surfaces
(`docs/lessons/2026-11-18-decision-in-one-surface-left-detail-open-in-another.md`).

**Failure / cancel / empty / wiring:** stale epoch → existing 409 at `desktop-server.ts:430–434`:
show "That approval changed; reload and try again", do not clear the card. Abort →
`ipc-bridge.ts:830–836` already resolves pending approvals; also clear `state.approval` on
`turn_cancelled`. No approval → card is absent and status is normal. Approval with no tool card →
card still renders from its own payload. Modes `ask/auto_edit/auto` stay unchanged: an edit is a
per-decision override, never a fourth mode. Keyboard: `Cmd+Enter`/`Esc` handlers on the card must
`preventDefault` and not fire the composer's Enter at `Chat.tsx:834–837`.

**Tests:** `packages/desktop/test/chat-turn-model.test.ts` — `approval_required` keeps request in
state, `approval_resolved` clears it; `packages/desktop/test/ipc-bridge.test.ts` (pattern at :908–949)
— `approve_modified` passes modified args and cannot bypass a dangerous-command prompt; epoch
409 leaves the request pending; `packages/desktop/test/grants-epoch-bridge.test.ts` — revoke after
card render makes the answer stale; `approvals-real-window.test.ts` — decide in chat, Inbox detail
clears, and vice versa.

## 4. Gap 3 — mid-run steering

**Event:** `POST /api/steer` body `{ sessionId, message }` → 200 `{ queued: boolean }` → bridge
`steerTurn()` stores one pending string per coordinator → on drain, TurnEvent
`steer_injected`. Add `steerTurn?` to `OpenSandBridgeApi` (`desktop/src/types.ts:38–66`) and
`CoreShellData` (`data.ts:96–144`); expose in `preload.cts` (near :33–36) and route in
`desktop-server.ts` (beside :420–444).

**Where it lands:** the tool boundary is `coordinator.ts:371–372` (`phase_started executing`,
start of the tool loop). Drain the pending steer *there*: append
`{ role: "user", content: "[Mid-run steer] " + message }` to `this.messages` and emit
`steer_injected`. The in-flight tool batch still finishes; the model reads the steer at the next
`streamCompletion` (`coordinator.ts:306–310`). That is "next tool boundary", not queued to the end
and not a mutation of a running call. One slot per turn: a second steer before the first drain
replaces it; never accumulate. Clear on abort (`ipc-bridge.ts:794–795`) and on `turn_completed`.

**UI:** `Chat.tsx:793–839` composer — when `isChatBusy` (`chat-turn-model.ts:70–72`), Enter calls
`data.steerTurn?.(draft)` instead of `send()` (blocked at `Chat.tsx:104`), then clears the draft and
shows a "Steer queued for the next safe point" chip; `aria-live="polite"` announces
`steer_injected`. Empty draft while busy → Enter is a no-op with a tooltip, not a send.

**Tests:** `packages/coordinator/test/coordinator.test.ts` — fake LLM records messages per call;
a steer injected mid tool batch appears in the *next* call verbatim and `steer_injected` is emitted;
second steer replaces the first; abort drops it. `packages/desktop/test/desktop-server.test.ts` —
route returns `queued:false` for an unknown session. DOM test in `chat-cards-real-window.test.ts` —
Enter while busy calls steer, not sendQuery.

## 5. Gap 4 — every wait visible with a clock

**Reuse, don't duplicate:** `LLMRetryCallback`/`ExtendedLLMClientConfig.onRetry` already exist at
`coordinator/src/llm-client.ts:72–81` and fire at :496–497 for 429/5xx. Wire a config callback in
`coordinator.ts` that emits `retry_scheduled` (with a fresh `waitId`) and wraps it in an open
`wait_started`/`wait_ended` pair for `kind:"rate_limit"`. **Do not add a second retry loop.**
(The brief names PR #429; that PR does not resolve in `Philosopher0707/opensand` — see §8.)

**Emit points (all already have a seam):** model call `coordinator.ts:306–310`; tool run
`coordinator.ts:372–372` with the command name and PID, ending at `tool_call_completed`
(:793); approval wait `ipc-bridge.ts:954–957` (request already has `timestamp`); compaction
`coordinator.ts:285` and `991`; rate-limit retry as above. Tool quietness: the `data` handler at
`command-runner.ts:181–185` already sees stdout chunks — add a 1 s tick there that reports
"no output for Ns" while the command runs; the timeout path (:136–154) already keeps partial output,
so never replace the label with a bare spinner.

**UI:** a `<WaitRow>` in `Chat.tsx` (next to `statusText` :127–146 and `ToolCard` :242) rendering
`Tool: npm test · 22s · no output for 9s` from a 1 s interval; text + icon, not colour alone;
polite live region. End on `wait_ended`, `turn_complete`, `turn_cancelled`, `error`, and abort.
Collapsible thought already exists (`ThoughtAccordion` :226–240) — leave it, add elapsed time to its
label using the model wait pair. Empty/no pending waits → no rows; missing label → `"Working"`.

**Tests:** `coordinator.test.ts` — each wait kind emits start+end exactly once, including when the
turn throws; `provider-error-handling.test.ts` — `onRetry` fires once per retry with `delayMs`;
`chat-turn-model.test.ts` — wait rows appear/resolve/clear on cancel; DOM test per state in
`chat-cards-real-window.test.ts` (loading, long-running, error, empty).

## 6. Gap 5 — same-error circuit breaker

**Event:** `circuit_open` (`message` is plain words: "Stopped: the same tool failed twice with the
same error — <error>. Change the request or fix the cause.").

**Core:** in `coordinator.ts` at `tool_call_completed` (:793) keep per-turn `{ toolName, errorHash }`
for the last *executed* tool; hash the normalized `result.error.message` (first 32 chars is enough).
Same tool name + same hash twice consecutively → emit `circuit_open`, stop the while loop at :300
with the plain message, and skip the remaining calls in the prepared batch. Any success, a different
error, or a new user turn resets the counter. Do not count `PERMISSION_DENIED` (:493–503),
cancellation, or a blocked/unauthorized tool as the repeated error. Cap at exactly two; no third
speculative retry.

**UI:** render `circuit_open` as an error card with the existing retry affordance
(`canRetryTurn`, `chat-turn-model.ts:75–79`) — "Retry" re-sends the last user turn, the user fixes
the cause first. Failure/cancel/empty: stop button still works; no card on a clean turn.

**Tests:** `coordinator.test.ts` — same error twice → third tool call never executes + event
asserted; different error and success reset; user rejection is not counted.

## 7. Build-dimension coverage and out of scope

Every new action answers the 14 dimensions in `~/SKILLS/engineering-workflow/references/
build-dimensions.md`: happy path (§2–6 main flows), failure paths (409 epoch, retry, `circuit_open`),
recovery (retry/steer after error), cancel/limits (abort clears approval/steer/waits; two-error cap),
UI states (§3–6 name empty/loading/error/disabled/keyboard), wiring (new functions traced to routes
and buttons), security (modified args re-gated; epochs; no secrets in events), data safety (no
migration), performance (one 1 s ticker only while a wait is open), compatibility (existing SSE/IPC),
observability (new events in `event-log.jsonl` path via `emitEvent`), tests/gates (named above),
docs/wording (plain messages, no CLI flags in desktop), release (docs-only for this PR; features
ship in their own PRs). Not applicable: packaging/schema migrations are untouched by this design.

Open gaps from the source analysis, deliberately excluded: 6 per-task chat cost cap, 7 shell rules in
system prompt (`system-prompt.ts:27–28`), 8 background process tool, 9 @file mentions, 10 GenUI
widgets, 11 verbatim user messages through compaction, 12 terminal pane.

## 8. Contradictions / decisions to record

- The brief points to PR #429 for the retry event; `gh pr view 429` does not resolve in this repo.
  The `onRetry` callback is already on main (`llm-client.ts:72–81,496–497`) but unwired — we wire it.
- `approval_resolved` is listened for (`data.ts:250`) but never emitted — we emit it rather than
  leave two sources of truth; the `opensand:approvals_changed` window event stays as the reload hint.
- `{ type: "approval" }` (`chat-turn-model.ts:64,321`) is why the card cannot exist today: the
  payload is discarded. The fix is in the mapper, not a new subscription.
- The research report points at `renderer/app.js`; the live UI is `renderer-next`. All UI refs here
  are renderer-next. Network-on + secret-path denies (owner decision 2026-11-20) is untouched.
- WorkMate modes (`ask`/`auto_edit`/`auto`) are unchanged; edit-then-approve is per decision.

## 9. PR-sized jobs (owner split)

| # | Owner | Scope | Files (main refs) | Depends on | Verified by |
|---|-------|-------|-------------------|-----------|-------------|
| A | Dex (core) | Shared wait/steer/circuit events, onRetry wiring, steer endpoint/preload, coordinator seams | `packages/shared/src/types.ts`; `coordinator/src/coordinator.ts`, `llm-client.ts`; `desktop/src/desktop-server.ts`, `preload.cts`, `ipc-bridge.ts` (:740–780); coordinator/provider tests | — | coordinator + provider tests green; new events visible on SSE |
| B | Dex (core) | Approval outcome/modifiedArgs, re-gating, `approval_resolved`, epoch path | `desktop/src/types.ts`, `ipc-bridge.ts` (:151,1060–1124), `desktop-server.ts` (:420–444), `coordinator.ts` (:477–515); approval tests | A (both touch shared types — land in order) | ipc-bridge + grants-epoch tests green |
| C | Pixel (UI) | Inline approval card, edit-then-approve, one-surface clearing | `renderer-next/src/views/Chat.tsx` (:132,643), `src/shell/chat-turn-model.ts` (:64,321), `data.ts` (:213), `Shell.tsx` (:491); chat-turn-model + approvals-real-window tests | B | DOM test: decide in chat clears Inbox detail; stale epoch message |
| D | Pixel (UI) | Wait rows/clocks, circuit card, steer composer | `Chat.tsx` (:127,242,793), `chat-turn-model.ts`, `command-runner.ts` (:181); chat-cards-real-window test | A | DOM tests per UI state; no spinner-only waits |

Ship order A → (B ∥ D after A) → C. No lockfile or `.github` changes; no merges in these jobs.
