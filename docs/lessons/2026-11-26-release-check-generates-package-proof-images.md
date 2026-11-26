# Full release-check runs generate proof images inside the package tree

**Trap:** `scripts/release-check.sh` ran the full desktop suite, which rewrote tracked proof screenshots and created additional PNGs under `packages/desktop/artifacts/` despite the release task having no source changes there.

**Root Cause:** Some real-window tests write their default proof output beside package tests instead of using a temporary output directory.

**Rule:** Before running the full release-check, record the initial package artifact status. Afterward restore only tracked screenshots changed by that run and remove only the untracked screenshot files it generated; verify `git status` contains no `packages/**` changes before committing.
