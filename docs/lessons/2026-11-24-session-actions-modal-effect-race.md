# A modal's reset effect can race an immediate real-window click

- **Trap:** The BTW/rollback/compact real-window test opened a modal and clicked its submit button in the same tick. The validation error never appeared, and the rollback result never rendered, even though the Preact click handler was attached and fired.
- **Root Cause:** Each modal resets its local state in a `useEffect` keyed on the open flag. That effect runs after paint, so it landed *after* the test's immediate click and cleared the error/result before the assertion could see it. The answer path worked because it took longer than the effect.
- **Rule:** After opening a modal in a real-window test, let one effect flush (a short `sleep` after the `!hidden` wait) before clicking its controls. When a state change disappears instantly, check for a reset effect keyed on the same prop before assuming the handler is missing.
