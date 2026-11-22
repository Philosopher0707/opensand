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
- `delegate_to_agent` is registered (`orchestrator-tools.ts:417-441`) but blocked by `requiresGate: "computerUse"` (default false, `state-manager.ts:135-144`, `tool-registry.ts:739-751`) and stripped by role whitelists (`token-hygiene.ts:310-330`; `ipc-bridge.ts:643`).
- Backend parallel turns already work (`session-parallel.ts:45-46,90-159`; `ipc-bridge.ts:799-863`). Renderer Parallel Board forces one global agent (`parallel-board.js:116`; `app.js:6243`).
- Delegated final text is buffered in memory only (`app.js:5141-5166`; `session-buffers.js`); child transcript is persisted under `sub_<id>_<ts>` (`orchestrator-tools.ts:472`).
- `getSessions()` (`ipc-bridge.ts:1131-1178`) returns `SessionSummary {id,title,createdAt,updatedAt,messageCount,agentId?,roomId?}`; one call + `agentId === bot.id || id === 'bot_'+bot.id` groups sessions reliably. No per-agent endpoint exists (none needed).
- Current rail has a hardcoded Default Assistant row (`bot-rail.js:82-88`) and no session source; no tree/ARIA-expanded precedent exists in the renderer.

## Architecture

### P1 — Chief core (settings, boot, delegation authority)

- Add `chiefOfStaffAgentId?: string` to `DesktopSettings`. Validate in `ipc-bridge.updateSettings()`: if set, the id must resolve via `agentStore.getAgent()`; otherwise reject or clear. When an agent is deleted, clear the field if it matched.
- Renderer: read chief id in `refreshSettings()`; expose `getChiefAgentId()` to the rail/inspector. Boot: if a chief id is configured and valid and no persisted session overrides it, set `activeAgentId` to the chief and open `bot_<chiefId>`; if unset/stale, show the welcome banner plus a "Choose a chief of staff" affordance. `selectSession(null)` guard and `startNewSession()` remain for generic sessions.
- Topbar badge and all "Default Assistant" fallbacks (`index.html:178`; `app.js:1329,1376,2449,1581-1588`) show the chief's name or "No chief chosen" — never "Default Assistant".
- Delegation authority:
  - Remove `requiresGate: "computerUse"` from `delegate_to_agent` and `await_agent` only (keep every other custom tool gated).
  - In `ipc-bridge.createSessionCoordinator()`, when `agentId === settings.chiefOfStaffAgentId`, union `delegate_to_agent` and `await_agent` into `effectiveAllowedTools` regardless of role defaults, and set `toolScopeMode` accordingly.
  - Add `chiefInstructions?: string` to `SystemPromptContext`; when chief, inject a `## Delegation Protocol` section: delegate specialist work via `delegate_to_agent`, use `background:true` + `await_agent` for parallel fan-out, never claim to have done delegated work yourself, and report which bot did what. Keep the existing bot identity/boundary sections intact.
  - Tests: settings round-trip + validation; chief gets tools in coordinator; non-chief does not; `delegate_to_agent` no longer returns `permission_pending` with the gate off; system prompt contains protocol only for chief.

### P2 — Sidecar tree (Orca-style nested sessions)

- Extend `createBotRail` with `getSessions` and `getChiefAgentId`. Fetch once per `render()`, group sessions by `agentId === bot.id || id === 'bot_' + bot.id`, and keep them in closure state.
- Remove the Default Assistant row (`bot-rail.js:82-88`, prepend at `:179`, null bindings at `:20-23,114,149-157`). `cardFor(null)` and null-branch helpers can be deleted; `selectSession(null)` guard stays.
- Each bot row: left disclosure `<button class="bot-tree-toggle" aria-expanded aria-controls>` using `#i-chevron-down` (rotates 90° when collapsed), avatar, name/subline, status dot, delegated badge, right tree-dots button `.btn-bot-inspect` reusing the existing inspector (render `⋯` instead of `#i-clock`; update `aria-label` to "Bot actions and sessions"). Keep `.btn-bot-model` only if a harness test needs it; prefer dots-only to avoid six controls in a 240–280px sidebar.
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
- Persist delegated final results into the target bot's session so they survive reload: add a bridge method `recordDelegatedResult(sessionId, agentId, content, sourceSessionId)` that appends exactly one message to the session event log (idempotent by `sourceSessionId`); renderer calls it when handling `turn_completed` for the target bot, in addition to the existing live/buffer behavior. If no event-log append primitive exists, add the minimal JSONL append alongside existing session write helpers.
- When opening a bot session, merged view shows persisted history + buffered pending once (existing `drain()` logic) + delegated records from `recordDelegatedResult`, with no duplicates.
- Tests: delegated result survives a simulated reload; compact reference opens target session; no duplicate rendering in chief or target; hidden bots' unread still surfaced by Show-more.

### P5 — Verification and documentation

- Full hermetic gate (`pnpm build`, `HOME=/tmp/... pnpm test`), live Electron screenshots (tree expanded/collapsed, chief badge, parallel board with different bots, inspector set-chief), per-phase spec + quality reviews, final whole-implementation review, `AGENTS_LEARNING.md`, and `CONTEXT.md` phase log complete.

## Error handling / edge cases

- Stale chief id → cleared from settings on boot; UI shows "No chief chosen".
- Agent deleted while chief → settings cleared in `deleteAgent` and renderer refreshes.
- `getSessions()` failure → rail shows "Sessions unavailable" row; no crash.
- Expanded-state JSON corrupt → `[]`.
- Delegation tool still respects depth cap 3 and existing approval policy; enabling it does not bypass other gates.
- No bots configured → "No bots yet" row + "New bot" action; chief picker empty.

## Testing

- P1: settings round-trip/validation, boot chief routing harness, tool union, prompt protocol unit test.
- P2: tree expand/collapse + localStorage round-trip, nested session rows, no Default Assistant row, chief badge/set-chief, no duplicate global sessions, nested delete harness.
- P3: board panes with two different agents, send attribution, status marking per event.
- P4: delegated persistence across reload, reference link, no double render.
- P5: full gate, screenshots, final review.

## Risks

- Removing `computerUse` gating from delegation is a deliberate authority change limited to two first-class tools; all other custom tools stay gated.
- Six controls in a narrow sidebar could crowd the row; dots-only design keeps it to arrow + dots plus status/badge.
- Hiding bot-owned sessions globally changes where users delete them; nested delete restores the capability.
- Persisting delegated results adds a write to session logs; idempotency by source session id is required to avoid duplicates.
