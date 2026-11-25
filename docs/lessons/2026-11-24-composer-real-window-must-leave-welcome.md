# Composer real-window test must leave the first-run welcome view

- **Trap:** macOS CI failed `composer-extras-real-window.test.ts` with "input field within viewport at
  960x740: false !== true". The same test passed locally, and the Settings/Welcome CSS looked like the
  culprit because it was the newest layout change.
- **Root Cause:** On a fresh CI home there is no key and no local model, so `main.ts` redirects the
  window to `/welcome` and `Shell` hides the chat panel; `#promptInput` still exists in the DOM but has
  zero width, so the viewport assertion fails. The owner's Mac has Ollama running, so onboarding was
  skipped locally and the test never exercised the CI condition. Forcing
  `OPENSAND_ENDPOINT=https://example.invalid/v1/chat/completions` reproduced the failure locally.
- **Rule:** Real-window tests that measure the composer must land on chat explicitly
  (`location.hash = '#chat'` and wait for a non-zero input width) before taking metrics. Do not weaken
  the viewport assertion or edit layout CSS to work around a hidden panel. Reproduce CI-only failures
  by forcing the missing precondition (no key / no local model) rather than assuming the newest CSS is
  at fault.
