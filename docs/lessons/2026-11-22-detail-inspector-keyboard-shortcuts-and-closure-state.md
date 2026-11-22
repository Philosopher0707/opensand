# Detail Inspector keyboard shortcut handlers and idempotent dismissal state

- **Trap:** In the Preact desktop shell Detail Inspector implementation, closing the slide-out inspector via Escape timed out in automated real-window Electron tests when the keydown handler conditionally checked captured `isDetailOpen` state before calling `setIsDetailOpen(false)`.
- **Root Cause:** Binding keyboard dismiss listeners with captured state guards (`if (isDetailOpen) setIsDetailOpen(false)`) creates hook listener churn on every toggle and can miss synthetic or rapid event dispatches if batched state updates lag event timing.
- **Rule:** Global keyboard dismissal handlers for slide-out panels and modals (e.g. Escape) should call idempotent dismissal setters (`setIsDetailOpen(false)`) unconditionally, allowing event listeners to remain stable with an empty dependency array.
