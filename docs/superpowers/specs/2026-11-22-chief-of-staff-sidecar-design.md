# Design: chief-of-staff sidecar, nested bot sessions and parallel bot chats

Date: 2026-11-22
Status: approved by owner in conversation after evidence-led design review
Baseline: `13e4753` on `feat/agent-settings-ui`. `CONTEXT.md` section 6 is the running phase log and must be updated after every phase.

## Goal

The human talks to a **chosen chief-of-staff bot** which delegates specialist work to other bots. The human can also talk directly to any bot, in parallel sessions. Every session is nested under its owning bot in the sidebar with a disclosure arrow (left) and a tree-dots menu (right). There is **no Default Assistant**.

## Non-goals

- No new dependency, no framework, no `renderer-next` (Preact) changes.
- Do not weaken session-id validation, SVG sanitizer, or approval/security gates for arbitrary computer-use tools.
- Do not delete orphan sessions of deleted bots; they stay in the global roster.
- No drag-reorder, no tree multi-select, no per-bot notifications beyond the existing delegated badge.

## Evidence summary (from investigation)

- `DesktopSettings` (`shared/src/types.ts:687-695`) persists automatically to `~/.opensand/config.json` (`ipc-bridge.ts:393,413,437,476`); IPC/REST/ApiClient pass the whole object (`main.ts:263-269`, `desktop-server.ts:571-587`, `app.js:255-273`). A new `chiefOfStaffAgentId` needs no transport work.
- A per-bot `chiefOfStaff?: boolean` exists (`shared/src/types.ts:144,186`; `agent-store.ts:58,105`) but has **no runtime reader** — it is unrelated metadata and must be documented as such.
- `delegate_to_agent` is registered (`orchestrator-tools.ts:417-441`) but blocked by `requiresGate: "computerUse"` (default false, `state-manager.ts:135-144`, `tool-registry.ts:739-751`) and stripped by role whitelists **when `allowedTools` is defined** (`token-hygiene.ts:310-330`; `ipc-bridge.ts:643`). Custom tools have no separate approval check beyond `requiresGate` (`tool-registry.ts:740-770`).
- Backend parallel turns already work (`session-parallel.ts:45-46,90-159`; `ipc-bridge.ts:799-863`). Renderer Parallel Board forces one global agent (`parallel-board.js:116`; `app.js:6243`).
- Delegated final text is buffered in memory only (`app.js:5141-5166`; `session-buffers.js`); child transcript is persisted under `sub_<id>_<ts>` (`orchestrator-tools.ts:472`). A durable, hash-chained append primitive already exists: `TranscriptManager.recordEvent()` (`transcript-manager.ts:154`) → `EventLogWriter.append()` (`shared/src/event-log.ts:172-188`); raw JSONL appends would bypass seq/prev-hash chaining and can raise `EventChainIntegrityError`.
- `getSessions()` (`ipc-bridge.ts:1131-1178`) returns `SessionSummary {id,title,createdAt,updatedAt,messageCount,agentId?,roomId?}`; one call + `agentId === bot.id || id === 'bot_'+bot.id` groups sessions reliably. No per-agent endpoint exists (none needed).
- Current rail has a hardcoded Default Assistant row (`bot-rail.js:82-88`) and no session source; no tree/ARIA-expanded precedent exists in the renderer.

## Architecture

### P1 — Chief core (settings, boot, delegation authority)

- Add `chiefOfStaffAgentId?: string` to `DesktopSettings`. Validate in `ipc-bridge.updateSettings()`: if set, the id must resolve via `agentStore.getAgent()`; reject with a clear error otherwise (never silently clear). When an agent is deleted, clear the field if it matched.
- **Chief change invalidation:** `updateSettings()` already aborts runtimes/coordinators on model/endpoint changes (`ipc-bridge.ts:386-412`); extend the same block to run when `chiefOfStaffAgentId` changes, invalidating **both** the old and new chief's coordinators so a demoted chief loses delegation authority on its next turn. Renderer must call `refreshBots()` after a chief change.
- Renderer reads chief id in `refreshSettings()`; expose `getChiefAgentId()` to rail/inspector. **Boot precedence is pinned:** persisted session (`SESSION_KEY`) > persisted agent (`AGENT_KEY`) > chief routing; `selectSession()` may legitimately overwrite `activeAgentId` from session meta (`:4245-4252`). If no session/agent exists and a valid chief is configured, set `activeAgentId = chief.id`, `currentSessionId = 'bot_' + chief.id` and call `selectSession()` (which writes `SESSION_KEY`), then set `AGENT_KEY`. If the configured chief id is stale (not in `getAgents()`), call `client.updateSettings({chiefOfStaffAgentId: null})` once during boot and show the no-chief state. If no chief, leave `activeAgentId` unset, show the welcome banner and the "Choose a chief" affordance. `selectSession(null)` guard and `startNewSession()` stay for generic sessions.
- **No-chief UI is one pinned control:** a `#btnChooseChief` button in the BOTS section header opens a compact picker popover listing agents (one click sets chief via `updateSettings`, Escape/backdrop closes); the inspector's Manage card has the same "Set as chief" / "Clear chief" toggle. The topbar badge and "Default Assistant" fallbacks (`index.html:178`; `app.js:1329,1376,2449,1581-1588`) show the chief's name or "No chief chosen" — never "Default Assistant". Other stale strings at `app.js:4758`, `bot-rail.js:70,74` and the harness test at `window-harness.test.ts:826` must be updated too.
- **Delegation authority (security boundary):**
  - Do **not** remove `requiresGate: "computerUse"` globally. Add a tool-descriptor flag `chiefOnly?: boolean` to `delegate_to_agent` and `await_agent`, and in the coordinator's permission path (`coordinator.ts:315-388`) allow those two tools when `chiefDelegation === true` **without** consulting `computerUse`; all other custom tools keep their gate unchanged. `chiefDelegation` comes from a new coordinator option set only by `ipc-bridge.createSessionCoordinator()` when `agentId === settings.chiefOfStaffAgentId`. CLI and non-chief callers leave it false, so the tools stay gated/unavailable there.
  - For the chief, union `delegate_to_agent` + `await_agent` into `effectiveAllowedTools` regardless of role defaults (and set `toolScopeMode` to an explicit whitelist containing them). For every non-chief session that has **no** `allowedTools` whitelist, explicitly build a whitelist that **denies** both tools, closing the "no whitelist means everything" gap (`coordinator.ts:133-134`).
  - Add `chiefInstructions?: string` to `SystemPromptContext`; when chief, inject a `## Delegation Protocol` section: delegate specialist work via `delegate_to_agent`, use `background:true` + `await_agent` for parallel fan-out, never claim to have done delegated work yourself, and report which bot did what. Keep identity/boundary sections intact.
  - Tests: settings round-trip + validation; chief gets tools and protocol; non-chief (with and without whitelist) is denied; ungated path works only with `chiefDelegation === true`; other custom tools still return `permission_pending` with gate off; CLI path unaffected.

### P2 — Sidecar tree (Orca-style nested sessions)

- Extend `createBotRail` with `getSessions` and `getChiefAgentId`. Fetch once per `render()`, group sessions by `agentId === bot.id || id === 'bot_' + bot.id`, and keep them in closure state. Expose `getGroupedSessionIds(): Set<string>` on the returned object; `refreshSessions()` (`app.js:1968-2039`) must consume that single source of truth synchronously to hide bot-owned sessions from `#sessionList` (no second `getAgents()`/grouping call). Orphan sessions of deleted bots remain global.
- Remove the Default Assistant row (`bot-rail.js:82-88`, prepend at `:179`, null bindings at `:20-23,114,149-157`). `cardFor(null)` and null-branch helpers can be deleted; `selectSession(null)` guard stays. The harness test `window-harness.test.ts:826-851` ("Default Assistant card clears session…") must be replaced with a test asserting no `.bot-rail-card:not([data-agent-id])` exists and that the header "Choose a chief" control opens the picker.
- Each bot row: left disclosure `<button class="bot-tree-toggle" aria-expanded aria-controls>` using `#i-chevron-down` (rotates 90° when collapsed), avatar, name/subline, status dot, delegated badge, right tree-dots button `.btn-bot-inspect` reusing the existing inspector (render `⋯` instead of `#i-clock`; update `aria-label` to "Bot actions and sessions"). **Keep the existing `.btn-bot-identity`, `.btn-bot-model` and `.btn-delete-bot` hover actions** — the prior approved persona spec pins them and harness tests at `window-harness.test.ts:363-379,532` click them. The new arrow and dots are additive; use tight spacing and ellipsis so they fit a 240–280px sidebar.
- Nested `<div class="bot-session-group" id="bot-sessions-<id>" hidden>` with `.bot-session-row` buttons (title, message count, relative date, hover delete). Clicking opens via existing `selectBotSession(id, bot)`. Synthetic "Bot home — <name>" row only when exact `bot_<id>` is absent (dedupe). Arrow toggling does not select the bot.
- Persist expanded bot ids in `localStorage` key `opensand-bot-tree-expanded` (JSON array; `try/catch` → `[]`; prune deleted ids). Do not conflate with show-more `expanded` boolean.
- Filter bot-owned sessions out of global `#sessionList` using live agent ids; keep orphan sessions of deleted bots there. Add delete to nested rows (reuse `client.deleteSession` and the active-session reset logic at `app.js:2019-2034`) so hiding them globally removes no capability.
- Chief row: star/`#i-spark` badge + "chief" chip; "Set as chief of staff" action in inspector Manage card (calls `client.updateSettings({chiefOfStaffAgentId: bot.id})`, then `refreshBots()` + badge update). Clearing chief allowed.
- A11y: `aria-expanded`/`aria-controls`, `role="button" tabindex="0"` on nested rows, focus-visible, arrow keys limited to rows/cards (no new tree keyboard semantics), reduced motion.

### P3 — Parallel direct bot chats

- `parallel-board.js`: add a per-pane `<select class="pane-agent">` populated from `client.getAgents()`; `createPane(agentId?)` stores `pane.agentId`; `send()` uses `pane.agentId` instead of global `getAgentId()`; broadcast uses each pane's own agent. New panes default to unused bots (cycle through agents); keep max 6.
- Fix status marking: `app.js:5167` must use the event's owning bot/session, not `activeAgentId`, when setting a card busy.
- Backend unchanged. Keep the chat composer's `turnBusy` queue; the board has no such lock.

### P4 — Delegation UX and persistence

- Chief session shows compact `↳ delegated to <Bot>` reference as a **button** that opens the target bot's session (reuse `selectBotSession`).
- Persist delegated final results into the target bot's session via the existing hash-chained event log: add bridge method `recordDelegatedResult({ targetSessionId = 'bot_' + subagent.agentId, sourceSessionId = event.sessionId, childTurnId, agentId, content })` that calls `TranscriptManager.recordEvent()` with kind `delegated_result`. The dedupe key is the compound `(sourceSessionId, childTurnId)` where `childTurnId` = `event.data?.event?.turnId ?? event.data?.turn?.id ?? event.id ?? sha256(finalContent)`; a durable seen-set is derived by scanning existing `delegated_result` events in the same log (no in-memory-only set), so two background fan-outs from the same parent to the same bot both persist. The renderer sees the nested `subagent` event with `child.type === 'turn_completed'` (`app.js:5145-5158`) and calls this method in addition to the existing live/buffer behavior.
- Wire the method through `preload.cts`, `main.ts`, `desktop-server.ts` (POST `/api/sessions/:id/delegated-result`) and renderer `ApiClient`. Validate ids with the same regex/path-traversal checks as other session routes; reject unknown agents.
- `loadSession()` returns these `delegated_result` events alongside normal events; `reconstructDialogueTurns()` (`app.js:4170+`) renders them as assistant messages with a `delegated` marker. The in-memory buffer (`drain()`) must skip a message whose `(sourceSessionId, childTurnId)` is already present in the loaded events so reload/double-render cannot duplicate it.
- Tests: two fan-out results from one parent persist; simulated reload shows both once; compact reference opens target session; no duplicate rendering in chief or target; hidden bots' unread still surfaced by Show-more.

### P5 — Verification and documentation

- Full hermetic gate (`pnpm build`, `HOME=/tmp/... pnpm test`), live Electron screenshots (tree expanded/collapsed, chief badge, parallel board with different bots, inspector set-chief), per-phase spec + quality reviews, final whole-implementation review, `AGENTS_LEARNING.md`, and `CONTEXT.md` phase log complete.

## Error handling / edge cases

- Stale chief id → cleared from settings on boot; UI shows "No chief chosen".
- Agent deleted while chief → settings cleared in `deleteAgent` and renderer refreshes.
- `getSessions()` failure → rail shows "Sessions unavailable" row; no crash.
- Expanded-state JSON corrupt → `[]`.
- Delegation tools keep the depth cap 3. Their chief-only bypass applies solely to the `computerUse` gate and only when `chiefDelegation === true`; every other custom tool stays gated. No additional approval policy is implied — custom tools have none beyond `requiresGate` (`tool-registry.ts:740-770`).
- No bots configured → "No bots yet" row + "New bot" action; chief picker empty.

## Phase dependencies (pinned)

P1 (chief core) → P2 (sidecar tree, needs chief id for badge/picker) → P3 (parallel per-pane bots, needs P2 session rows) → P4 (delegation UX/persistence, needs P1–P3) → P5 (verification/docs). Each phase is a separate plan chunk with tests and reviews; `CONTEXT.md` section 6 is updated after each.

## Testing

- P1: settings round-trip/validation, boot chief routing harness, tool union + non-chief denial, prompt protocol unit test.
- P2: tree expand/collapse + localStorage round-trip, nested session rows, no Default Assistant row, chief badge/set-chief + picker, global roster consumes `getGroupedSessionIds()` so no duplicate sessions, nested delete, and the replacement harness test for the removed default row.
- P3: board panes with two different agents, send attribution, status marking per event.
- P4: delegated persistence across reload, reference link, no double render.
- P5: full gate, screenshots, final review.

## Risks

- Removing `computerUse` gating from delegation is a deliberate authority change limited to two first-class tools; all other custom tools stay gated.
- Six controls in a narrow sidebar could crowd the row; dots-only design keeps it to arrow + dots plus status/badge.
- Hiding bot-owned sessions globally changes where users delete them; nested delete restores the capability.
- Persisting delegated results adds a write to session logs; idempotency by source session id is required to avoid duplicates.
