# Design: enterprise-grade bot sidebar section (Orca-parity)

Date: 2026-11-22
Status: approved by owner; revised after owner supplied an Orca UI reference screenshot and asked for the same design. The exact screenshot file on the Desktop is not readable from this sandbox (macOS TCC), so the design is ported from the installed Orca app's own renderer source (`/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/...`).
Predecessor: `docs/superpowers/specs/2026-11-21-bot-sidecar-sessions-design.md` — per-bot sessions, delegation routing, SVG identity (shipped in `3c541b3`, `e19aac8`)

## Problem

The shipped compact cards are mounted at `index.html:484` **inside `#viewTemplates`**. `switchView()` (`app.js:805-857`) hides that panel, so the bot rail disappears everywhere except the Bots & Personas page. A previous revision proposed a separate 220px shell column; the owner's Orca reference shows a different, better pattern: **a Bots section inside the existing left sidebar**, above the conversation list. With 19 live agents and 0 `logoSvg` values, avatars also fall back to plain initial tiles and identity is invisible.

## Goal

Port Orca's Bots-sidebar pattern into our shell: a persistent "Bots" section in the left sidebar with an inline search, compact avatar rows with status/unread badges and a second metadata line, a "Show N more" overflow, and keyboard navigation. One source of truth for bot cards (`#botList`), visible from every view; identity-visible avatars; no new dependency.

## Reference evidence (Orca's shipped renderer source)

- `app.asar.unpacked/out/shared/bots/bot-sidebar-view.js` (sort/filter options), `bot-sidebar-entries.js` (one mixed list), `bot-sidebar-search.js` (search panel), `bot-sidebar-tree.js`, `bot-sidebar-workspaces.js`.
- `out/renderer/assets/App-C1D5BKnF.js` contains the rendered Bots section:
  - row class `worktree-sidebar-card-hover flex w-[calc(100%-0.25rem)] shrink-0 items-center pt-1.25 pb-1.5 pl-1.5 text-left focus-visible:ring-2 focus-visible:ring-sidebar-ring`;
  - avatar `size-8 rounded-md text-sm` with a bottom-right status badge (`absolute -right-1 -bottom-1 z-10 size-2 rounded-full bg-foreground ring-1 ring-sidebar` for unread, attention/working variants);
  - name `truncate text-[13px] leading-5`, second line `truncate text-xs leading-4 text-muted-foreground`;
  - search toggle `data-bot-sidebar-search-toggle`, list `data-bot-sidebar-list`, rows `data-bot-sidebar-entry`, ArrowUp/ArrowDown focus movement;
  - "Show {{count}} more bots" overflow button (`bots.section.showMore`) and `+N` hidden-attention badge;
  - sort choices Manual / Agent Activity / Recent / Name (`bot-sidebar-view.js:9-18`).
- Our renderer has no framework and no equivalent CSS utility system; port the **pattern and proportions with our existing tokens**, not the React implementation.

## Non-goals

- No new dependency, no React/Preact, no `renderer-next`.
- No drag-to-reorder, sort menu, paused/sleeping filters, resizable split, group/room rows, or hovercards — they depend on Orca data models we do not have. Keep the row/search/overflow pattern only.
- No changes to session identity, delegation routing, `session-buffers.js`, identity editor, SVG sanitizer, or server/API.
- No workspace-task or routine changes.

## Architecture

### 1. Sidebar mount — move `#botList`, do not duplicate

- Move `<div class="bot-rail" id="botList"></div>` out of `#viewTemplates` (`index.html:484`) into a new `<section class="bot-sidecar" id="botSidecar" aria-label="Bots">` inserted in `aside.sidebar` between the conversation search box (`index.html:82-86`) and the roster container (`index.html:88-91`).
- Section markup:
  ```html
  <section class="bot-sidecar" id="botSidecar" aria-label="Bots">
    <div class="bot-sidecar-header">
      <span class="bot-sidecar-title">Bots</span>
      <div class="bot-sidecar-actions">
        <button id="btnBotSearch" class="btn-icon-ghost" aria-label="Search bots" aria-expanded="false" title="Search bots"><svg …search…></button>
        <button id="btnBotNew" class="btn-icon-ghost" aria-label="New bot" title="New bot"><svg …plus…></button>
      </div>
    </div>
    <div class="bot-sidecar-search hidden" id="botSearchWrap">
      <svg class="search-icon" …></svg>
      <input id="botSidecarSearch" type="search" placeholder="Search bots" aria-label="Search bots">
    </div>
    <div class="bot-rail" id="botList" role="list"></div>
    <button class="bot-sidecar-more hidden" id="btnBotShowMore"></button>
  </section>
  ```
- The section is always visible (sidebar itself may collapse via the existing `#btnCollapseSidebar`). `switchView()` never touches the sidebar, so the same `#botList` node survives every view switch. `refreshBots()` → `botRail.render()` and existing harness selectors keep working.
- `#viewTemplates` keeps management UI (New Persona / Export / Import, Active Workspace Tasks, persona grid) and loses the duplicate roster; `#btnOpenCreateBot` stays there.

### 2. Row design (`renderer/modules/bot-rail.js`)

- Keep `createBotRail({ buffers, getAgents, getActiveAgentId, onIdentity, onModel, onSelect, onDelete }) → { render(), applyFilter(text) }` and exported `setBotCardStatus`/`setBotCardBadge`.
- `render()` fetches agents once into a closure `lastAgents`, then `renderRows()` applies the active filter and the show-more limit. `applyFilter(text)` re-renders from `lastAgents` without a fetch.
- Row structure (Orca proportions, our tokens): `<div class="bot-rail-card bot-item" role="button" tabindex="0" aria-current aria-label data-agent-id data-status>` containing:
  - `<span class="bot-avatar-wrap">` with `safeAvatarMarkup(bot)` (or escaped initial tile via `--bot-tint`) plus a `<span class="bot-status-badge">` overlay (bottom-right dot; delegated unread adds a small ringed dot with `role="status"`);
  - `<span class="bot-item-info">` with `<span class="bot-item-name">` (13px/20px, ellipsis) and `<span class="bot-item-sub">` (11-12px muted): `provider · model` with `role` when present;
  - existing hover/focus actions 🎨 identity, model picker, delete with confirm.
- Default Assistant row stays first with no agent id.
- Filter matches name, role, provider, model, case-insensitively. With no query, show the first 6 agents + a `Show N more bots` button; clicking reveals all and toggles to `Show less`. While filtering, show all matches and hide the overflow button. No-match renders a single muted "No bots match" row.
- Keyboard: cards handle Enter/Space → `onSelect(bot)` unless the event target is a nested button; ArrowDown/ArrowUp move focus to the next/previous visible card (Orca behavior). Escape in the search input closes the search and returns focus to `#btnBotSearch`.

### 3. Controller wiring (`renderer/app.js`)

- Beside the existing `createBotRail(...)` wiring (`app.js:1316-1347`):
  - `btnBotNew.onclick = () => document.getElementById('btnOpenCreateBot')?.click();`
  - `btnBotSearch.onclick` toggles `hidden` on `#botSearchWrap`, sets `aria-expanded`, focuses/blurs the input, clears the filter on close, calls `botRail.applyFilter('')`.
  - `botSidecarSearch.oninput = () => botRail.applyFilter(value)`; `onkeydown` Escape → toggle closed.
  - Show-more button click toggles the module's `expanded` state via `botRail.setExpanded(bool)` and updates its label.
- No changes to delegation event handling or `selectSession()`.

### 4. CSS (`renderer/styles.css`)

- `.bot-sidecar`: border-bottom, padding 6px 4px, `flex: 0 0 auto`; `.bot-sidecar-header` flex row, title uppercase 10-11px muted; `.bot-sidecar-actions` right-aligned ghost icon buttons.
- `.bot-sidecar-search`: reuses searchbox styling (icon + input, small height).
- `.bot-rail`: remove the old `max-height: 220px`; no fixed cap — the section stays short via the 6-row overflow limit.
- `.bot-rail-card`: match `.session-channel-item` density (padding ~6-7px, radius, hover/active backgrounds, left accent bar on active) but keep 30px rounded-square avatar with the bottom-right status badge, 13px name, 11-12px subline. Focus-visible ring from the global rule (`styles.css:151-154`).
- Delegated badge: small ringed dot + optional text in the subline; `role="status"` for announcement; rehydrate from `buffers.hasUnread()` after rebuild (already shipped).
- Light theme: token-only colors; keep `.bot-item` legacy rules (`styles.css:1993-2068`) intact since cards retain that class.
- Reduced motion: existing global kill switch (`styles.css:4074-4082`) plus rail rules at `:4472-4475`.

### 5. Error / edge cases

- Unknown provider/model → existing `global`/`default` fallback.
- Malformed `logoSvg` → `safeAvatarMarkup` initial-tile fallback (already shipped).
- Names/roles/providers always `escapeHtml`.
- No-match and all-hidden states render explanatory rows, never a blank section.
- Filter is cleared when the search panel closes so rows do not stay hidden unexpectedly.
- New-bot button is a no-op if the management trigger is absent during early boot.

## Testing

- Extend `packages/desktop/test/window-harness.test.ts`:
  - Bots section is visible while `#viewChat` is active and the same `#botList` node survives a view switch;
  - search toggle reveals/focuses the input; typing filters cards; clearing + ArrowUp/Down keyboard navigation works;
  - "Show N more" reveals all agents and toggles back;
  - card Enter/Space sets `activeAgentId` and `currentSessionId === 'bot_' + id`;
  - existing security (hostile SVG), escaped-name, delegation-unread, badge-clear and IPC round-trip assertions remain green.
- Full hermetic gate (`pnpm build`, `HOME=/tmp/... pnpm test`) — all packages green.
- Live Electron captures via `scripts/capture-ui.sh`: chat view with the sidebar Bots section, search open with a query, show-more expanded, and light theme; read each PNG.
- Score against `docs/ui-parity-plan.md` dimensions; mean ≥90 required to report as done.
- Per-chunk spec + code-quality subagent reviews, fix loops until approved; local commits via `scripts/ship_phase.sh` with explicit paths only.

## Risks

- The reference screenshot itself could not be read from the sandbox; parity is based on Orca's shipped renderer source, so exact pixel colors/spacing may differ from that screenshot.
- Reusing the `.bot-item` class means legacy card CSS can leak into the new rows; scope new rules under `.bot-sidecar`.
- Six-row overflow keeps the sidebar compact but hides bots; the search + Show-more path must be obvious and keyboard reachable.
- Scope is one navigation surface; the separate routine scheduler and workspace-task checklist are untouched.
