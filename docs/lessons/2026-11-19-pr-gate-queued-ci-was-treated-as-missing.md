# pr-gate --when-green gave up while CI was still queued

- **Trap:** Twice in one day a `scripts/pr-gate.sh --when-green` merge (Nova's lanes) failed
  with "no CI checks appeared" while the PR's workflow run had only just been created and its
  jobs were still waiting for a runner — the gate treated queued CI as missing CI and exited 3.
- **Root Cause:** The no-checks grace window only covered "GitHub has not registered any check
  on the PR yet". It had no notion that a workflow run can sit in queued/pending/waiting/
  requested state before checks appear. `gh run list`'s status field also lags the real job
  state, so it cannot decide whether CI is still running.
- **Rule:** In the `--when-green` no-checks wait, treat queued/pending/waiting/requested/
  in_progress jobs on the head commit's runs as CI still running: read each run's state from
  the per-run Jobs API (`gh api repos/{owner}/{repo}/actions/runs/<id>/jobs`) — the source of
  truth — and extend the grace window, bounded by `PR_GATE_QUEUED_RUN_MAX_SECONDS`
  (default 600s). Fail only on red/cancel, or on timeout naming the queued jobs. A repeat
  becomes selftest cases: queued → green, queued → red, queued at the bound → exit 3, and
  run-list lag → Jobs API still decides.
