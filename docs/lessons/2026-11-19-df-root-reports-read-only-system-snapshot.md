# A `df -k /` free-space guard measures the read-only system snapshot

- **Trap:** `scripts/worktree.sh new` refused to create a worktree with
  "Insufficient disk space: 0 GB available (< 3 GB required)" while the data volume had
  plenty free, and `scripts/release.sh` Step 1 would have run `clean-disk.sh --yes` on
  every release for the same wrong number.
- **Root Cause:** On macOS `/` is the read-only system snapshot (`/dev/disk3s1s1`), whose
  `df -k /` Available column is near zero; the writable data volume is
  `/System/Volumes/Data`. PR #140 fixed this in `clean-disk.sh`, but the free-space guards
  copied into `worktree.sh` and `release.sh` still read `/`.
- **Rule:** One source of truth: `scripts/lib/free-space.sh` sets `DISK_PATH` to
  `/System/Volumes/Data` when it exists, else `$HOME`, and every disk guard runs
  `df -k "$DISK_PATH"`. Each guard's selftest stubs `df` so `/` reports 0 free and the
  data volume reports space, and asserts both that the work succeeds and that `df` was
  asked about the data volume path (never `/`).
