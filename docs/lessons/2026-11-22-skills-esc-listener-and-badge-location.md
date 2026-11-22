# Keep one stable Escape listener, and assert badges where you rendered them

- **Trap:** The Skills preview modal closed with its button and with Esc on first open, but Esc stopped working after the preview was closed and reopened. Re-attaching the `keydown` listener from an effect keyed on modal state missed the fast reopen.
- **Root Cause:** A per-state listener has a detach/attach window; a second open in the same interaction sequence can leave no listener registered while the state already says the modal is open.
- **Rule:** Register the Escape handler once with `[]` deps and read the latest modal state inside a functional state update; it removes the reattachment race and one branch of state bookkeeping.
- **Trap:** The real-window test expected the category badge inside `.card-meta`, but it was rendered in `.card-top`, so a passing UI produced a failing assertion.
- **Root Cause:** The assertion copied the neighbouring view's selector instead of reading the component under test.
- **Rule:** Assert each badge from the exact container the component renders, and let a screenshot confirm the card before changing the component to fit the test.
