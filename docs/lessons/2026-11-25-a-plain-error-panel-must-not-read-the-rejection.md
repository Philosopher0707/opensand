# A panel that promises plain errors must not read `err.message` at all

- **Trap:** CI failed with `FAIL: 1 NEW raw error path(s) reaching the user` on `QuickOcr.tsx`, even though the message was passed through `plainOcrError()` and the unit test asserted no raw path leaked.
- **Root Cause:** `scripts/check-raw-errors.sh` scans source text for raw error reads (`err.message`, `String(err)`) on user-visible paths. Sanitising the value afterwards does not remove the read, and the rejection can carry arbitrary engine text.
- **Rule:** When a UI promises plain errors, ignore the rejection entirely in the catch handler and dispatch a fixed plain message. Run `scripts/check-raw-errors.sh` locally before pushing; do not add an allowlist entry for a new raw read.
