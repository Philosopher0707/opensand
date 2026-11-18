# baseRefOid follows the live base, so stale PRs report DIRTY/CONFLICTING

- **Trap:** The auto-rebase gate decided a PR was behind by comparing `baseRefOid` with `origin/main` and checking `mergeStateStatus == BEHIND`. On the first live PR after main moved, `baseRefOid` already equalled the new main tip while `mergeStateStatus` was `DIRTY` and `mergeable` was `CONFLICTING`; no rebase ran and check 1 failed with "PR mergeable status is CONFLICTING".
- **Root Cause:** GitHub keeps `baseRefOid` at the current base tip, so a stale base is not visible there. The real signal that a merge was refused because main moved is `mergeStateStatus` `DIRTY`/`BEHIND` or `mergeable` `CONFLICTING`.
- **Rule:** Detect a stale PR with `mergeStateStatus` in {BEHIND, DIRTY} or `mergeable == CONFLICTING` (keep the baseRefOid mismatch as a fallback) and selftest the DIRTY/CONFLICTING case with baseRefOid at main, not just the BEHIND case.
