# Navigation real-window test assumed chat was the first-run view

- **Trap:** macOS CI failed `navigation-real-window.test.ts` with "default view is chat" — expected
  `viewChat`, got `viewWelcome`. Every other real-window test passed under the same no-model condition.
- **Root Cause:** This PR makes an unconfigured first run open Welcome on purpose. The navigation test
  snapshotted the initial view before navigating and asserted chat-specific header/back/nav/subnav
  details from that snapshot; Welcome is a legitimate default, so the product was right and the test
  was stale.
- **Rule:** For tests that need chat, assert the welcome default first, then call
  `navigateToView({ js, sleep }, '#chat', '#viewChat')` and take a separate chat snapshot for the
  chat-specific assertions. When a product changes the initial view, grep all `*-real-window.test.ts`
  for initial-view assumptions, not just the literal "default view is chat" phrase.
