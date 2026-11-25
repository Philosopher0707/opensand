# Legacy line numbers live in the worktree, not the owner checkout (2026-11-25)

**Trap:** Grepping `ictat` in `~/dev/opensand` gave legacy dictation at `app.js:4744–4810`, but the same code in the fresh Phase 5 worktree was at `4542–4608`. Reading the first range in the worktree returned unrelated trigger-popover code. The shared base clone was also two commits behind `origin/main`, so its line numbers were stale too.

**Root Cause:** The owner checkout is on a different feature branch (`feat/agent-settings-ui`), while `scripts/worktree.sh new` refreshes the base clone to `origin/main` and creates the job branch from there. Each branch has its own line offsets.

**Rule:** Read a brief's cited line ranges from the job worktree, never from the owner checkout or the base clone. Run `scripts/worktree.sh new <job>` and use its reported base SHA as the source of truth; re-grep legacy code there before editing or reporting file:line ranges.
