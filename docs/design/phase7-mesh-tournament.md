# Phase 7: Mesh and tournament

Status: design, 2026-11-18. Nothing here is implemented. It specifies Phase 7 of
`docs/design/opensand-next.md` §6.2 ("Role routing, ladder, stats, parallel
attempts in worktrees"; done when: a three-attempt tournament finishes with every
worktree but the kept one removed, and routing changes after the stats change, in
a test with fixed data). Sections 3.4, 3.5 and 4.5 of that doc are the product
intent; this doc is the build contract for Dex.

Phase 7 sits on three earlier phases. Their status at the time of writing:

| Dependency | What Phase 7 uses | State in `55d1f1f` |
|---|---|---|
| Phase 1 event log | Hash-chained per-mission `log.jsonl`; every stat is a record in it | `packages/engine/src/missions/` exists; the hash-chained log is Phase 1 work. Phase 7 refuses to start on a log without a verified chain |
| Phase 3 missions | Mission graph, harness-run `check`, receipt, budget events | `packages/engine/src/missions/{runner,check,receipt}.ts` exist. Treat as the integration points, confirm the Phase 3 done-when before S4 |
| Phase 4 containment | Sandbox profile per command, grants with epoch, inbox | `packages/local-exec-daemon/src/sandbox/{macos-profile,linux-bwrap}.ts` exist. The grant epoch and folder trust are Phase 4 work |

**Gap found while writing this doc.** Nothing records token usage or cost today:
`grep` over `packages/coordinator/src` and `packages/engine/src` finds no
`usage`, `inputTokens` or `costUsd` in any provider client or in the coordinator
loop. Per-attempt cost, the budget (§3.5) and the cost tie-break (§5) all need
it. This is precondition P1 (§9), owned by Phase 3.

---

## 1. Decisions at a glance

| Question | Decision | Why this and not the alternative |
|---|---|---|
| Where do stats live | In the existing mission logs, as `mesh.attempt.result` records. Stats are a rebuildable cache over them, keyed by each log's head hash | A separate `mesh/stats.jsonl` (listed in `opensand-next.md` §4.8) is a second writer that can disagree with the log, the same failure §4.3 was written to prevent. This is a deliberate change to §4.8 (see §3.3) |
| Routing table | User-editable `mesh/routes.json` (ordered ladder per role) plus a pure function that picks the start rung from stats | The ladder is the user's order; stats only skip rungs that have no good record. Nothing is re-ordered silently |
| Attempt workspace | `git worktree add --detach <path> <base-sha>` under `~/.opensand/missions/<id>/attempts/<n>/tree`, never under `os.tmpdir()` | `GitManager.createWorktree` (`packages/coordinator/src/git-manager.ts:253`) defaults to `os.tmpdir()`, which the OS clears and a crash cannot find again. Detached HEAD means no branch per loser |
| Keep | The winner gets a branch `opensand/<mission>/<n>` and stays where it is. The tournament never writes to the user's checkout | The user merges. An automatic apply into the working folder would be a write outside containment |
| Loser removal | Snapshot to a hidden ref first, then remove (never a bare `--force`) | `removeWorktree` uses `--force` and returns `false` on any error (`git-manager.ts:494`). Losers' work must survive removal |
| Judge | Deterministic gate, then a deterministic rank, then a cross-family reviewer only for a tie | Model judgment cannot override a failed check |
| Limits | Hard caps in code; defaults in the mission; cost split evenly per attempt | §5 |
| Containment | Each attempt runs under the mission's Phase 4 profile with its write root set to its own tree | §7 |

New dependencies: **none**. Git plumbing uses the `git` binary through the
existing `execGit` helper; the lock is the existing `EventLogLock`
(`packages/shared/src/event-log-lock.ts`); the stats fold and the judge are
plain TypeScript; HTTP to models uses the existing provider clients.

---

## 2. Roles and routing

### 2.1 Roles

Five roles, from `opensand-next.md` §3.5: `planner`, `coder`, `reviewer`,
`summarizer`, `vision`. Phase 7 implements routing for `coder` and `reviewer`
first; the other three use the same code path and one fixture each.

### 2.2 `mesh/routes.json`

Lives at `~/.opensand/mesh/routes.json`. Validated by a schema on load; an
invalid file makes the engine refuse tournaments and say which key is wrong. It
does not fall back to a default ladder, because a silent fallback would route
work to a model the user never chose.

```json
{
  "version": 1,
  "roles": {
    "coder": {
      "ladder": ["ollama:qwen3:8b", "openrouter:<cloud-coder>", "openrouter:<strong-coder>"],
      "minSamples": 5,
      "minPassRate": 0.5
    },
    "reviewer": {
      "ladder": ["openrouter:<cloud-reviewer>"],
      "minSamples": 5,
      "minPassRate": 0.5
    }
  }
}
```

- Each entry is `provider:model`. The provider's family comes from a required
  `family` field in the model catalog entry. A model with no family is
  `family: "unknown"`, and an unknown family is treated as the same family as
  every other model, so it never satisfies the cross-family rule.
- Entries in angle brackets are placeholders, not real model IDs.
- Ladder order is the user's order. By convention it is cheapest first. Phase 7
  does not sort by price.

### 2.3 Start rung (pure function)

`selectStartRung(role, ladder, stats, now) → { rung, model, reason }`

1. Walk the ladder in order.
2. A rung qualifies if its stats for this role have `counted >= minSamples`
   and the Wilson lower bound (95%, z = 1.96) of the pass rate is `>= minPassRate`.
3. The first qualifying rung is the start. If none qualifies, the start is rung 0
   and `reason` is `no-qualifying-record`.
4. A rung with 3 timeouts in its last 10 attempts is skipped until one of its
   attempts succeeds (`reason` says so).

Routing decisions are written as `mesh.route.selected` with the input hash
(`stats` fingerprint, ladder, thresholds) and the chosen rung. §8 explains why.

### 2.4 Cross-family reviewer

When the coder is in family F and a reviewer rung exists with family ≠ F, the
reviewer is taken from the first such rung. If none exists, the reviewer runs
from the same family and the receipt says `review: same-family (no second family configured)`.
Phase 7 does not refuse that case, because a single-family install is normal; it
labels it.

---

## 3. Stats

### 3.1 What is recorded per attempt

One record per finished attempt, appended to the mission's `log.jsonl`:

```json
{"seq":57,"kind":"mesh.attempt.result","attempt":2,"node":"act",
 "data":{"role":"coder","model":"openrouter:<cloud-coder>","family":"<family>",
         "outcome":"check_failed","checkExit":1,"diffLines":84,"filesChanged":3,
         "costUsd":0.0412,"wallMs":431000,"tokensIn":18211,"tokensOut":3305,
         "rung":1,"escalatedFrom":"ollama:qwen3:8b","missionBudgetUsd":2.0,
         "scopeViolations":0,"containmentEvents":0}}
```

`outcome` is one of:

| Outcome | Counted for routing | Meaning |
|---|---|---|
| `passed` | yes, success | Check exit 0, no containment event, scope kept |
| `check_failed` | yes, failure | The model's change ran and the check exited non-zero |
| `no_change` | yes, failure | The attempt's diff is empty. A model that does nothing does not pass |
| `review_rejected` | yes, failure | The reviewer rejected a passing check (only when the mission enables review) |
| `timeout` | no; counted in the timeout window (§2.3 step 4) | Wall clock exceeded |
| `infra_error` | no | Provider 429/5xx/network, or HTTP 402 out of credit |
| `interrupted` | no | Process died during the attempt (crash, kill -9) |
| `budget_stopped` | no | Stopped by the attempt's cost cap |

Rule: **only a model's own result counts.** Infrastructure outcomes are logged
for the receipt and the cost ledger but never move a pass rate. This is what stops
one provider outage from poisoning a model's record (§9, row 4).

### 3.2 The fold

`foldMeshStats(records) → Map<(role, model), Stats>` is a pure function over
records, where `Stats = { counted, passed, rateWilsonLow, costMedianUsd, timeouts,
window }`. It keeps the last **50** counted results per `(role, model)` (a window,
so an old regression stops mattering) and reports the Wilson lower bound on that
window.

### 3.3 Where the fold reads from

- Source of truth: every `mission.*/log.jsonl` record with
  `kind = mesh.attempt.result`.
- Cache: `~/.opensand/mesh/stats.cache.json`, `{ "missions": { "<id>": "<head-hash>" },
  "stats": {…} }`. On read, a mission whose head hash changed is re-folded. The
  cache is deletable at any time and rebuilds from the logs.
- Why a cache at all: folding every log on each mission start grows with history.
  Why it cannot diverge: it is keyed by the log's head hash, and deleting it
  changes nothing.
- Change to `opensand-next.md` §4.8: `mesh/stats.jsonl` is dropped. Stats are
  projections of the logs, the same rule §4.3 applies to the conversation and the
  receipt. Only `mesh/routes.json` and the cache are files under `mesh/`.

### 3.4 Receipts

The Phase 3 receipt gains a `Tournament` section built from the same records:

```
Tournament  3 attempts, 2 concurrent · base 4f2a9c1
  #1  check_failed  ollama:qwen3:8b       diff 41   $0.00   6m 02s
  #2  passed        openrouter:<cloud>    diff 58   $0.04   7m 40s   ← kept (branch opensand/m-41/2)
  #3  no_change     openrouter:<strong>   diff 0    $0.09   4m 11s
  Judge: deterministic (1 passed). No tie-break. Losers snapshotted: #1 s-refs/…/1, #3 …/3
  Routing: coder start ollama:qwen3:8b (no-qualifying-record); escalated to rung 1 on check_failed
```

The model does not write this. The harness builds it from the records.

---

## 4. Parallel attempts in worktrees

### 4.1 Lifecycle

A tournament is started from a mission at its `check`-ready point, with a base
commit `B` (the target repo's `HEAD` when the tournament starts, recorded in
`mesh.tournament.started {base: B}`).

Per attempt `n`, the events below are appended in this order. **The log record
always comes before the filesystem action it describes**, so a crash can be
detected by reconciling the log against the disk.

| Step | Log record (before the action) | Action | Idempotent re-run |
|---|---|---|---|
| 1 Reserve | `attempt.reserved {n, path, lease}` | none | nothing to do |
| 2 Create | `attempt.created {n}` | `git worktree add --detach <path> B` under the worktree lock | if `<path>` is a worktree of this repo at `B`, skip; else remove the directory and recreate |
| 3 Run | `attempt.running {n}` | sandboxed model/tool loop (§7) | interrupted → step 6 with `interrupted` (never resumed in place, §6.2) |
| 4 Check | `attempt.checked {n, exit}` | harness check in the sandbox | the check is re-run only if its record is missing |
| 5 Finish | `attempt.finished {n, outcome}` + `mesh.attempt.result` | none | append-once: a second `finished` for `n` is refused |
| 6 Snapshot (losers only, and interrupted) | `attempt.snapshotted {n, ref}` | commit the tree to `refs/opensand/missions/<m>/attempts/<n>` using a temporary index (the same mechanism as `timeline-fork.md` §1) | if the ref exists at the expected tree, skip |
| 7 Remove (losers) | `attempt.removing {n}` … `attempt.removed {n}` | `git worktree remove <path>` (no `--force` unless step 6 has committed the tree); then delete any leftover directory under the attempts root | runs again until `removed` is logged |
| 7' Keep (winner) | `attempt.kept {n, branch}` | `git branch opensand/<m>/<n> <commit>`; the worktree stays | branch exists at the same commit → skip |

Two rules hold at every step:

- **Never `git worktree prune`.** The existing comment at `git-manager.ts:484`
  explains the race: prune deletes a peer's registration that is mid-add. Cleanup
  removes one named path at a time.
- **Never remove a path that is not under `~/.opensand/missions/<id>/attempts/`.**
  The remover checks the prefix after `realpath`, so a symlink cannot point it
  elsewhere.

### 4.2 Concurrency

- Up to `concurrency` attempts run at once (default 2, hard max 3). The rest wait
  in `attempt.reserved`.
- Worktree creation takes the existing `withWorktreeLock`, the same lock
  `GitManager` uses (`git-manager.ts:127`). It is not held during the run.
- Attempts share the object database and nothing else. Each has its own index,
  its own `HEAD` (detached) and its own working tree.

### 4.3 Crash and kill recovery (reconcile)

`reconcileTournaments()` runs on engine start, on `opensand mission reconcile`,
and when a mission is opened. For each mission with a non-terminal attempt:

1. Take the attempt's lease (§4.4). If the lease is held by a live process, skip it.
2. Walk the log for the attempt's last record and resume at the matching step:
   `reserved` with no directory → mark `interrupted`, skip to the end;
   `created`/`running` → step 6 then step 7; `finished` → step 6 if a loser, then 7;
   `removing` → step 7 again.
3. **Orphan scan** (no log record): list `git worktree list --porcelain`, keep only
   paths under this repo's `~/.opensand/missions/*/attempts/` root, and for each
   whose `attempt.reserved` record is missing, snapshot (if dirty) and remove that
   path. A directory under the root with no worktree registration is deleted.

Reconcile is idempotent: a second run does nothing.

### 4.4 Lease

`attempts/<n>/lease.json`: `{ "pid", "startedAt", "bootId" }`, written at step 1
and removed at step 7 or 7'. Liveness is `kill(pid, 0)` plus a comparison of the
process start time with `startedAt`, so a reused PID is not mistaken for the
original owner. A lease with a dead owner is stale.

---

## 5. Judging the winner

### 5.1 Stage 0: deterministic gate (harness code, no model)

An attempt is **eligible** only if all hold:

1. `attempt.checked.exit == 0` (the mission's check, run by the harness).
2. `containmentEvents == 0` and `scopeViolations == 0`.
3. `diffLines > 0` (no change never wins).
4. `diffLines <= mission.maxDiffLines` (default 1000).
5. The snapshot and worktree operations succeeded (no `interrupted`).

No eligible attempt means the tournament ends `failed` with the receipt listing
each attempt's reason. It does not ask a model to pick.

### 5.2 Stage 1: deterministic rank

Eligible attempts sort by the key `(diffLines asc, costUsd asc with null last,
wallMs asc, n asc)`. `costUsd` is null when P1 is not met; such a mission cannot
start (§9), so in practice it is never null.

### 5.3 Stage 2: tie-break (the only model judgment)

Attempts are **tied** when each is within the band of the best eligible attempt:
`diffLines <= best.diffLines * 1.10 + 20` and `costUsd <= best.costUsd * 1.10`.
If one attempt is alone in the band, it wins with no model call.

If two or more are tied, the **cross-family reviewer** (§2.4) gets the tied
attempts' diffs, their check output and no other attempt's information. It must return JSON:
`{ "order": ["<attempt id>", …], "reason": "…" }`, with `order` a permutation of
the tied set. The output is validated:

- Not a permutation, not valid JSON, a timeout, or a call error → use Stage 1's
  order and record `tieBreak: "fallback-deterministic"`. Still a decision; no retry loop.
- The reviewer cannot add an attempt that failed Stage 0, and cannot reorder
  across the band.

`mesh.decision {inputsHash, eligible, band, reviewerRaw?, order, winner, tieBreak}`
is written once. Replay reads it (§6.3).

### 5.4 When the judge is wrong

The design does not assume the judge is right. It makes a wrong judgment cheap to
reverse:

- Every loser is snapshotted before removal, so the user can reopen any loser
  as a worktree from its ref (`mission.attempt.restore`, S5).
- The receipt lists every attempt, including failed ones, so the user sees the
  choice and its inputs.
- A check that passes the wrong thing is caught by the mutation probe on the
  check (§9, S3), not by the judge.

---

## 6. Limits and failure semantics

### 6.1 Limits

| Limit | Default | Hard cap | Enforced by |
|---|---|---|---|
| Attempts per tournament | 3 | 5 | `limits.ts`, refused at start |
| Concurrency | 2 | 3 | `limits.ts` |
| Cost, mission | from the mission budget | the mission budget | budget events (Phase 3) |
| Cost, per attempt | mission budget ÷ attempts | the same | reservation before each model call |
| Wall clock, per attempt | 20 min | 60 min | attempt timer; kill process group → `timeout` |
| Wall clock, mission | 40 min | 4 h | mission timer |
| Escalations per attempt | 2 (rung 0 → 2) | 2 | ladder |
| Repair rounds | 3 | 3 | Phase 3 budget (`opensand-next.md` §3.1) |
| Retries on `infra_error` | 3, backoff 1 s / 4 s / 16 s, same rung | 3 | provider wrapper |
| Diff size per attempt | 1000 lines | 1000 | Stage 0 |

**Cost reservation.** Before a model call, the engine reserves
`maxTokens × price` against the attempt's cap, and settles to actual usage after.
When a model's price is unknown, the tournament refuses to start (fail closed:
an unknown cost is not a small cost). An attempt that would exceed its cap stops
with `budget_stopped`. The mission never continues past its limit silently
(`opensand-next.md` §3.5).

**Escalation triggers.** Only `check_failed`, `no_change` and `review_rejected`
move up a rung. `infra_error` retries the same rung. HTTP 402 (out of credit)
parks the attempt at once as `infra_error` with no retry, because retrying does
not change the balance. Escalating on infra errors would spend the next rung on
a provider that is down.

### 6.2 Crash and resume

- An attempt interrupted mid-run is **not resumed in place.** A partial edit from a
  killed model cannot be verified, so the tree is snapshotted (kept for
  inspection), the attempt is recorded `interrupted`, and a new attempt starts
  from the base commit only if the mission's retry budget allows one.
- The mission resumes at its last checkpoint (`opensand-next.md` §4.4). Finished
  attempts are not re-run.

### 6.3 Replay

- Replay never calls a model. Model responses are read from the `model.*` records
  in the log (the response is stored by hash, as Phase 1 requires).
- Route choices are replayed from `mesh.route.selected`, not recomputed from
  current stats. Changing stats does not rewrite a finished mission's history.
- Judgments are replayed from `mesh.decision`. A decision is written once; a second
  decision for the same mission and round is refused, because the log is append-only and the
  head is re-read under the lock.

---

## 7. Containment per attempt (Phase 4)

Every attempt runs under Phase 4 (`opensand-next.md` §4.6) with these settings.
If Phase 4's sandbox is unavailable on the host, **the tournament refuses to start**
(`opensand-next.md` already requires that when neither sandbox exists, every command
asks; an attempt cannot ask in the background, so it fails closed instead).

| Rule | Setting |
|---|---|
| Profile | `workspace-write`, write root = that attempt's `tree/` only |
| Denied writes | `<repo>/.git/**` (the shared git dir: refs, config, hooks, index), the user's checkout, every other attempt's directory |
| Denied reads | `~/.ssh`, `~/.opensand/vault`, shell rc files (Phase 4), and sibling attempts' `tree/` directories, so one attempt cannot copy another's answer |
| Git from the agent | Read-only subset (`status`, `diff`, `log`, `show`). `worktree`, `update-ref`, `config`, `push`, `reset --hard` are refused. Git plumbing is the executor's job |
| Network | Off, unless the mission already holds a grant. Attempts never create grants |
| Approvals | An attempt's approval requests have `initiator: subagent` (`policy-engine.ts`). They park in the inbox and are never self-approved |
| Untrusted text | Tool output and file content enter prompts in a labelled tag (Phase 4 §4.6). Check output is data |

**Why the shared `.git` is denied to the agent.** Every attempt's `.git` is a
pointer into the same common directory. If an attempt could write there, it could
move a branch, change config or install a hook that every other attempt and the
user's checkout would run. Plumbing is done by the executor, outside any sandbox,
under the worktree lock.

---

## 8. Relation to existing designs

- **`timeline-fork.md` §1** rejects detached worktrees for the time machine, because
  build caches and editor watchers attach to one folder. That reasoning holds for
  time-machine forks, which stay in place. Tournament attempts are a different case:
  each is isolated for a whole run, and nothing attaches to them while they run.
  Phase 7 does not change time-machine behaviour.
- **Ref names** follow `timeline-fork.md` (`refs/opensand/missions/<id>/…`), so a
  loser's snapshot is visible to the same tooling as a step snapshot.
- **`opensand-next.md` §4.8** lists `mesh/stats.jsonl`. This doc replaces it with
  the log-derived fold (§3.3). That is the only change to the storage layout.

---

## 9. Stress test: how the design breaks, and what it does

| # | Failure | What goes wrong without a countermeasure | What the design does | Test that proves it |
|---|---|---|---|---|
| 1 | **Orphan worktrees.** Engine killed between `git worktree add` and the log record, or after the directory is written | Directories and registrations pile up under `tmp`, and `git worktree list` never shows them again | Log before action (§4.1); reconcile by path under the attempts root (§4.3); no `tmp` location (§1) | Kill at each of the 7 steps in `attempt-worktrees.test.ts`; after reconcile, `git worktree list` has only the main entry and the attempts root is empty |
| 2 | **Two attempts write the same file.** Parallel edits race on one file | Lost writes, or one attempt's diff contains the other's edit | Separate trees (detached worktrees, §4.2). The only shared object is the common `.git`, which the agent cannot write (§7). Diff is taken per tree | Two fixture attempts both edit `README.md` with different text. Each attempt's diff contains only its own edit, and the kept branch matches its tree's `HEAD` |
| 3 | **The judge is wrong.** A check passes a no-op, or the reviewer picks an incorrect change | A bad change is kept and the user trusts "verified" | Check is the gate (§5.1); no-op never eligible; reviewer only breaks ties inside the band and cannot override Stage 0; losers snapshotted (§5.4); the check itself is covered by the Phase 3 mutation probe | Fixture: check exits 0 with an empty diff → `no_change`, never kept. Reviewer stub returning a Stage 0 failure → ignored. Mutation: make the gate ignore exit code; the suite must fail |
| 4 | **Stats poisoned by one bad run.** A provider outage, a flaky test or a single unlucky check changes the routing | Routing flips on noise and the user cannot tell why | Only the model's own outcomes count, so an outage never counts (§3.1); `minSamples` (5); Wilson lower bound, not the raw rate; a 50-result window (§3.2). **Residual, accepted:** one real `check_failed` can move a 9/10 model below the 0.5 bound (9/11 gives a lower bound of about 0.47). The start then moves down the ladder to a rung that qualifies, and escalation still applies. The boundary is pinned by test, so the sensitivity is known, not hidden | Fixed-data test: one `infra_error` leaves a 9/10 model's start unchanged; one `check_failed` moves it, and the test asserts that exact boundary; a model with 1 sample never qualifies |
| 5 | **Crash mid-cleanup.** Killed after the snapshot but before `worktree remove`, or after remove but before `removed` is logged | A half-removed worktree with uncommitted work; a loser whose work is gone | Snapshot before remove (step 6 before 7); `removing` is logged first and re-run until `removed`; each sub-step is idempotent (§4.1) | Kill after each sub-step of step 7; reconcile reaches `removed` and the snapshot ref holds the dirty file |
| 6 | **Forced removal loses work.** `--force` on a dirty worktree | Uncommitted edits in a loser are gone | `--force` is used only after the tree is committed to a ref (§4.1 step 7). The existing `removeWorktree` (`--force`, errors swallowed) is not reused for this | Loser with an untracked file: after removal, `git cat-file -p <ref>:<file>` returns its content |
| 7 | **Escalation burns budget on outages.** 402 or 429 walks the ladder to the most expensive model | Money spent with no progress | Escalation only on model outcomes (§6.1); 402 parks at once; retries keep the rung | Stub provider returns 402 for rung 0: the attempt parks with no call to rung 1; stub returns 429 twice then 200 → same rung, one `passed` |
| 8 | **Two engines reconcile the same attempt.** Second engine removes a live attempt | A running model loses its directory mid-run | Lease with PID and start time; reconcile skips live leases (§4.4) | Start two reconcilers; one holds a live lease; the attempt's directory survives and the other reports `skipped: live` |
| 9 | **Budget overrun by parallel attempts.** Two attempts both spend the mission's last dollar | Mission goes past budget, silently | Per-attempt cap from the mission budget ÷ attempts, reservation before each call (§6.1) | Stub prices and a budget of $0.10 across 2 attempts: the second attempt stops with `budget_stopped` before its call |
| 10 | **Unknown price or family.** A model with no catalog entry | Its cost reads as zero, so it always wins the tie-break | Missing price refuses the tournament; missing family is `unknown`, never a different family (§2.2) | Route with a model lacking `price` → tournament refuses with the model named; family `unknown` never satisfies §2.4 |
| 11 | **Routing changes history on replay.** A replayed mission picks a different model because stats moved | A finished mission cannot be explained | Route choices are logged and replayed from the log (§6.3) | Record a route, change the stats, replay: the route is unchanged, and a new mission picks the new rung |

---

## 10. Build plan for Dex

Five vertical slices, in order except that S1 and S2 are independent and may run
in parallel. Each slice ships as its own PR through `scripts/worktree.sh new` and
`scripts/pr-gate.sh --when-green`. No slice touches `packages/desktop` (Pixel) or
`packages/local-exec-daemon/src/tool-registry.ts` (Dex's current work). No slice
adds a dependency.

Every done-when is a command. "Passes" means exit 0.

### S1. Stats fold and start-rung routing (pure, fixed data)

- **Builds:** `foldMeshStats`, the Wilson bound, `selectStartRung`, `routes.json`
  schema validation. No I/O beyond reading the fixture files.
- **Files:**
  - new `packages/engine/src/mesh/types.ts`
  - new `packages/engine/src/mesh/stats.ts`
  - new `packages/engine/src/mesh/routing.ts`
  - new `packages/engine/src/mesh/routes-schema.ts`
  - new `packages/engine/test/fixtures/mesh/stats-a.jsonl`, `stats-b.jsonl`
  - new `packages/engine/test/mesh-routing.test.ts`
- **Done when:**
  ```
  pnpm --filter @opensand/engine build && pnpm --filter @opensand/engine test -- mesh-routing
  ```
  passes. The test asserts, on exact fixtures: `stats-a` has model 1 at 9 passes
  and 1 failure, and model 2 at 2 passes and 8 failures; the start is model 1.
  `stats-b` is appended after it: model 1 gets 10 more failures (9/20, lower bound
  about 0.26) and model 2 gets 18 passes (20/28, lower bound about 0.53); the start
  moves to model 2. It also asserts that a model
  with 1 sample never qualifies, and the 9/10 boundaries: one `infra_error` leaves
  the start unchanged; one `check_failed` (9/11, lower bound about 0.47) moves it.
- **Depends on:** the `mesh.attempt.result` shape in §3.1 (defined here, in `types.ts`).

### S2. Worktree lifecycle and reconcile (real git, no model)

- **Builds:** the seven-step lifecycle (§4.1) for attempts, the snapshot-before-remove
  rule, the lease (§4.4), reconcile and orphan scan (§4.3). Runs against a real
  temporary git repository.
- **Files:**
  - new `packages/local-exec-daemon/src/attempt-worktrees.ts`
  - new `packages/local-exec-daemon/src/attempt-lease.ts`
  - new `packages/local-exec-daemon/test/attempt-worktrees.test.ts` (creates a
    temp repo with `git init`; never touches `~/dev/opensand`)
  - `packages/local-exec-daemon/src/index.ts` (export only)
- **Fault injection:** a `hooks` parameter with a `failAt(step)` callback; the test
  throws at each step in turn, then runs reconcile.
- **Done when:**
  ```
  pnpm --filter @opensand/local-exec-daemon build && pnpm --filter @opensand/local-exec-daemon test -- attempt-worktrees
  ```
  passes, including: for each of the 7 steps, a simulated crash followed by
  `reconcile()` leaves `git worktree list` with only the main entry, the attempts
  root empty, and the snapshot ref holding any dirty file. A second `reconcile()`
  changes nothing.
- **Depends on:** nothing from S1.

### S3. Judge (deterministic gate, rank, reviewer tie-break)

- **Builds:** Stage 0 gate, Stage 1 rank, Stage 2 tie-break with reviewer output
  validation and fallback (§5).
- **Files:**
  - new `packages/engine/src/mesh/judge.ts`
  - new `packages/engine/test/mesh-judge.test.ts`
  - new `packages/engine/test/fixtures/mesh/attempts-*.json`
  - new `scripts/mesh-judge-probe.sh` (the mutation probe below)
- **Done when:**
  ```
  pnpm --filter @opensand/engine test -- mesh-judge
  ```
  passes, including: a no-change attempt never wins; a failed check never wins
  even when the reviewer stub prefers it; a tie inside the band goes to the
  reviewer; a reviewer returning invalid JSON falls back to Stage 1 and records
  `fallback-deterministic`. **Mutation probe:** a script (`scripts/mesh-judge-probe.sh`)
  flips the exit-code check in `judge.ts`, runs `mesh-judge`, and requires the
  suite to fail; then it restores the file in a `finally` and requires the suite to pass.
- **Depends on:** S1 (`types.ts`).

### S4. Tournament runner: limits, containment hook, cost reservation

- **Builds:** `startTournament`, the attempt state machine over S2, S3 and the
  Phase 3 runner. Limits from §6.1. Refusal to start on a missing price, a missing
  Phase 4 sandbox or an invalid log chain.
- **Files:**
  - new `packages/engine/src/mesh/tournament.ts`
  - new `packages/engine/src/mesh/limits.ts`
  - `packages/engine/src/missions/runner.ts` (add a tournament node; the one
    existing-file change)
  - new `packages/engine/test/mesh-tournament.test.ts`
  - new `packages/engine/test/fixtures/stub-provider.ts` (a local HTTP stub that
    returns scripted responses, including 402 and 429)
- **Done when:**
  ```
  pnpm --filter @opensand/engine build && pnpm --filter @opensand/engine test -- mesh-tournament
  ```
  passes, and it includes the three-attempt end-to-end test: a 3-attempt tournament
  against the stub with a real check command finishes, and `git worktree list` in
  the test repo has exactly two entries (main, and the kept one), and nothing
  remains under the attempts root. It also includes: a kill -9 of the child
  process mid-attempt, then reconcile, reaches the same end state; an attempt
  that writes outside its tree fails the containment fixture (`sandbox` denies
  the path); a missing price refuses the start.
- **Depends on:** S2, S3, Phase 3 (`missions/runner.ts`), Phase 4 (sandbox
  profile), P1 (usage in `model.*` records).

### S5. Receipt, route wiring, CLI and the phase's own end-to-end check

- **Builds:** `mesh/routes.json` loading in the mission start path, the
  `Tournament` receipt section (§3.4), `mesh.route.selected` writes, the CLI verbs
  `opensand mission tournament <id> --attempts 3`, `opensand mission reconcile`,
  and `opensand mission attempt restore <n>`.
- **Files:**
  - new `packages/engine/src/mesh/receipt-section.ts`
  - new `packages/engine/src/mesh/route-config.ts`
  - `packages/engine/src/missions/receipt.ts` (one section added)
  - `packages/cli/src/` (the three verbs; confirm the CLI's command layout first)
  - new `scripts/phase7-e2e.sh`
- **Done when:**
  ```
  scripts/phase7-e2e.sh
  ```
  exits 0. The script: (1) writes a `routes.json` and a stats fixture into a temp
  `OPENSAND_HOME`; (2) runs a 3-attempt tournament against the stub; (3) asserts
  `git worktree list` has two entries and the attempts root is empty apart from the
  kept attempt; (4) asserts the receipt's Tournament rows match the log records
  one-to-one; (5) appends a stats fixture that changes the ladder's start, starts a
  new mission, and asserts that its `mesh.route.selected` names the new start.
  This is the phase's two done-when items, written as a command.
- **Depends on:** S4.

### Order and gates

S1 and S2 run in parallel. S3 needs S1. S4 needs S2 and S3, and Phase 3, Phase 4 and
P1. S5 needs S4. Each PR runs `scripts/pr-gate.sh --when-green <PR>` after CI is
registered. The owner merges (`gh pr merge` is not run by workers).

---

## 11. Preconditions and what is still open

- **P1 (blocks S4):** `model.completed` records carry `usage` (input and output
  tokens) and each catalog model has a price. Owner: Phase 3. Nothing in the
  current tree records usage (the gap note above §1).
- **P2 (blocks S4):** the Phase 4 sandbox profile can be applied to a single
  command with a configurable write root. The macOS and Linux profiles exist; the
  per-write-root variant is Phase 4 work.
- **Open, owner decision:** whether a kept attempt should be applied to the user's
  checkout by a command, or only left as a branch. This doc chooses branch-only
  (§1). Changing it later does not affect any slice above.
- **Open, not designed here:** cross-mission learning beyond the 50-result window,
  and a per-project routing override. Both are additive to `routes.json`.
