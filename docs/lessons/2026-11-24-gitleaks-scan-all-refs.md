# A shared clone can make gitleaks report secrets that CI does not scan

**Trap:** A local full-history scan in the shared OpenSand clone reported two findings across 887 commits, while the same pinned gitleaks version in CI reported one across 620. The extra finding came from a throwaway branch that was no longer on the remote.

**Root Cause:** `gitleaks detect` scans all refs present in the clone. A long-lived shared clone retains stale remote-tracking refs, so its scan universe is not the same as a fresh `actions/checkout` full-history checkout.

**Rule:** Reproduce a CI secret-scan failure in a fresh clone from the actual origin, check out the PR head, and run the same redacted command/config. Report only commit, file, line and rule id; never print the candidate value. Allowlist only an exact fingerprint after proving the value is synthetic.
