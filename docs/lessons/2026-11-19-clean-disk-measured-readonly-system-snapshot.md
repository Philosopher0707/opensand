# clean-disk.sh measured the read-only system snapshot instead of the Data volume

- **Trap:** `clean-disk.sh` reported free space with `df -h /`. On macOS that prints
  `/dev/disk3s1s1` — the read-only sealed system snapshot — whose capacity/used columns
  describe the system volume, and whose "available" figure (e.g. 2.8 GiB) differs from
  the real free space on the writable data volume `/System/Volumes/Data` (3.6 GiB).
  Decisions taken from that line (release disk guard, worktree low-space checks) were
  wrong by design, and cleanup logs showed a volume nobody can write to.
- **Root Cause:** `df <path>` reports the mount that path resolves to, and `/` resolves
  to the sealed snapshot on macOS, not to the writable data volume. `status-report.sh`
  already measured `/System/Volumes/Data`; `clean-disk.sh` never got the same treatment.
- **Rule:** Any script that reports free disk space on macOS must measure
  `/System/Volumes/Data` (`df -k` there), falling back to `$HOME` on Linux CI where the
  path does not exist. Copy the pattern from `scripts/status-report.sh`. The selftest
  now stubs `df` so a script that measures any other path fails the suite — keep that
  case green when touching disk reporting.
- **Related:** the worktree 3 GB guard read `df -k /` and reported the same confused
  number while macOS held ~2.8 GiB purgeable that cannot be reclaimed without sudo
  (`purge` fails with "Operation not permitted"); a shell-script-only job was blocked
  by a conservative pre-flight check even though the worktree itself needs ~100 MB.
