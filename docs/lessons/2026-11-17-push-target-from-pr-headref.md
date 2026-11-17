# Push to the branch the PR actually has, not the branch the job is named after

- **Trap:** A fix commit was pushed to `job-release-asset-retry` because that was the worktree/job name, while the open PR was on a different branch. The push succeeded, so CI stayed green on the old head and the PR never received the fix; the mismatch only showed up when checking the PR's head commit against the local commit.
- **Root Cause:** The job/worktree name and the PR branch name are set in different places and can differ. `git push` alone (or `git push origin HEAD`) targets whatever name the local branch carries, which is not proof that the commit landed on the PR. The branch name was assumed from context instead of read from the PR that would be merged.
- **Rule:** Take the push target from the pull request itself: `git push origin HEAD:$(gh pr view <PR> --json headRefName -q .headRefName)`. After pushing, verify the PR head matches the local commit with `gh pr view <PR> --json headRefOid -q .headRefOid` compared against `git rev-parse HEAD`; do not report a fix as delivered until those two SHAs agree.

(Found while retrying a release asset download fix: the push went to `job-release-asset-retry` while the PR was on `fix/release-asset-download-race`.)
