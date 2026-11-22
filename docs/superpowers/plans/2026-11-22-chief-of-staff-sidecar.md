# Chief-of-Staff Sidecar Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** chosen chief bot delegates to specialists; nested per-bot session tree in the sidebar; no Default Assistant; parallel direct bot chats.

**Architecture:** P1 settings/security core → P2 sidebar tree → P3 parallel per-pane bots → P4 delegated persistence → P5 verification. `CONTEXT.md` section 6 updated after each phase.

**Tech Stack:** TypeScript (shared/coordinator/desktop), vanilla JS renderer, Electron IPC + REST, TAP tests, CSS tokens.

**Spec:** `docs/superpowers/specs/2026-11-22-chief-of-staff-sidecar-design.md`
**Baseline:** `d15b291`, branch `feat/agent-settings-ui`. Never stage `pnpm-lock.yaml` or pre-existing untracked files.

---

## P1 — Chief core

### Task 1: Failing tests
**Files:** `packages/coordinator/test/system-prompt.test.ts`, `packages/desktop/test/ipc-bridge.test.ts`, `packages/desktop/test/window-harness.test.ts`

- [ ] **Step 1:** Add to `system-prompt.test.ts` (imports `{ describe, it }`):
```ts
it("adds a delegation protocol only for the chief", () => {
  const chief = buildSystemPrompt({ agentName: "CTO Bot", agentRole: "Chief of Staff", chiefInstructions: "Delegate specialist work via delegate_to_agent." });
  const plain = buildSystemPrompt({ agentName: "Coder", agentRole: "Engineer" });
  assert.match(chief, /## Delegation Protocol/);
  assert.match(chief, /Delegate specialist work via delegate_to_agent\./);
  assert.doesNotMatch(plain, /## Delegation Protocol/);
  assert.match(plain, /You are Coder — Engineer/);
});
```
- [ ] **Step 2:** Add to `ipc-bridge.test.ts` (imports `test`; own `tmpDir` + local `bridge` idiom):
```ts
test("chief settings persist, validate and invalidate coordinators", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-chief-settings-"));
  try {
    const bridge = new DesktopIpcBridge({ baseDir: tmpDir });
    const a = await bridge.createAgent({ name: "Chief", role: "Lead", systemPrompt: "lead" });
    await bridge.updateSettings({ chiefOfStaffAgentId: a.id });
    assert.strictEqual((await bridge.getSettings()).chiefOfStaffAgentId, a.id);
    const c1 = await bridge.createSessionCoordinator(`bot_${a.id}`, a.id);
    await bridge.updateSettings({ chiefOfStaffAgentId: null });
    const c2 = await bridge.createSessionCoordinator(`bot_${a.id}`, a.id);
    assert.notStrictEqual(c2, c1, "changing chief must evict cached coordinators");
    await assert.rejects(() => bridge.updateSettings({ chiefOfStaffAgentId: "agent_missing" }));
    await bridge.deleteAgent(a.id);
    assert.strictEqual((await bridge.getSettings()).chiefOfStaffAgentId ?? null, null);
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});
```
- [ ] **Step 3:** Add a runtime gate test to `packages/coordinator/test/tool-gate.test.ts` (imports `{ describe, it }` and `LocalExecDaemon` already). Register a stub custom tool to exercise the gate without spawning a real child:
```ts
it("chiefOnly tools bypass computerUse only with chiefDelegation", async () => {
  const daemon = new LocalExecDaemon();
  daemon.tools.registerCustomTool({
    definition: { type: "function", function: { name: "probe_chief_tool", description: "probe", parameters: { type: "object", properties: {} } } },
    handler: async () => ({ ok: true }),
    requiresGate: "computerUse",
    chiefOnly: true,
  });
  const gates = { computerUseAllowed: false, deviceToolsAllowed: false };
  const denied = await daemon.executeTool("probe_chief_tool", {}, { permissionGates: gates });
  const allowed = await daemon.executeTool("probe_chief_tool", {}, { permissionGates: gates, chiefDelegation: true });
  assert.strictEqual(denied.status, "permission_pending");
  assert.strictEqual(allowed.status, "ok");
  const other = await daemon.executeTool("exec_command", { command: "true" }, { permissionGates: gates, chiefDelegation: true });
  assert.strictEqual(other.status, "permission_pending", "chiefDelegation must not open other custom tools");
});
```
Use `it` (file's import) and adapt `parameters` to the exact `ToolDefinition` shape if needed. Also add to `ipc-bridge.test.ts`: chief coordinator's resolved tools include `delegate_to_agent` and `await_agent`; non-chief coordinator with no `allowedTools` excludes both.
- [ ] **Step 4:** Run `pnpm --filter @opensand/coordinator run build && pnpm --filter @opensand/coordinator test && pnpm --filter @opensand/desktop run build && pnpm --filter @opensand/desktop test`. Build first (tests use `dist/`). All new tests must FAIL.

### Task 2: Settings + authority implementation
**Files:** `packages/shared/src/types.ts`, `packages/desktop/src/ipc-bridge.ts`, `packages/coordinator/src/system-prompt.ts`, `packages/coordinator/src/orchestrator-tools.ts`, `packages/coordinator/src/coordinator.ts`, `packages/local-exec-daemon/src/tool-registry.ts`

- [ ] **Step 1:** `shared/src/types.ts`: change `DesktopSettings` to include `chiefOfStaffAgentId?: string | null`.
- [ ] **Step 2:** `ipc-bridge.ts updateSettings()` (`:373-416`): validate non-null chief id with `agentStore.getAgent()`, reject unknown; include `chiefOfStaffAgentId` in the change-detection condition that aborts runtimes/clears `coordinatorMap` (`:386-412`); for old→new change, call `invalidateAgentCoordinators` for both ids. `deleteAgent()` (`:1033-1040`): if deleted id matches settings chief, `updateSettings({chiefOfStaffAgentId: null})`.
- [ ] **Step 3:** Extend interfaces first: `local-exec-daemon/src/tool-registry.ts:56-60` `CustomToolRegistration` gains `chiefOnly?: boolean`; `ToolExecutionContext` (`:29-52`) gains `chiefDelegation?: boolean`. Then in `orchestrator-tools.ts` add `chiefOnly: true` to the `delegate_to_agent` registration object (beside `requiresGate: "computerUse"` at `:443`) and to the `await_agent` registration object (insert `chiefOnly: true` after its `definition` block, before `handler` at `:629`; that tool has no `requiresGate`). Keep all existing gate fields unchanged.
- [ ] **Step 4:** `coordinator.ts`: add `chiefDelegation?: boolean` to coordinator options; add it to every `executeTool` context object at `:414-419` and `:459-464` (the calls that reach the daemon). `system-prompt.ts`: add `chiefInstructions?: string` to context and inject `\n## Delegation Protocol\n${context.chiefInstructions}` when present.
- [ ] **Step 5:** `tool-registry.ts:742-763` — keep both existing gate checks intact and add a bypass only to the computerUse one:
```ts
const chiefBypass = custom.chiefOnly === true && context?.chiefDelegation === true;
if (!chiefBypass && custom.requiresGate === "computerUse" && context?.permissionGates && !context.permissionGates.computerUseAllowed) { /* existing permission_pending block unchanged */ }
if (custom.requiresGate === "deviceTools" && context?.permissionGates && !context.permissionGates.deviceToolsAllowed) { /* unchanged */ }
```
Do not alter the deviceTools check or any other tool path.
- [ ] **Step 6:** `ipc-bridge.ts`: define `const CHIEF_TOOLS = ['delegate_to_agent', 'await_agent'] as const;`. In `createSessionCoordinator()`: set `chiefDelegation: agentId === this.settings.chiefOfStaffAgentId`. When chief, union `CHIEF_TOOLS` into `effectiveAllowedTools`. When not chief and `agent.allowedTools` is undefined, set `effectiveAllowedTools` to all currently resolved tool names minus `CHIEF_TOOLS` (so "no whitelist" cannot imply access). Define in the bridge:
```ts
const CHIEF_INSTRUCTIONS = 'You are the user\'s chief of staff. Delegate specialist work via delegate_to_agent. For parallel fan-out use background:true and collect results with await_agent. Never claim to have done delegated work yourself; report which bot did what.';
```
and pass it as `chiefInstructions` when chief.
- [ ] **Step 7:** Run build + tests; all green.

### Task 3: Renderer chief picker + boot
**Files:** `index.html`, `app.js`, `styles.css`, new `packages/desktop/renderer/modules/chief-picker.js`, harness test
- [ ] **Step 1:** Add `#btnChooseChief` to BOTS header (`index.html:93-106`) with `#i-spark` icon and `aria-label="Choose chief of staff"`.
- [ ] **Step 2:** `app.js`: after `refreshSettings()` stores settings, cache `chiefAgentId`; expose `getChiefAgentId: () => chiefAgentId` via `window.__railState` (add alongside existing keys). Implement `openChiefPicker(anchor)` reusing a compact popover (create `renderer/modules/chief-picker.js` with `openChiefPicker({ agents, currentId, anchor, onPick, onClear })` — focus trap/Escape/backdrop like `bot-inspector.js`, buttons per agent + "No chief"). Wire `#btnChooseChief` click → `client.getAgents()` → picker; `onPick` → `client.updateSettings({chiefOfStaffAgentId: id})` → `refreshSettings()` + `refreshBots()` + update badge; `onClear` → null.
- [ ] **Step 3:** Boot (`:6198-6236`): after validating agents, if stale chief id call `client.updateSettings({chiefOfStaffAgentId: null})` once; if no session/agent and chief exists, set `activeAgentId = chief.id`, `currentSessionId = 'bot_'+chief.id`, call `selectSession(...)` and `persistAgent()`. Replace all visible "Default Assistant" badge strings with chief name or "No chief chosen" (`index.html:178`, `app.js:1329,1376,2449`, detail panel `:1581-1588`), and update `app.js:4758` @mention label.
- [ ] **Step 4:** Replace the Default Assistant harness test (`window-harness.test.ts:826-851`). `runHarness` has no reload hook (`HarnessOptions` at `:13-18`; `interactScript` runs once from `did-finish-load` at `:180-184`, and `location.reload()` would destroy the context). Instead **pre-seed `<tmpHome>/.opensand/config.json`** with `{ ...defaults, chiefOfStaffAgentId: "agent_chief_ab12cd34" }` plus the agent JSON before `runHarness`, then assert on first load: no `.bot-rail-card:not([data-agent-id])`, `getActive().activeAgentId === 'agent_chief_ab12cd34'`, `currentSessionId === 'bot_agent_chief_ab12cd34'`, badge shows chief name, and `#btnChooseChief` opens the picker. Use the config shape from `ipc-bridge.ts:128-136`.
- [ ] **Step 5:** Run build + tests; commit P1 explicit paths; message `feat(ai): chief-of-staff setting, scoped delegation and boot routing`. Update `CONTEXT.md` Phase 1 log (commit hash, test counts, evidence) and commit it.

---

## P2 — Sidecar tree

### Task 4: Tree module
**Files:** `renderer/modules/bot-rail.js`, `styles.css`
- [ ] **Step 1:** Extend options with `getSessions`, `getChiefAgentId`. Add closure `expandedIds = new Set(loadExpanded())` with:
```js
const EXPANDED_KEY = 'opensand-bot-tree-expanded';
function loadExpanded() { try { const v = JSON.parse(localStorage.getItem(EXPANDED_KEY) || '[]'); return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []); } catch { return new Set(); } }
function saveExpanded() { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expandedIds])); }
```
In `render()`, after fetching agents, prune stale ids: `for (const id of expandedIds) if (!agents.some((a) => a.id === id)) { expandedIds.delete(id); } saveExpanded();`
- [ ] **Step 2:** `render()` fetches agents (single `getAgents()` call) and sessions (single `getSessions()` call). Group with `const sessionsFor = (bot) => sessions.filter((s) => s.agentId === bot.id || s.id === 'bot_' + bot.id);`.
- [ ] **Step 3:** Remove Default Assistant: delete `cardHtml(null,…)`, its prepend in `renderRows()`, `cardFor(null)`, and the null keydown binding. `cardAttrs` no longer needs a null branch.
- [ ] **Step 4:** In `cardHtml(bot, activeId)` add left disclosure button and nested group AFTER the card:
```js
const isOpen = expandedIds.has(bot.id);
const disclosure = `<button class="bot-tree-toggle" type="button" aria-expanded="${isOpen}" aria-controls="bot-sessions-${id}" aria-label="${isOpen ? 'Collapse' : 'Expand'} ${escapeHtml(bot.name||'')} sessions"><svg class="icon bot-tree-chevron" aria-hidden="true" focusable="false"><use href="#i-chevron-down"></use></svg></button>`;
const own = sessionsFor(bot);
const homeId = `bot_${bot.id}`;
if (!own.some((s) => s.id === homeId)) own.unshift({ id: homeId, title: `Bot home — ${bot.name || 'bot'}`, messageCount: 0, updatedAt: null });
const rows = own.map((s) => `<div class="bot-session-row" role="button" tabindex="0" data-session-id="${escapeHtml(s.id)}"><span class="bot-session-title">${escapeHtml(s.title || s.id)}</span><span class="bot-session-meta">${s.messageCount || 0} msgs · ${s.updatedAt ? new Date(s.updatedAt).toLocaleDateString() : ''}</span><button class="btn-delete-session" type="button" data-session-id="${escapeHtml(s.id)}" aria-label="Delete session">×</button></div>`).join('');
const group = `<div class="bot-session-group" id="bot-sessions-${id}" ${isOpen ? '' : 'hidden'}>${rows}<button class="bot-session-new" type="button">＋ New session with this bot</button></div>`;
```
This is the canonical markup: a `<div role="button" tabindex="0">` row with a real nested delete `<button>` (never a button inside a button). Bind Enter/Space on the div.
- [ ] **Step 5:** Render `disclosure + card + group` per bot. Bind: disclosure click toggles `expandedIds`, `saveExpanded()`, then `renderRows()` (do not select bot); session row click → `onOpenSession(s.id, bot)`; delete button → `onDeleteSession(s.id)` with `window.confirm`; new-session → `onNewSession(bot)`. `moveFocus()` must select `.bot-rail-card` only (unchanged). Keep `.btn-bot-inspect` and render literal `⋯` text (no sprite), preserving its class and `aria-label="Bot actions and sessions"` for inspector/harness compatibility.
- [ ] **Step 6:** Chief row decoration: if `getChiefAgentId() === bot.id`, add `<span class="bot-chief-badge">★ chief</span>` to `.bot-item-info`. Expose `getGroupedSessionIds: () => new Set(sessionsFor all bots ids)` on return object.
- [ ] **Step 7:** CSS: `.bot-tree-toggle` (left, rotate chevron on `[aria-expanded="false"]`), `.bot-session-group` (margin-left indentation), `.bot-session-row` (ellipsis, hover, focus-visible), `.btn-delete-session`, `.bot-session-new`, `.bot-chief-badge`. Use tokens; reduced motion.
- [ ] **Step 8:** Run build + tests; commit P2 module step.

### Task 5: App wiring + dedupe + inspector
**Files:** `app.js`, `bot-inspector.js`, `window-harness.test.ts`
- [ ] **Step 1:** Pass `getSessions: () => client.getSessions()`, `getChiefAgentId` into `createBotRail`. Add rail options `onOpenSession: (id, bot) => selectBotSession(id, bot)`, `onDeleteSession: async (id) => { if (confirm) { await client.deleteSession(id); if (currentSessionId === id) startNewSession(); await refreshBots(); refreshSessions(); } }`, `onNewSession` already exists.
- [ ] **Step 2:** In `refreshSessions()`, filter out sessions whose id is in `botRail.getGroupedSessionIds()` (read synchronously; no extra IPC). Keep orphan sessions. Add nested-row delete (Task 4 handles).
- [ ] **Step 3:** `bot-inspector.js`: add a button in Manage card `inspector-chief` labelled "Set as chief" / "Clear chief" based on a new `isChief` option passed by `app.js botInspectHandler`; onClick calls `onSetChief(bot, !isChief)` then closes. `app.js`: `onSetChief` calls `client.updateSettings({chiefOfStaffAgentId: clear ? null : bot.id})`, `refreshSettings()`, `refreshBots()`, badge update.
- [ ] **Step 4:** Harness: assert tree expand/collapse + localStorage persistence, nested rows for seeded sessions, no default row, chief badge/set-chief, global roster has no duplicate bot sessions, nested delete removes session.
- [ ] **Step 5:** Run build + tests; commit P2 explicit paths; update `CONTEXT.md` Phase 2 log and commit.

---

## P3 — Parallel per-pane bots

### Task 6: Pane agent selector
**Files:** `renderer/modules/parallel-board.js`, `app.js`, `index.html`, harness test
- [ ] **Step 1:** `initParallelBoard` options gain `getAgents` and `registerSessionAgent(sessionId, agentId)` (writes the `getAgentIdForSession` cache in app.js). Change signature to `createPane(sessionId, agentId = null)` — keep the existing first argument `sessionId` (`parallel-board.js:49`, callers at `:200,213-214`) unchanged. Store `pane.agentId = agentId`; render `<select class="pane-agent">` with an option per agent (plus "No bot"/none), `change` handler sets `pane.agentId` and calls `registerSessionAgent(pane.sessionId, pane.agentId)`.
- [ ] **Step 2:** In `app.js` the `initParallelBoard({...})` call site (`:6240-6244`) must pass `getAgents: () => client.getAgents()` and `registerSessionAgent`. `initParallelBoard` caches the agents list (refresh it when the Parallel view opens) and picks a new pane's agent with `const used = new Set(panes.map((p) => p.agentId)); const next = agents.find((a) => !used.has(a.id)) || agents[panes.length % agents.length] || null; createPane(sessionId, next?.id ?? null);`. `send()` uses `pane.agentId` (not global `getAgentId()`) in `client.sendQuery`; call `registerSessionAgent(pane.sessionId, pane.agentId)` before send. `broadcast()` iterates panes using each `pane.agentId`.
- [ ] **Step 3:** `app.js`: implement `agentIdForSession` Map; `getAgentIdForSession(id)` checks Map then `bot_`/`sub_agent_` inference then `getSessions()` meta. Replace `setBotCardStatus(activeAgentId,'busy')` at `:5167` with `setBotCardStatus(getAgentIdForSession(event.sessionId),'busy')`.
- [ ] **Step 4:** Harness: open Parallel view, create two panes, select different agents, send from each, assert both panes carry different `agentId` and events attributed to their own sessions; assert no global-agent leakage.
- [ ] **Step 5:** Run build + tests; commit P3; update `CONTEXT.md` Phase 3 log and commit.

---

## P4 — Delegation UX and persistence

### Task 7: Durable delegated results
**Files:** `packages/desktop/src/ipc-bridge.ts`, `preload.cts`, `main.ts`, `desktop-server.ts`, `renderer/app.js`, `renderer/modules/session-buffers.js`, harness test
- [ ] **Step 1:** `ipc-bridge.ts`: import `TranscriptManager` from `@opensand/coordinator`; add `recordDelegatedResult({targetSessionId, sourceSessionId, childSessionId, agentId, content})`. Validate ids with the existing regex/path-traversal helper. Read `path.join(this.baseDir, 'sessions', targetSessionId, 'event-log.jsonl')` using the same file-read/JSON-parse pattern as `ipc-bridge.ts:536-551` (which reads the event log; `loadSession` at `:1182-1227` reads `transcript.jsonl` chat lines and is **not** suitable). Scan parsed records for `kind === 'delegated_result'` with matching `(sourceSessionId, childSessionId)`; if present, return without writing. Otherwise:
```ts
const tm = new TranscriptManager(targetSessionId, path.join(this.baseDir, 'sessions'));
await tm.recordEvent('delegated_result', { sourceSessionId, childSessionId, agentId, content, at: Date.now() });
```
`recordEvent(kind, data)` takes the kind **first** (`transcript-manager.ts:154`, constructor `(sessionId, customBaseDir?)` at `:119`); there is no `this.transcriptManager` on the bridge.
- [ ] **Step 2:** Wire `opensand:recordDelegatedResult` in preload/main and `POST /api/sessions/:id/delegated-result` in desktop-server; renderer `ApiClient.recordDelegatedResult(...)`.
- [ ] **Step 3:** `app.js` delegation handler (`~5141-5166`): on child `turn_completed`, call `client.recordDelegatedResult({targetSessionId:'bot_'+targetId, sourceSessionId:event.sessionId, childSessionId: await (async () => { if (event.subagent?.sessionId) return event.subagent.sessionId; const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(finalContent)); return `hash-${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`; })(), agentId:targetId, content:finalContent})`. Web Crypto is available in the renderer; `createHash` is not (nodeIntegration false, `main.ts:124-126`). Append to buffer with `dedupeKey = sourceSessionId+'|'+childSessionId`. Extend `sessionBuffers.append(sessionId, message)` to accept `message.dedupeKey`; `drain(sessionId, knownKeys = new Set())` skips messages whose key is in `knownKeys`.
- [ ] **Step 4:** `loadSession()` (`ipc-bridge.ts:1182-1227`) must also parse the target session's `event-log.jsonl` and include `kind === 'delegated_result'` records in its returned `events` array (or a dedicated `delegatedResults` field), otherwise a reload cannot show them. `selectSession()` passes those loaded keys into `drain()`. `reconstructDialogueTurns()` renders `delegated_result` events as assistant messages with a `delegated` marker. Parent compact line becomes a button that calls `selectBotSession('bot_'+targetId, {id:targetId,name:event.subagent.agentName})`.
- [ ] **Step 5:** Harness: two background fan-out results from one parent persist; reload shows both once; compact reference opens target; no duplicates; hidden bots' Show-more unread still works.
- [ ] **Step 6:** Run build + tests; commit P4; update `CONTEXT.md` Phase 4 log and commit.

---

## P5 — Verification and documentation

- [ ] **Step 1:** Full hermetic gate: `HOME=/tmp/opensand-hermetic-home pnpm build && HOME=/tmp/opensand-hermetic-home pnpm test`; report pass/fail/skip counts.
- [ ] **Step 2:** Live screenshots via `scripts/capture-ui.sh` (with `--user-data-dir` workaround if needed): (a) tree expanded with nested sessions + chief badge, (b) tree collapsed, (c) chief picker open, (d) parallel board with two different bots. Read PNGs.
- [ ] **Step 3:** Per-phase spec + quality reviews and final whole-implementation review; fix loops until approved.
- [ ] **Step 4:** `AGENTS_LEARNING.md` new lesson; in `CONTEXT.md` section 6 add a `### Phase N — … (COMPLETE)` heading for each phase with commit hash/test counts/evidence, and update the stale Phase 0 line from "design pending owner approval" to "approved, implemented"; commit both.

## Guardrails
- Explicit `git add <paths>` only; never stage `pnpm-lock.yaml`, CI, or untracked user files.
- `.delegated-badge`, `window.__railState`, strict session-id validation, and existing hover actions remain stable contracts.
- No push/merge; local commits only.
