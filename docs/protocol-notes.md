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
