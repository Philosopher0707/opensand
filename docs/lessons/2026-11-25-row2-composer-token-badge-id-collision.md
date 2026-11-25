# A composer control must not reuse a legacy topbar id

- **Trap:** The new chat composer's token badge used the legacy `#badgeTokens` id. At 960×740 it had text but zero size; at 1920×1080 it rendered normally.
- **Root Cause:** `renderer/styles.css` hides `#badgeTokens` for every window at or below 1180px to protect the legacy topbar. The global id selector won over the composer's own layout, so the badge was invisible exactly at the smallest supported window.
- **Rule:** Give a ported control a component-local id (here `#composerTokenBadge`) instead of copying the legacy topbar id, and prove visibility at both 960×740 and 1920×1080 in a real window before calling parity done. [checked: packages/desktop/test/chat-composer-controls-real-window.test.ts]
