# Time Machine Fork Architecture and RPC Contract

Defines the architecture and RPC contract for `timeline.Timeline.get` and `timeline.Timeline.fork` in OpenSand.

## 1. Working Tree: Same Workspace vs Copy
* **Decision:** Same workspace. Fork operates in-place on the existing `workspaceRoot`.
* **Working Tree Effects:** When forking step N while the workspace is at step M, the engine executes `restoreSnapshot(workspaceRoot, parentMissionId, stepN)`. It captures an emergency safety snapshot of step M (`refs/opensand/missions/<parentId>/s-pre-restore-<ts>`), unlinks files created after step N that do not exist at step N, and materializes step N's tree into `workspaceRoot` using an isolated temporary git index.
* **Why Boring:** OpenSand's single-window desktop model attaches the user's editor, terminals, language servers, and watchers to one project directory. Directory copies or detached worktrees bloat disk usage, invalidate build caches, and break external dev tooling. Reusing `restoreSnapshot` (PR #90) provides proven, atomic, in-place materialization.

## 2. Git Guarantees and Invariants
* **Untouched (Byte-Identical):**
  1. `.git/HEAD` and current branch ref: untouched.
  2. `.git/index`: byte-identical before and after fork (`sha256(.git/index)` strictly unchanged).
  3. `.git/refs/stash`: untouched.
  4. User tags, branches, and untracked/ignored files: untouched.
* **Fork Ref Placement:**
  * New mission receives a fresh ID (`m-<uuid8>`).
  * Base tree pinned at: `refs/opensand/missions/<newId>/base` (points to step N's tree).
  * Step snapshots: `refs/opensand/missions/<newId>/s-<seq>`.
  * Lineage ref: `refs/opensand/missions/<newId>/fork-parent` pointing to `refs/opensand/missions/<parentId>/s-<stepN>`.
* **Test Witness:** A test records `git rev-parse HEAD`, `git symbolic-ref HEAD`, `shasum -a 256 .git/index`, and `git stash list` before `fork`, runs `fork`, and asserts byte-for-byte equality while verifying `treeOf(workspace)` equals step N's `targetTree`.

## 3. Mission Identity & State Inheritance
* **Decision:** Brand-new mission ID (`m-<uuid8>`). Fork is never a resume of the parent mission.
* **Inherited:**
  * `workspaceRoot` (same folder).
  * `title`: `params.newTitle ?? "${parent.title} (fork)"`.
  * `initialQuery`: `params.newInstruction ?? parent.initialQuery`.
  * `checkCommand`: parent `checkCommand`.
  * `budget`: fresh budget limits configured from parent (or `params`); spent counters reset to zero.
  * `baseTree`: step N tree.
  * Lineage metadata: `forkedFrom: { missionId: parentId, snapshot: stepN, tree: stepNTree }`.
* **Not Inherited (Fresh / Reset):**
  * Running state: starts fresh ("idle" -> "running").
  * Approvals / grants: inbox approvals are epoch-bound and non-transferable; none carry over.
  * Event log: fresh append-only `<stateDir>/missions/<newId>/log.jsonl` starting with `MISSION_FORKED`.
  * Repair count, error states, and token/cost counters reset to 0.

## 4. Exact RPC Contract

### `timeline.Timeline.get`
* **Params:** `{ missionId: string }`
* **Result:**
  ```ts
  {
    missionId: string,
    steps: Array<{
      seq: number,
      node: "start" | "plan" | "act" | "check" | "review" | "repair" | "receipt" | "end",
      title: string,
      claim?: string,
      passed?: boolean,
      durationMs?: number,
      timestamp: string,
      snapshotRef?: string,
      isRestorable: boolean
    }>
  }
  ```
* **Errors:**
  * `InvalidParams` (-32602): `missionId` missing, invalid format, or mission log directory not found.

### `timeline.Timeline.fork`
* **Params:**
  ```ts
  {
    missionId: string,
    snapshot: string | number,
    workspaceRoot?: string,
    newInstruction?: string,
    newTitle?: string,
    budgetUsd?: number,
    maxRepairs?: number
  }
  ```
* **Result:**
  ```ts
  {
    success: true,
    newMissionId: string,
    forkedFrom: { missionId: string, snapshot: string, targetTree: string },
    restoredFilesCount: number,
    deletedFilesCount: number,
    preRestoreSnapshot: string
  }
  ```
* **Errors:**
  * `InvalidParams` (-32602): missing `missionId`/`snapshot`; unknown step ref; foreign mission ref prefix; tree safety validation failure (path traversal, symlink escape, `.git` collision).
  * `InvalidRequest` (-32600): untrusted workspace; active mission running on workspace; restore/fork concurrency lock held; no-op fork.

## 5. Failure and Rollback
* **Mid-Restore Failure:** If file unlinking or checkout fails during workspace reset, `restoreSnapshot` executes its automatic rollback via temporary index to `preRestoreSnapshot`. No new mission is spawned. Engine returns `InternalError` (-32603) with `preRestoreSnapshot` ref and `manualRecoveryCommand`. Desktop displays error dialog.
* **Initialization Failure:** If workspace restore succeeds but mission runner instantiation fails, `preRestoreSnapshot` remains pinned; partial state is cleaned up; engine returns `InternalError` with instructions to retry or restore `preRestoreSnapshot`.

## 6. Out of Scope for v1
1. Git worktree branching or multi-directory concurrent execution.
2. Splicing agent memory, conversation turns, or partial thought chains across missions.
3. Three-way merge or cherry-picking between divergent forks.
4. Remote git sync/push of `refs/opensand/missions/*`.
5. Interactive file conflict resolution during fork restore.
