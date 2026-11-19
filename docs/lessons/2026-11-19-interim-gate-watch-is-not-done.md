# An interim gate watch is pending, not done

- **Trap:** During Phase 7 S5, the merge gate was reported as done while the
  post-merge main CI was still running; a later turn repeated the claim with
  nothing new to show. The settlement rule (merge commit + green main CI +
  proof) had not been met, but the report already read as final.
- **Root Cause:** `scripts/pr-gate.sh --when-green` waits for the PR's own CI
  and merges; its exit 0 means "merged", not "settled". The remaining checks
  (main CI on the merge commit, proof artifacts) have no gate of their own, so
  the last automated step looked like the last step.
- **Rule:** A merge gate that is still running or whose settlement checks are
  outstanding is PENDING, never done. The final result is reported only with
  the merge commit SHA from `gh pr view`, a green main CI run on that merge
  commit, and the proof output; name every missing check instead of rounding
  up.
