# Design: bot persona boundaries, management and session access

Date: 2026-11-22
Status: approved by owner in conversation (4-chunk plan, two-card inspector popover)
Baseline: `91882c2` on `feat/agent-settings-ui`. This spec covers four independent issues discovered by evidence-led investigation; they are implemented as separate chunks.

## Goal and problems

1. **Persona identity:** every selected or delegated bot answers "I'm OpenSand — an autonomous AI coding and systems engineering assistant." The engine's system message hardcodes `You are OpenSand…` (`coordinator/src/system-prompt.ts:19`) and appends the bot's real `systemPrompt` at the very end as `## User Custom Instructions` (`:58`). `name`/`role` are never passed to the prompt (`ipc-bridge.ts:708-713`, `orchestrator-tools.ts:483-488`, `cli-app.ts:411`). Additionally some `bot_<id>` sessions have `meta.json` with `agentId: null`, and `inferAgentIdFromSessionId` (`ipc-bridge.ts:589-596`) only recognizes `sub_agent_*`, so re-opening those sessions sends no agent at all.
2. **Broken session open:** clicking the sidebar's Default Assistant row calls `onSelect(null)` → `app.js:1343 selectSession(null)` → `app.js:4207 client.loadSession(null)` → `ipc-bridge.ts:1185` throws → `app.js:4225` shows `Error loading session: … Invalid sessionId: null.`
3. **Management:** rename is supported in the store/API (`updateAgentProfile(id, {name})`, `agent-store.ts:448-465`; `desktop-server.ts:702-715`; `ipc-bridge.ts:1063-1067`; renderer `app.js:313-323`) but has no UI. Delete is wired in the sidebar (`bot-rail.js:139-142` → `app.js:1330-1340`) but `deleteAgent` does not invalidate cached coordinators (`ipc-bridge.ts:1033-1040`).
4. **Session access:** vanilla renderer has no per-bot session list; Preact precedent `renderer-next/src/views/AgentSessionHistory.tsx:20-39` filters `s.agentId === agentId`. `getSessions()` returns `SessionSummary { id, title, createdAt, updatedAt, messageCount, agentId?, roomId? }` (`shared/src/types.ts:697-705`).

## Non-goals

- No new dependency, no framework, no Preact shell changes.
- Do not weaken bridge session-id validation (`ipc-bridge.ts:1184-1192`) or SVG sanitizer (`bot-identity.js:56-66`).
- Do not delete orphaned `bot_<id>` sessions on agent delete (data loss); they remain accessible via the global session list. No audit/`soul` work, no drag-reorder, no sort menu, no task/routine changes.
- Do not fix unrelated latent issues in this job: delegation depth off-by-one (`orchestrator-tools.ts:505` vs `:514`), UI-only default prompt string (`app.js:1555`).

## Architecture (four independent chunks)

### Chunk A — null-session guard (smallest blocker)

- `app.js` `selectSession(sessionId)` (~`:4197`): first line `if (!sessionId) { startNewSession(); return; }` — one shared guard covers the Default Assistant row, keyboard activation and any future null caller. `startNewSession()` already clears state/SESSION_KEY and shows the welcome banner (`app.js:4237-4251`).
- Regression: window-harness clicks `#botList .bot-rail-card:not([data-agent-id])` and asserts no `Error loading session:` text in `#messageFeed`, and that `window.__railState.getActive().currentSessionId` is null.
- Bridge validation unchanged; the renderer simply never asks to load a null session.

### Chunk B — persona boundaries

- `coordinator/src/system-prompt.ts`: extend `SystemPromptContext` with optional `agentName?: string`, `agentRole?: string`. Build the identity line as:
  - no agent: **unchanged** `You are OpenSand, an autonomous AI coding and systems engineering assistant.`
  - agent: `You are ${agentName}${agentRole ? ` — ${agentRole}` : ''}, a specialist bot operating inside OpenSand.`
- When an agent identity is present, add one short `## Persona Boundary` section immediately before the existing custom-instructions block. It states that the identity above is authoritative for this session and that the instructions below define the bot's voice/role/constraints and take precedence over generic OpenSand defaults where they conflict. The `## User Custom Instructions` heading is **unchanged** in both branches; the agent branch simply gains the extra boundary section. Tests assert both the bot identity line and `## Persona Boundary`.
- Pass `agentName`/`agentRole` at all three coordinator construction sites: `ipc-bridge.ts:708-713` (from `agent.name`/`agent.role` already loaded at `:635-649`), `orchestrator-tools.ts:483-488` (child delegation), `cli-app.ts:405-414` (CLI parity).
- `ipc-bridge.ts:589-596` `inferAgentIdFromSessionId`: also match `^bot_(agent_[A-Za-z0-9_]+)$` so `loadSession` restores the agent for `bot_<id>` sessions.
- **Self-healing meta — no new call site.** `writeSessionMeta` (`ipc-bridge.ts:560-587`) is already invoked on every coordinator creation (`:614`, reached from `sendQuery` at `:821`), but line `:574` writes `agentId: agentId ?? null`, which can overwrite a good value with null. Change only its resolution to `agentId ?? this.inferAgentIdFromSessionId(sessionId) ?? previous.agentId ?? null`. This both infers from `bot_<id>` and preserves an existing non-null value, so old sessions heal on their next turn. Do not add a redundant write call.
- Result: a bot's first identity is its own name/role; the generic OpenSand identity remains only for the Default Assistant. Delegated children get the target bot's identity, not the parent's.

### Chunk C — rename and delete bot

- New module `renderer/modules/bot-inspector.js`: `openBotInspector({ bot, anchor, loadSessions, onRename, onIdentity, onModel, onDelete, onOpenSession, onNewSession })` — a fixed-width popover anchored to the card, same focus-trap/backdrop/Escape/focus-restore pattern as `bot-identity.js:83-208`, `role="dialog" aria-modal="true" aria-label="<bot name> actions"`. All interpolated values use `escapeHtml`. **Only one dialog at a time:** the inspector calls its own `close()` (restoring focus to the anchor) before invoking `onIdentity` / `onModel` / `onOpenSession` / `onNewSession` / `onDelete`, so its document-level focus trap cannot overlap the identity editor or model picker. Two sections/cards:
  1. **Manage bot** — name input + Save/Cancel (rename), and buttons Change identity / Change model / Delete bot. The inspector owns `window.confirm` for delete; `onDelete` must not confirm again (the rail confirms separately at `bot-rail.js:141`). `onRename` signals validation failure by rejecting with an `Error`; the inspector awaits/catches every callback and shows the message inline (never an unhandled rejection).
  2. **Sessions** — `loadSessions` is an async callback supplied by the controller returning `SessionSummary[]`, or `null` on failure; the inspector renders a muted "Sessions unavailable" line for `null`. Each row is a button; plus "New session with this bot".
- `bot-rail.js`: add `onInspect` option and one card button using the existing `#i-clock` sprite (`index.html:48`), `aria-label="Bot actions and sessions"`, wired to `onInspect(bot, button)`. Keep existing three hover actions. Export nothing new otherwise; `.delegated-badge` and `setBotCardStatus` contracts unchanged.
- `app.js` wiring beside existing rail options:
  - `onInspect: (bot, anchor) => openBotInspector({ bot, anchor, loadSessions: async () => { try { const all = await client.getSessions(); return all.filter((s) => s.agentId === bot.id || s.id === 'bot_' + bot.id); } catch { return null; } }, ...callbacks })`. The fallback lives here (`null` on failure); the inspector only renders what it receives. Use exact `s.id === 'bot_' + bot.id` — a broader `startsWith` could attribute another bot's session.
  - `onRename: async (bot, name) => { const trimmed = name.trim(); if (!trimmed || trimmed.length > 64) throw new Error('Name must be 1–64 characters'); await client.updateAgentProfile(bot.id, { name: trimmed }); await refreshBots(); refreshDetailPanel(); if (activeAgentId === bot.id) badgeActiveBot.textContent = trimmed; }`
  - `onIdentity`/`onModel`/`onDelete` reuse existing handlers (no extra confirm in `onDelete`); `onOpenSession: (id) => selectSession(id)`. **Pinned `onNewSession` behavior:** `activeAgentId = bot.id; void selectSession('bot_' + bot.id);` — always open the dedicated home session (the bridge tolerates an empty one), never the generic welcome banner. A brand-new bot therefore lands in its own empty session, not the Default Assistant state.
- `ipc-bridge.ts` `deleteAgent` (`:1033-1040`): call the existing `invalidateAgentCoordinators` helper (`:1042-1055`) after a successful delete, matching `updateAgentSettings`/`updateAgentProfile`.
- Trust boundaries: trimmed non-empty name, max 64 chars, `escapeHtml` on all display, `window.confirm` for delete, existing id validation untouched.

### Chunk D — per-bot sessions card (UI + wiring)

- The Sessions card inside `openBotInspector` renders every session returned by the filter, showing `title || id`, `messageCount`, and a short relative/absolute `updatedAt` string; clicking calls `onOpenSession(id)` and closes the popover. A synthetic row labelled `Bot home — <bot name>` with id `bot_<bot.id>` is added **only if no session with that exact id is already in the list** (dedupe), so a brand-new bot remains openable without duplicating the normal case. No-session case renders a muted empty line, never a blank card.
- The inspector popover CSS lives in `styles.css` next to `.identity-*`, using existing tokens, `--shadow-lg`, focus-visible ring, reduced-motion kill switch, and light-theme compatibility. No new icon set.

## Error handling / edge cases

- `selectSession(null)` → `startNewSession()`, no IPC.
- Agent whose meta still has `agentId: null`: inference from `bot_<id>` recovers it; capability check against live agents stays in renderer (`app.js:4210-4212`).
- Rename to a name matching another bot is allowed by the store but makes `getAgent(idOrName)` ambiguous for name-addressed tools; document as residual risk, do not block in UI.
- Delete leaves orphan sessions; they remain listed globally and are not deleted.
- Inspector `getSessions()` failure falls back to the synthetic home row only and shows a muted "Sessions unavailable" line; it never throws into the renderer.
- Empty/overlong name shows an inline validation message in the Manage card and does not call the API.

## Testing

- Coordinator: `system-prompt.test.ts` add agent-identity case asserting bot name/role in the identity line and the `## Persona Boundary` section, and no generic OpenSand identity line in that branch; keep existing default test green.
- IPC bridge: `ipc-bridge.test.ts` add (a) `loadSession('bot_agent_x')` returns inferred `agentId` when meta has null, (b) `sendQuery` backfills meta `agentId` for a `bot_` session, (c) `deleteAgent` invalidates cached coordinators (spy or observable equivalent).
- Window harness: (a) Default Assistant card click → no error banner, session id null; (b) inspector opens with two cards; (c) rename via inspector persists through `GET /api/agents` (round-trip, not just DOM); (d) sessions card lists a seeded `bot_<id>` session and clicking it opens that session; (e) delete via inspector removes the card and the agent from the API.
- Full hermetic gate (`pnpm build`, `HOME=/tmp/... pnpm test`) green; live Electron screenshots of the inspector (both cards) and a bot session list; per-chunk spec + quality reviews; local commits only, explicit paths.

## Risks

- Changing the authoritative identity line may alter model behavior for existing Default Assistant turns; the no-agent branch is byte-identical, limiting this.
- `bot_<id>` inference assumes the id part is a valid agent id pattern; unknown ids still load as no-agent (safe).
- Rename/delete naming collisions and orphan sessions are documented residuals, not blockers.
- Reference screenshot from earlier remains unread (macOS TCC); this UI follows the already-approved sidebar pattern.
