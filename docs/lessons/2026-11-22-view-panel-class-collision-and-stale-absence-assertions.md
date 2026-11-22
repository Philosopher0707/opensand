# A new view panel must beat the legacy `view-panel` rules, and absence assertions must be flipped

- **Trap:** Adding `<div class="view-panel">` to the Preact shell gave every panel a fixed `height: calc(100vh - 52px)` and `overflow: hidden`, inherited from `renderer/styles.css`, because `main.tsx` imports the legacy stylesheet first. The chat split still looked right, but a tall mission timeline had no scroll container.
- **Root Cause:** Class names in the new shell share the legacy stylesheet's namespace, and equal-specificity rules resolve by import order only when the override actually exists.
- **Rule:** When a new Preact component reuses a legacy class name, scope the override under its new parent (`.shell-body .view-panel { height: auto; overflow: auto; }`) in `shell.css` and check a content-heavy state, not just the empty one.

- **Trap:** `window-harness.test.ts` asserted `hasViewChat === false` for the Preact renderer, encoding "the shell has no view panels yet". Adding the panel the brief requires turned a correct change into a red suite.
- **Root Cause:** An absence assertion documents a migration stage, not a behaviour, so it silently becomes a lie at the next row.
- **Rule:** Before adding a DOM id that a brief mandates, grep the real-window suites for that id and flip or replace any absence assertion in the same change.

- **Trap:** The Connections subnav has six tabs; with the legacy `nowrap` + `overflow-x: auto` strip the last two were clipped at 960x740 with no visible affordance.
- **Root Cause:** A horizontally scrolling tab strip hides destinations at compact widths and no overflow metric catches it, because the page itself does not overflow.
- **Rule:** Let subnav tabs wrap, and assert in the real-window test that every `.subnav-tab` rect sits inside its panel at both 960x740 and 1920x1080.
