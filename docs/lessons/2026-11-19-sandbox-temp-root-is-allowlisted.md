# macOS sandbox-exec allowlists the per-user temp root, so a containment probe under /var/folders proves nothing

- **Trap:** Phase 7 S4's containment fixture wrote its "forbidden" target into
  the test repo under `os.tmpdir()` and expected the sandbox to deny it. The
  write SUCCEEDED (exit 0) and the fixture failed in the wrong direction: the
  sandbox was working exactly as built.
- **Root Cause:** The workspace-write profile allowlists, besides the workspace
  root, the temp dirs (`TMPDIR`, `os.tmpdir()` and macOS's per-user temp root
  from `getconf DARWIN_USER_TEMP_DIR`) and the standard caches. A repo created
  with `mkdtemp` lives under exactly those roots, so writing "outside the
  workspace" inside a temp-rooted path is an allowed write by design.
- **Rule:** A containment probe's forbidden target must sit outside every
  allowlisted root — for the current profile that means outside the workspace,
  both temp roots, and `~/Library/Caches`-style paths. A home-directory path is
  the dependable choice; name it with a fixed, cleanup-able prefix and delete
  it in `finally` (it only exists if the denial failed). Check the allowlist in
  the profile generator, not your intuition about what "outside" means.
