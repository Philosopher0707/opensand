# A test helper that spawns children must close them on the failure path, or a red run never ends

- **Trap:** During the Phase 8 S2 mutation probe (flipping the target.hello
  version gate), the mutant made the handshake fail on purpose — and the probe
  hung for over 30 minutes instead of going red. The suite's `connect()` helper
  awaited `client.hello()` outside its `try/finally`, so every test that
  expected a working handshake threw before reaching its cleanup, leaving the
  spawned `opensand-target` child processes alive.
- **Root Cause:** The orphaned children held open stdio pipes. node --test's
  event loop keeps running while any inherited/piped stream handle is open, so
  the runner never printed its failure summary and the probe's RED step never
  completed. Green runs hide this: every test closed its client in `finally`.
- **Rule:** Any test helper that spawns a child process must close the child on
  the failure path too — wrap the setup (handshake, preflight) in try/catch and
  close in the catch before rethrowing, not only in the test's `finally`. A
  mutation probe is exactly the run that hits your failure paths, so a suite
  that can only exit clean cannot be probed. Caught during the S2 version-gate
  probe; the fix is in `target-transport.test.ts` `connect()`.
