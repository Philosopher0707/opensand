# A fetch that failed silently made origin/main look unfixed

- **Trap:** The first fetch used `timeout 60000 git fetch`. macOS has no `timeout` binary, so the command printed `command not found` and fetched nothing. The local `origin/main` was still at the pre-#117 commit, so `git merge-base --is-ancestor 78852e8 origin/main` failed and the checkout looked unfixed.
- **Root Cause:** The fetch's exit status was not checked, and the tail of its output was not read before the next step used the stale ref.
- **Rule:** Do not wrap git commands in `timeout` on macOS; use `git fetch origin` and read its exit status before trusting any `origin/*` ref. Before reporting a commit as merged or missing, confirm it with `git merge-base --is-ancestor` after a successful fetch.
