# Measure serialized security test payloads

- **Trap:** The first 100,000-row model catalog fixture was assumed to exceed 5 MB, but its serialized JSON was smaller and the fixture precondition failed.
- **Root Cause:** The row shape was compact; row count alone did not establish the intended byte-size boundary.
- **Rule:** Assert the serialized byte count in oversized-input tests and add explicit padding when the byte-size claim matters.
