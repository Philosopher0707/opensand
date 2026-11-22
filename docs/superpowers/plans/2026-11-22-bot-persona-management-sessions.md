# Bot persona, management and sessions Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each bot speak with its own persona, stop `Invalid sessionId: null`, and let users rename/delete bots and open all of a bot's sessions from the sidebar Bots section.

**Architecture:** Four independent chunks: (A) one renderer guard for null session ids; (B) authoritative bot identity in the shared system prompt plus `bot_<id>` agent inference/meta self-healing; (C) a two-card bot inspector popover for manage + sessions, wired to existing `updateAgentProfile`/`deleteAgent`/`getSessions`; (D) session-list completion, new-session action and full verification. No new dependency, no server schema change.

**Tech Stack:** vanilla JS ES modules, Electron IPC + REST, TypeScript coordinator/IPC bridge, TAP/tsx renderer window harness, CSS tokens.

**Spec:** `docs/superpowers/specs/2026-11-22-bot-persona-management-sessions-design.md`
**Baseline HEAD:** `6371e8a`, branch `feat/agent-settings-ui`. Never stage `pnpm-lock.yaml` or the pre-existing untracked files.

---

## Chunk A: null-session guard

### Task 1: Failing harness test

**Files:** `packages/desktop/test/window-harness.test.ts`

- [ ] **Step 1: Add a new test after the sidebar-section test (currently ends ~`:820`).**

```ts
test("Real-Window Harness: Default Assistant card clears session without load error", async (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-ui-default-card-home-"));
  const script = [
    "(async () => {",
    "  await new Promise((r) => setTimeout(r, 350));",
    "  const card = document.querySelector('#botList .bot-rail-card:not([data-agent-id])');",
    "  card.click();",
    "  await new Promise((r) => setTimeout(r, 250));",
    "  return {",
    "    feed: document.getElementById('messageFeed').textContent,",
    "    active: window.__railState.getActive(),",
    "    welcomeVisible: !document.getElementById('welcomeBanner').classList.contains('hidden'),",
    "  };",
    "})()",
  ].join("\n");
  try {
    const r = await runHarness("default", { home: tmpHome, interactScript: script });
    if (r.skipped) { t.skip(r.skipped); return; }
    const v = r.interactResult || {};
    assert.ok(!String(v.feed).includes('Error loading session:'), `default card must not show a session error (${JSON.stringify(v)})`);
    assert.strictEqual(v.active?.currentSessionId, null, `default card must clear the session id (${JSON.stringify(v)})`);
    assert.strictEqual(v.welcomeVisible, true, `default card must restore the welcome banner (${JSON.stringify(v)})`);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it and confirm failure.**

Run: `pnpm --filter @opensand/desktop run build && pnpm --filter @opensand/desktop run test`
Expected: new test FAILS on `default card must not show a session error`.

### Task 2: Guard in `selectSession`

**Files:** `packages/desktop/renderer/app.js`

- [ ] **Step 1: At the very start of `selectSession(sessionId)` (`:4197`), insert:**

```js
  if (!sessionId) {
    startNewSession();
    return;
  }
```

No other code changes. `startNewSession()` already clears `SESSION_KEY`, resets state and shows the welcome banner.

- [ ] **Step 2:** Run build + desktop tests. All 131 tests pass (130 prior + 1 new).

- [ ] **Step 3:** Commit explicit paths: `packages/desktop/renderer/app.js packages/desktop/test/window-harness.test.ts`, message `fix(ui): default assistant card no longer loads a null session`.

---

## Chunk B: persona boundaries

### Task 3: Failing unit tests

**Files:** `packages/coordinator/test/system-prompt.test.ts`, `packages/desktop/test/ipc-bridge.test.ts`

- [ ] **Step 1: Add to `system-prompt.test.ts`:**

```ts
it("buildSystemPrompt gives an agent an authoritative identity", () => {
  const prompt = buildSystemPrompt({
    workspaceDir: "/tmp/ws",
    agentName: "Security Sentinel",
    agentRole: "Security reviewer",
    userInstructions: "Always cite the exact file and line.",
  });
  assert.match(prompt, /^You are Security Sentinel — Security reviewer, a specialist bot operating inside OpenSand\./);
  assert.match(prompt, /## Persona Boundary/);
  assert.match(prompt, /## User Custom Instructions/);
  assert.doesNotMatch(prompt.split("\n")[0], /You are OpenSand/);
});
```

Keep the existing default test (`assert.match(buildSystemPrompt(), /You are OpenSand/)`) unchanged.

- [ ] **Step 2: Add to `ipc-bridge.test.ts`, following that file's own idiom (every test creates its own `tmpDir` and `new DesktopIpcBridge({ baseDir: tmpDir })` — there is no shared `tmpHome`/`bridge` variable):**

```ts
test("loadSession infers the owning bot agent from a bot_<id> session id", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-bot-infer-"));
  try {
    const bridge = new DesktopIpcBridge({ baseDir: tmpDir });
    const id = "agent_infer_me_ab12cd34";
    const sessionId = `bot_${id}`;
    const dir = path.join(tmpDir, "sessions", sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ sessionId, agentId: null }), "utf8");
    const loaded = await bridge.loadSession(sessionId);
    assert.strictEqual(loaded.agentId, id);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
```

The meta path is `<baseDir>/sessions/<id>/meta.json` (`ipc-bridge.ts:1187`, `:519`), **not** `<baseDir>/.opensand/sessions/...`.

- [ ] **Step 3:** Run `pnpm --filter @opensand/coordinator run build && pnpm --filter @opensand/coordinator test && pnpm --filter @opensand/desktop run build && pnpm --filter @opensand/desktop test`. Build first — the `test` scripts run against `dist/` and have no pretest hook. Expected: both new tests FAIL (identity line generic; inferred agent undefined).

### Task 4: Implement identity in the system prompt

**Files:** `packages/coordinator/src/system-prompt.ts`, `packages/desktop/src/ipc-bridge.ts`, `packages/coordinator/src/orchestrator-tools.ts`, `packages/cli/src/cli-app.ts`

- [ ] **Step 1:** In `system-prompt.ts` extend the interface and identity line:

```ts
export interface SystemPromptContext {
  workspaceDir?: string;
  userInstructions?: string;
  learnedRules?: string;
  memoryContext?: string;
  skillsContext?: string;
  platform?: string;
  shell?: string;
  agentName?: string;
  agentRole?: string;
}
```

```ts
  const identity = context.agentName
    ? `You are ${context.agentName}${context.agentRole ? ` — ${context.agentRole}` : ''}, a specialist bot operating inside OpenSand.`
    : 'You are OpenSand, an autonomous AI coding and systems engineering assistant.';
  const personaBoundary = context.agentName
    ? '\n## Persona Boundary\nThe identity above is authoritative for this session. The instructions below define this bot\'s voice, role and constraints and take precedence over generic OpenSand defaults where they conflict.'
    : '';
```

Replace line 19 with `${identity}` and insert `${personaBoundary}` immediately before the existing `${context.userInstructions ? ...}` block on line 58. Keep the `## User Custom Instructions` heading exactly as-is.

- [ ] **Step 2:** Pass identity at all three call sites:
  - `ipc-bridge.ts`: the `const agent = await this.agentStore.getAgent(agentId)` at `:636` is block-scoped inside `if (agentId) { … }` (`:635-650`). Hoist `let agent: AgentRecord | undefined;` **before** `:635`, assign inside the block (`agent = await …`), and add `agentName: agent?.name, agentRole: agent?.role` to the coordinator's `systemPromptContext` at `:708-713`. Do not reference `agent` at `:708` without hoisting — it would not compile.
  - `orchestrator-tools.ts:483-488`: `agent` is in scope — add `agentName: agent.name, agentRole: agent.role`.
  - `cli-app.ts:405-414`: add the same fields from the CLI's resolved agent record (`activeAgent` is in scope).

- [ ] **Step 3:** Add a bridge test for delete invalidation using the file's own `tmpDir`/local `bridge` idiom:

```ts
test("deleteAgent invalidates cached coordinators", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-bot-delete-"));
  try {
    const bridge = new DesktopIpcBridge({ baseDir: tmpDir });
    const agent = await bridge.createAgent({ name: "Delete Me", role: "Tester", systemPrompt: "x" });
    const sessionId = `bot_${agent.id}`;
    const before = await bridge.createSessionCoordinator(sessionId, agent.id);
    await bridge.deleteAgent(agent.id);
    const after = await bridge.createSessionCoordinator(sessionId, agent.id);
    assert.notStrictEqual(after, before, "a deleted agent must not keep its cached coordinator");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
```

`coordinatorMap` is private; the observable identity check above is the assertion. `CreateAgentInput` requires `role`, so include it. Keep the exact em dash `—` when transcribing the identity line.

### Task 5: Implement inference + meta self-healing + delete invalidation

**Files:** `packages/desktop/src/ipc-bridge.ts`

- [ ] **Step 1:** Extend `inferAgentIdFromSessionId` (`:589-596`):

```ts
  private inferAgentIdFromSessionId(sessionId: string): string | undefined {
    const child = sessionId.match(/^sub_agent_(.+)_(\d{10,})$/);
    if (child) return child[1];
    const bot = sessionId.match(/^bot_(agent_[A-Za-z0-9_]+)$/);
    return bot ? bot[1] : undefined;
  }
```

- [ ] **Step 2:** In `writeSessionMeta` (`:560-587`) replace `agentId: agentId ?? null,` with:

```ts
        agentId: this.inferAgentIdFromSessionId(sessionId) ?? agentId ?? previous.agentId ?? null,
```

No new write call — this runs on every coordinator creation.

- [ ] **Step 3:** In `deleteAgent` (`:1033-1040`), call the existing private `invalidateAgentCoordinators` helper (`:1042-1055`) with the deleted agent id on **both** success paths — before the ROOM early return (`:1036-1038`) and before the normal return (`:1039`) — matching `updateAgentSettings`/`updateAgentProfile`.

- [ ] **Step 4:** Add the backfill regression test to `ipc-bridge.test.ts` (same `tmpDir`/local `bridge` idiom):

```ts
test("a bot_ session meta self-heals its agentId on the next turn", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-bot-backfill-"));
  try {
    const bridge = new DesktopIpcBridge({ baseDir: tmpDir });
    const agent = await bridge.createAgent({ name: "Backfill", role: "Tester", systemPrompt: "x" });
    const sessionId = `bot_${agent.id}`;
    const dir = path.join(tmpDir, "sessions", sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ sessionId, agentId: null }), "utf8");
    // No agentId argument: inference from `bot_<id>` must be the only source,
    // otherwise this test would pass against the old `agentId ?? null` line.
    await bridge.createSessionCoordinator(sessionId);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
    assert.strictEqual(meta.agentId, agent.id);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 5:** Run `pnpm --filter @opensand/coordinator run build && pnpm --filter @opensand/coordinator test && pnpm --filter @opensand/desktop run build && pnpm --filter @opensand/desktop test`. All green.

- [ ] **Step 6:** Commit explicit paths only, message `fix(ai): bot identity in system prompt and bot session agent inference`.

---

## Chunk C: inspector popover, rename and delete

### Task 6: Failing harness tests

**Files:** `packages/desktop/test/window-harness.test.ts`

- [ ] **Step 1: Add one test that seeds two agents (`agent_insp_a1`, `agent_insp_b2`) and a `bot_agent_insp_a1` session via `seedSessions`, then drives the inspector:**

```ts
test("Real-Window Harness: inspector renames and deletes a bot", async (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-ui-inspector-home-"));
  const agentPath = path.join(tmpHome, ".opensand", "agents");
  fs.mkdirSync(agentPath, { recursive: true });
  seedSessions(tmpHome, [{ id: "bot_agent_insp_a1", firstLine: "bot-home-history" }]);
  const now = Date.now();
  for (const [id, name] of [["agent_insp_a1", "Alpha Bot"], ["agent_insp_b2", "Beta Bot"]] as const) {
    fs.writeFileSync(path.join(agentPath, `${id}.json`), JSON.stringify({
      id, name, role: "Tester", systemPrompt: `You are ${name}.`, kind: "AGENT",
      model: "default", provider: "global", createdAt: now, updatedAt: now,
    }), "utf8");
  }
  const script = [
    "(async () => {",
    "  await new Promise((r) => setTimeout(r, 350));",
    "  const card = document.querySelector('#botList .bot-rail-card[data-agent-id=\"agent_insp_a1\"]');",
    "  const btn = card.querySelector('.btn-bot-inspect');",
    "  btn.click();",
    "  await new Promise((r) => setTimeout(r, 150));",
    "  const dialog = document.querySelector('.inspector-popover');",
    "  const cards = dialog ? dialog.querySelectorAll('.inspector-card').length : -1;",
    "  const input = dialog?.querySelector('.inspector-name');",
    "  input.value = 'Renamed Alpha';",
    "  dialog.querySelector('.inspector-rename').click();",
    "  let renamed = null;",
    "  let cardName = null;",
    "  for (let i = 0; i < 20; i++) {",
    "    const agents = await (await fetch('/api/agents')).json();",
    "    renamed = (agents || []).find((a) => a.id === 'agent_insp_a1')?.name;",
    "    cardName = document.querySelector('#botList .bot-rail-card[data-agent-id=\"agent_insp_a1\"] .bot-item-name')?.textContent;",
    "    if (renamed === 'Renamed Alpha' && cardName === 'Renamed Alpha') break;",
    "    await new Promise((r) => setTimeout(r, 100));",
    "  }",
    "  const sessionsBtn = document.querySelector('#botList .bot-rail-card[data-agent-id=\"agent_insp_b2\"] .btn-bot-inspect');",
    "  sessionsBtn.click();",
    "  await new Promise((r) => setTimeout(r, 150));",
    "  const betaSessionRows = document.querySelectorAll('.inspector-popover .inspector-session').length;",
    "  return { cards, renamed, cardName, betaSessionRows };",
    "})()",
  ].join("\n");
  try {
    const r = await runHarness("default", { home: tmpHome, interactScript: script });
    if (r.skipped) { t.skip(r.skipped); return; }
    const v = r.interactResult || {};
    assert.strictEqual(v.cards, 2, `inspector must have manage + sessions cards (${JSON.stringify(v)})`);
    assert.strictEqual(v.renamed, "Renamed Alpha", `rename must persist via API (${JSON.stringify(v)})`);
    assert.strictEqual(v.cardName, "Renamed Alpha", `rail must show the new name (${JSON.stringify(v)})`);
    assert.strictEqual(v.betaSessionRows, 1, `a bot with no real sessions shows exactly one synthetic home row (${JSON.stringify(v)})`);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
```

The synthetic home row uses class `.inspector-session`, so a bot with no real sessions has exactly 1 row; a bot with a real `bot_<id>` session also has exactly 1 row (the synthetic one is deduped). Both counts are pinned.

- [ ] **Step 2:** Run build + tests; expected FAIL because `.btn-bot-inspect` / `.inspector-popover` do not exist.

### Task 7: Implement the inspector module and wiring

**Files:** create `packages/desktop/renderer/modules/bot-inspector.js`; modify `bot-rail.js`, `app.js`, `styles.css`, `index.html` (sprite check only)

- [ ] **Step 1: Create `bot-inspector.js` with this complete implementation.**

```js
/** Bot inspector: one popover with a Manage card and a Sessions card. */
let root = null;
let onKeydown = null;
let returnFocus = null;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function close() {
  if (root) root.remove();
  root = null;
  if (onKeydown) document.removeEventListener('keydown', onKeydown);
  onKeydown = null;
  const restore = returnFocus;
  returnFocus = null;
  if (restore?.isConnected) restore.focus();
}

export function openBotInspector({
  bot, anchor, loadSessions, onRename, onIdentity, onModel, onDelete, onOpenSession, onNewSession,
} = {}) {
  close();
  returnFocus = anchor ?? null;
  root = el('div', 'inspector-backdrop');
  const popover = el('div', 'inspector-popover');
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-modal', 'true');
  popover.setAttribute('aria-label', `${bot?.name || 'Bot'} actions`);
  root.appendChild(popover);

  popover.appendChild(el('div', 'inspector-title', `${bot?.name || 'Bot'} · actions`));
  const error = el('div', 'inspector-error');
  error.hidden = true;
  popover.appendChild(error);

  const manage = el('section', 'inspector-card');
  manage.appendChild(el('h4', 'inspector-card-title', 'Manage bot'));
  const input = el('input', 'inspector-name');
  input.type = 'text';
  input.maxLength = 64;
  input.value = bot?.name || '';
  input.setAttribute('aria-label', 'Bot name');
  manage.appendChild(input);
  const actions = el('div', 'inspector-actions');
  const rename = el('button', 'inspector-rename', 'Rename');
  rename.type = 'button';
  const cancel = el('button', 'inspector-cancel', 'Cancel');
  cancel.type = 'button';
  cancel.onclick = close;
  const identity = el('button', 'inspector-identity', 'Change identity');
  identity.type = 'button';
  const model = el('button', 'inspector-model', 'Change model');
  model.type = 'button';
  const del = el('button', 'inspector-delete', 'Delete bot');
  del.type = 'button';
  actions.append(rename, cancel, identity, model, del);
  manage.appendChild(actions);
  popover.appendChild(manage);

  const sessions = el('section', 'inspector-card');
  sessions.appendChild(el('h4', 'inspector-card-title', 'Sessions'));
  const list = el('div', 'inspector-sessions');
  sessions.appendChild(list);
  const newBtn = el('button', 'inspector-new', 'New session with this bot');
  newBtn.type = 'button';
  sessions.appendChild(newBtn);
  popover.appendChild(sessions);

  async function run(fn) {
    try {
      error.hidden = true;
      await fn();
    } catch (err) {
      error.textContent = err?.message || 'Action failed';
      error.hidden = false;
    }
  }
  rename.onclick = () => run(async () => { await onRename?.(bot, input.value); close(); });
  // Dialog-opening callbacks must receive the ORIGINAL card button: closing the
  // inspector detaches its own buttons, giving getBoundingClientRect() zeros.
  const replaceDialog = (callback) => {
    void Promise.resolve()
      .then(() => { close(); return callback(anchor); })
      .catch((err) => console.error('[bot-inspector]', err));
  };
  // Only rename/delete keep the inspector open, so they are the callbacks whose
  // errors can be shown inline; dialog-opening callbacks are caught and logged.
  identity.onclick = () => replaceDialog((a) => onIdentity?.(bot, a));
  model.onclick = () => replaceDialog((a) => onModel?.(bot, a));
  del.onclick = () => {
    if (!window.confirm(`Are you sure you want to delete bot "${bot?.name}"?`)) return;
    void run(async () => { await onDelete?.(bot); close(); });
  };
  newBtn.onclick = () => replaceDialog(() => onNewSession?.(bot));

  async function renderSessions() {
    const items = await loadSessions?.();
    list.textContent = '';
    if (items === null || !Array.isArray(items)) {
      list.appendChild(el('div', 'inspector-empty', 'Sessions unavailable'));
      return;
    }
    const homeId = `bot_${bot?.id}`;
    const rows = items.slice();
    if (!rows.some((s) => s.id === homeId)) {
      rows.unshift({ id: homeId, title: `Bot home — ${bot?.name || 'bot'}`, messageCount: 0, updatedAt: null });
    }
    for (const s of rows) {
      const button = el('button', 'inspector-session');
      button.type = 'button';
      const when = s.updatedAt ? ` · ${new Date(s.updatedAt).toLocaleDateString()}` : '';
      button.textContent = `${s.title || s.id}${s.messageCount ? ` · ${s.messageCount} messages` : ''}${when}`;
      button.onclick = () => replaceDialog(() => onOpenSession?.(s.id, bot));
      list.appendChild(button);
    }
  }
  void renderSessions();

  root.onclick = (event) => { if (event.target === root) close(); };
  document.body.appendChild(root);
  input.focus();
  onKeydown = (event) => {
    if (event.key === 'Escape') { close(); return; }
    if (event.key !== 'Tab') return;
    const items = [...popover.querySelectorAll('button, input')].filter((n) => !n.disabled);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const outside = !popover.contains(document.activeElement);
    if (event.shiftKey && (outside || document.activeElement === first)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (outside || document.activeElement === last)) { event.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKeydown);

  if (anchor?.getBoundingClientRect) {
    const rect = anchor.getBoundingClientRect();
    popover.style.top = `${Math.min(rect.bottom + 8, Math.max(0, window.innerHeight - 440))}px`;
    popover.style.left = `${Math.min(rect.left, Math.max(0, window.innerWidth - 340))}px`;
  }
}
```

- [ ] **Step 2:** In `bot-rail.js`, destructure `onInspect` from options, add one card button to `cardHtml` for real bots:

```js
<button class="btn-bot-inspect" title="Bot actions and sessions" aria-label="Bot actions and sessions"><svg class="icon" aria-hidden="true" focusable="false"><use href="#i-clock"></use></svg></button>
```

Bind it in `bindCards` with `event.stopPropagation(); onInspect?.(bot, event.currentTarget);`. Leave `.delegated-badge`, `setBotCardStatus` and all existing actions untouched. `#i-clock` exists at `index.html:48`.

- [ ] **Step 3:** In `app.js`, define shared handlers ONCE before `createBotRail(...)` and reuse them for both the rail options and the inspector, so the two bodies cannot drift (the rail's existing `onDelete` already calls `refreshTokenBadge()`; the inspector must not lose it):

```js
  const botIdentityHandler = (b, a) => openBotIdentity({
    bot: b,
    anchor: a,
    onSave: async (patch) => { await client.updateAgentSettings(b.id, patch); await refreshBots(); },
  });
  const botModelHandler = (b, a) => openBotModelPicker(b, a);
  const botDeleteHandler = async (b) => {
    await client.deleteAgent(b.id);
    if (activeAgentId === b.id) {
      activeAgentId = null;
      badgeActiveBot.textContent = 'Default Assistant';
    }
    await refreshBots();
    refreshTokenBadge();
    localStorage.removeItem(AGENT_KEY);
    refreshTemplates();
  };
  const selectBotSession = (id, b) => {
    activeAgentId = b.id;
    badgeActiveBot.textContent = b.name;
    persistAgent();
    void selectSession(id);
  };
  const botInspectHandler = (bot, anchor) => openBotInspector({
    bot,
    anchor,
    loadSessions: async () => {
      try {
        const all = await client.getSessions();
        return all.filter((s) => s.agentId === bot.id || s.id === 'bot_' + bot.id);
      } catch { return null; }
    },
    onRename: async (b, name) => {
      const trimmed = String(name).trim();
      if (!trimmed || trimmed.length > 64) throw new Error('Name must be 1–64 characters');
      await client.updateAgentProfile(b.id, { name: trimmed });
      await refreshBots();
      refreshDetailPanel();
      if (activeAgentId === b.id) badgeActiveBot.textContent = trimmed;
    },
    onIdentity: botIdentityHandler,
    onModel: botModelHandler,
    onDelete: botDeleteHandler,
    onOpenSession: (id, b) => selectBotSession(id, b),
    onNewSession: (b) => selectBotSession('bot_' + b.id, b),
  });
```

Then change the existing `createBotRail({...})` options `onIdentity`/`onModel`/`onDelete` to `botIdentityHandler`/`botModelHandler`/`botDeleteHandler` and add `onInspect: botInspectHandler`. Import `openBotInspector` at the top of app.js with the other module imports. The inspector renders bot/session text with `textContent` (not `innerHTML`), which is inherently XSS-safe — this satisfies the spec's escaping requirement without importing `escapeHtml`.

- [ ] **Step 4:** Add CSS next to `.identity-*` in `styles.css`: `.inspector-backdrop`, `.inspector-popover` (fixed, z-index 135 like identity), `.inspector-title`, `.inspector-error`, `.inspector-card`, `.inspector-card-title`, `.inspector-name`, `.inspector-actions`, `.inspector-sessions`, `.inspector-session`, `.inspector-empty`, `.inspector-new` — token-based, focus-visible via global rule, motion-reduce compatible. Keep it compact.

- [ ] **Step 5:** Run build + tests; all green; commit explicit paths only, message `feat(ui): bot inspector with rename, delete and sessions cards`.

---

## Chunk D: session card completion and full verification

### Task 8: Harness assertions for sessions behavior

**Files:** `packages/desktop/test/window-harness.test.ts`

- [ ] **Step 1:** Extend the inspector test. A real `bot_agent_insp_a1` session is already seeded. Use DISTINCT field names (`alphaSessionRows`, `alphaSessionLabels`, `openedSession`) — the earlier `betaSessionRows` from Task 6 must not be redeclared. Add this BEFORE the Beta Bot click:

```ts
    "  const alphaCard = document.querySelector('#botList .bot-rail-card[data-agent-id=\"agent_insp_a1\"]');",
    "  alphaCard.querySelector('.btn-bot-inspect').click();",
    "  await new Promise((r) => setTimeout(r, 150));",
    "  const alphaSessionRows = [...document.querySelectorAll('.inspector-popover .inspector-session')];",
    "  const alphaSessionLabels = alphaSessionRows.map((r) => r.textContent);",
    "  alphaSessionRows[0]?.click();",
    "  await new Promise((r) => setTimeout(r, 250));",
    "  const openedSession = window.__railState.getActive().currentSessionId;",
```

Include all three in the returned object. Assertions:

```ts
    assert.strictEqual(v.alphaSessionRows.length, 1, `one bot home session must be listed once (${JSON.stringify(v)})`);
    assert.match(String(v.alphaSessionLabels[0]), /bot-home-history/, `the REAL session row must be listed, not the synthetic home (${JSON.stringify(v)})`);
    assert.strictEqual(v.openedSession, "bot_agent_insp_a1", `clicking a session must open it (${JSON.stringify(v)})`);
```

The seeded first line is `bot-home-history` (from `seedSessions`), so the label assertion genuinely distinguishes the real row from the synthetic `Bot home — …` row.

- [ ] **Step 2:** Add the delete-via-inspector round trip at the END of the same script (after the Beta inspector is open):

```ts
    "  window.confirm = () => true;",
    "  const betaDialog = document.querySelector('.inspector-popover');",
    "  betaDialog.querySelector('.inspector-delete').click();",
    "  let betaGone = false;",
    "  let betaCardGone = false;",
    "  for (let i = 0; i < 20; i++) {",
    "    const remaining = await (await fetch('/api/agents')).json();",
    "    betaGone = !(remaining || []).some((a) => a.id === 'agent_insp_b2');",
    "    betaCardGone = !document.querySelector('#botList .bot-rail-card[data-agent-id=\"agent_insp_b2\"]');",
    "    if (betaGone && betaCardGone) break;",
    "    await new Promise((r) => setTimeout(r, 100));",
    "  }",
```
Return `betaGone` and `betaCardGone`; assert both `true`:
```ts
    assert.strictEqual(v.betaGone, true, `delete must remove the agent from the API (${JSON.stringify(v)})`);
    assert.strictEqual(v.betaCardGone, true, `delete must remove the rail card (${JSON.stringify(v)})`);
```
Polling both avoids a race with the async `refreshBots()` in `botDeleteHandler`. (The rail's own delete button still confirms separately; here the inspector owns `window.confirm`, stubbed to `true`.)

- [ ] **Step 3:** Run `pnpm --filter @opensand/desktop run build && pnpm --filter @opensand/desktop run test`. Chunk C already implements these behaviors, so the new assertions must PASS; if any fails, fix the root cause in the inspector module/wiring rather than weakening the assertion.

### Task 9: Full verification and commit

- [ ] **Step 1:** Full hermetic gate: `HOME=/tmp/opensand-hermetic-home pnpm build && HOME=/tmp/opensand-hermetic-home pnpm test`. Expected: all packages green, 0 failures (Electron harness tests may legitimately self-skip without a display; report skips explicitly rather than implying every test ran). Prior baseline was 656 pass / 0 fail.
- [ ] **Step 2:** Live screenshots via `scripts/capture-ui.sh`: (a) inspector open on a seeded bot showing both cards, (b) default chat view with the Bots sidebar section. Read both PNGs.
- [ ] **Step 3:** Per-chunk spec + code-quality subagent reviews; fix loops until approved; final whole-implementation review.
- [ ] **Step 4:** Commit with explicit paths only via `scripts/ship_phase.sh` or `git add`, message `feat(ui): per-bot session access and persona/management verification`. Update `/tmp/opensand-job-ledger.md` progress and `AGENTS_LEARNING.md` with the new lessons.

## Guardrails
- Never stage `pnpm-lock.yaml`, CI files, or the pre-existing untracked docs/screenshots.
- `.delegated-badge`, `window.__railState`, and the strict session-id validation are stable contracts — do not rename or weaken.
- No push/merge; all commits local on `feat/agent-settings-ui`.
