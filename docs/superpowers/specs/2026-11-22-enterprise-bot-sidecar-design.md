# Design: enterprise-grade persistent bot sidecar

Date: 2026-11-22
Status: approved by owner (design presented in conversation; owner asked for "enterprise grade" and approved the revised left-edge layout)
Predecessor: `docs/superpowers/specs/2026-11-21-bot-sidecar-sessions-design.md` (per-bot sessions, delegation routing, SVG identity — already shipped in `3c541b3`, `e19aac8`)

## Problem

The shipped compact cards are mounted at `index.html:484` **inside `#viewTemplates`**. `switchView()` (`app.js:805-857`) hides that whole panel, so the bot rail disappears everywhere except the Bots & Personas page. The owner's approved mockup (`.superpowers/brainstorm/26237-1795260295/bot-card-identity.html:6-8`) shows a persistent "BOTS · SIDECAR" strip; the current build does not match it. Additionally:

- With 19 live agents and 0 `logoSvg` values, every avatar falls back to an initial tile and the identity feature is effectively invisible.
- Cards are `<div>`s with click handlers only: no keyboard activation, no `aria-current`, no announced status/unread state.
- A 220px scroll box showing ~4 of 19 cards has no filter.

## Goal

A persistent, always-visible compact bot rail in the app shell that works from every view; single source of truth for bot cards; identity-visible avatars; keyboard/screen-reader usable; usable with dozens of bots. Enterprise grade here means **fit and finish of the navigation surface**, not more subsystems.

## Non-goals

- No new dependency, no framework, no `renderer-next` (Preact) work.
- No change to session identity (`bot_<agentId>`), delegation routing, or `session-buffers.js` semantics — those are shipped and approved.
- No change to identity editor internals, SVG sanitizer, or server/API.
- No task/routine changes, drag-reorder, bulk actions, density setting, or custom tooltip library.

## Architecture

### 1. Shell mount — single `#botList` moved, not duplicated

- Move the existing `<div class="bot-rail" id="botList"></div>` out of `#viewTemplates` (currently `index.html:484`) into a new direct child of `.app-layout`, inserted **between** `</aside>` of `.sidebar` (ends `index.html:142`) and `<main class="main-panel">` (`index.html:145`).
- New markup:
  ```html
  <aside class="bot-sidecar" id="botSidecar" aria-label="Bot sidecar">
    <div class="bot-sidecar-header">
      <span class="bot-sidecar-title">BOTS</span>
      <button id="btnToggleBotSidecar" class="btn-icon-ghost" aria-label="Collapse bot rail" aria-expanded="true">…sprite icon…</button>
    </div>
    <input id="botSidecarSearch" class="bot-sidecar-search" type="search" placeholder="Filter bots" aria-label="Filter bots">
    <div class="bot-rail" id="botList" role="list"></div>
    <div class="bot-sidecar-footer">
      <button id="btnSidecarNewBot" class="btn btn-secondary btn-sm">+ New bot</button>
    </div>
  </aside>
  ```
- Why after `.sidebar`: the Electron gutter selector `.sidebar.collapsed ~ .main-panel .topbar` (`styles.css:222-224`) is a general-sibling selector and still matches with an intervening sibling; the sidebar keeps its traffic-light padding (`styles.css:205-207`). Bots sit next to sessions (both are conversations), and the right edge stays reserved for `#detailPanel`.
- `switchView()` never touches this aside, so it survives every view switch. `refreshBots()` → `botRail.render()` keeps working because `#botList` keeps its id and class. Harness selectors `#botList .bot-rail-card` stay valid.
- `#viewTemplates` keeps its management surface (New Persona / Export / Import, Active Workspace Tasks, persona grid) and loses the duplicate roster. `btnOpenCreateBot` remains there and is reused by the rail footer.

### 2. Rail module changes (`renderer/modules/bot-rail.js`)

- Keep `createBotRail({ buffers, getAgents, getActiveAgentId, onIdentity, onModel, onSelect, onDelete }) → { render() }` and the existing exported `setBotCardStatus`/`setBotCardBadge` API.
- `render()` fetches agents once into a closure variable `lastAgents`, then calls an internal `renderRows(agents)` that applies the current filter (case-insensitive match on name, role, provider, model) before building rows. Expose `applyFilter(text)` on the returned object, which calls `renderRows(lastAgents)` without a network fetch.
- Each card becomes `role="button" tabindex="0" aria-current="<true|false>"`, with `keydown` handling Enter/Space → `onSelect(bot)` (ignore when the event target is one of the nested action buttons). Keep the existing click handler and `event.target.closest('button')` guard.
- Card gains `aria-label="<name> — <provider> · <model>; <status>; delegated work unread when applicable"` and `data-flyout="<name> · <provider> · <model>"` (escaped through `escapeHtml`) for the collapsed-mode CSS tooltip. Status dot stays `aria-hidden="true"`; status is in the card label.
- Delegated badge span gets `role="status"` so insertion is announced. Badge rehydration from `buffers.hasUnread()` after `innerHTML` rebuild stays as shipped.
- Default Assistant row also gets role/tabindex/aria-current but no filter match requirement (always first).

### 3. Controller wiring (`renderer/app.js`)

- Next to the existing `createBotRail(...)` wiring (`app.js:1316-1347`):
  - `btnSidecarNewBot.onclick = () => document.getElementById('btnOpenCreateBot')?.click();`
  - Collapse state: read `localStorage.getItem('botSidecarCollapsed')`; toggle `is-collapsed` on `#botSidecar`, set `aria-expanded` and the button's `aria-label`, persist on click. On `resize`, force collapsed when `innerWidth < 1100` without overwriting the stored preference; restore the stored preference when wider.
  - `botSidecarSearch.oninput = () => botRail.applyFilter(value)`.
- No changes to the delegation event branch or `selectSession` buffer logic.

### 4. CSS (`renderer/styles.css`)

- `.bot-sidecar`: flex column, `width: 220px`, `flex: 0 0 auto`, full height, right border and background from existing tokens (`--bg-secondary`/`--border-color`), `transition: width 150ms var(--ease-out)`; `.bot-sidecar.is-collapsed { width: 56px }`.
- `.bot-sidecar-header` / `.bot-sidecar-search` / `.bot-sidecar-footer`: compact, token-based padding/borders; focus-visible follows the global rule (`styles.css:151-154`).
- `.bot-rail` (now shell-mounted only): replace `max-height: 220px` with `flex: 1; min-height: 0; overflow-y: auto`.
- Collapsed mode: hide `.bot-item-info`, `.bot-model-chip`, `.bot-sidecar-title`, and the search input; center `.bot-avatar-wrap`; show the CSS flyout from `data-flyout` on `:hover`/`:focus-within` using `position:absolute` and `--shadow-lg`; keep the status dot and delegated badge visible; reveal action buttons on hover/focus as today.
- Extended reduced-motion block covers `.bot-sidecar` (existing global kill switch at `styles.css:4074-4082` already covers transitions; add alongside the rail rules at `:4472-4475`).
- Light theme: token-only colors; no hardcoded dark values. Keep `.bot-item` legacy rules (`styles.css:1993-2068`) intact — cards still carry that class.

### 5. Error handling / edge cases

- Filter with no matches shows a single "No bots match" row (not an empty box); it does not affect selection state.
- Collapsed state stored in `localStorage` is validated as `'true'`/`'false'`; any other value falls back to expanded.
- New-bot button is a no-op if the management modal trigger is absent (e.g. during early boot).
- Keyboard activation ignores Enter/Space originating from nested buttons to avoid double actions.
- Unknown provider/model keeps the existing `global`/`default` fallback.

## Testing

- Extend `packages/desktop/test/window-harness.test.ts` (per-bot rail test or a sibling test):
  - rail is visible while `#viewChat` is active; switching to Bots and back keeps the **same** `#botList` element;
  - `btnToggleBotSidecar` toggles `is-collapsed`, `aria-expanded`, and `localStorage`;
  - typing in `#botSidecarSearch` reduces visible cards and clearing restores them;
  - a card receives focus and Enter sets `activeAgentId` + `currentSessionId === 'bot_' + id`;
  - existing security/escaping/delegation-unread/IPC assertions remain green.
- Full hermetic gate (`pnpm build`, `HOME=/tmp/... pnpm test`) — all packages green.
- Live Electron captures via `scripts/capture-ui.sh`: chat view with expanded rail, collapsed rail, light theme; read each PNG.
- Score against `docs/ui-parity-plan.md` dimensions; mean ≥90 required to report as done.
- Per-chunk spec + code-quality subagent reviews, fix loops until approved; local commits via `scripts/ship_phase.sh` with explicit paths only.

## Risks

- Adding a 220px shell child narrows chat at 1280px and below; narrow-window forced collapse mitigates it.
- CSS specificity: new `.bot-sidecar .bot-rail` rules must win over the legacy `.bot-rail` 220px cap without disturbing `.bot-item` used by other lists.
- Moving a DOM node out of a hidden view panel changes what screenshots show; existing harness assertions keyed to `#botList` are structurally safe, but visual snapshots must be re-taken.
- This is one focused shell/navigation subsystem; it deliberately does not touch the separate routine scheduler or workspace-task checklist.
