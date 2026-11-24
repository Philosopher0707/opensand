# A brief's base ref can be stale locally, and the shared worktree base can be dirty

**Trap:** The Settings/Welcome brief named `origin/main` at `a657626`, but this checkout's `origin/main` still pointed at `d225b51`; `scripts/worktree.sh` and `docs/audits/2026-11-23-completeness-audit.md` were missing from disk. The reusable base clone also held another bot's untracked lesson file, so `worktree.sh new` would refuse to refresh it.
**Root Cause:** A local clone's remote-tracking ref is a cache, not the live remote. The base clone is shared across bots, so one bot's untracked file makes `is_worktree_dirty` fail closed for everyone.
**Rule:** Fetch `origin` and confirm the brief's base SHA before assuming files are absent. Never clean or delete a shared base clone to make room for a job; set `OPENSAND_BASE_DIR` to a fresh scratch path so the helper clones its own clean base, leaving other bots' work untouched.
