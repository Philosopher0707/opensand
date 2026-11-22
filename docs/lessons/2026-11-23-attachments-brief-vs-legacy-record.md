# Attachments brief names the wrong nav group and legacy data fields

**Trap:** The Row 18 brief called the subnav a "capabilities subnav", but `NAV_GROUPS` puts `attachments` in the `connections` group and the legacy `#viewAttachments` uses `data-group="connections"`. It also asked for parity with `refreshAttachments`, which reads `fileName`/`filePath`/`byteLength`, while the live bridge record uses `filename`/`localPath`/`sizeBytes`.

**Root Cause:** A brief written from the legacy renderer's labels and field names can be stale against the new shell's navigation model and the shared record type; copying it would render an empty grid from real data.

**Rule:** Before porting a view, confirm the nav group against `NAV_GROUPS` and field names against the shared record type; accept both field spellings for one release rather than preserving a legacy name bug. Applied in `AttachmentsView.tsx` and `attachmentCardView` (Row 18).
