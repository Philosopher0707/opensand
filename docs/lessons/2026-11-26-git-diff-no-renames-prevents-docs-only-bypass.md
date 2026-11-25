# Git diff --no-renames prevents source-to-docs rename from bypassing CI

**Trap:** Renaming an essential source file into `docs/` (e.g. `git mv packages/good/src/removed.ts docs/removed.md`) was treated by CI as a docs-only change, exiting 0 before running builds or tests.

**Root Cause:** `git diff --name-only` enables Git rename detection by default, reporting only the destination path (`docs/removed.md`) and omitting the source path (`packages/good/src/removed.ts`). Because all reported paths matched the docs patterns, `verify.sh` set `DOCS_ONLY=1` and skipped compilation and test execution.

**Rule:** Always pass `--no-renames` to `git diff --name-only` when inspecting changed paths for CI skip conditions, ensuring both the deletion of the old path and the creation of the new path are evaluated. Any rename from code into docs must fail closed to executing builds and package test suites. [checked: `scripts/verify-selftest.sh`]
