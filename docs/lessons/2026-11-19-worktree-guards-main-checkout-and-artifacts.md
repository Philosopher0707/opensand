# Two worktree traps became automatic checks: the main checkout, and regenerated screenshots

- **Trap:** `scripts/worktree.sh` refused only a *current directory* inside `~/dev/opensand`. Run from
  anywhere else, or invoked as `~/dev/opensand/scripts/worktree.sh`, `new`/`review` still acted on the
  owner's main checkout (worktree records written into its `.git`), and `done <path>` reached it as a
  target. Separately, a full `verify.sh` rewrote tracked PNGs under `packages/desktop/artifacts/` and
  `save` staged them, which `pr-gate.sh` then refused as a binary in the diff (Dex #138, Rigel #139,
  same day).
- **Root Cause:** The safety rule was written as one cwd check against the literal path, not as a
  predicate over *every* repository and target a command would act on, and it did not resolve
  symlinks. Screenshot rewrites are a side effect of running tests, so "everything changed in this
  worktree" is the wrong default for `save`.
- **Rule:** `scripts/lib/worktree-safety.sh` owns `is_main_checkout`/`assert_not_main_checkout`
  (symlink-resolved, override only via `OPENSAND_ALLOW_MAIN_CHECKOUT=1` for tests), and `worktree.sh`
  applies it to the cwd, the source repository's toplevel, and every `new`/`review`/`done` target path
  before acting. `save` never stages `packages/desktop/artifacts/*.png` unless the path is named
  explicitly after `--`: it restores them to HEAD and prints what it skipped. Both rules are covered by
  `scripts/worktree-selftest.sh` test 12 and by a mutation probe.
