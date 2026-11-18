# An element that exists can still be hidden at the minimum window size

- **Trap:** The first real-window run at 960×740 failed "button is fully inside the window" with a zero-size rectangle. The button existed in the DOM, but `styles.css` hides `#btnQuickWindow` at `max-width: 1024px`.
- **Root Cause:** The shell reuses the legacy stylesheet, and the legacy rules for quick tools hide them at narrow widths. Nothing in the component tests exercises CSS, so the rule was invisible until a real window was measured.
- **Rule:** A window test records the element's rectangle and the window size, and asserts the rectangle is non-empty and inside the viewport, not just that the node exists. Where the shell must keep a control at a size the legacy CSS hides, override it in `shell.css` with a more specific selector and say so in a comment.

(The override is `.topbar-actions #btnQuickWindow` in `packages/desktop/renderer-next/src/shell.css`.)
