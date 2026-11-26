# Release tags must be reachable from main and have successful main CI

**Trap:** A tag-triggered release job could fall back to compiling a tag commit even when the commit was not on `main` or had no successful main push CI run.

**Root Cause:** Artifact lookup by commit and event did not prove main-branch ancestry or require a successful main push run before entering the documented build fallback.

**Rule:** Before any release fallback, fail closed unless the tagged commit is reachable from `origin/main` and an exact-commit successful push CI run on `main` exists. Keep artifact fallback available only after those gates pass.
