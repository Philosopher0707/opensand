# A stale bump-PR base stalls release.sh at the gate instead of rebasing and resuming

**Trap:** When other PRs merge while the bump PR's CI runs, a re-run of `release.sh <version>` dies at pr-gate Check 2/5 with "PR base is out of date" (exit 1). The operator has to hand-run `gh pr update-branch <PR> --rebase` and then remember to re-run the release, so a finished release waits on a manual step.

**Root Cause:** pr-gate verifies that the PR's `baseRefOid` equals `origin/main` and fails. release.sh treated that failure as fatal even though a moving base is an expected, recoverable state during a release: CI is still running on the bump branch while main keeps moving.

**Rule:** In release.sh Step 3, before invoking pr-gate, compare the bump PR's `baseRefOid` with `git ls-remote origin refs/heads/main`. When they differ, run `gh pr update-branch <PR> --rebase` inside release.sh, print that it did, and exit 3 with re-run instructions so the caller resumes after CI. Selftest case 18 stubs gh and git and asserts the rebase call, exit 3, and that the gate was never run on the stale base.
