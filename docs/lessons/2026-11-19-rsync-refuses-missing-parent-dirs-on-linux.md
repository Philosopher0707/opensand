# Linux rsync refuses a destination whose parent directories do not exist

- **Trap:** Every target-sync test that really ran rsync passed on macOS and
  failed on Linux CI with `rsync: [Receiver] mkdir "<dest>" failed: No such
  file or directory`, for both the push (`<root>/missions/<id>/`) and the
  bundle deploy (`<root>/.opensand/target/<hash>/`) whose parent chain was
  still missing on a fresh remote.
- **Root Cause:** rsync creates only the destination's final path component.
  macOS's rsync (Apple's build) creates the missing parents, Linux rsync
  3.4.x does not, so a green local run hid the failure from the platform that
  CI actually runs.
- **Rule:** Before every rsync into a remote directory, run
  `mkdir -p <dest>` over the same remote-access path the sync uses (an
  argument-array ssh exec, or /bin/sh locally), so the code never relies on
  the local rsync's behavior to prove a remote platform's. The fresh-remote
  case (no `.opensand`, no `missions/` yet) is a first-class test case on
  Linux CI, not an incidental side effect of macOS tooling.
