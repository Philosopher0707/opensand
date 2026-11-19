# Check a block's real boundaries before wrapping it in a new branch

- **Trap:** Adding a Linux branch to an existing `if DRY_RUN ... fi` block in `release.sh`, I assumed the block had an outer `if` and appended an extra `fi`; `bash -n` failed with `syntax error near unexpected token 'fi'`.
- **Root Cause:** I edited from a remembered shape rather than the file's actual lines; the existing block had exactly one `if`, so adding `elif` extended it and no second `fi` was needed.
- **Rule:** Read the exact lines around a block before inserting branch scaffolding, then run `bash -n <script>` immediately after the edit. Keep numbering comments cosmetic and do not let them drive structure.
