# A CLI stub that ignores positional arguments let a duplicate subcommand merge into main

**Trap:** PR #204 changed pr-gate to build `MERGE_ARGS=(merge "$PR" --merge)` and run `gh pr merge "${MERGE_ARGS[@]}"`. That executes `gh pr merge merge 42 --merge`, which real `gh` rejects. Every one of the 43 stubbed selftest cases passed.

**Root Cause:** The `gh` stub dispatched on `$1=pr`, `$2=merge`, then logged `echo "gh pr merge $*"` and exited 0 without checking `$3`. The literal word `merge` sat where the PR number should be and nothing looked at it; the log prefix itself repeated `pr merge`, so even reading the log looked plausible, and case 42 only grepped for `--body`.

**Rule:** A stub for a positional CLI must validate every argument the real command depends on, and log `gh $*` so the recorded line is the command actually invoked (no hand-written prefix). `pr-gate-selftest.sh` now refuses a `pr merge` whose `$3` is not a positive integer and asserts each merge log line begins `gh pr merge <number> --merge`. Before merging a gate change, put the old line back, show the test fails, restore it, and show every case passes (60 failures on the mutant, 43 passes on the fix).
