# Approval decision wiring, stale epoch handling, and event propagation

- **Trap:** When executing approval actions (Approve Once, Always Allow, Reject) in the Preact desktop shell across sidebar and main detail views, resolving a pending approval could leave stale detail views open or fail to notify other UI components of pending queue changes.
- **Root Cause:** Slices of approval state (sidebar expanded item vs. main panel detail card) operated with localized callbacks, and bridge methods required request epochs that could be rejected with a `StaleEpochError` without dedicated user-facing error feedback.
- **Rule:** Every approval action must echo the request's creation epoch, emit standard `opensand:approvals_changed` events across window listeners on resolution, reset active detail selection views in parent shells, and specifically detect stale epoch errors to alert the user when state is superseded.
