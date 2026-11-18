# A turn that waits for an approval the shell cannot answer looks like a hang

- **Trap:** The quick "Capture window" button sat in `sending` for 60 s and the real-window test failed. The bridge had a pending `folder.trust` approval, and the Preact Inbox listed it with no Approve/Reject control, so nothing could resolve it.
- **Root Cause:** The capture reducer treated every event after `session_started` as "still running" and ignored `approval_required`. The Inbox was read-only (the legacy modal had the buttons, the shell did not), so the turn was blocked on a decision the window could not offer.
- **Rule:** A control that starts a turn must (1) show a `waiting` state when the engine asks for approval, and (2) the shell must be able to answer every approval it lists. The real-window test answers approvals through the Inbox and asserts the `waiting` state appears at the first size.

(Found while porting the quick window into the Preact shell, PR for Phase 5.)
