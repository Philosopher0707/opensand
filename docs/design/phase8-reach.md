# Phase 8: Reach — targets and shippable builds

Status: design, 2026-11-19. Nothing here is implemented. It specifies Phase 8 of
`docs/design/opensand-next.md` §6.2 ("Container and SSH targets, Linux build,
signed and notarized macOS build"; done when: per target, the phase-3 mission
suite passes on it). §3.1 (the mission's `target`), §4.6 (containment), §6.1
(packages) and §7 (owner decisions) are the product intent; this doc is the
build contract for Rigel.

Phase 8 sits on the phases below. Their state at the time of writing:

| Dependency | What Phase 8 uses | State in `dbf0f5e` |
|---|---|---|
| Phase 1 event log | Target events append to the mission log; the receipt is a projection | `packages/shared/src/event-log.ts` and `packages/engine/src/reconnect.ts` own the log path and writer |
| Phase 2 OSP | Line framing (`encodeLine`, `parseLine`) for the target link | `packages/protocol/src/{frames,line-decoder}.ts` exist; the engine's stdio server is `packages/engine/src/server.ts` |
| Phase 3 missions | `MissionRunner`, harness `runCheck`, receipt | `packages/engine/src/missions/{runner,check,receipt}.ts` exist; runner's check call is `runner.ts:384`, the command bridge is `check.ts:26` |
| Phase 4 containment | Sandbox profiles, grants, folder trust, path denial | `packages/local-exec-daemon/src/sandbox/` has macOS and Linux profiles; the path guard is `file-ops.ts:37` |
| Phase 6 snapshots | Hidden refs for the apply-conflict snapshot | `packages/engine/src/missions/workspace-diff.ts` (`pinTrees`, `changedLinesBetweenTrees`) exists |
| Phase 7 mesh | Nothing. Targets run one mission, not a tournament | — |

**Gap found while writing this doc (P1).** "The phase-3 mission suite" does not
exist. `grep -rn "mission suite" docs scripts evals` finds only the roadmap row
above; `scripts/phase7-e2e.sh` is the only end-to-end mission driver, and
`evals/tasks.json` is the 28-task scripted suite, not missions. Phase 8 owns the
missing fixture: S1 writes `scripts/mission-suite.sh` and every later slice is
measured by it. Without one fixed suite, "passes on the target" has no meaning.

**Gap found while writing this doc (P2).** There is no target abstraction at
all. `packages/local-exec-daemon` runs commands through `runCommandOperation`
(`command-runner.ts:9`) and files through `file-ops.ts`; the mission runner and
the scripted agent both assume `workspaceRoot` is a local path
(`agent.ts:80-88` writes with `fs`). §5 is the seam that changes this.

---

## 1. Decisions at a glance

| Question | Decision | Why this and not the alternative |
|---|---|---|
| Where the engine runs | Always on the user's machine. A target runs commands and file operations only | The event log is the truth (Phase 1), the check verdict is made locally (Phase 3), and model keys never leave the machine. Running a second engine on the target would create a second log and a second policy |
| Target configuration | Owner-edited `~/.opensand/targets.json`; a mission selects a target by name, default `local` | A per-mission ad-hoc host or path would let a model name its own execution surface. Declaring a target is the trust decision, like a grant |
| Wire protocol | A new `opensand-target --stdio` server spoken over `docker exec -i` or `ssh`, using the existing OSP line framing | Reuses the framing and the existing tool implementations instead of inventing a second RPC. The target has no model, no log and no policy of its own |
| Container workspace | Bind mount of the mission workspace at `/workspace`; no copy | The same bytes are local and in the container, so live snapshots and git diffs in Phase 3/6 keep working unchanged |
| SSH workspace | Per-mission copy under `<root>/missions/<id>/`, pushed before `act`; fetched to staging before `review`; applied after the reviewer accepts | A remote path cannot be the local workspace. One push and one apply make the mission a single transaction at the user's boundary, and the reviewer still sees the change |
| Applying an SSH result | Fetch to staging and pin its tree first; after approval, verify the local tree has not changed since push, then apply; otherwise refuse and keep the pinned tree | `rsync` straight into the user's workspace would silently overwrite an edit made while the mission ran |
| "Verified" with a target | Only when the check passed and the result is in the user's workspace (bind mount, or an applied fetch) | A green check on a remote copy the user never received is not a verified mission |
| Container containment | The container is the boundary: only the workspace and the read-only tool bundle are mounted, network off by default, no Docker socket, no `--privileged`, `no-new-privileges` | Phase 4's sandbox confines a host process; a container target is already inside an OS boundary, and nesting a second one adds failure modes without adding isolation |
| SSH containment | Bubblewrap required for missions; a target with `sandbox: "none"` may serve interactive turns only | A mission runs unattended and cannot answer Phase 4's "where neither sandbox exists, every command asks" |
| Remote git | `.git` is read-only inside a container target and not copied to an SSH target | The agent must not install hooks or move refs on a host (the Phase 7 rule); the mission's diff is computed locally |
| New dependencies | No new external dependency. The daemon gains one workspace link, `@opensand/protocol`, for its line framing. System tools: `docker` (or `podman` aliased), `ssh`, `rsync`, `tar`, and `node >= 22` on an SSH host | The target server is the daemon package deployed with `pnpm deploy`; the launcher is `spawn` over existing binaries |
| Linux build | AppImage and `.deb`, x86_64, unsigned | Covers the two download shapes without a distro repository. arm64 is additive later |
| macOS build | arm64 dmg/zip, Developer ID signed, hardened runtime, notarized and stapled when the owner's credentials exist | Gatekeeper blocks the current unsigned build (opensand-next §2) |

---

## 2. What a target is, and what it is not

```
 user's machine                                   target
┌──────────────────────────────────────┐      ┌───────────────────────────────┐
│ renderer / CLI                       │      │ container or SSH host         │
│   │ OSP                             │      │                               │
│ engine ── mission runner ── check    │      │  opensand-target --stdio      │
│   │            │                    │      │    exec / read / write /      │
│   │            └── TargetWorkspace ─┼──────┼──▶ edit / grep / glob / list  │
│   │                                 │ stdio│    (existing daemon ops)      │
│ event log, snapshots, receipt        │      │  workspace root only          │
│ model keys, model calls              │      │  no model, no log, no keys    │
└──────────────────────────────────────┘      └───────────────────────────────┘
```

A target is **an execution surface for one mission's workspace**. It is not a
place where OpenSand runs, not a model endpoint, and not a second source of
truth. The following invariants hold in every slice:

1. **One writer of the truth.** The event log, the check verdict, snapshots,
   the receipt and model calls stay on the user's machine. A target receives a
   command or a file operation and returns its output.
2. **One root.** Every path a tool sends is relative to the mission root. The
   target resolves it with the existing path guard (`file-ops.ts:37`) and
   refuses anything that leaves the root, including through a symlink.
3. **No credentials.** The target server starts with a small environment
   allowlist and the launcher never forwards `*_API_KEY`, `*_TOKEN`,
   `*_SECRET`, `SSH_AUTH_SOCK` (except to the `ssh` process itself) or the
   vault passphrase. The existing sanitizer in `command-runner.ts` remains the
   second line.
4. **Identity is visible.** The server sets `OPENSAND_TARGET_ID=<name>` for
   every command, and the receipt records the target's kind, name, platform and
   root. A mission that silently ran locally fails the suite (§10).
5. **Fail closed.** An unreachable target, a version mismatch, a missing
   sandbox or a lost connection ends the mission `failed`. No fallback to
   `local` is ever taken.

---

## 3. `targets.json`

Lives at `~/.opensand/targets.json`. It is validated on load; an invalid file
makes every target mission refuse and names the bad key. It does not fall back
to a default, for the same reason `mesh/routes.json` does not (Phase 7 §2.2).

```json
{
  "version": 1,
  "targets": {
    "devbox": {
      "kind": "ssh",
      "host": "devbox",
      "root": "/srv/work/opensand",
      "sshArgs": ["-o", "BatchMode=yes"],
      "sandbox": "bwrap"
    },
    "node22": {
      "kind": "container",
      "runtime": "docker",
      "image": "node:22-bookworm",
      "network": "none",
      "memory": "4g",
      "cpus": 2
    }
  }
}
```

- `local` is implicit and cannot appear in the file.
- `kind: "ssh"` requires `host` and an absolute `root`. `sandbox` is `"bwrap"`
  (default) or `"none"`; `"none"` is refused for missions (§6).
- `kind: "container"` requires `image`. `runtime` is `docker` (default) or
  `podman`. `network` is `"none"` (default) or `"bridge"`. The root is fixed at
  `/workspace`.
- No password, key path or token field exists. SSH uses the user's own
  `~/.ssh/config` and agent; `BatchMode=yes` prevents a prompt from hanging a
  mission.
- `targets.json` is owner-edited. Writing it from a model tool is not part of
  Phase 8.

A mission selects a target by name: `mission.Missions.start` gains an optional
`target` string, default `local`. The target is resolved once, before the
folder-trust gate, and recorded on `mission.started`.

---

## 4. The target link

### 4.1 The server

`packages/local-exec-daemon/src/target/bin.ts` is a new bin:

```
opensand-target --stdio --root <absolute-path> [--sandbox bwrap|none]
```

It prints nothing on stdout except framed responses; diagnostics go to stderr.
The first request must be `target.hello`; any other request before a successful
handshake is refused.

| Method | Input | Output |
|---|---|---|
| `target.hello` | `{protocol: 1, clientVersion}` | `{protocol, version, platform, arch, node, root, sandbox, marker}` |
| `target.exec` | `{command, cwd, timeoutMs, env}` | `{exitCode, signal, stdout, stderr, durationMs}` |
| `target.readFile` | the daemon's `ReadFileInput` | `ReadFileOutput` |
| `target.writeFile` | `WriteFileInput` | `WriteFileOutput` |
| `target.editFile` | `EditFileInput` | `EditFileOutput` |
| `target.grep` | `GrepInput` | `GrepOutput` |
| `target.glob` | `GlobInput` | `GlobOutput` |
| `target.listDirectory` | `ListDirectoryInput` | `ListDirectoryOutput` |
| `target.ping` | `{}` | `{ok: true}` |

The server calls the same operations as the local daemon, with `workspaceRoot`
set to `--root` and `allowOutsideWorkspace: false`. `target.exec` runs the same
bash validator and environment sanitizer as `runCommandOperation`; the only
additions are `OPENSAND_TARGET_ID` and the caller's explicit `env`.

**Protocol version is exact.** A client and server that disagree on
`protocol` or on the package version refuse the connection with
`target-version-mismatch` before any workspace change. An app upgrade therefore
redeploys the bundle instead of speaking to an old server.

### 4.2 The client

`packages/local-exec-daemon/src/target/client.ts` owns one child process, one
line decoder, a request map keyed by id, per-request timeouts and `close()`.
Requests are sent **sequentially**: the coordinator may issue parallel
read-only tools, but a target serializes them. This keeps path and command
ordering deterministic and avoids interleaved output on one pipe. A request
that times out closes the link; a late response is ignored.

### 4.3 Deploying the bundle

The target server is a self-contained deploy of the daemon package, produced by
a new root npm script:

```
pnpm target:build      # rm -rf dist/target && pnpm --filter @opensand/local-exec-daemon... build
                       #   && pnpm --filter @opensand/local-exec-daemon deploy --prod --legacy dist/target
```

- **Container:** bind-mount `dist/target` read-only at `/opt/opensand-target`
  and run `node /opt/opensand-target/dist/src/target/bin.js --stdio --root
  /workspace`. The image must provide `node >= 22`; preflight runs
  `node --version` and refuses otherwise. No network is needed at start.
- **SSH:** `rsync` the same bundle to `<root>/.opensand/target/<sha256>/` on
  first use or after an upgrade, keyed by the bundle's content hash. The remote
  needs `node >= 22`, `rsync`, and (for missions) `bwrap`.

Deployment is idempotent and happens before any workspace push. A failed
deploy leaves the local workspace untouched.

### 4.4 Lifecycle

- **Container:** `docker run -d --rm --name opensand-<missionId> --label
  opensand.mission=<missionId> --network none --cap-drop ALL
  --security-opt no-new-privileges --memory <m> --cpus <n>
  -v <workspace>:/workspace -v <workspace>/.git:/workspace/.git:ro
  -v <dist/target>:/opt/opensand-target:ro -w /workspace <image> sleep
  infinity`, then one persistent `docker exec -i ... node
  /opt/opensand-target/dist/src/target/bin.js --stdio --root /workspace`. At
  the end, `docker rm -f`. On engine start, containers labelled with a mission
  that is not running are removed (the Phase 7 reconcile pattern).
- **SSH:** one persistent `ssh ... opensand-target` process per mission. At the
  end, `target.shutdown`, then wait for the process to exit; a live process is
  killed after a short grace period. The remote mission directory is kept on
  success and on failure (it is the only copy of unapplied work).
- **Lock:** `<root>/.opensand/lock` on the target and an in-process lock on the
  local workspace. A second mission for the same target or workspace is
  refused with `target-busy`. The lock records the mission id and a stale-after
  timestamp.

---

## 5. The workspace seam

### 5.1 `MissionWorkspace`

`packages/engine/src/missions/workspace.ts` defines the one interface the
mission runner uses for everything that touches files or commands:

```ts
export interface MissionWorkspace {
  readonly root: string;                 // local path: trust, log, snapshots
  exec(input: ExecCommandInput): Promise<ExecCommandOutput>;
  readFile(input: ReadFileInput): Promise<ReadFileOutput>;
  writeFile(input: WriteFileInput): Promise<WriteFileOutput>;
  editFile(input: EditFileInput): Promise<EditFileOutput>;
  grep(input: GrepInput): Promise<GrepOutput>;
  glob(input: GlobInput): Promise<GlobOutput>;
  listDirectory(input: ListDirectoryInput): Promise<ListDirectoryOutput>;
  begin(): Promise<void>;                // connect, preflight, push
  prepare(): Promise<WorkspaceResult>;   // fetch the result and pin its tree; no local write
  apply(): Promise<WorkspaceResult>;     // conflict gate, then apply; no-op for local/container
  close(): Promise<void>;
}
```

`prepare` exists because the reviewer must see the target's diff. A fetch that
only happens after `review` would show the reviewer an empty diff, and an
approval of nothing is worse than a failed check. `prepare` fetches the remote
tree into staging and pins it with the existing temp-index machinery, so
`review` reads a real tree; `apply` is the only step that writes the user's
workspace.

- `LocalWorkspace` calls the current functions directly; `begin`, `prepare` and
  `apply` are no-ops that return the current local tree.
- `TargetWorkspace` holds a client, a target config, the push manifest and the
  fetched staging path. `root` stays the local path so folder trust, snapshots
  and the receipt keep working exactly as in Phase 3/6.
- `MissionRunner` creates the workspace before the trust gate, passes
  `workspace.exec` into `runCheck`'s existing `opts` (the tournament path at
  `mesh/tournament.ts:706` keeps the local default), and passes it in
  `ctx.workspace` to the agent. The scripted agent stops writing with raw `fs`
  and uses `ctx.workspace`, so the test path and the real path use the same
  seam.
- `manager.ts` builds the workspace from the mission's target and closes it in
  a `finally`, on cancel, and on shutdown.

### 5.2 Container: no copy

The workspace is mounted at `/workspace`. File operations and commands see the
same bytes the local tree has, so `treeOf`, `pinTrees` and
`changedLinesBetweenTrees` need no change. The only path translation is the
root: `/workspace` inside, `workspaceRoot` outside, and all tool paths stay
relative. `TargetWorkspace` rewrites an absolute path or `cwd` under `root` to
the target root, and refuses one outside it; the check's `cwd` therefore
becomes the root rather than a host path that does not exist in the
container.

`.git` is mounted read-only over the writable mount. A check that needs to
write git (commit, checkout, worktree) fails on a container target; that is
named in §13 as a limitation. The agent cannot install a hook or move a ref.

### 5.3 SSH: push, fetch, apply

**Push, after preflight and before `act`:**

1. `rsync -a --delete --exclude .git <workspace>/ <host>:<root>/missions/<id>/`
2. Write `~/.opensand/missions/<id>/target-manifest.json`: every relative path
   with its sha256, mode and symlink target. Refuse before `act` when the tree
   has more than 100,000 entries or 2 GB, or when a symlink resolves outside
   the workspace (the same rule as `file-ops.ts:37`). `.git` is excluded.

**Fetch to staging (`prepare`), before `review` and before any terminal event:**

1. `rsync -a --delete <host>:<root>/missions/<id>/ <staging>/`
2. Pin `<staging>` into a tree object with the local repository's temp index
   (`workspace-diff.ts`). The staging tree, not the untouched local tree, is
   what `review` and the receipt read.
3. No local file is written in this step. A failed check can be repaired
   remotely while staging is discarded and refetched.

**Apply (`apply`), only after `review` accepts:**

1. Compare every path the staging tree would add, replace or delete with the
   manifest:
   - local hash equals the manifest hash → safe to replace or delete;
   - local file is absent and the manifest has it → safe to delete;
   - anything else (a user edit, a new local file) → **conflict**.
2. Apply into the local workspace in one pass (write temp, `rename`, delete
   only manifest paths). Modes and executable bits are preserved.
3. On conflict: do not touch the local workspace. The staging tree is already
   pinned as `refs/opensand/missions/<id>/target-tree`, `mission.target` is
   recorded with `phase: "conflict"`, and the mission ends `failed` with
   `reason: target-apply-conflict`. The user can inspect or restore the ref from
   the time machine.

**Verified rule.** For an SSH target, the runner sets `verified` only after a
successful `apply`. A passing check with a failed apply is `failed`. A review
rejection leaves the local workspace untouched and the staging tree kept. For a
container target the mount already applied the result, so the existing Phase 3
rule stands unchanged.

### 5.4 What is not synced

Ignored files are synced like any other file; only `.git` is excluded. Build
caches (`node_modules`, `dist`) are copied if they are in the workspace. That
is deliberate: a check that runs a build must see the same inputs. The 2 GB cap
is what keeps it bounded; a target mission on a huge tree fails before `act`
with `target-workspace-too-large`, not halfway through.

---

## 6. Containment on a target

### 6.1 Container

| Rule | Setting |
|---|---|
| Mounts | `/workspace` (the mission root) and `/workspace/.git` read-only; `/opt/opensand-target` read-only. Nothing else |
| Network | `--network none`, unless `targets.json` says `bridge` |
| Privileges | `--cap-drop ALL`, `--security-opt no-new-privileges`, never `--privileged`, never `/var/run/docker.sock` |
| Limits | `--memory` and `--cpus` from config; `--pids-limit 512` |
| User | The image's own user. Phase 8 does not force `--user`; an image that runs as root is the owner's choice and the container is still the boundary |
| Phase 4 sandbox | Not nested. The bash validator and policy engine still run inside the target server before `exec` |
| `.git` | Read-only. The agent cannot write hooks, refs or config |

`docker`/`podman` is invoked with an argument array, never a shell string.
Container names and labels are derived from the mission id, which is generated
by the engine, not the model.

### 6.2 SSH

A mission-level SSH target requires `sandbox: "bwrap"` and a working
bubblewrap. Preflight runs:

```
bwrap --ro-bind / / --dev /dev --proc /proc --unshare-net true
```

and refuses the mission if that fails. Commands then run through the Phase 4
Linux profile with the write root set to the mission directory. The profile
keeps denying `~/.ssh`, `~/.opensand/vault` and shell rc files
(`sandbox/constants.ts`). A target with `sandbox: "none"` is accepted only for
an interactive turn, where Phase 4 may ask; the mission start path refuses it
with `target-sandbox-required`.

The SSH launcher passes `SSH_AUTH_SOCK` to the `ssh` process so agent auth
works, and strips it from every remote command's environment. Host-key checking
is whatever the user's SSH config says; Phase 8 does not add
`StrictHostKeyChecking=no`.

---

## 7. Mission integration

| Surface | Change |
|---|---|
| `mission.Missions.start` | optional `target` name; unknown name is `InvalidParams` |
| `mission.started` | carries `{target: {name, kind}}` |
| `MissionRunner` | resolves the workspace, logs `mission.target` on connect, push, prepare, apply, conflict or failure; `prepare()` runs at the start of `review` (and before a terminal receipt that never reaches review), `apply()` runs in the `receipt` node after acceptance, before `pinTrees` and the terminal event |
| `check.ts` | `runCheck` takes an optional `exec` in its existing `opts`; the mission passes the workspace's, the tournament (`mesh/tournament.ts:706`) keeps the local default |
| `agent.ts` | `MissionAgentContext` gains `workspace: MissionWorkspace`; the scripted agent uses it |
| `receipt.ts` | new optional `target` block: `{name, kind, platform, root, result: "bind" / "applied" / "conflict" / "failed", detail?}`. A target `conflict` or `failed` after the last accepted review makes the receipt `FAILED`; the check/review rule alone cannot mark it verified |
| `mission-events.ts` | one new kind, `mission.target`, with `{phase, name, kind, platform?, detail?}`. One event, not five, so the log stays small and the receipt folds the last phase |

The receipt is still built by the harness. The model never writes the target
block, and a target name in the model's output is data.

**No UI or CLI surface in this phase.** The shell has no mission-start command
yet, and the CLI's `mission` verbs are Phase 7's tournament tools. Phase 8 adds
the engine parameter and the suite that drives it; the target picker is shell
work (opensand-next §5), not a Phase 8 slice. A user starts a target mission
through the engine API until that picker exists.

---

## 8. Failure semantics

Target link states: `connecting → ready → lost → closed`. The mission maps them
as follows:

| Event | Mission | What happens to the workspace |
|---|---|---|
| Preflight fails (no node, no bwrap, bad version, busy lock) | `failed` before `act`, `reason: target-*` | Local untouched. No push |
| Push fails partway | `failed`, `reason: target-push-failed` | Local untouched; the remote partial dir is deleted on a best-effort `ssh rm -rf` |
| Link lost during a command | `failed`, `reason: target-lost` | The command's outcome is unknown; it is **not retried**. The remote dir is kept. No fetch, because a partial tree proves nothing |
| Link lost between commands | `failed`, `target-lost` | Remote dir kept; no local write |
| Check failed, staging fetched | `failed` (the check decided) | Staging is pinned for the receipt; local untouched. The remote dir is kept |
| Review rejects the change | repair while budget remains, then `failed` | Staging pinned for the receipt; local untouched; remote dir kept |
| Check passed, apply conflict | `failed`, `target-apply-conflict` | Local untouched; remote result in a hidden ref |
| Check passed, fetch or apply fails (rsync/disk) | `failed`, `target-apply-failed` | Local untouched; remote dir kept |
| Container removed or OOM-killed | `failed`, `target-lost` | Remote state gone; local untouched |
| Engine dies mid-mission | On restart the mission is `failed` with `target-lost`; it is **not resumed in place** | The remote dir and manifest stay for inspection. A new mission starts from the last local snapshot |

**Why no resume.** A resumed target session would have to prove that the remote
tree is exactly the tree the interrupted step left. The target does not keep a
per-step log (that is Phase 1 work, local only), so the cheapest honest answer
is the tournament's: snapshot what exists, keep it, and start again. The local
workspace was never touched, so the user loses no local work.

**Cancel** closes the link, removes a container, and keeps an SSH mission dir.
A cancel during `exec` kills the child; the command's outcome is unknown, which
is the same case as a lost link.

---

## 9. Builds

### 9.1 Linux

| Item | Decision |
|---|---|
| Formats | AppImage and `.deb` |
| Arch | x86_64 only in Phase 8 |
| Runner | `ubuntu-22.04` (older glibc than `ubuntu-latest`) |
| Packaging | `electron-builder --linux AppImage deb --publish never` |
| Native helpers | Not shipped. `packages/native-bridge/bin` holds macOS Mach-O binaries; `mac.extraResources` owns that copy and Linux gets none. The bridges already return "unsupported" off macOS (`speech-bridge.ts:13`, `messages-reader.ts:29`) |
| Smoke | `scripts/smoke-linux.sh <path.deb>` extracts with `dpkg-deb -x`, finds the executable from the packaged `.desktop` entry, runs it under `xvfb-run -a` with `OPENSAND_SMOKE=1` and an isolated state dir, reads `server.port`/`server.token`, and asserts `/api/diagnostics` reports the bundle version. The job installs `xvfb` |
| Gate | A `.deb` that contains a Mach-O file, or an app that exits before writing `server.port`, fails the smoke |

`package.json` gains `"package:linux"`, mirroring `package:app` but without
the macOS-only `--mac`. `scripts/verify-linux.sh` stays as it is: it proves the
tree builds and tests on Linux; it does not package.

### 9.2 macOS signing and notarization

`electron-builder.yml` currently says `identity: null` and
`hardenedRuntime: false` (lines 29-31). Phase 8 replaces that with:

```yaml
mac:
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  notarize: true
```

- `build/entitlements.mac.plist` contains only what Electron needs:
  `com.apple.security.cs.allow-jit` and
  `com.apple.security.cs.allow-unsigned-executable-memory`. No camera,
  microphone, automation or library-validation exception is added.
- `notarize: true` reads `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
  `APPLE_TEAM_ID`, or the App Store Connect key trio
  (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`). The owner picks
  one method; the other is documented but not wired.
- `electron-builder` signs the two helpers in
  `packages/native-bridge/bin` with the same identity. Notarization fails if
  it does not, which is the intended tripwire.
- CI signs only when `CSC_LINK` is present. Without it, the job uploads an
  unsigned artifact with the suffix `-unsigned` and the release is marked as
  such; it never publishes an unsigned file under the normal name.

`scripts/verify-mac-signature.sh <dmg|app>` runs and requires all of:

```
codesign --verify --deep --strict --verbose=2 <app>
codesign --verify --strict <each helper in Contents/Resources/bin>
spctl -a -vvv -t install <app>
xcrun stapler validate <dmg>
xcrun stapler validate <app>
```

It prints `signed and notarized` and exits 0 only when every command passes.
`scripts/release.sh` calls it after downloading the artifact and before
installing; an unsigned or unstapled artifact is a hard failure when
`--require-signature` is set, which is the default for a release (opt out only
with `--allow-unsigned`).

### 9.3 Release workflow

The tag workflow gains a `build-linux` job next to the macOS job and runs the
two artifact jobs in parallel. Both upload to the same GitHub release. The
macOS job keeps `CSC_IDENTITY_AUTO_DISCOVERY: false` only in the unsigned
branch; the signed branch sets `CSC_LINK`/`CSC_KEY_PASSWORD` from secrets.
`release.sh` downloads `*.dmg`, `*.zip`, `*.AppImage` and `*.deb`; the macOS
DMG checks (mount, `Info.plist`) stay macOS-only, and the Linux checks are the
smoke script.

---

## 10. The phase-3 mission suite

`scripts/mission-suite.sh` is the acceptance gate the roadmap names. It is a
shell script with an embedded Node driver (the `scripts/phase7-e2e.sh` pattern),
so it adds no package and no test framework.

It builds `shared`, `engine` and the target bundle, creates a temp
`OPENSAND_HOME` with `targets.json` and a temp git workspace per mission,
starts the engine with `--stdio --scripted-agent <fixture>`, and drives
`mission.Missions.start`/`get` over OSP.

Five missions, each a fixture in `evals/mission-suite/`:

| # | Fixture | Agent does | Check | Expected |
|---|---|---|---|---|
| 1 | `verified.json` | writes `out.txt` with the expected text | `test -f out.txt && grep -qx ok out.txt` | `verified`; changed lines for `out.txt` |
| 2 | `false-claim.json` | claims "all tests pass", writes nothing | `test -f out.txt` | `failed`; no `verified` event |
| 3 | `repair.json` | round 1 writes `bad`; round 2 writes `ok` | `grep -qx ok out.txt` | `verified` after one repair; two check events |
| 4 | `budget.json` | writes `bad` every round | `grep -qx ok out.txt` | `failed` after `maxRepairs`; the claim never wins |
| 5 | `changed-lines.json` | edits line 2 of a fixture file | `true` | `verified`; receipt changed lines equal an independent `git diff` parse |

Every check starts with `printf 'target=%s\n' "$OPENSAND_TARGET_ID"` and the
suite asserts the last check's `outputTail` carries the selected target's name
and the receipt's `target` block matches its kind and platform. That is the
proof that the mission ran on the target and not locally.

Usage:

```
scripts/mission-suite.sh --target local
scripts/mission-suite.sh --target container      # docker; node:22-bookworm
OPENSAND_SSH_TARGET=devbox scripts/mission-suite.sh --target ssh
```

Each run prints `5/5 missions passed on <name>` and exits 0. A skipped SSH run
is not a pass: the script exits 2 and says which environment variable is
missing. The per-target phase done-when is this command on that target.

---

## 11. Stress test: how the design breaks, and what it does

| # | Failure | What goes wrong without a countermeasure | What the design does | Test that proves it |
|---|---|---|---|---|
| 1 | **The target silently runs locally.** A wiring bug drops the target and the mission "passes" on the host | A target feature ships untested; the suite is green for the wrong reason | Every command gets `OPENSAND_TARGET_ID`; the receipt records the target's platform and root; the suite asserts both | Container suite run on macOS: the check output and receipt say `container`/`linux`, not `local`/`darwin` |
| 2 | **SSH drops mid-command.** The process dies after the remote command may have applied | A retry applies a non-idempotent command twice | Outcome is unknown: mission `failed`, no retry, remote dir kept, no fetch | Close the pipe during `target.exec`; the mission records `target-lost` and exactly one exec |
| 3 | **An edit during the mission is overwritten.** The user changes a file while the agent works remotely | The apply silently replaces newer local work | Manifest check before apply; conflict refuses the write and leaves the pinned remote tree | Edit the local file after push; apply is refused, local bytes are unchanged, `git cat-file` on the ref returns the remote file |
| 4 | **The reviewer reviews nothing.** On SSH the local tree has not changed yet, so a naive diff is empty | The reviewer approves an empty diff and a bad change is "verified" | `prepare()` fetches and pins the remote tree before `review`; the reviewer gets the real diff | Fake target changes a file; assert the review payload contains the change, and an empty prepared tree makes the mission fail, not verify |
| 5 | **A failed apply still says verified.** Check passes, rsync fails | The user gets a receipt for work that is not on disk | `verified` requires a successful `apply`; a failure ends `failed` | Stub apply failure after a passing check; assert `failed` and no `verified` event |
| 6 | **Two missions share one target root.** A second mission starts while the first runs | Two agents edit one tree; the second apply clobbers the first | Target lock plus local workspace lock; second start is `target-busy` | Start two missions on one target; the second fails before `act` |
| 7 | **A model writes outside the root.** `../`, an absolute path, or a symlink | Escape from containment | The target uses `resolveAndValidatePath` with `allowOutsideWorkspace: false` and resolves symlinks; an external symlink is refused at push | Probe `../outside`, `/etc/passwd`, and a symlink to `~/.ssh`; all three are refused |
| 8 | **The agent installs a git hook.** It writes `.git/hooks/pre-commit` and the user later commits | Code execution on the user's next commit | `.git` is read-only in a container and absent on SSH; git writes in a check fail | Attempt the write through `target.writeFile` and through `exec`; both fail |
| 9 | **Secrets reach the target.** A parent environment leaks a key | Keys live in the container/host logs | Allowlist environment; launcher never forwards `*_API_KEY`, `*_TOKEN`, `SSH_AUTH_SOCK` (except to `ssh`), vault passphrase | Remote `env` probe asserts none of the known names is present |
| 10 | **Version skew after an app update.** Old target bundle, new client | Undefined behaviour on a half-versioned protocol | Exact `target.hello` version check; mismatch refuses before push and redeploys on the next attempt | Run the client against a server with a bumped version; assert `target-version-mismatch` and no push |
| 11 | **A container crash or OOM.** The process is gone between steps | Stale containers accumulate; a mission waits forever | One timeout, then `target-lost`; labels allow reconcile; `--rm` plus `docker rm -f` | Kill the container mid-mission; the mission fails; the next engine start removes the label |
| 12 | **An unsigned build is shipped.** Signing is skipped or the staple is missing | Gatekeeper blocks every download; the release looks fine in CI | Sign only with credentials; `verify-mac-signature.sh` requires codesign, `spctl`, and stapler on both dmg and app; the release job fails otherwise | Run the verifier on the current unsigned artifact: exit 1, `not signed`; on the owner's artifact: exit 0, `signed and notarized` |
| 13 | **The Linux package carries a Mac helper.** The checked-in Mach-O binaries are copied into the `.deb` | A broken helper ships to Linux users | Move `extraResources` under `mac`; Linux gets none; the smoke asserts no Mach-O magic in the package | `dpkg-deb -c` + a file scan in `smoke-linux.sh` |
| 14 | **The mission suite passes a false claim.** A broken checker marks "all tests pass" as verified | The product's core promise is false | Mission 2's check never passes; the receipt's `verified` rule ignores the claim | S1 suite run; mission 2 must be `failed` |

---

## 12. Build plan for Rigel

Six vertical slices. S1 is first because it is the gate; S2 → S3 → S4 are
sequential; S5 and S6 run in parallel with them. Each slice ships as its own PR
through `scripts/worktree.sh new` and `scripts/pr-gate.sh --when-green`. No
slice adds a package dependency, and no slice touches `packages/desktop`
(Pixel's shell).

Every done-when is a command. "Passes" means exit 0.

### S1. The phase-3 mission suite (fixed, local)

- **Builds:** the missing acceptance suite: five scripted missions, a driver,
  assertions on status, receipt and target identity. No target code yet.
- **Files:**
  - new `scripts/mission-suite.sh`
  - new `evals/mission-suite/verified.json`, `false-claim.json`,
    `repair.json`, `budget.json`, `changed-lines.json`
  - `scripts/README.md` (catalog row for the new script)
- **Done when:**
  ```
  bash scripts/mission-suite.sh --target local
  ```
  exits 0 and prints `5/5 missions passed on local`.
- **Depends on:** the current engine's scripted-agent path
  (`packages/engine/src/missions/agent.ts`) and OSP. Nothing from S2-S6.

### S2. Target bundle, transport and the container target

- **Builds:** `targets.json` schema and loader, `opensand-target --stdio`
  (hello, exec, all file operations), the stdio client, the `docker`/`podman`
  launcher, container lifecycle and reconcile. No mission integration yet.
- **Files:**
  - new `packages/shared/src/target-types.ts`
  - new `packages/shared/src/targets-store.ts`
  - `packages/shared/src/index.ts` (export only)
  - new `packages/local-exec-daemon/src/target/types.ts`
  - new `packages/local-exec-daemon/src/target/server.ts`
  - new `packages/local-exec-daemon/src/target/client.ts`
  - new `packages/local-exec-daemon/src/target/launcher.ts`
  - new `packages/local-exec-daemon/src/target/index.ts`
  - new `packages/local-exec-daemon/src/target/bin.ts`
  - `packages/local-exec-daemon/package.json` (the `opensand-target` bin and the `@opensand/protocol` workspace link)
  - `packages/local-exec-daemon/src/index.ts` (export only)
  - `package.json` (the `target:build` script)
  - new `scripts/target-probe.sh`
  - `scripts/README.md` (catalog row)
  - new `packages/local-exec-daemon/test/target-transport.test.ts`
- **Done when:**
  ```
  pnpm target:build && pnpm --filter @opensand/local-exec-daemon test -- target-transport && bash scripts/target-probe.sh container
  ```
  passes. `target-transport` starts a real `opensand-target` child over a temp
  root and asserts hello, exec cwd/marker, a path escape refusal, an external
  symlink refusal, and a version mismatch. `target-probe.sh container` starts
  `node:22-bookworm`, proves `target.exec` reports Linux and the marker, reads
  and writes a file, and removes the container on exit.
- **Depends on:** nothing from S1. Requires `docker` on the runner.

### S3. SSH target and workspace sync

- **Builds:** the SSH launcher, bundle deploy by content hash, `rsync` push and
  fetch, the manifest, the conflict gate, and the target lock.
- **Files:**
  - `packages/local-exec-daemon/src/target/launcher.ts` (the ssh branch)
  - new `packages/local-exec-daemon/src/target/sync.ts`
  - new `packages/local-exec-daemon/src/target/manifest.ts`
  - new `packages/local-exec-daemon/test/target-sync.test.ts`
  - `scripts/target-probe.sh` (the ssh branch)
- **Done when:**
  ```
  pnpm target:build && pnpm --filter @opensand/local-exec-daemon test -- target-sync
  ```
  passes. `target-sync` uses a temp directory as the remote and asserts: push
  excludes `.git`; a clean fetch then apply succeeds; a local edit after push
  refuses the apply and leaves the local bytes unchanged; a deletion is applied only for a
  path the manifest owns; an external symlink is refused before push; the
  second lock holder is refused.
- **Depends on:** S2. The real SSH path is exercised by S4 on a machine the
  owner names (`OPENSAND_SSH_TARGET`); CI has no sshd.

### S4. Mission integration and target receipt

- **Builds:** `MissionWorkspace`, `LocalWorkspace`, `TargetWorkspace`; target
  resolution in the start path; check and agent through the workspace;
  `prepare()` before review and `apply()` after acceptance; `mission.target`;
  the receipt block.
- **Files:**
  - new `packages/engine/src/missions/workspace.ts`
  - new `packages/engine/src/missions/target-workspace.ts`
  - `packages/engine/src/missions/runner.ts` (the workspace seam, `prepare()` and `apply()`)
  - `packages/engine/src/missions/check.ts` (optional executor in `opts`)
  - `packages/engine/src/missions/agent.ts` (`ctx.workspace`)
  - `packages/engine/src/missions/manager.ts` (create/close)
  - `packages/engine/src/missions/receipt.ts` (the `target` block)
  - `packages/shared/src/mission-events.ts` (`mission.target`)
  - `packages/engine/src/handlers/missions.ts` (`target` parameter)
  - new `packages/engine/test/target-mission.test.ts`
  - `scripts/mission-suite.sh` (wire `--target container` and `--target ssh`)
- **Done when:**
  ```
  bash scripts/mission-suite.sh --target local && bash scripts/mission-suite.sh --target container
  ```
  exits 0, each printing `5/5 missions passed on <name>`. With
  `OPENSAND_SSH_TARGET` set, the third form
  `bash scripts/mission-suite.sh --target ssh` is the phase's own done-when on
  that host.
- **Depends on:** S1, S2, S3. Requires `docker` for the container form.

### S5. Linux build

- **Builds:** the AppImage and `.deb` targets, the release job, and a Linux
  smoke that launches the packaged app.
- **Files:**
  - `electron-builder.yml` (`linux:` targets; `extraResources` moves under
    `mac`)
  - `package.json` (`package:linux`)
  - new `scripts/smoke-linux.sh`
  - `scripts/README.md` (catalog row)
  - `.github/workflows/release.yml` (the `build-linux` job)
  - `docs/install.md` (the Linux download and smoke note)
- **Done when:** on `ubuntu-22.04`:
  ```
  pnpm package:linux && bash scripts/smoke-linux.sh dist/release/*.deb
  ```
  exits 0 and prints `OpenSand <version> linux ok`.
- **Depends on:** nothing from S1-S4. Runs in parallel.

### S6. Signed and notarized macOS build

- **Builds:** hardened runtime, the entitlements file, conditional signing in
  the release job, notarization and stapling, and the verifier wired into
  `release.sh`.
- **Files:**
  - `electron-builder.yml` (`hardenedRuntime`, `entitlements`, `notarize`)
  - new `build/entitlements.mac.plist`
  - new `scripts/verify-mac-signature.sh`
  - `scripts/README.md` (catalog row)
  - `.github/workflows/release.yml` (signed branch and the unsigned suffix)
  - `scripts/release.sh` (verify before install; `--allow-unsigned` opt-out)
  - `docs/install.md` (Gatekeeper note)
- **Done when:** the tag workflow's macOS job is green and
  `bash scripts/verify-mac-signature.sh dist/release/OpenSand-*.dmg` exits 0
  printing `signed and notarized`. Until D1 is answered, the unsigned path
  stays and this slice is parked; it does not block S1-S5.
- **Depends on:** the owner's Apple Developer ID and CI secrets (D1).

### Order and gates

S1 → (S2 → S3 → S4). S5 and S6 run alongside. Each PR runs
`scripts/pr-gate.sh --when-green <PR>` after CI is registered. The owner
merges; workers do not run `gh pr merge`.

---

## 13. Preconditions and what is still open

- **P1 (blocks S2):** `pnpm deploy` must produce a runnable target bundle with
  its workspace dependencies as real directories. S2's first task is to prove
  that with a one-file deploy and `node bin.js --help`; if it cannot, the
  fallback is to ship the daemon's `dist` plus a resolved `node_modules` in the
  same step, not to add a bundler.
- **P2 (blocks S4):** the container image must contain `node >= 22`. The
  preflight checks it and refuses with `target-toolchain-missing`; Phase 8 does
  not build a custom image per project.
- **P3 (blocks S4 on SSH):** the host needs `node >= 22`, `rsync` and `bwrap`.
  A host without them can still serve interactive turns when its target says
  `sandbox: "none"`, but never a mission.
- **P4 (blocks S6):** Apple Developer ID membership and the CI secrets. Only
  the owner can enrol and issue them.

- **Open, owner decision D1 — Apple Developer ID.** Recommended default:
  enrol (the paid membership) and put the signing identity and notary
  credentials in the release secrets; pick either an app-specific password or
  an App Store Connect API key. Until then: unsigned local builds only, S6
  parked, and the release name carries `-unsigned`.
- **Open, owner decision D2 — Linux formats and arch.** Recommended default:
  AppImage and `.deb`, x86_64 only. arm64 and a repository are additive later.
- **Open, owner decision D3 — container runtime.** Recommended default: the
  `docker` CLI only; `podman` is accepted through the same argument shape but
  is not tested in Phase 8.
- **Open, owner decision D4 — SSH sandbox.** Recommended default: require
  `bwrap` for any SSH mission and allow `sandbox: "none"` only for interactive
  turns. If the owner's dev box cannot run bwrap, the choice is to install it
  or to accept that box as interactive-only.
- **Open, owner decision D5 — the SSH host's toolchain.** Recommended default:
  require `node >= 22` and `rsync`; do not ship a Node runtime. This keeps the
  bundle small and the host under the owner's package management.

- **Open, not designed here:** remote Docker (`DOCKER_HOST`), Windows/WSL
  targets, running models on the target, a target picker in the Preact shell,
  per-step remote undo, and multi-target missions. All are additive; none
  changes the invariants in §2.
- **Known limitation, accepted:** an SSH target does not carry `.git`, so a
  check that needs git history fails there. A container target carries `.git`
  read-only, so a check that commits also fails. The suite's checks do neither;
  a project that needs git inside its check should use `local` in Phase 8.
