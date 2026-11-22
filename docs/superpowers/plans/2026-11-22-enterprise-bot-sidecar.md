# Enterprise-grade bot sidebar section Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `#botList` into a persistent Orca-style "Bots" section in the left sidebar with search, status overlays, overflow ("Show N more") and keyboard navigation, while preserving delegated-badge and session behavior.

**Architecture:** `index.html` provides the sidebar section shell; `bot-rail.js` owns card DOM plus filter/expanded state and exposes `render/applyFilter/setExpanded/isExpanded`; `app.js` owns only search-panel open state and button wiring; `styles.css` scopes all new visuals under `.bot-sidecar` and reuses existing tokens. No server, session-buffer, identity-editor, or delegation changes.

**Tech Stack:** vanilla JS renderer (ES modules), Electron window harness (TAP/tsx), CSS tokens, existing inline SVG sprite.

**Spec:** `docs/superpowers/specs/2026-11-22-enterprise-bot-sidecar-design.md`

---

## File structure

- Modify `packages/desktop/renderer/index.html` — relocate `#botList`, add sidebar section markup; remove old roster from `#viewTemplates`.
- Modify `packages/desktop/renderer/styles.css` — `.bot-sidecar*` styles, `.bot-rail` cap removal, scoped row/status styling.
- Modify `packages/desktop/renderer/modules/bot-rail.js` — stateful render, filter, overflow, keyboard nav.
- Modify `packages/desktop/renderer/app.js` — search toggle, new-bot button, show-more wiring; `window.__railState` unchanged.
- Test `packages/desktop/test/window-harness.test.ts` — add assertions per chunk; never weaken existing ones.

## Chunk 1: Sidebar mount + visual shell

### Task 1: Harness test for section placement (failing)

**Files:** `packages/desktop/test/window-harness.test.ts`

- [ ] **Step 1: Add a new test immediately after the existing per-bot rail test (currently ends at `:676`).**

```ts
test("Real-Window Harness: bot roster lives in a persistent sidebar section", async (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-ui-sidebar-bots-home-"));
  const script = [
    "(async () => {",
    "  await new Promise((r) => setTimeout(r, 350));",
    "  const list = document.getElementById('botList');",
    "  const section = document.getElementById('botSidecar');",
    "  const nodeBefore = list;",
    "  const chatVisible = !document.getElementById('viewChat').classList.contains('hidden');",
    "  document.getElementById('navBtnBots').click();",
    "  await new Promise((r) => setTimeout(r, 200));",
    "  document.getElementById('btnBackToChat').click();",
    "  await new Promise((r) => setTimeout(r, 250));",
    "  return {",
    "    chatVisible,",
    "    inSection: section?.contains(list) === true,",
    "    sectionInSidebar: !!section?.closest('aside.sidebar'),",
    "    sectionNotInView: !section?.closest('.view-panel'),",
    "    sameNode: document.getElementById('botList') === nodeBefore,",
    "    visible: !!list && getComputedStyle(section).display !== 'none' && list.getBoundingClientRect().width > 0,",
    "    searchToggle: !!document.getElementById('btnBotSearch'),",
    "    newButton: !!document.getElementById('btnBotNew'),",
    "    moreButton: !!document.getElementById('btnBotShowMore'),",
    "  };",
    "})()",
  ].join("\n");
  try {
    const r = await runHarness("default", { home: tmpHome, interactScript: script });
    if (r.skipped) { t.skip(r.skipped); return; }
    const v = r.interactResult || {};
    assert.strictEqual(v.chatVisible, true, `chat view must be the boot view (${JSON.stringify(v)})`);
    assert.strictEqual(v.inSection, true, `#botList must live inside #botSidecar (${JSON.stringify(v)})`);
    assert.strictEqual(v.sectionInSidebar, true, `Bots section must be in aside.sidebar (${JSON.stringify(v)})`);
    assert.strictEqual(v.sectionNotInView, true, `Bots section must not be inside a switchable view (${JSON.stringify(v)})`);
    assert.strictEqual(v.sameNode, true, `view switches must not replace #botList (${JSON.stringify(v)})`);
    assert.strictEqual(v.visible, true, `Bots section must be visible in chat view (${JSON.stringify(v)})`);
    assert.strictEqual(v.searchToggle, true, `search toggle must exist (${JSON.stringify(v)})`);
    assert.strictEqual(v.newButton, true, `new-bot button must exist (${JSON.stringify(v)})`);
    assert.strictEqual(v.moreButton, true, `show-more button must exist (${JSON.stringify(v)})`);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it and confirm it fails.**

Run: `pnpm --filter @opensand/desktop run build && pnpm --filter @opensand/desktop run test`
Expected: new test FAILS with `#botList must live inside #botSidecar`.

### Task 2: Move the markup

**Files:** `packages/desktop/renderer/index.html`

- [ ] **Step 1: Insert the section after the conversation search box and before the roster container (between `:86` and `:88`).**

```html
      <!-- Bots section (Orca-style: persistent in the sidebar spine) -->
      <section class="bot-sidecar" id="botSidecar" aria-label="Bots">
        <div class="bot-sidecar-header">
          <span class="bot-sidecar-title">Bots</span>
          <div class="bot-sidecar-actions">
            <button id="btnBotSearch" class="btn-icon-ghost" aria-label="Search bots" aria-expanded="false" title="Search bots">
              <svg class="icon" aria-hidden="true" focusable="false"><use href="#i-search"></use></svg>
            </button>
            <button id="btnBotNew" class="btn-icon-ghost" aria-label="New bot" title="New bot">
              <svg class="icon" aria-hidden="true" focusable="false"><use href="#i-plus"></use></svg>
            </button>
          </div>
        </div>
        <div class="bot-sidecar-search hidden" id="botSearchWrap">
          <svg class="icon" aria-hidden="true" focusable="false"><use href="#i-search"></use></svg>
          <input id="botSidecarSearch" type="search" placeholder="Search bots" aria-label="Search bots" />
        </div>
        <div class="bot-rail" id="botList" role="list"></div>
        <button class="bot-sidecar-more hidden" id="btnBotShowMore" type="button"></button>
      </section>
```

Before using `#i-search` / `#i-plus`, check the sprite at `index.html:12-57`; if an id is absent, use the same inline SVG pattern as `#btnNewSession` at `:71` instead.

- [ ] **Step 2: Delete the old roster lines from `#viewTemplates` (`:483-484`):**

```html
          <div class="sidebar-section-title" style="margin-top: 14px;">Active Persona Roster</div>
          <div class="bot-rail" id="botList"></div>
```

Keep the `Active Workspace Tasks` and `Available Agent Personas…` sections untouched.

### Task 3: Style the shell

**Files:** `packages/desktop/renderer/styles.css`

- [ ] **Step 1: Replace the `.bot-rail` block (`:4402-4406`) and add the sidebar-section block.**

```css
/* ---- Bots section in the sidebar spine (Orca-style) --------------------- */
.bot-sidecar {
  flex: 0 0 auto; padding: 6px 4px 8px;
  border-bottom: 1px solid var(--border-color);
}
.bot-sidecar-header { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 0 6px 4px; }
.bot-sidecar-title { font-size: 10.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--text-muted); }
.bot-sidecar-actions { display: flex; align-items: center; gap: 2px; }
.bot-sidecar-search { display: flex; align-items: center; gap: 6px; margin: 0 4px 6px; padding: 4px 7px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-input); }
.bot-sidecar-search .icon { width: 13px; height: 13px; color: var(--text-muted); flex: none; }
.bot-sidecar-search input { width: 100%; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text-main); font: inherit; font-size: 11.5px; }
.bot-sidecar-search.hidden { display: none; }
.bot-sidecar-more { display: block; width: calc(100% - 8px); margin: 4px 4px 0; padding: 4px 6px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: transparent; color: var(--text-muted); font-size: 11px; cursor: pointer; }
.bot-sidecar-more:hover { background: var(--bg-hover); color: var(--text-main); }
.bot-sidecar-more.hidden { display: none; }

.bot-rail { display: flex; flex-direction: column; gap: 3px; }
```

Do **not** change `.bot-item` (`:1993-2068`) or the avatar/status rules (`:4361-4384`); row-level overrides come in Chunk 2, scoped under `.bot-sidecar`.

- [ ] **Step 2: Run build + desktop tests; the new test must pass and all prior tests remain green.**

Run: `pnpm --filter @opensand/desktop run build && pnpm --filter @opensand/desktop run test`
Expected: 130 desktop tests pass (129 prior + 1 new).

- [ ] **Step 3: Commit.**

```bash
git add packages/desktop/renderer/index.html packages/desktop/renderer/styles.css packages/desktop/test/window-harness.test.ts
git commit -m "feat(ui): relocate bot roster into persistent sidebar section"
```

---

## Chunk 2: Stateful rail module (filter, overflow, keyboard)

### Task 4: Harness test for filter/overflow/keyboard (failing)

**Files:** `packages/desktop/test/window-harness.test.ts`

- [ ] **Step 1: Seed 8 agents in the Chunk 1 test's `tmpHome/.opensand/agents` before `runHarness`.** One MUST be `agent_railbot_ab12cd34` with `name: "CTO Bot"`, `provider: "openrouter"`, `model: "cto-model"`; the other 7 have distinct ids, names like `Bot 1`…`Bot 7`, `provider: "global"`, `model: "default"`. Reuse the agent JSON shape from the existing rail test (`id`, `name`, `role`, `systemPrompt`, `kind: "AGENT"`, `model`, `provider`, `createdAt`, `updatedAt`). **Set CTO Bot's `createdAt` to `Date.now() + 100000` and every other agent's to `Date.now()`** — `listAgents()` (`agent-store.ts:252-274`) sorts newest-first, so CTO Bot is first in DOM and the ArrowDown focus assertion below is deterministic.

- [ ] **Step 2: Inside the async IIFE, assign async results to locals BEFORE `return { … }` (a Promise property serializes to `{}` in the harness).**

```ts
    "  const input = document.getElementById('botSidecarSearch');",
    "  input.value = 'cto';",
    "  input.dispatchEvent(new Event('input', { bubbles: true }));",
    "  const filteredCount = document.querySelectorAll('#botList .bot-rail-card[data-agent-id]').length;",
    "  input.value = '';",
    "  input.dispatchEvent(new Event('input', { bubbles: true }));",
    "  const filterClearedCount = document.querySelectorAll('#botList .bot-rail-card[data-agent-id]').length;",
    "  const moreLabel = document.getElementById('btnBotShowMore').textContent;",
    "  const moreVisible = !document.getElementById('btnBotShowMore').classList.contains('hidden');",
    "  document.getElementById('btnBotShowMore').click();",
    "  const expanded = document.querySelectorAll('#botList .bot-rail-card[data-agent-id]').length;",
    "  await window.__railState.refresh();",
    "  const afterRefresh = document.querySelectorAll('#botList .bot-rail-card[data-agent-id]').length;",
    "  const moreLabelAfter = document.getElementById('btnBotShowMore').textContent;",
    "  const card = document.querySelector('#botList .bot-rail-card[data-agent-id=\"agent_railbot_ab12cd34\"]');",
    "  card.focus();",
    "  const nextFocused = (() => { card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); return document.activeElement !== card; })();",
    "  card.focus();",
    "  card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));",
    "  await new Promise((r) => setTimeout(r, 200));",
    "  const kb = window.__railState.getActive();",
    "  return {",
    "    filteredCount, filterClearedCount, moreLabel, moreVisible, expanded, afterRefresh, moreLabelAfter, nextFocused,",
    "    keyboardSelect: { agent: kb.activeAgentId, session: kb.currentSessionId },",
    // …keep all existing rail-test properties in this return object…
```

Assertions (add after the existing ones in the same test):

```ts
    assert.strictEqual(v.filteredCount, 1, `search must narrow cards to the matching bot (${JSON.stringify(v)})`);
    assert.ok(v.filterClearedCount > v.filteredCount, `clearing search must restore cards (${JSON.stringify(v)})`);
    assert.strictEqual(v.moreVisible, true, `show-more must appear when agents exceed the limit (${JSON.stringify(v)})`);
    assert.match(String(v.moreLabel), /Show \d+ more/, `show-more label must count hidden bots (${JSON.stringify(v)})`);
    assert.strictEqual(v.afterRefresh, v.expanded, `expanded state must survive refreshBots() (${JSON.stringify(v)})`);
    assert.match(String(v.moreLabelAfter), /Show less/, `expanded show-more must offer Show less (${JSON.stringify(v)})`);
    assert.strictEqual(v.nextFocused, true, `ArrowDown must move focus to the next card (${JSON.stringify(v)})`);
    assert.strictEqual(v.keyboardSelect.agent, 'agent_railbot_ab12cd34', `Enter must select the focused card (${JSON.stringify(v)})`);
    assert.strictEqual(v.keyboardSelect.session, 'bot_agent_railbot_ab12cd34', `Enter must open the bot_ session (${JSON.stringify(v)})`);
```

- [ ] **Step 3: Run tests; expect the new assertions to fail (no filter / no overflow / no keyboard).**

Run: `pnpm --filter @opensand/desktop run build && pnpm --filter @opensand/desktop run test`
Expected: FAIL on `search must narrow cards to the matching bot`.

### Task 5: Rewrite the rail module

**Files:** `packages/desktop/renderer/modules/bot-rail.js`

- [ ] **Step 1: Replace the file with this complete implementation** (keeps the shipped `setBotCardStatus`/`setBotCardBadge` contracts and the unread-badge rehydration):

```js
/**
 * Bot sidebar section: one card per bot plus the Default Assistant row.
 * The module owns filter/expanded UI state; the controller owns search-panel
 * open state. Session buffers stay in the controller to avoid a cycle.
 */
import { escapeHtml } from './chat/markdown.js';
import { safeAvatarMarkup } from './bot-identity.js';

const VISIBLE_LIMIT = 6;
const uiIcon = (name, cls = 'icon') => `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;
const tint = (bot) => /^#[0-9a-fA-F]{3,8}$/.test(bot?.logoColor || '') ? bot.logoColor : 'var(--accent)';

function avatarMarkup(bot) {
  const avatar = safeAvatarMarkup(bot) || escapeHtml((bot.name || '?').trim().charAt(0).toUpperCase());
  return `<span class="bot-avatar" style="--bot-tint:${tint(bot)}">${avatar}</span>`;
}

function cardFor(agentId) {
  const selector = agentId
    ? `#botList .bot-rail-card[data-agent-id="${CSS.escape(String(agentId))}"]`
    : '#botList .bot-rail-card:not([data-agent-id])';
  return document.querySelector(selector);
}

export function setBotCardStatus(agentId, status) {
  if (!agentId) return;
  const card = cardFor(agentId);
  if (card) card.dataset.status = status;
}

export function setBotCardBadge(agentId, text) {
  if (!agentId) return;
  const card = cardFor(agentId);
  if (!card) return;
  let badge = card.querySelector('.delegated-badge');
  if (!text) { badge?.remove(); return; }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'delegated-badge';
    card.appendChild(badge);
  }
  badge.textContent = text;
}

export function createBotRail(options = {}) {
  const { buffers, getAgents, getActiveAgentId, onIdentity, onModel, onSelect, onDelete } = options;
  const list = document.getElementById('botList');
  let lastAgents = [];
  let filter = '';
  let expanded = false;

  function matches(bot) {
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return [bot?.name, bot?.role, bot?.provider, bot?.model]
      .some((v) => String(v || '').toLowerCase().includes(q));
  }

  function cardAttrs(bot, activeId) {
    const id = bot ? escapeHtml(bot.id || '') : '';
    const active = bot ? activeId === bot.id : activeId === null;
    const status = active ? 'active' : 'idle';
    const provider = bot?.provider || 'global';
    const model = bot?.model || 'default';
    const label = bot
      ? `${bot.name || ''} — ${provider} · ${model}`
      : 'Default Assistant — global · default';
    return `class="bot-rail-card bot-item ${active ? 'active' : ''}"
      ${id ? `data-agent-id="${id}"` : ''} data-status="${status}"
      role="button" tabindex="0" aria-current="${active}" aria-label="${escapeHtml(label)}"
      title="${escapeHtml(bot?.role || bot?.name || 'Default Assistant')}"`;
  }

  function statusDot() {
    return '<span class="bot-status-dot" aria-hidden="true"></span>';
  }

  function cardHtml(bot, activeId) {
    if (!bot) {
      return `<div ${cardAttrs(null, activeId)}>
        <span class="bot-avatar-wrap"><span class="bot-avatar default-avatar">${uiIcon('bot')}</span>${statusDot()}</span>
        <span class="bot-item-info"><span class="bot-item-name">Default Assistant</span>
          <span class="bot-item-sub">global · default</span></span>
      </div>`;
    }
    const provider = bot.provider || 'global';
    const id = escapeHtml(bot.id || '');
    return `<div ${cardAttrs(bot, activeId)}>
      <span class="bot-avatar-wrap">${avatarMarkup(bot)}
        <span class="bot-provider-badge" title="${escapeHtml(provider)}">${escapeHtml(provider.charAt(0).toUpperCase())}</span>
        ${statusDot()}</span>
      <span class="bot-item-info">
        <span class="bot-item-name">${escapeHtml(bot.name || '')}</span>
        <span class="bot-item-sub">${escapeHtml(provider)} · ${escapeHtml(bot.model || 'default')}${bot.role ? ` · ${escapeHtml(bot.role)}` : ''}</span>
      </span>
      <button class="btn-bot-identity" title="Edit identity" data-bot-id="${id}" aria-label="Edit bot identity">🎨</button>
      <button class="btn-bot-model" title="Choose provider & model" data-bot-id="${id}" aria-label="Choose provider and model">${uiIcon('spark')}</button>
      ${onDelete ? `<button class="btn-delete-bot" title="Delete bot" data-bot-id="${id}" aria-label="Delete bot">${uiIcon('trash')}</button>` : ''}
    </div>`;
  }

  function moveFocus(card, key) {
    const cards = Array.from(list.querySelectorAll('.bot-rail-card'));
    const i = cards.indexOf(card);
    const next = cards[i + (key === 'ArrowDown' ? 1 : -1)];
    if (next) next.focus();
  }

  function bindCards(agents) {
    cardFor(null)?.addEventListener('click', () => onSelect?.(null));
    for (const bot of agents) {
      const card = cardFor(bot.id);
      if (!card) continue;
      card.addEventListener('click', (event) => {
        if (event.target.closest('button')) return;
        onSelect?.(bot);
      });
      card.addEventListener('keydown', (event) => {
        if (event.target !== card) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect?.(bot);
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          moveFocus(card, event.key);
        }
      });
      card.querySelector('.btn-bot-identity')?.addEventListener('click', (event) => {
        event.stopPropagation();
        onIdentity?.(bot, event.currentTarget);
      });
      card.querySelector('.btn-bot-model')?.addEventListener('click', (event) => {
        event.stopPropagation();
        onModel?.(bot, event.currentTarget);
      });
      card.querySelector('.btn-delete-bot')?.addEventListener('click', (event) => {
        event.stopPropagation();
        if (window.confirm(`Are you sure you want to delete bot "${bot.name}"?`)) void onDelete?.(bot);
      });
    }
    list.querySelector('.bot-rail-card:not([data-agent-id])')?.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveFocus(event.currentTarget, event.key);
      }
    });
  }

  function syncMoreButton(totalMatches) {
    const more = document.getElementById('btnBotShowMore');
    if (!more) return;
    const hidden = filter.trim() ? 0 : Math.max(0, totalMatches - VISIBLE_LIMIT);
    more.classList.toggle('hidden', hidden === 0);
    more.textContent = !hidden ? '' : (expanded ? 'Show less' : `Show ${hidden} more bots`);
  }

  function renderRows() {
    if (!list) return;
    const activeId = typeof getActiveAgentId === 'function' ? getActiveAgentId() : null;
    const matchesAll = lastAgents.filter(matches);
    const shown = filter.trim() ? matchesAll : (expanded ? matchesAll : matchesAll.slice(0, VISIBLE_LIMIT));
    const defaultRow = filter.trim() && matchesAll.length === 0 ? '' : cardHtml(null, activeId);
    list.innerHTML = defaultRow + (shown.length
      ? shown.map((bot) => cardHtml(bot, activeId)).join('')
      : `<div class="bot-rail-empty">${filter.trim() ? 'No bots match' : 'No bots yet'}</div>`);
    if (buffers) {
      for (const bot of lastAgents) {
        if (bot.id && buffers.hasUnread('bot_' + bot.id)) setBotCardBadge(bot.id, 'delegated');
      }
    }
    syncMoreButton(matchesAll.length);
    bindCards(shown);
  }

  return {
    async render() {
      const agents = await getAgents?.();
      lastAgents = Array.isArray(agents) ? agents : [];
      renderRows();
    },
    applyFilter(text) { filter = String(text || ''); renderRows(); },
    setExpanded(value) { expanded = Boolean(value); renderRows(); },
    isExpanded() { return expanded; },
  };
}
```

`render()` issues exactly one `getAgents()` call and reuses the local `agents` value.

- [ ] **Step 2: Add scoped row styles AFTER the existing `.bot-rail-card .bot-avatar-wrap` / `.bot-avatar` / `.bot-avatar svg` rules (anchor on those selector texts, not line numbers — Chunk 1 shifts them). Equal-specificity rules later in the file win; do not insert before them.**

```css
.bot-sidecar .bot-rail-card { padding: 5px 7px; gap: 7px; border-color: transparent; background: transparent; }
.bot-sidecar .bot-rail-card:hover { background: var(--bg-hover); border-color: var(--border-color); }
.bot-sidecar .bot-rail-card.active { background: var(--accent-soft); border-color: var(--border-color); }
.bot-sidecar .bot-rail-card.active::before { content: ""; position: absolute; left: 0; top: 7px; bottom: 7px; width: 2px; border-radius: 2px; background: var(--accent); }
.bot-sidecar .bot-avatar-wrap { width: 30px; height: 30px; }
.bot-sidecar .bot-avatar { width: 30px; height: 30px; border-radius: 8px; font-size: 13px; }
.bot-sidecar .bot-avatar svg { width: 18px; height: 18px; }
.bot-sidecar .bot-status-dot { position: absolute; right: -3px; bottom: -2px; }
.bot-sidecar .bot-item-info { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.bot-sidecar .bot-item-name { font-size: 13px; line-height: 18px; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bot-sidecar .bot-item-sub { font-size: 11px; line-height: 14px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bot-sidecar .bot-model-chip { display: none; }
.bot-rail-empty { padding: 8px 7px; font-size: 11.5px; color: var(--text-muted); }
```

- [ ] **Step 3: Run build + tests; all green, including the new filter/overflow/keyboard assertions.**

Run: `pnpm --filter @opensand/desktop run build && pnpm --filter @opensand/desktop run test`

- [ ] **Step 4: Commit.**

```bash
git add packages/desktop/renderer/modules/bot-rail.js packages/desktop/renderer/styles.css packages/desktop/test/window-harness.test.ts
git commit -m "feat(ui): searchable, keyboard-accessible bot sidebar rows"
```

---

## Chunk 3: Controller wiring + full verification

### Task 6: Wire search / new-bot / show-more

**Files:** `packages/desktop/renderer/app.js`

- [ ] **Step 1: Add wiring immediately after the `createBotRail(...)` block (`:1347`), before `window.__railState`.** Note: Chunk 2 already added the `#botSidecarSearch` `input` listener and `#btnBotShowMore` `click` listener so its own harness assertions could pass. **Do NOT re-add those two** — a second listener would double-toggle `expanded` and double-render on every keystroke. Wire only the search toggle/open-state path and the new-bot button:

```js
  // Bot section controls: one open-state path, no stale toggle state.
  const botSearchWrap = document.getElementById('botSearchWrap');
  const botSearchInput = document.getElementById('botSidecarSearch');
  const botSearchToggle = document.getElementById('btnBotSearch');
  function setSearchOpen(open) {
    botSearchWrap.classList.toggle('hidden', !open);
    botSearchToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      botSearchInput.focus();
    } else {
      botSearchInput.value = '';
      botRail.applyFilter('');
      botSearchToggle.focus();
    }
  }
  botSearchToggle?.addEventListener('click', () => setSearchOpen(botSearchWrap.classList.contains('hidden')));
  botSearchInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); setSearchOpen(false); }
  });
  document.getElementById('btnBotNew')?.addEventListener('click', () => {
    document.getElementById('btnOpenCreateBot')?.click();
  });
```

Do not touch the delegation branch or `selectSession()`. `window.__railState` stays as shipped.

- [ ] **Step 2: Extend the Chunk 1/2 harness script with control assertions.**

```ts
    // Place these two lines BEFORE the script's `return { … }`, then include
    // `searchFlow` in that returned object.
    const searchFlow = await (async () => {
      const toggle = document.getElementById('btnBotSearch');
      const input = document.getElementById('botSidecarSearch');
      toggle.click();
      const opened = !document.getElementById('botSearchWrap').classList.contains('hidden')
        && document.activeElement === input
        && toggle.getAttribute('aria-expanded') === 'true';
      input.value = 'cto';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const narrowed = document.querySelectorAll('#botList .bot-rail-card').length;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return {
        opened,
        narrowed,
        closed: document.getElementById('botSearchWrap').classList.contains('hidden'),
        focusReturned: document.activeElement === toggle,
        restored: document.querySelectorAll('#botList .bot-rail-card').length,
      };
    })();
```

```ts
    assert.strictEqual(v.searchFlow.opened, true, `search toggle must open and focus the input (${JSON.stringify(v)})`);
    assert.strictEqual(v.searchFlow.closed, true, `Escape must close search (${JSON.stringify(v)})`);
    assert.strictEqual(v.searchFlow.focusReturned, true, `Escape must return focus to the toggle (${JSON.stringify(v)})`);
    assert.strictEqual(v.searchFlow.restored > v.searchFlow.narrowed, true, `closing search must restore all cards (${JSON.stringify(v)})`);
```

- [ ] **Step 3: Run build + desktop tests; 130 tests green.**

### Task 7: Full verification and commit

- [ ] **Step 1: Full hermetic gate.**

Run: `HOME=/tmp/opensand-hermetic-home pnpm build && HOME=/tmp/opensand-hermetic-home pnpm test`
Expected: all packages green, 0 failures (prior baseline 655 + new assertions).

- [ ] **Step 2: Live screenshots.**

Write `/tmp/sidebar-bots-interaction.js` that waits ~500 ms, clicks `#btnBotSearch`, types `cto` into `#botSidecarSearch`, waits ~300 ms and returns counts. Run `bash scripts/capture-ui.sh sidebar-bots-search /tmp/sidebar-bots-interaction.js /tmp/opensand-ui-capture-home`, then read the PNG. Repeat once with a plain chat-view capture (no interaction) for the expanded section. Confirm the section is visibly present in the sidebar.

- [ ] **Step 3: Spec + code-quality reviews of the whole diff** (subagent reviewers, fix loops until ✅).

- [ ] **Step 4: Commit via `scripts/ship_phase.sh` with explicit paths only.**

```bash
HOME=/tmp/opensand-hermetic-home SHIP_PATHS="packages/desktop/renderer/index.html packages/desktop/renderer/styles.css packages/desktop/renderer/modules/bot-rail.js packages/desktop/renderer/app.js packages/desktop/test/window-harness.test.ts" bash scripts/ship_phase.sh "feat(ui): Orca-style bot sidebar section with search and keyboard nav" sidebar-bots
```

## Notes / guardrails

- Existing delegated-badge behavior and `.delegated-badge` class are a stable harness hook — never rename or remove.
- `window.__railState` stays unchanged so all prior harness tests keep working.
- No new dependencies. All icons from the existing sprite or inline SVG.
- If the reference screenshot becomes readable later, tune only Chunk 1 CSS spacing/colors; no module changes should be needed.
