# Brief helper scripts may exist only on origin/main

**Trap:** A Phase 5 brief ordered `scripts/worktree.sh new` and `bash scripts/pr-gate.sh --when-green`, but the main checkout was sitting on an unrelated feature branch whose tree has neither script. Working from that checkout fails before any task code is touched.
**Root Cause:** The scripts are tracked on `origin/main` but absent from the checked-out branch; the brief was written against a fresh `origin/main` checkout. In addition, `origin/main` can move between the moment a brief is written and the moment it is read (here `a15b5d3` → `b312ce5` after a fetch).
**Rule:** Fetch `origin/main` first and verify the brief's anchor commit resolves before creating the worktree. If a named helper is missing, look for it in `git ls-tree origin/main scripts/` and run it from the shared scratch base clone (`~/dev/_scratch/opensand-base`), which stays detached at `origin/main`; never create the worktree from the owner's dirty main checkout.
