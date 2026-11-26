# Quality-scores harness: brief command, hermetic seams and local-model timing

**Trap:** The brief said to run `scripts/worktree.sh start quality-scores origin/main`, but the script only supports `new|review|save|done|list|base|prune`; `start` does not exist. The shared base clone was also dirty with another session's `AGENTS_LEARNING.md` edit, so `worktree.sh new` would have refused before touching anything.

**Root Cause:** A brief names an intended action, not a verified command. `ensure_base` requires the shared clone to be pristine, and resetting it would destroy work that is not mine.

**Rule:** Read the script's usage before running a brief-supplied command; when the shared base is dirty, create the job worktree directly with `git worktree add -b <branch> <path> origin/main` after fetching, and leave the base untouched.

**Trap:** The first selftest asserted that a sanitized claim did not contain a backslash-escaped backtick, although the sanitizer deliberately escapes backticks; the test went red on correct code. A hidden-test tamper check also tried to copy a workspace that had not been created.

**Root Cause:** The assertion described the raw input instead of the escaped output, and the check-copy fixture skipped the workspace setup step.

**Rule:** Assert the transformed form at a sanitization boundary, and build the full fixture through the same `createWorkspace` path production uses. [checked: evals/quality-scores/selftest.mjs sections 5 and 6]

**Trap:** A real native turn against local `qwen3:8b` solved `sum` correctly in 81 s, but the harness's 60 s per-task cap aborted it, so a real three-task run exits 1 before scoring.

**Root Cause:** The design deliberately caps each task at 60 s to bound the full run; the local 8B model is slower than that on this host.

**Rule:** Keep the 60 s cap fail-closed; judge the harness with the hermetic selftest (12 stubs red, 12 reference solutions green, two killed mutants) and report a real-model run as measured-but-capped rather than weakening the cap to obtain a green score.
