# Bot Sidecar Sessions Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sidecar lists every bot as a compact card with its own session and editable inline-SVG identity; delegated work is rendered in the delegated bot's session.

**Architecture:** Three focused renderer modules over the existing HTTP/IPC surface: `bot-identity.js` (SVG templates + color/expression editor), `session-buffers.js` (per-session message map), `bot-rail.js` (card rendering + selection/actions). `app.js` wires them inside `DOMContentLoaded` and handles the delegated-event filter bypass. No backend schema change.

**Tech Stack:** vanilla JS renderer, existing `node:test` + real-Electron `window-harness`, inline SVG, CSS custom properties, no new dependencies.

Spec: `docs/superpowers/specs/2026-11-21-bot-sidecar-sessions-design.md`

---

## File Structure

- Create `packages/desktop/renderer/modules/bot-identity.js` — fixed SVG templates, color/expression presets, identity popover.
- Create `packages/desktop/renderer/modules/session-buffers.js` — `Map<sessionId, messages[]>` with `append()` / `renderInto()` / `clear()`.
- Create `packages/desktop/renderer/modules/bot-rail.js` — rail card markup, click-to-session, badge lifecycle.
- Modify `packages/desktop/renderer/app.js` — replace `refreshBots` body (:1830), wire modules inside `DOMContentLoaded` (:6160+), subagent filter bypass before the session filter (:5244).
- Modify `packages/desktop/renderer/index.html` — `#botList` container class (:484).
- Modify `packages/desktop/renderer/styles.css` — `.bot-rail-card`, `.identity-popover`, badge styles.
- Test `packages/desktop/test/window-harness.test.ts` — new harness assertions.

## Chunk 1: Identity module + session buffers

### Task 1: session-buffers.js

**Files:** Create `packages/desktop/renderer/modules/session-buffers.js`

- [ ] **Step 1: Write the module**

```js
export function createSessionBuffers() {
  const buffers = new Map();
  return {
    append(sessionId, message) {
      if (!sessionId) return;
      const list = buffers.get(sessionId) ?? [];
      list.push(message);
      if (list.length > 500) list.shift();
      buffers.set(sessionId, list);
    },
    renderInto(sessionId, feedEl, renderMessage) {
      if (!feedEl) return;
      feedEl.innerHTML = '';
      for (const message of buffers.get(sessionId) ?? []) {
        feedEl.appendChild(renderMessage(message));
      }
    },
    has(sessionId) { return buffers.has(sessionId); },
    clear(sessionId) { buffers.delete(sessionId); },
  };
}
```

- [ ] **Step 2: Write the failing buffer test FIRST** in `packages/desktop/test/window-harness.test.ts`: an `interactScript` that asserts `window.__railState.buffers` exists, calls `append('bot_x', {role:'assistant',content:'BUFFER_OK'})`, then renders into a temp element and asserts `BUFFER_OK` appears. Run it now: expected FAIL (`window.__railState` undefined) before Task 3 wiring. TDD order: test → fail → implement → pass. This is the buffer-specific test; Task 4 covers cards/identity/delegation.

- [ ] **Step 3: Commit** `git add packages/desktop/renderer/modules/session-buffers.js && git commit -m "feat(ui): per-session message buffers"`

### Task 2: bot-identity.js

**Files:** Create `packages/desktop/renderer/modules/bot-identity.js`

- [ ] **Step 1: Write the module** with fixed templates:

```js
const SHAPES = ['mascot', 'diamond', 'gear', 'spark', 'orb'];
const COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#64748b'];
const EXPRESSIONS = ['neutral', 'happy', 'focused'];
const PREFIX = 'opensand:icon:';

export function iconMarkup(shape, color, expression) {
  const safeColor = COLORS.includes(color) ? color : COLORS[0];
  const s = SHAPES.includes(shape) ? shape : 'mascot';
  const e = EXPRESSIONS.includes(expression) ? expression : 'neutral';
  const stroke = `stroke="${safeColor}"`;
  const faces = {
    neutral: `<circle cx="9" cy="10" r="1" fill="${safeColor}"/><circle cx="15" cy="10" r="1" fill="${safeColor}"/>`,
    happy: `<path d="M8 10c1 1 2 1 3 0M13 10c1 1 2 1 3 0" ${stroke} fill="none"/>`,
    focused: `<path d="M8 10h3M13 10h3" ${stroke}/>`,
  };
  const bodies = {
    mascot: `<circle cx="12" cy="12" r="9" ${stroke} fill="none"/>${faces[e]}`,
    diamond: `<path d="M12 3l9 9-9 9-9-9z" ${stroke} fill="none"/>`,
    gear: `<circle cx="12" cy="12" r="4" ${stroke} fill="none"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4" ${stroke}/>`,
    spark: `<path d="M12 2l2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z" ${stroke} fill="none"/>`,
    orb: `<circle cx="12" cy="12" r="7" fill="${safeColor}" opacity="0.85"/>`,
  };
  return `<svg viewBox="0 0 24 24" width="20" height="20" data-icon="${s}" data-expression="${e}" aria-hidden="true">${bodies[s]}</svg>`;
}

/** Only accept a byte-exact template we generated; everything else falls back. */
export function safeAvatarMarkup(bot) {
  const svg = String(bot?.logoSvg || '');
  const match = /data-icon="(mascot|diamond|gear|spark|orb)"/.exec(svg);
  if (!match) return null;
  const colorMatch = /stroke="(#[0-9a-fA-F]{6})"|fill="(#[0-9a-fA-F]{6})"/.exec(svg);
  const color = colorMatch?.[1] || colorMatch?.[2];
  const expression = /data-expression="(neutral|happy|focused)"/.exec(svg)?.[1] || 'neutral';
  const canonical = iconMarkup(match[1], color || COLORS[0], expression);
  return svg === canonical ? svg : null; // exact-match, no blacklist
}

export function openBotIdentity({ bot, anchor, onSave }) {
  // Build a popover with SHAPES/COLORS/EXPRESSIONS pickers, live preview via
  // iconMarkup(), Save → onSave({ logoSvg, logoColor }). Escape/backdrop closes.
  // Use document.createElement + textContent for all labels; only iconMarkup()
  // output goes through innerHTML (it is generated from constants above).
}
```

- [ ] **Step 2: Commit** `git add ... && git commit -m "feat(ui): inline SVG bot identity editor"`

## Chunk 2: Rail cards + app wiring

### Task 3: bot-rail.js + app.js wiring

**Files:** Create `packages/desktop/renderer/modules/bot-rail.js`; Modify `app.js:1830-1900`, `app.js:6160+`, `index.html:484`, `styles.css`

- [ ] **Step 1: Add ESM imports at top of app.js** (module imports are top-level; wiring stays inside `DOMContentLoaded`): `import { createSessionBuffers } from './modules/session-buffers.js'`, `import { createBotRail, setBotCardBadge, setBotCardStatus, selectBotCard } from './modules/bot-rail.js'`, `import { openBotIdentity, safeAvatarMarkup } from './modules/bot-identity.js'`.

- [ ] **Step 2: Replace `botAvatarMarkup` (:1815) / `providerBadgeMarkup` (:1826) / `refreshBots` (:1830-1900) with `bot-rail.js` renderers. DELETE the existing `function setBotCardStatus` at `app.js:5218` entirely** (the imported one from bot-rail.js replaces it — leaving both is a SyntaxError). Update its two callers at `:5226/:5228` to use the imported version. Cards keep `data-agent-id` and `data-status` attributes but use class `bot-rail-card`; define `setBotCardStatus`/`setBotCardBadge` in bot-rail.js with selectors `#botList .bot-rail-card[data-agent-id=…]`. `safeAvatarMarkup(a)` + `escapeHtml(a.name/role/id)`. Actions: 🎨 identity, model picker, delete with confirm. Card click = `selectBotCard(a)` which sets `activeAgentId` AND calls `selectSession('bot_' + a.id)`. Remove the now-dead old markup functions.

- [ ] **Step 3: Wire modules inside `DOMContentLoaded`** (lesson 11.12):

```js
const sessionBuffers = createSessionBuffers();
const botRail = createBotRail({ buffers: sessionBuffers, getAgents: () => client.getAgents(), onIdentity: (bot, anchor) => openBotIdentity({ bot, anchor, onSave: async (patch) => {
  await client.updateAgentSettings(bot.id, patch); await refreshBots();
}}), onModel: (bot, anchor) => openBotModelPicker(bot, anchor), onSelect: selectBotCard });
window.__railState = {
  buffers: sessionBuffers,
  getActive: () => ({ currentSessionId, activeAgentId }),
  emit: (event) => client.listeners.forEach((l) => l(event)), // injection hook for harness
};
```

- [ ] **Step 4: Delegation filter bypass** in `app.js` event handler, as the FIRST check (before `if (currentView === 'parallel') return;` at :5232 and before the session filter at :5244):

```js
if (event.type === 'subagent') {
  const targetId = event.subagent?.agentId;
  const child = event.data?.event || event.data || {};
  const text = child.type === 'text_delta' ? child.text : child.type === 'turn_completed' ? child.finalContent : '';
  if (text) sessionBuffers.append('bot_' + targetId, { role: 'assistant', content: text });
  if (currentSessionId === 'bot_' + targetId) appendToFeed(text); // live only when that bot is open
  setBotCardBadge(targetId, 'delegated'); // unread dot on target card
  appendToFeed(`↳ delegated to ${event.subagent?.agentName || 'bot'}`); // compact reference in parent only
  return; // single authoritative destination; never fall through to the old branch
}
```
DELETE the old `if (event.type === 'subagent')` branch at `app.js:5249` (and its `handleSubagentEvent` full-text path at `:4117`) — the early handler above replaces it, otherwise full child text renders in the parent and the test "parent DOM has no CTO_REPORT" fails. "Compact reference only" is the one-line `↳ delegated to …` above. No dead code.

- [ ] **Step 4b: Buffer read accessor** — add `get(sessionId)` to `session-buffers.js` returning a copy of the message list, so harness can assert `window.__railState.buffers.get('bot_'+id)` contains `CTO_REPORT`.

- [ ] **Step 5: CSS** for `.bot-rail-card`, `.identity-popover`, `.delegated-badge`, motion-reduce; `index.html:484` → `<div class="bot-rail" id="botList"></div>` (new class name explicit).

- [ ] **Step 6: Render-on-select** — call `sessionBuffers.renderInto(currentSessionId, messageFeed, renderMessage)` inside `selectSession` after history load; clear unread badge for that session.

- [ ] **Step 7: Commit** `git add packages/desktop/renderer/{app.js,index.html,styles.css} packages/desktop/renderer/modules/{bot-rail.js,bot-identity.js,session-buffers.js} && git commit -m "feat(ui): bot sidecar cards with per-bot sessions"`

## Chunk 3: Tests + verification

### Task 4: Harness tests

**Files:** Modify `packages/desktop/test/window-harness.test.ts`

- [ ] **Step 1: Card + identity test** — seed 2 agents (one with a canonical `iconMarkup()` output stored as `logoSvg` + color, one with hostile `<svg onload=...>`); assert 2 `.bot-rail-card` rows, valid SVG rendered, hostile falls back to initial tile with no `onload` attribute, agent name escaped. Use `window.__railState.getActive()` for state assertions (added in Task 3).
- [ ] **Step 2: Selection test** — click a card with no transcript on disk; assert `window.__railState.getActive()` gives `activeAgentId=<id>` and `currentSessionId==='bot_<id>'`.
- [ ] **Step 3: IPC round-trip test** — via identity editor change color, save, then reload the harness window (or re-query through `client.getAgents()`) and assert `logoSvg/logoColor` persisted, not just re-rendered.
- [ ] **Step 4: Delegation routing test** — inject a synthetic `subagent` event via `window.__railState.emit({type:'subagent', sessionId:'parent-session', subagent:{agentId: ctoId, agentName:'CTO Bot'}, data:{event:{type:'text_delta', text:'CTO_REPORT'}}})` while parent pane is open; assert CTO Bot's buffer got `CTO_REPORT`, parent DOM has no `CTO_REPORT`, CTO card shows unread badge; open CTO session → badge clears.
- [ ] **Step 5: Run full gate** `mkdir -p /tmp/opensand-hermetic-home && pnpm build && HOME=/tmp/opensand-hermetic-home pnpm test` — all packages green (canonical `scripts/verify.sh` may be run additionally for release checks).
- [ ] **Step 6: Live screenshot** — write an interaction JS to /tmp, run `bash scripts/capture-ui.sh bot-sidecar /tmp/<interaction>.js /tmp/opensand-ui-capture-home`, read the PNG; parity threshold from `docs/ui-parity-plan.md` (≥90 mean).
- [ ] **Step 7: Commit**
