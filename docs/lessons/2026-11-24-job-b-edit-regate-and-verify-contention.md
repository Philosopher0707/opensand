# Job B: re-gating an edit must compare tiers; full verify can stall under load

**Trap:** The first re-gate denied every edited argument whose policy action was `REQUIRE_APPROVAL`, so a valid edit that stayed in the same tier was rejected with "needs a fresh approval". The test failed with `PERMISSION_DENIED / safety_gate` on the happy path.

**Root Cause:** The check looked only at the edit's policy action, not at the action the original call already had. A human had already answered at that tier; re-asking is not a safety improvement, it is a false denial. Separately, the full `scripts/verify.sh` run in the foreground made no progress for 15 minutes and was killed by the harness timeout while `uptime` showed load ~80 from other bots' verification runs; `check-test-teardown.sh` passed in under a second when run alone.

**Rule:** When re-gating a per-decision edit, pass the original policy action into the check and deny only when the edit raises the tier (or hits DENY, a dangerous/nested-shell/unsandboxed command, or a memory/skill gate). [checked: `packages/coordinator/test/approval-modified-args.test.ts`] On a loaded host, run the full suite in a background shell without a fixed harness timeout and check `ps` for other verify processes before treating a stall as a failure; never rerun a timed-out verification unchanged.
