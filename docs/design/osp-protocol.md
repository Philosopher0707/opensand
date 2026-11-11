# OpenSand Protocol (OSP) Specification

**Version:** 1.0.0-draft  
**Authors:** Ada (AI Systems Architect), OpenSand Core Team  
**Status:** Design Proposal (Phase 2)  
**Parent Design:** `docs/design/opensand-next.md` (§4.1, §4.2)

---

## 1. Overview and Core Principles

The **OpenSand Protocol (OSP)** is a typed, line-delimited JSON RPC and event-streaming protocol. It provides the single communication contract connecting all OpenSand user interfaces (Desktop Electron Shell, Terminal CLI, VS Code panel, and HTTP/SSE gateway) to the autonomous **OpenSand Engine** process.

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

### Architectural Principles
1. **One Engine, Multiple Clients:** The engine runs as its own process (`opensand engine --stdio` or local domain socket). All client interfaces speak the identical line protocol.
2. **The Event Log is the Single Truth:** The engine maintains no transient in-memory state that is not persisted in the hash-chained session/mission event log. If the engine process terminates abruptly (`kill -9`), it restarts and replays from the log.
3. **Structured 4-Axis RPC Naming:** All methods and events follow strict hierarchical naming: `namespace.Class.method` and `namespace.Class.event` (e.g., `mission.Missions.start`, `inbox.Approvals.answer`).
4. **Zero Generic Invocation:** Clients receive closed, typed bridge APIs; generic arbitrary `eval` or dynamic `invoke` channels are strictly prohibited.
5. **Epoch-Guarded Grants:** Capability grants and permissions carry an atomic monotonically increasing epoch number. Answers referencing stale epochs are rejected.

---

## 2. Wire Framing and Message Format

OSP messages are transported as UTF-8 encoded JSON Lines (`\n` delimited). Each physical line represents exactly one complete, self-contained protocol message.

### 2.1 Request Framing
A request is sent from a client to the engine:
```json
{
  "id": "req-01HZY4P9X7",
  "method": "mission.Missions.start",
  "params": {
    "workspaceRoot": "/Users/philosopher/dev/project",
    "title": "Fix auth token renewal",
    "initialQuery": "Inspect and repair the refresh loop",
    "checkCommand": "pnpm -r test",
    "budgetUsd": 2.50
  }
}
```

- `id` (string, required): Unique client-generated correlation identifier.
- `method` (string, required): RPC method in `namespace.Class.method` format.
- `params` (object, required): Method-specific parameters payload.

### 2.2 Response Framing
A response is returned from the engine for a specific request `id`:

**Success Response:**
```json
{
  "id": "req-01HZY4P9X7",
  "result": {
    "missionId": "m-8f7a1b",
    "status": "running",
    "startedAt": "2026-11-11T18:30:00.000Z"
  }
}
```

**Error Response:**
```json
{
  "id": "req-01HZY4P9X7",
  "error": {
    "code": 4001,
    "message": "Stale approval epoch: grant epoch 12 superseded by epoch 13",
    "data": {
      "currentEpoch": 13,
      "submittedEpoch": 12
    }
  }
}
```

### 2.3 Event Streaming Framing
Events are asynchronous broadcasts emitted by the engine to subscribed clients:
```json
{
  "event": "mission.Missions.nodeCompleted",
  "seq": 42,
  "missionId": "m-8f7a1b",
  "ts": "2026-11-11T18:30:05.123Z",
  "data": {
    "node": "check",
    "exitCode": 0,
    "durationMs": 4210,
    "snapshotId": "s-0012"
  }
}
```

- `event` (string, required): Event name in `namespace.Class.event` format.
- `seq` (number, required): Monotonically increasing sequence number matching the mission's underlying event log sequence.
- `ts` (string, required): ISO-8601 UTC timestamp.
- `data` (object, required): Event payload.

---

## 3. RPC Methods Specification

### 3.1 `engine.Engine` Namespace (Lifecycle & Control)

| Method | Parameters | Returns | Description |
|---|---|---|---|
| `engine.Engine.ping` | `{}` | `{ "timestamp": string }` | Round-trip liveness ping. |
| `engine.Engine.status` | `{}` | `{ "version": string, "pid": number, "activeMissions": number, "uptimeMs": number }` | Returns engine runtime status. |
| `engine.Engine.reconnect` | `{ "missionId"?: string, "sessionId"?: string, "lastSeq": number }` | `{ "replayedEvents": number, "currentSeq": number }` | Re-establishes event stream; replays all events from `lastSeq + 1` to head. |
| `engine.Engine.shutdown` | `{ "force"?: boolean }` | `{ "success": boolean }` | Gracefully shuts down the engine process. |

### 3.2 `mission.Missions` Namespace (Mission Orchestration)

| Method | Parameters | Returns | Description |
|---|---|---|---|
| `mission.Missions.start` | `{ "workspaceRoot": string, "title": string, "initialQuery": string, "checkCommand"?: string, "budgetUsd"?: number }` | `{ "missionId": string, "status": string }` | Spawns a new autonomous mission on the state graph. |
| `mission.Missions.get` | `{ "missionId": string }` | `{ "missionId": string, "status": string, "title": string, "currentNode": string, "budgetSpentUsd": number }` | Fetches current mission status and metadata. |
| `mission.Missions.list` | `{ "status"?: string[] }` | `{ "missions": Array<{ missionId: string, title: string, status: string, updatedAt: string }> }` | Lists all missions. |
| `mission.Missions.pause` | `{ "missionId": string }` | `{ "success": boolean }` | Pauses active mission execution at the current checkpoint. |
| `mission.Missions.resume` | `{ "missionId": string }` | `{ "success": boolean }` | Resumes a paused or parked mission. |
| `mission.Missions.cancel` | `{ "missionId": string }` | `{ "success": boolean }` | Cancels active mission execution. |
| `mission.Missions.subscribe` | `{ "missionId": string, "fromSeq"?: number }` | `{ "subscribed": boolean, "currentSeq": number }` | Subscribes to mission events from specified sequence. |

### 3.3 `inbox.Approvals` Namespace (Human-in-the-Loop & Grants)

All requests requiring human attention land in the central Inbox. Background agents, routines, and webhook triggers cannot approve themselves; they park in the inbox until resolved.

| Method | Parameters | Returns | Description |
|---|---|---|---|
| `inbox.Approvals.list` | `{}` | `{ "items": Array<ApprovalItem> }` | Lists all pending approval requests. |
| `inbox.Approvals.answer` | `{ "approvalId": string, "decision": "allow_once" \| "allow_mission" \| "allow_folder" \| "deny", "epoch": number }` | `{ "success": boolean, "newEpoch": number }` | Answers an approval request with an epoch check. |
| `inbox.Approvals.subscribe` | `{}` | `{ "subscribed": boolean }` | Subscribes to inbox events (new approval needed, resolved). |

#### ApprovalItem Schema:
```typescript
interface ApprovalItem {
  approvalId: string;
  missionId: string;
  epoch: number;
  createdAt: string;
  tool: string;
  scope: string; // command string, path prefix, or target domain
  riskLevel: "low" | "medium" | "high" | "critical";
  initiator: "human" | "routine" | "webhook" | "subagent";
  reason: string;
}
```

### 3.4 `timeline.Timeline` Namespace (Time Machine & Snapshots)

| Method | Parameters | Returns | Description |
|---|---|---|---|
| `timeline.Timeline.get` | `{ "missionId": string }` | `{ "nodes": Array<TimelineNode>, "checkpoints": Array<Checkpoint> }` | Retrieves step-by-step timeline and checkpoints. |
| `timeline.Timeline.restore` | `{ "missionId": string, "checkpointId": string }` | `{ "restored": boolean, "snapshotId": string }` | Restores workspace and engine state to checkpoint. |
| `timeline.Timeline.fork` | `{ "missionId": string, "checkpointId": string, "newTitle"?: string }` | `{ "newMissionId": string, "forkedFromSeq": number }` | Creates a new mission attempt branched from checkpoint. |

#### Timeline Data Structures:
```typescript
interface TimelineNode {
  nodeId: string;
  name: "plan" | "act" | "check" | "repair" | "review" | "receipt";
  status: "pending" | "running" | "completed" | "failed";
  seqStart: number;
  seqEnd?: number;
  durationMs?: number;
}

interface Checkpoint {
  checkpointId: string;
  seq: number;
  snapshotId: string;
  label: string;
  createdAt: string;
}
```

### 3.5 `session.Sessions` Namespace (Interactive Chat Parity)

| Method | Parameters | Returns | Description |
|---|---|---|---|
| `session.Sessions.create` | `{ "workspaceRoot"?: string, "title"?: string }` | `{ "sessionId": string }` | Creates an interactive chat session. |
| `session.Sessions.get` | `{ "sessionId": string }` | `{ "sessionId": string, "messages": ChatMessage[], "meta": object }` | Retrieves session history projected from event log. |
| `session.Sessions.list` | `{}` | `{ "sessions": Array<SessionSummary> }` | Lists all sessions. |
| `session.Sessions.rename` | `{ "sessionId": string, "title": string }` | `{ "success": boolean }` | Renames session title. |
| `session.Sessions.delete` | `{ "sessionId": string }` | `{ "success": boolean }` | Deletes a session and its projected files. |

#### Session Data Structures:
```typescript
interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  seq?: number;
}

interface SessionSummary {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}
```

### 3.6 Streaming Events Catalog

Events are asynchronous notifications emitted by the engine over active OSP transports (stdio, domain socket, or WebSocket/SSE). Every event maps directly to an append operation in the underlying hash-chained event log, carrying an immutable monotonic `seq` number.

| Event Name | Class | Payload Schema | Description |
|---|---|---|---|
| `mission.Missions.started` | `mission.Missions` | `{ "missionId": string, "title": string, "workspaceRoot": string, "budgetUsd": number }` | Autonomous mission started on state graph. |
| `mission.Missions.nodeStarted` | `mission.Missions` | `{ "missionId": string, "node": string, "attempt": number }` | Graph transition into state node (`plan`, `act`, `check`, `repair`, `review`, `receipt`). |
| `mission.Missions.nodeCompleted` | `mission.Missions` | `{ "missionId": string, "node": string, "exitCode"?: number, "durationMs": number, "snapshotId"?: string }` | State node execution finished. |
| `mission.Missions.toolStarted` | `mission.Missions` | `{ "missionId": string, "tool": string, "callId": string, "params": object }` | Tool execution dispatched to Executor sandbox. |
| `mission.Missions.toolCompleted` | `mission.Missions` | `{ "missionId": string, "tool": string, "callId": string, "exitCode": number, "durationMs": number, "snapshotId": string }` | Tool execution finished in Executor sandbox. |
| `mission.Missions.checkCompleted` | `mission.Missions` | `{ "missionId": string, "exitCode": number, "durationMs": number, "passed": boolean }` | Automated harness check script completed. |
| `mission.Missions.paused` | `mission.Missions` | `{ "missionId": string, "checkpointId": string, "reason": string }` | Mission paused at checkpoint. |
| `mission.Missions.resumed` | `mission.Missions` | `{ "missionId": string, "checkpointId": string }` | Mission resumed from checkpoint. |
| `mission.Missions.completed` | `mission.Missions` | `{ "missionId": string, "receipt": object, "totalCostUsd": number }` | Mission completed with verifiable receipt. |
| `mission.Missions.failed` | `mission.Missions` | `{ "missionId": string, "error": string, "node": string }` | Mission execution failed or budget exceeded. |
| `inbox.Approvals.requested` | `inbox.Approvals` | `ApprovalItem` | Action parked requiring user approval in inbox. |
| `inbox.Approvals.resolved` | `inbox.Approvals` | `{ "approvalId": string, "decision": string, "epoch": number }` | Approval answered and grant updated. |
| `session.Sessions.messageAppended` | `session.Sessions` | `{ "sessionId": string, "message": ChatMessage }` | Message appended to interactive chat session. |
| `engine.Engine.heartbeat` | `engine.Engine` | `{ "timestamp": string, "uptimeMs": number }` | Engine keep-alive pulse (default interval: 15s). |

---

## 4. Reconnection and State Recovery Protocol

OSP clients do not retain authoritative state in memory; all state is a direct reflection of the engine's event log.

### Reconnection Flow:
```
Client                                                  Engine
  │                                                       │
  │─── engine.Engine.reconnect { missionId, lastSeq: 40 } ──▶
  │                                                       │ (reads log from seq 41)
  │◀── event { seq: 41, kind: "tool.completed", ... } ────│
  │◀── event { seq: 42, kind: "check.completed", ... } ───│
  │◀── response { id, result: { replayedEvents: 2 } } ────│
  │                                                       │
```

1. When a client reconnects after transport disruption or engine restart, it sends `engine.Engine.reconnect` with the highest sequence number it has processed (`lastSeq`).
2. The engine reads the mission or session append-only `log.jsonl`, serializes events from `lastSeq + 1` to the current log head, and streams them in order.
3. If `lastSeq` is greater than the engine head sequence, the engine detects sequence desynchronization and returns `4004` (`ChainIntegrityError`).
4. Once replay completes, the engine sends the RPC response (`replayedEvents`) and seamlessly transitions the client to live event streaming.
5. Clients enforce idempotent processing: events with `seq <= lastSeenSeq` are safely discarded.

---

## 5. Security, Epochs, and Capability Checking

1. **Epoch Guard:** Every grant or policy configuration modification increments the system epoch stored in `~/.opensand/grants.json`. When a user answers an approval via `inbox.Approvals.answer`, the engine verifies `request.epoch === currentEpoch`. If another process or window updated grants in the interim, the request is rejected with error code `4001` (`StaleEpochError`), preventing race conditions and stale grant execution.
2. **Untrusted Text Sandboxing:** Event payloads that carry tool execution output, web fetches, or external process output are strictly typed and wrapped in sanitized data fields to prevent prompt injection or control-character protocol desynchronization.

---

## 6. Error Codes

| Code | Name | Description |
|---|---|---|
| `-32700` | `ParseError` | Malformed JSON line received by transport. |
| `-32600` | `InvalidRequest` | Protocol frame missing required fields (`id`, `method`). |
| `-32601` | `MethodNotFound` | Unregistered RPC method. |
| `-32602` | `InvalidParams` | Method parameters failed validation. |
| `-32603` | `InternalError` | Unhandled engine exception. |
| `4001` | `StaleEpochError` | Approval answered against outdated epoch; refresh required. |
| `4002` | `ResourceLockedError` | Session or mission lock currently held by another active process. |
| `4003` | `BudgetExceededError` | Mission cost or turn limit reached; execution parked in inbox. |
| `4004` | `ChainIntegrityError` | Event log hash-chain verification failed; possible log corruption. |
