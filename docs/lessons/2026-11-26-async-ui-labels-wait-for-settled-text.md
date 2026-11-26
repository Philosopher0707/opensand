# Async UI labels filled on modal open must be waited on for settled text

- **Trap:** Both settings real-window tests read `#settingsVersion` as soon as the modal was visible and the engine select was enabled; it still held the `…` placeholder, so the version assertion failed intermittently (5 pass / 1 fail in 6 runs).
- **Root Cause:** The renderer ships `…` in the HTML and replaces it from an async `fetch('/api/version')` after the settings view opens. Waiting on modal visibility or a sibling control being enabled does not wait for that fetch, so a cold start can be read mid-hydration.
- **Rule:** For any label hydrated asynchronously when a view opens, wait for the text itself to leave its loading placeholder (`textContent.trim() !== '…'`) before reading it, not just for the containing modal or a sibling control.
