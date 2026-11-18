# The brief lint missed "Report back with:" and mis-coded unreadable files

- **Trap:** The first run of `scripts/lint-brief-selftest.sh` failed two cases: a valid brief with `Report back with:` was reported as missing Report back, and an unreadable brief exited 1 (failed brief) instead of 2 (usage error).
- **Root Cause:** The section regex put the colon immediately after the label, but the real brief template writes "Report back **with**:". Separately, the unreadable-file branch lived inside the per-brief lint function, so its failure was folded into the general "a brief failed" status.
- **Rule:** Match a label up to its colon (`Report[[:space:]]+back[^:]*:`) and validate every input path before linting so usage errors keep exit 2. Both cases are selftested in `scripts/lint-brief-selftest.sh`.
