# Draft briefs from executable code rather than hand-copied memory or comments

- **Trap:** Hand-drafting task briefs by copying route names, HTTP verbs, and validation constraints from memory, design notes, or comments introduces subtle discrepancies—such as specifying `POST /api/routines/:id/enabled` when the server actually implements `PATCH`, or omitting mandatory request body checks. The mismatch only surfaces during implementation, wasting debugging time on 404s/400s.
- **Root Cause:** Comments and human notes frequently diverge from the runtime code over time. Relying on manual transcription preserves outdated assumptions rather than reflecting the real executable router conditions (`req.method === '...'`).
- **Rule:** Generate row briefs directly from the repository using `scripts/brief-row.sh`. Always extract server routes, HTTP methods (`req.method === '...'`), and body validation checks from actual server code rather than comments or assumptions.
