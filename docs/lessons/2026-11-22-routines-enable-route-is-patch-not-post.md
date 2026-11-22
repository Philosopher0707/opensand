# The routines enable route is PATCH, not POST — read the server before coding a brief's HTTP verb

- **Trap:** The Row 14 brief specified `POST /api/routines/:id/enabled`. The desktop server registers `PATCH /api/routines/:id/enabled` (matching the legacy client), so a faithful POST implementation would 404 on every Pause/Enable click and the view would keep showing the old state.
- **Root Cause:** The brief's endpoint list was written from the legacy view's shape, not re-checked against `desktop-server.ts`; the mismatch only shows up when the control is exercised against the real route.
- **Rule:** Before implementing any HTTP call named in a brief, grep the server's route registration and the legacy client for that path and use the registered verb; note any deviation from the brief in the report, and assert the verb in the real-window fetch stub so a wrong method fails the test.
