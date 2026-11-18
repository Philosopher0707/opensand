# A rebase --continue opened an editor and hung the merge gate

**Trap:** The gate's INDEX-only auto-resolve regenerated the index, staged it, then ran `git rebase --continue`. Live, that command opened the commit-message editor and waited; with no tty it failed, so the gate reported "regenerating INDEX did not let the rebase continue" and refused to push. The hermetic selftest stub returned 0 for `rebase --continue`, so every case stayed green.

**Root Cause:** `git rebase --continue` can invoke an editor for the commit message. The stub could not reproduce an interactive editor, so the test asserted the call but not that it was non-interactive.

**Rule:** The gate runs `GIT_EDITOR=true git rebase --continue` so a resolved rebase never waits for a human. The selftest stub records `$GIT_EDITOR` on that call and case 25 asserts it is `true`: a stubbed command must assert the properties that keep the real command from hanging, not just that it was called.
