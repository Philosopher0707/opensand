# Protocol notes

**Purpose:** the compatibility surface OpenSand reproduces for existing clients. Every name here is a
**protocol fact**: it was observed from request traffic, logs, or the UI calling the app, never read out
of decompiled source. The implementations behind these names are OpenSand's own and live in
`packages/*/src`.

Rule for adding an entry: write down what the name means (inputs, outputs, state change, errors) *before*
implementing it, and implement from this note.

## 1. Connect-Web RPC (`packages/desktop/src/rpc-gateway.ts`)

Transport: HTTP `POST`, `Content-Type: application/grpc-web+proto` (also accepts JSON bodies), path
`/aiserver.v1.<Service>/<Method>`. Response is a single frame with the same message shape the client
already parses. Unknown service or method returns `404`; a malformed body returns `400`.

| Service | Methods |
|---|---|
| `aiserver.v1.GrokBotService` | `RollBackGrokBotConversation`, `AskSideQuestion`, `CompactHistory`, `GetTokenTelemetry`, `SubmitQuery`, `EnsureSandBox`, `EnsureSandBoxWindow`, `RecreateSandBox` |
| `aiserver.v1.AgentStoreService` | `ListAgents`, `ListAgentStores`, `GetAgent`, `CreateAgent`, `DeleteAgent`, `ExportAgentTemplate`, `ImportAgentTemplate` |
| `aiserver.v1.SandBoxService` | `ExecCommand`, `ReadFile`, `WriteFile`, `ListDirectory` |
| `aiserver.v1.DashboardService` | `GetTeams`, `GetMe`, `GetFleetStatus`, `ListTasks`, `CreateTask`, `ListRooms`, `CreateRoom`, `RunRoomDiscussion`, `ListRoutines`, `TriggerRoutine`, `ListSecrets`, `ListMemories`, `ListAttachments` |

State: the service names are the compatibility contract; the request/response bodies are OpenSand's own
types in `packages/shared/src`. No upstream proto file is vendored.

## 2. HTTP API (`packages/desktop/src/desktop-server.ts`)

Names kept for parity with what the shipped client already calls:

| Method | Route | Input | Effect |
|---|---|---|---|
| `GET` | `/api/attachments` | none | lists staged attachments |
| `POST` | `/api/attachments` | file bytes or path | stages an attachment, returns its id |
| `DELETE` | `/api/attachments/:id` | id | removes a staged attachment |
| `GET` | `/api/templates/:agentId` | agent id | exports the agent as a portable template |
| `POST` | `/api/templates/import` | template body | registers a new agent from a template |
| `POST` | `/api/btw` | question + session id | one ephemeral side question, not appended to history |
| `POST` | `/api/rollback` | session id + turn count | drops the last N user turns |

Errors: `400` for a malformed body, `404` for an unknown id, `409` when a turn is already running.

## 3. Orchestrator tool names (`packages/coordinator/src/orchestrator-tools.ts`)

The 48 tool names (`create_agent`, `delegate_to_agent`, `update_memory`, `create_routine`, …) are the
names a model is told to call. They exist because the prompt contract and the UI both expect them.
Schemas and handlers are OpenSand's own; see the file for each tool's `inputSchema` and description.

## 4. Skill file format (`packages/coordinator/src/skill-store.ts`)

`SKILL.md` with YAML frontmatter between `---` fences: `name`, `description`, and free-form keys.
Falls back to the first `# H1` for the name, then to the filename; a file named `SKILL.md` takes its
name from its parent directory. Written from the observed format, not from upstream parser code.

## 5. OSP Evolution: Mapping Legacy Contracts to OSP

Phase 2 replaces the fragmented legacy transports—Connect-Web gRPC-Web emulation (`rpc-gateway.ts`) and Express HTTP API routes (`desktop-server.ts`)—with the unified, line-delimited **OpenSand Protocol (OSP)** (`docs/design/osp-protocol.md`).

OSP establishes a standalone, long-running engine process (`opensand engine --stdio` or local domain socket) communicating with all clients (Desktop Shell, Terminal CLI, VS Code extension, and webhooks) through a typed RPC and event-streaming contract.

### 5.1 Connect-Web RPC Mapping (`packages/desktop/src/rpc-gateway.ts`)

| Legacy Service / Method | OSP Namespace / Method / Event | Architectural Rationale & Transition Path |
|---|---|---|
| `aiserver.v1.GrokBotService/SubmitQuery` | `mission.Missions.start` or `session.Sessions.create` | Moves user turns from an ephemeral in-memory turn loop into first-class graph-executed missions or sessions backed by the hash-chained event log. |
| `aiserver.v1.GrokBotService/RollBackGrokBotConversation` | `timeline.Timeline.restore` | Replaces destructive in-memory array slicing (`messages.slice(0, -turns)`) with non-destructive checkpoint and git snapshot restoration. |
| `aiserver.v1.GrokBotService/AskSideQuestion` | Ephemeral inspection query via `engine.Engine` | Side-questions execute out-of-band without polluting the mission graph or append-only event log. |
| `aiserver.v1.GrokBotService/CompactHistory` | Projected log checkpoint (`timeline.Timeline`) | The log is append-only and never mutated. Compaction creates checkpoint projections without rewriting history. |
| `aiserver.v1.GrokBotService/GetTokenTelemetry` | `engine.Engine.status` / mission budget metrics | Token telemetry and spend are tracked monotonically in `mission.Missions.get` (`budgetSpentUsd`) and engine status. |
| `aiserver.v1.GrokBotService/EnsureSandBox`<br>`EnsureSandBoxWindow`<br>`RecreateSandBox` | Internal Executor process lifecycle | Shell no longer manages ad-hoc sandbox windows. The Executor manages isolated sandbox profiles per command run. |
| `aiserver.v1.AgentStoreService/ListAgents`<br>`GetAgent`<br>`CreateAgent`<br>`DeleteAgent` | Subagent mesh & configuration store | Agent roles and subagents are declared in project/user configuration; engine instantiates roles dynamically. |
| `aiserver.v1.AgentStoreService/ExportAgentTemplate`<br>`ImportAgentTemplate` | Portable template store (`packages/coordinator/src/template-store.ts`) | Maintained as portable template imports/exports integrated with engine workspace configuration. |
| `aiserver.v1.SandBoxService/ExecCommand`<br>`ReadFile`<br>`WriteFile`<br>`ListDirectory` | Executor capability-checked tool calls (`tool.*` events) | Eliminates unauthenticated, direct client execution RPCs. All file and command actions execute through capability-checked tools in the Executor. |
| `aiserver.v1.DashboardService/ListTasks`<br>`CreateTask` | `mission.Missions.list`<br>`mission.Missions.start` | Replaces task records with state-graph mission orchestration. |
| `aiserver.v1.DashboardService/ListRoutines`<br>`TriggerRoutine` | Trigger-based mission dispatch | Routines are stored as automation triggers that dispatch `mission.Missions.start` with predefined check commands and budgets. |
| `aiserver.v1.DashboardService/ListRooms`<br>`CreateRoom`<br>`RunRoomDiscussion` | Multi-agent mission tournament / mesh (`opensand-next.md` §3.4, §3.5) | Evolved into parallel multi-attempt tournaments and collaborative model mesh. |
| `aiserver.v1.DashboardService/ListSecrets` | Capability grants (`~/.opensand/grants.json`) | Replaces plaintext secret listing with epoch-guarded grants, OS keychain references, and secure credential prompts. |
| `aiserver.v1.DashboardService/ListMemories` | Event log memory projection | Memory mutations become audited `memory.*` events in the log rather than ad-hoc JSON updates. |
| `aiserver.v1.DashboardService/ListAttachments` | Workspace staging / mission attachments | File attachments are staged directly in the workspace or referenced by sha256 in mission parameters. |

### 5.2 HTTP API Routes Mapping (`packages/desktop/src/desktop-server.ts`)

| Legacy Route | HTTP Method | OSP Target / Mechanism | Architectural Rationale & Transition Path |
|---|---|---|---|
| `/api/attachments` | `GET`, `POST`, `DELETE` | Workspace staging / mission resource references | Integrated into workspace file storage; staged files are tracked with content hashes in mission parameters. |
| `/api/templates/:agentId`<br>`/api/templates/import` | `GET`, `POST` | Agent template registry in Engine | Templates export/import clean declarative YAML/JSON configurations. |
| `/api/btw` | `POST` | Ephemeral side-query via Engine | Side inquiries do not append to the append-only event log. |
| `/api/rollback` | `POST` | `timeline.Timeline.restore` | Restores filesystem snapshot and timeline pointer instead of mutating session JSON files on disk. |
| `/api/policies`<br>`/api/policies/audit` | `GET`, `POST` | `inbox.Approvals.*` & Epoch Grants | Replaced by epoch-checked capability system; all policy overrides and approvals require monotonic epoch validation. |
| `/api/webhooks` | `GET`, `POST`, `DELETE` | Engine trigger subsystem | Incoming webhooks dispatch autonomous missions into the mission runner with isolated sandbox targets. |

### 5.3 Compatibility Bridge Strategy

During the Phase 2 migration:
1. `packages/desktop/src/rpc-gateway.ts` and `packages/desktop/src/desktop-server.ts` are retained as an adapter layer translating legacy HTTP/Connect-Web calls into OSP messages.
2. New clients (CLI, updated Desktop shell, VS Code extension) connect directly to the Engine via stdio or domain socket speaking native OSP JSON Lines.
3. Once all UI views transition to the OSP client bridge (Phase 5), the legacy HTTP routes and Connect-Web gateway will be formally decommissioned.

### 5.4 Wire Codec Package (`packages/protocol`, `@opensand/protocol`)

`@opensand/protocol` is the pure, dependency-free codec for OSP v1 JSON Lines framing: method and event name registries (22 methods, 14 events, `namespace.Class.member`), the error codes in `docs/design/osp-protocol.md` §6, a `LineDecoder` for stream reassembly, and `encodeLine` / `parseLine` for frames. It has no transport and no schemas for method parameters; those are deferred to the engine package (p2b), so `parseLine` checks envelope shape and name form only. A blank line is skipped, not an error, and a trailing `\r` is stripped. An event's `seq` must be an integer of at least 1. Malformed JSON raises `ParseError` (-32700); a well-formed JSON value that breaks the envelope rules (missing or empty `id`, bad method or event name, non-object params, wrong `seq` type) raises `InvalidRequest` (-32600). Callers that read chunked stdio must decode bytes with `TextDecoder` in streaming mode (`decode(chunk, { stream: true })`), or a multi-byte UTF-8 character split across chunks will decode as replacement characters before `LineDecoder` sees it.
