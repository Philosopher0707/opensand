# The main checkout can be years behind and is never updated

- **Trap:** Phase 8 S1 ran `bash scripts/worktree.sh new phase8-s1-mission-suite`
  from `~/dev/opensand` and got `No such file or directory`. That checkout was
  at PR #19 while `origin/main` was #146; `scripts/worktree.sh`, and almost
  every other script the brief names, did not exist in it.
- **Root Cause:** `~/dev/opensand` is the owner's checkout and is permanently
  protected: no bot may fetch-into it, check it out, or update it. Reading the
  tree from `git show origin/main:<path>` works, but executing a script whose
  file is absent does not, and the brief's first command is that script.
- **Rule:** run `scripts/worktree.sh` from the scratch base clone
  (`~/dev/_scratch/opensand-base`), which `new` refreshes to `origin/main`
  first. Never "fix" the missing file by updating the main checkout. When a
  named script is also absent from the base clone, read it with
  `git show origin/main:<path>` and run that copy from the base clone.
