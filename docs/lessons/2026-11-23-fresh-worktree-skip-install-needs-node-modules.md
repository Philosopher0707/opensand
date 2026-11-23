# A fresh worktree has no node_modules, so SKIP_INSTALL=1 fails at build

**Trap:** `TMPDIR=$(mktemp -d) SKIP_INSTALL=1 bash scripts/verify.sh` in a new `worktree.sh new` tree failed with `tsc: command not found` and `node_modules missing`; the base clone has no dependencies either.

**Root Cause:** `SKIP_INSTALL=1` means "reuse node_modules". It assumes dependencies were installed earlier, but a fresh worktree has none.

**Rule:** In a new worktree, run `pnpm install --frozen-lockfile --offline` once from the shared store (no network), then run verify.sh with `SKIP_INSTALL=1`. The offline install's missing-`dist` bin warnings are expected and resolve after build.
