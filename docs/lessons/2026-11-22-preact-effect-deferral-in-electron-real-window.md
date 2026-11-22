# Preact effects can be deferred in the Electron renderer: read live state in shortcuts, not from an effect closure

- **Trap:** In Phase 5 Row 11, an account popup's click-outside `document` listener and the global `keydown` handler were installed in `useEffect`s whose dependency arrays included volatile state (`isAccountPopupOpen`, `canvasState.isOpen`). In a real Electron window the handlers acted on stale values: Esc sometimes closed the wrong layer, and the outside-click listener never closed the popup. A localStorage write made in a `useEffect([sidebarCollapsed])` also lagged behind the DOM class, failing a real-window assertion that read localStorage immediately after the click.
- **Root Cause:** In this renderer, effect callbacks can be scheduled after the DOM has already re-rendered (and, in the test, after the next `executeJavaScript` round trip). A listener closure or a persistence effect is therefore not a reliable source of "current" state at the moment a user event arrives.
- **Rule:** For global shortcuts, install the `keydown` listener once (`[]`) and read the live values from a ref assigned **during render** (`stateRef.current = {...}`), not from an effect. Persist localStorage synchronously in the click/key handlers that change the value, the way legacy `app.js` does. For click-outside dismissal, prefer a mounted click-catching backdrop (`position:fixed; inset:0`) rendered from current state over a `document` listener.

- **Trap:** The first backdrop was rendered inside `.sidebar-footer` with `z-index:999`; `elementFromPoint(600,400)` still hit `.chat-container` and the popup stayed open.
- **Root Cause:** The backdrop's stacking was confined by the sidebar; the sibling `.main-panel` painted above it despite the z-index.
- **Rule:** Render full-window overlays as a direct child of the app root (`.app-layout`), not inside a sidebar/panel subtree, and verify with `document.elementFromPoint(x, y)` in the real-window test.

- **Trap:** The inline theme-toggle SVG rendered ~2px wide (a dot) even though it had `width="15"` / `height="15"` attributes.
- **Root Cause:** No CSS sizing rule applied to that SVG, and the project's stroke/geometry convention lives in the `.icon` class.
- **Rule:** Give inline SVGs the `.icon` class or an explicit CSS width/height, and assert the rendered icon width in the real-window snapshot so a collapsed icon cannot regress unnoticed.
