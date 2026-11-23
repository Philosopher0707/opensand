# OpenSand release tagging requires fresh origin/main and matching package version; pr-gate auto-readies worktree drafts

**Trap:** `scripts/release.sh` Step 4 created and pushed release tag `v<version>` directly from local `HEAD` without checking if local `HEAD` was stale. When the local checkout lagged behind `origin/main` (or if package versions were not bumped on that commit), a stale commit was tagged, breaking the GitHub Actions `release.yml` build. Step 5 then collided with leftover artifacts from an older release. Meanwhile in `scripts/pr-gate.sh`, draft PRs opened by `scripts/worktree.sh save` stalled at Check 1 until manually marked ready.

**Root Cause:** `release.sh` never ran `git fetch origin` or asserted that `HEAD` matched `origin/main` and `packages/desktop/package.json` matched `$VERSION` before tagging or proceeding with an existing tag. In Step 5, `gh release download` did not pass `--clobber` or purge leftover version files. In `pr-gate.sh`, Check 1 failed unconditionally on `isDraft === true` instead of auto-readying drafts opened by `worktree.sh save`.

**Rule:**
1. In `scripts/release.sh` Step 4, before creating a tag, run `git fetch origin` and refuse unless `HEAD` equals `origin/main` and `packages/desktop/package.json` version equals `$VERSION`. If the tag already exists on origin, check that the tag's commit has package version `$VERSION`, failing with an actionable fix hint if mismatched.
2. In `scripts/release.sh` Step 5, clean leftover artifacts not matching `$VERSION` and pass `--clobber` to `gh release download`.
3. In `scripts/pr-gate.sh` Check 1, detect drafts opened by `worktree.sh save`, run `gh pr ready <PR>` automatically (logging the transition), and proceed without stalling.
