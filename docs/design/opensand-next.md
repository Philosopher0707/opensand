# OpenSand Next: design and build structure

Status: proposal, 2026-11-11. Not yet reviewed by the owner. Nothing in this
document is implemented unless section 2 says it exists today.

Sources: the OpenSand repo at `4d32ec7` (read directly), and the Claude Desktop
4.4212.0 architecture notes in `~/research/claude-desktop/ARCHITECTURE.md`
(architecture lessons only; no code is taken from it). I did not survey
competitors' current feature lists for this document, so nothing below claims
that a feature is unique. The claims are about what an open, local, any-model
app is structurally free to do.

---

## 1. The bet

Every agent app today is a chat window in front of one vendor's model. You
watch it work, you approve things as they pop up, and at the end the model
tells you it is done. You find out later whether that was true.

OpenSand should be **the agent app you can walk away from**. You hand it a
goal and leave. That only works if three things hold, and the whole design
exists to make them hold:

| You can walk away when | Which means the app must provide |
|---|---|
| "Done" is checked by something other than the model | **Proof**: the harness runs the check and writes the report |
| Any step can be undone | **Undo**: a snapshot before every change, restore and fork from any point |
| The worst case is bounded | **Containment**: commands run in an OS sandbox with stored, scoped grants |

A closed, single-vendor app can add any one feature from this list. What it
cannot easily do is the combination that open and local gives for free:

- **Any model, per step.** A cheap local model drafts, a strong cloud model
  reviews, and a third family breaks ties. Extra attempts on a local model
  cost nothing.
- **The harness is yours.** Policy, skills, hooks and the event log are plain
  files you can read, diff and change.
- **Your work stays on your machine**, in a format that can be replayed.

What OpenSand should not try to win: the vendor's own model quality, mobile
device simulators, office add-ins, account sync, a 1,400-call RPC surface.

---

## 2. Where the codebase is today

About 25,700 lines of TypeScript in six tracked packages, plus a 6,026-line
`renderer/app.js`. A lot of surface exists. Several pieces the new design
depends on are written but not connected, and a few are missing.

| Area | What exists | What I found |
|---|---|---|
| Agent loop | `coordinator/src/coordinator.ts` (`AgentCoordinator`, auto-compaction, hooks, parallel read-only tools) | Solid base. Runs **inside the Electron main process** (`desktop/src/ipc-bridge.ts:534`), so an engine hang or crash is an app hang or crash |
| File tools | `local-exec-daemon/src/tool-registry.ts:46`: `exec_command`, `read_file`, `write_file`, `list_directory`, 4 pty tools | **No `edit_file`, `grep` or `glob` exists**, yet `template-gallery.ts:113,167`, `token-hygiene.ts:211,307-312` and the healer prompt at `workspace-sentinel.ts:56` tell agents to use `edit_file`. Agents must rewrite whole files |
| Undo | `shared/src/workspace-snapshot.ts:49,85` (create and revert) | **Called only by the eval runner.** No turn takes a snapshot |
| Graph engine | `coordinator/src/agent-graph.ts:75` (`StateGraph`, checkpoints, events) | Used only by `webhook-gateway.ts`. The main loop does not run on it |
| Permissions | `policy-engine.ts` (rules by tool, command, path, domain, initiator; audit log), bash validator, standing allowlist | Decisions are good; **enforcement is by string inspection only**. `exec_command` is not OS-sandboxed (Seatbelt is used only for the 1Password launcher) |
| Sessions | per session: `messages.json`, `meta.json`, `transcript.jsonl`, `transcript.txt` | Four files for one truth; resume already needed a recovery pipeline (`f96987d`) |
| Subagents | `delegate_to_agent`, tool scoping, event forwarding | Delegation is a sequential barrier (`tool-parallelism.ts`); no parallel attempts |
| Models | OpenAI-compatible and Anthropic clients, OpenRouter catalog, per-agent model override | No routing by role, no fallback ladder, no cost budget |
| Automation | routines (cron), sentinel, webhooks, rooms, connectors | Present; all run with no human present, which is exactly where proof and containment matter most |
| Desktop shell | hardened flags (`main.ts:114-116`), preload namespace (`preload.ts:15`), REST and SSE server | The packaged app does not load the preload (found during the UI fix), so the renderer falls back to HTTP. Renderer is one vanilla file |
| Evals | `evals/tasks.json`, 28 tasks | Mostly scripted checks of harness functions, not "did a model finish a real task" |
| Distribution | v0.1.4 dmg and zip, macOS only | Unsigned; Gatekeeper blocks it |

Two things outside the code:

- **Provenance wording.** The README's first sentence says OpenSand is derived
  from byte-level reverse engineering of a named commercial app. For a
  product meant to compete in public that is a legal and reputational
  exposure. `docs/provenance-review.md` exists; the public framing needs the
  owner's decision before any launch.
- **Breadth.** Rooms, the seven-layer memory, habits, templates, vault,
  connectors and native bridges all exist at once. The proposal freezes these
  as they are and spends effort on depth in one path.

---

## 3. The product

### 3.1 Missions instead of chats

A **mission** is a goal, a done-check and a budget.

```
goal    "Add an edit_file tool and migrate the templates to it"
check   pnpm -r build && pnpm -r test          (exit 0)
budget  $2.00, 40 minutes, 3 repair rounds
target  ~/dev/opensand  (local, sandbox: workspace-write, network: off)
```

- The agent proposes the check when you do not give one; you accept or edit it
  before work starts. Checks are commands, file assertions, or a short
  checklist you tick yourself for things no command can prove.
- States: `planned → running → needs-you → verified | failed | stopped`.
- **Only the harness can set `verified`**, and only by running the check
  itself. The model saying "all tests pass" changes nothing.
- A plain chat still exists for questions. Any chat can be promoted to a
  mission; a mission's conversation is one of its views.

### 3.2 Receipts

Every mission ends with a receipt that the harness builds from the event log.
The model does not write it.

```
VERIFIED  check exited 0 (2 runs: failed at 14:02, passed at 14:09)
Changed   packages/local-exec-daemon/src/tool-registry.ts  46-171  CORE_TOOL_DEFINITIONS
          packages/coordinator/src/template-gallery.ts     113, 167
Ran       11 commands, 1 non-zero (pnpm -r test, exit 1, 14:02)
Used      local qwen3:8b (plan, code)  ·  cloud reviewer (1 call)  ·  $0.04  ·  7m 12s
Asked     1 approval (write outside workspace: denied)
Not done  Windows path handling (model note; unverified)
Undo      restore point #0 returns the folder to its state at 14:01
```

### 3.3 Time machine

- A snapshot is taken before every step that can change the workspace.
- The mission view has a timeline. Selecting a point shows the diff from
  there; **Restore** returns the folder to that point; **Fork** starts a new
  attempt from it with a new instruction or a different model.
- Restore is exact for tracked and untracked files inside the workspace. It
  does not undo effects outside it (a pushed commit, a sent message); those
  steps are marked on the timeline as not reversible, and they are the steps
  that always ask first.

### 3.4 Tournament

Run one mission as several attempts at once, each in its own git worktree,
each with a different model or strategy. The harness runs the same check on
every attempt and shows the ones that pass side by side: diff size, cost,
time, reviewer notes. You keep one; the others are deleted.

This turns "which model is best for my code" from an opinion into a number
measured on your own repository, and feeds 3.5.

### 3.5 Model mesh

- Work is split by **role**: planner, coder, reviewer, summarizer, vision.
  Each role maps to an ordered list of models.
- **Ladder:** start with the cheapest model that has a good record for the
  role; move up one rung when the check fails or the reviewer rejects.
- **Record:** every receipt adds a row (role, model, passed, cost, time) to a
  local stats file. The routing table is computed from it. No data leaves the
  machine.
- **Cross-family review:** the reviewer is never the same model family as the
  coder when a second family is configured.
- **Budget:** a mission stops and asks when it reaches its money or time
  limit. It never continues past it silently.

### 3.6 One inbox

Everything that needs a person, from every mission, routine, watcher and
webhook, lands in one queue: approvals, questions, finished receipts. Nothing
opens a modal over your work. A mission that needs you parks; the others keep
going. Grants made from the inbox are stored ("always allow `pnpm test` in
this folder"), so the same question is not asked twice.

Work started with nobody present (routines, sentinel, webhooks, subagents)
can never approve itself. It parks in the inbox. `policy-engine.ts` already
carries the initiator on every decision; this makes it a rule.

---

## 4. Architecture

### 4.1 Processes

```
 Desktop shell        CLI             VS Code panel      HTTP/SSE (browser, webhooks)
 (Electron main +     (terminal)      (extension)        (desktop-server.ts)
  sandboxed renderer)
        │                │                 │                     │
        └────────────────┴────── OSP ──────┴─────────────────────┘
                 JSON lines; requests, events, one schema
                                 │
                    ┌────────────▼─────────────┐
                    │  ENGINE  (one per         │   opensand engine --stdio
                    │  workspace, own process)  │
                    │  mission runner (graph)   │
                    │  coordinator loop         │
                    │  model router             │
                    │  event log + projections  │
                    └────────────┬─────────────┘
                                 │ tool calls (capability-checked)
                    ┌────────────▼─────────────┐
                    │  EXECUTOR                 │   local-exec-daemon
                    │  policy + grants          │
                    │  OS sandbox per command   │
                    │  snapshots                │
                    │  target: local | container | ssh
                    └──────────────────────────┘
```

- **Shell** owns windows, menus, tray, updates, notifications. No agent logic.
- **Engine** is the same program for the desktop and the CLI. If it dies the
  shell starts it again and it resumes from the log. This is the main lesson
  from the Claude Desktop notes (their section 5.5): one engine, many front
  ends, joined by a line protocol.
- **Executor** is the only code that touches files and runs commands. The
  engine never does either directly.

### 4.2 OSP, the OpenSand protocol

One typed schema in `packages/protocol`, used by every client.

- Requests are named `namespace.Class.method` (`mission.Missions.start`,
  `inbox.Approvals.answer`). Small namespaces from the start, never one large
  one.
- Events are the event-log records of 4.3, streamed as they are appended. A
  client that reconnects sends its last sequence number and receives what it
  missed. The UI holds no state that the log does not.
- The renderer receives a closed object of functions built at preload time,
  never a generic `invoke`. The packaged-app preload bug gets fixed here, and
  a test launches the packaged app to prove `window.opensand` exists.

### 4.3 The event log is the only truth

One append-only JSONL file per mission. Everything else is computed from it:
the conversation, the timeline, the receipt, resume, replay, eval scoring.

```json
{"seq":41,"ts":"…","attempt":1,"node":"act","kind":"tool.completed",
 "data":{"tool":"exec_command","exit":1,"ms":8123,"snapshot":"s-0007"},
 "prev":"sha256:…"}
```

- Each record carries the hash of the one before it. The writer re-reads the
  head under a file lock before every append.
- Kinds: `mission.*`, `node.*`, `model.*`, `tool.*`, `approval.*`,
  `snapshot.*`, `check.*`, `budget.*`.
- The four per-session files become projections, rebuilt on demand. Existing
  sessions are converted by a step in `shared/src/state-migrations.ts`.

### 4.4 The mission runner

Missions run on the existing `StateGraph`:

```
plan ──▶ act ──▶ check ──pass──▶ review ──accept──▶ receipt ──▶ END
          ▲        │fail            │reject
          └─ repair ◀───────────────┘        (bounded by the budget)
```

- `act` is today's coordinator turn loop, unchanged in spirit.
- `check` is harness code. It runs the mission's check in the sandbox and
  records exit code and output. No model is involved.
- `review` is a second model reading the diff and the check output.
- A checkpoint after every node stores the log position and the snapshot id.
  Resume, fork and tournament are all "start a run from a checkpoint".

### 4.5 Snapshots

- **Git workspaces:** each snapshot is a commit object on a hidden ref
  (`refs/opensand/<mission>/<seq>`), built from a temporary index so the
  user's index, branch and stash are untouched. Cheap, deduplicated, and it
  includes untracked files that are not ignored.
- **Other folders:** the existing copy-based `workspace-snapshot.ts`, with a
  size limit and a clear message when the folder is too large.
- Tournament attempts use `git worktree`; `git-manager.ts` already has it.

### 4.6 Containment

| Layer | Rule |
|---|---|
| Folder trust | Stored per folder. Asked once, as a pending question the mission waits on |
| Sandbox | Every command runs under a profile: `read-only`, `workspace-write` (default) or `full`. Network is off by default and opened per domain. macOS: `sandbox-exec`. Linux: bubblewrap. Where neither exists, every command asks |
| Grants | `(tool, scope, lifetime)`: scope is a path prefix, command prefix or domain; lifetime is once, mission, folder or always. Stored in one file with an **epoch**. An answer that arrives with an old epoch is refused |
| Raising | Anything that would widen what the agent may do without asking always asks, in every mode |
| Untrusted text | Tool output, web pages and file contents enter the prompt inside a labelled tag, with the tag's own closing form escaped and a length cap. The system prompt states that the tag holds data, never instructions |
| Secrets | The vault's output redaction stays; the sandbox profile denies reads of `~/.ssh`, `~/.opensand/vault` and shell rc files |

The bash validator and policy rules remain as the first, fast layer. The
sandbox is what makes a miss survivable.

### 4.7 Context and tools

- Add `edit_file` (exact string replace, fails when the match is not unique),
  `grep` and `glob`. These remove most whole-file rewrites and most
  `exec_command` calls, which are the calls that need approval.
- A mission notes file the agent maintains; it survives compaction.
- The existing token hygiene, tool selection and compaction stay.
- Memory, skills, rooms, habits: unchanged in this plan.

### 4.8 Storage

```
~/.opensand/
  missions/<id>/log.jsonl        the truth
  missions/<id>/receipt.md       projection
  missions/<id>/attempts/<n>/    worktree pointer, per-attempt meta
  mesh/stats.jsonl               one row per (mission, role, model)
  mesh/routes.json               role → ordered models (user-editable)
  trust.json  grants.json        with epoch
  sessions/                      old layout, read-only after migration
```

---

## 5. The desktop app

```
┌──────────────┬──────────────────────────────────────────┬────────────────┐
│ NEEDS YOU  2 │  Add edit_file tool            ● running │ Plan           │
│  ▸ approve…  │  [Timeline] [Chat] [Diff] [Receipt]      │  ✓ read tools  │
│  ▸ question… │                                          │  ● write tool  │
│ RUNNING    3 │  14:01 ◆ start        snapshot #0        │  ○ migrate     │
│ VERIFIED     │  14:02 ● edit tool-registry.ts  +84 −0   │ Check          │
│ FAILED       │  14:02 ✕ pnpm -r test  exit 1            │  pnpm -r test  │
│              │  14:07 ● edit …                          │ Budget         │
│ Chats        │  14:09 ✓ pnpm -r test  exit 0            │  $0.04 / $2.00 │
│ Routines     │        [Restore here] [Fork from here]   │ Models         │
└──────────────┴──────────────────────────────────────────┴────────────────┘
```

- Left: missions grouped by state, the inbox always on top.
- Centre: the selected mission. Timeline is the default view, not chat.
- Right: plan, check, budget and models for the mission.
- Tournament view: one column per attempt with check result, diff size and
  cost, and a button to keep one.
- A quick window on a global shortcut starts a mission from anywhere.
- Tray shows the count of items that need you.

**Renderer rebuild.** A single 6,026-line file cannot carry a timeline, a
diff view and a tournament view. Recommendation: TypeScript with Preact,
built by Vite, one bundle per window kind (main, quick, consent). It is a
build-time dependency only; what ships stays small. The change is made view
by view against the same OSP events, with the current UI running until each
view is replaced. The cost is the end of the "no build step for the renderer"
property the README describes.

---

## 6. Build structure

### 6.1 Packages

```
packages/
  protocol/            NEW   OSP schema, client, reconnect
  engine/              NEW   mission runner, event log, projections, receipts,
                             model router (takes the loop from coordinator)
  coordinator/         KEEP  turn loop, providers, hooks, token hygiene;
                             its 2,576-line orchestrator-tools.ts is split by area
  local-exec-daemon/   GROW  edit/grep/glob, sandbox profiles, grants, snapshots, targets
  shared/              KEEP  types, migrations
  desktop/             SLIM  shell only; ipc-bridge.ts (1,590 lines) becomes an OSP client
  renderer/            NEW   Preact app, split out of desktop/
  cli/                 KEEP  becomes an OSP client of the same engine
  native-bridge/       KEEP  frozen
  evals/               GROW  mission-level tasks, live-model lane
```

### 6.2 Phases

Durations are my estimates for this team, not measurements.

| Phase | Delivers | Done when | Owner |
|---|---|---|---|
| **0. Repair** (about 1 week) | `edit_file`, `grep`, `glob`; a snapshot taken before every mutating tool call and a restore call; preload loads in the packaged app | A test asserts every tool named in a template or role list is registered. Restore after a scripted turn leaves the folder byte-identical. A test launches the packaged app and reads `window.opensand` | Dex, Rigel |
| **1. Event log** (1–2 weeks) | One hash-chained log per session; the four old files become projections; migration | `kill -9` in the middle of a turn, restart, and no event is lost or repeated. Old sessions open after migration. A broken chain is detected | Dex, Ada |
| **2. Engine process + OSP** (2 weeks) | `opensand engine --stdio`; desktop and CLI as clients; restart and reconnect | Killing the engine during a turn leaves the window responsive and the turn resumes. Desktop and CLI pass the same protocol test suite | Ada (schema), Dex |
| **3. Missions and receipts** (2–3 weeks) | Mission graph, harness-run checks, receipts, budgets | A model that claims success with a failing check ends `failed`. A mutation probe on the checker catches each deliberate break. The receipt's changed lines match `git diff` | Dex, Rigel |
| **4. Containment** (2 weeks) | Sandbox profiles on macOS and Linux, grants with epoch, folder trust, untrusted-text channel, inbox back end | Inside the sandbox, writing outside the workspace and reading `~/.ssh` both fail. An answer with an old epoch is refused. An injection fixture in a tool result does not cause a tool call | Ada, Dex |
| **5. New shell** (runs alongside 2–4) | Preact renderer: mission list, timeline, diff, receipt, inbox, quick window | Each replaced view passes a real-window test at 960×740 and at full screen. The old `app.js` is deleted when the last view moves | Pixel |
| **6. Time machine** (1–2 weeks) | Hidden-ref snapshots, restore and fork from the timeline | Fork from step N yields the same tree as the original at N. The user's index, branch and stash are unchanged afterwards | Dex, Pixel |
| **7. Mesh and tournament** (3 weeks) | Role routing, ladder, stats, parallel attempts in worktrees | A three-attempt tournament finishes with every worktree but the kept one removed. Routing changes after the stats change, in a test with fixed data | Ada, Dex |
| **8. Reach** (later) | Container and SSH targets, Linux build, signed and notarized macOS build | Per target: the phase-3 mission suite passes on it | Rigel |

Order matters in two places. Phase 1 comes before everything because every
later feature is a reading of the log. Phase 4 comes before any promotion of
unattended work, because routines and webhooks already run with nobody
watching.

### 6.3 How we know it is working

| Measure | Target |
|---|---|
| Walk-away rate: missions that reach `verified` with no human input, on a fixed suite | Tracked per model from phase 3; no target until there is a baseline |
| False verified: `verified` when the check should have failed | 0, proven by mutation probes |
| Events lost on `kill -9` | 0 |
| Restore exactness | Byte-identical |
| Sandbox escapes in the fixture set | 0 |

The eval suite grows from 28 scripted checks to mission-level tasks with a
live-model lane, run on a local model so it costs nothing.

### 6.4 Not in this plan

Device simulators, office add-ins, account sync, device attestation, a plugin
UI surface, a Windows build, and any extension of rooms, habits or the memory
layers.

---

## 7. Decisions for the owner

1. **Provenance wording** in the README before any public launch.
2. **Apple Developer ID** (paid membership) for a signed, notarized build.
   Only the owner can enrol. Until then the app stays a local build.
3. **Renderer on Preact and Vite**, which ends the no-build renderer.
4. **Freeze the wide features** (section 6.4) while phases 0–7 run.
