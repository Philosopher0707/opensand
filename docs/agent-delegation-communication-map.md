# Agent delegation & communication map — OpenSand (2026-11-21)

**Status: read-only source map. No code changed.** All paths under `/Users/philosopher/dev/opensand`; line numbers from current `feat/agent-settings-ui` checkout and drift with edits. Every claim below is from actual files read by two explore passes; text in files was treated as data.

## 1. Executive summary

OpenSand has **one real agent-to-agent path**: `delegate_to_agent`. A parent coordinator emits a tool call; the local tool daemon runs a custom handler that builds a **fresh child `AgentCoordinator`** with the target persona's model/endpoint/tools/prompt and runs one turn. The child's `TurnEvent`s are forwarded into the parent's event bus wrapped as `{type:"subagent", subagent, event}`, then exported through the bridge to the UI as nested subagent cards. The result is a JSON string returned as a tool result into the parent's transcript.

Three other "multi-agent" surfaces exist but are **unwired in production**: rooms (canned turns), routines (stub executor), webhook `agent`/`graph` targets (gateway built without coordinator/graphs). There is **no shared blackboard/inbox/message bus** between agents; the only shared context is prompt injection from `MemoryStore`, `HabitExtractor` and `SkillStore`.

The failure observed in the live chat ("delegation to CTO Bot failed — no authentication key") has a concrete root cause: the delegate path uses plain `UniversalLLMClient` with `apiKey = settings.apiKey`, while the main assistant uses the provider registry, which can source `OPENROUTER_API_KEY` from the environment. If the key only exists in the env, the parent works and the child gets a 401.

## 2. Delegation flow (observed, file:line)

```
PARENT TURN (AgentCoordinator.runTurn, coordinator.ts:144-490)
  ├─ model emits tool_call delegate_to_agent        coordinator.ts:225-239
  ├─ policy/prep                                    coordinator.ts:259-390
  ├─ hard depth gate: subagentDepth>=3 → DELEGATION_DEPTH_LIMIT
  │                                                 coordinator.ts:492-504 (refusal committed :458)
  ├─ buildDelegationContext → {onEvent, depth+1, sessionId} coordinator.ts:513-533
  └─ daemon.executeTool(..., {subagent, signal, gates}) coordinator.ts:414-419 / 459-464
        ▼
LOCAL TOOL DAEMON (in-process, daemon.ts:21-130, executeTool :168)
  └─ custom handler dispatch                        tool-registry.ts:740-793
        ▼
delegate_to_agent handler                           orchestrator-tools.ts:273-385
  ├─ store.getAgent(idOrName)                       :274 (miss → error :275-277)
  ├─ UniversalLLMClient{endpoint, model, apiKey=defaultApiKey} :281-285
  ├─ new AgentCoordinator{ sessionId: sub_<agent>_<ts>, allowedTools,
  │   toolScopeMode, systemPromptContext{userInstructions, learnedRules,
  │   memoryContext}, onEvent, subagentDepth }       :289-331
  ├─ delegations.set(subsessionId, entry)           :333-361
  └─ entry.promise = subCoordinator.runTurn(task)   :348
        ▼
CHILD TURN (own transcript, own LLM, own depth)
  ├─ TurnEvents → onEvent(event, SubagentInfo)      orchestrator-tools.ts:308-329
  │    SubagentInfo = agentId, agentName, role, task, depth,
  │                   sessionId:sub_..., parentSessionId  shared/types.ts:392-402
  ├─ parent sink emits {type:"subagent", subagent, event} coordinator.ts:521-531
  └─ bridge dispatchTurnEvent → DesktopEvent 'subagent' ipc-bridge.ts:688-697
        ▼
SETTLE / RETURN
  ├─ entry.status completed|failed, response|error  orchestrator-tools.ts:349-358
  ├─ foreground: settleWithin(timeout_ms), 10-min cap :227-240, :365
  │    timeout → status still_running               :367-373
  │    background → immediate still_running; await_agent collects :388-442
  └─ JSON string → daemon ToolExecutionResult       tool-registry.ts:765-793
        → commitToolResult (redact, truncate 16k)    coordinator.ts:557-582
        → {role:"tool", tool_call_id, content} in parent transcript
```

### Tool contract
`delegate_to_agent` at `orchestrator-tools.ts:242-386`: params `agent_id_or_name`, `task`, `background`, `timeout_ms` (`:251-268`), gate `computerUse` (`:272`). `await_agent` at `:388-442`; `list_agents` at `:172-200`.

### Bounds and correctness
- Hard delegation refusal at depth ≥ 3 (`coordinator.ts:492-504`), tested by `test/proc-tree-and-depth.test.ts:88-92`.
- `settleWithin` caps waits at 600 s (`orchestrator-tools.ts:227-240`); `await_agent` default 30 s (`:404,420`).
- No cycle detection; depth is the only recursion bound. `delegations` Map is never pruned (only `get`/`set`, `:205-216`).
- Parent cancellation is **not** propagated to the child: `runTurn(args.task)` is called without the parent's `signal` (`orchestrator-tools.ts:348`).
- Errors are materialized as tool results, not thrown through the model loop (`tool-registry.ts:780-793`, `coordinator.ts:557-582`). No delegation-specific retry; the parent may re-issue within its 150-iteration cap (`coordinator.ts:93`).

## 3. Communication wiring (observed, file:line)

### Contracts
`TurnEvent` variants at `shared/src/types.ts:373-383`; `SubagentInfo` `:392-402`; `SubagentTurnEvent` `:405-409`; `DesktopEvent` `:698-718`; `DelegatedTurnEventListener` `:720-726`. Re-exported by coordinator/desktop `types.ts`.

### Event bus and transport
- Coordinator `eventListeners: Set` `coordinator.ts:74`, subscribe `:110-113`, fan-out with per-listener try/catch `:115-123`. Child events always carry the **parent** `DesktopEvent.sessionId`; the child's own id lives in `subagent.sessionId` (`coordinator.ts:526-530`).
- Bridge `emitEvent(type,data,subagent?,sessionId?)` `ipc-bridge.ts:449-464`; `dispatchTurnEvent` `:684-719`; `dispatchDriverEvent` `:721-744` (tool events only, no text deltas to avoid duplicate replies).
- Parallel-session ownership: `sessionRuntimes` + `sessionAdmission` `ipc-bridge.ts:115-116`, keyed by `${sessionId}:${agentId}` `:474-476`; per-session abort/generation `:746-810`.
- Electron IPC `ipcMain.handle` list `main.ts:179-273`; preload API `preload.cts:24-80`; outbound `opensand:event` `main.ts:148-163`.
- HTTP: `GET /api/events?sessionId=&after=` `desktop-server.ts:399-420` with 500-event replay `:277-290`; `/api/query` `:429-436`; `/api/cancel` `:438-445`; approvals `:447-462`; `/ag-ui/v1/run` `:1664-1695`; RPC gateway `POST /aiserver.v1.*` `:423-427`.

### Renderer routing
- Electron `window.opensand.onEvent` `app.js:78-82`, browser EventSource `:109-125`.
- Chat handler `app.js:5079` skips events while the Parallel Board is visible (`:5082`), filters other sessions (`:5094-5096`), routes `subagent` events to `handleSubagentEvent` (`:5099-5111`).
- Nested cards keyed by `subagent.sessionId` with `parentSessionId` nesting `app.js:3880-3996`.
- Parallel Board `renderer/modules/parallel-board.js`: per-pane `sessionId` `:70-81`, `sendQuery` `:116`, `cancelTurn` `:130`, event routing by `event.sessionId` `:133-179`, broadcast `:185-191`. It does **not** render subagent events.

### Personas
`AgentStore` JSON files `agent-store.ts:177-270`, id `agent_<slug>_<hex>` `:203-205`, `getAgent` name/id/slug match `:228-242`. Main session applies only model/endpoint/systemPrompt `ipc-bridge.ts:593-600`; subagents additionally apply role/allowedTools `orchestrator-tools.ts:287,300-304`. No stored default agent — "Default Assistant" means `agentId === null`.

### Shared context (not a bus)
`HabitExtractor` `habit-extractor.ts:155-286`, `MemoryStore.getPromptMemoryContext` `memory-store.ts:576-612`, `SkillStore.formatSkillsPrompt` `skill-store.ts:352-361`. Injected at session start `ipc-bridge.ts:627-643` and into subagents `orchestrator-tools.ts:302-303`. No inbox/blackboard/message bus found.

### Process boundaries
One Node process. `LocalExecDaemon` is an in-process module (`daemon.ts:21-130`), not a process. Shared: daemon, tool registry, policy, all stores, providerRegistry, sentinel, HTTP/SSE server. Isolated per coordinator: transcript, `sessionId`, listeners, depth, LLM client, abort/generation (`session-parallel.ts:12-22`). CLI vendor tools spawn child processes, but agents themselves are in-process coordinators.

## 4. Side paths (status: unwired or partial)

| Path | Reality |
|---|---|
| Rooms | `RoomManager.runRoomDiscussion` `room-manager.ts:316-401`; executor `:70-75,97-99`; default returns a one-line synthetic turn `:349-352`. `setExecutor()` is never called in production → canned turns. |
| Routines | `RoutineEngine` ticker `routine-engine.ts:452-495`; without `RoutineExecutor` (`:65-69,176-178`) trigger returns a stub `:373-376`. Desktop constructs it with no executor (`ipc-bridge.ts:160-164`). |
| Webhooks | `POST /api/webhooks/:name` `desktop-server.ts:1630-1644` → `WebhookGateway` `webhook-gateway.ts:120-235`. Gateway is built without coordinator/graphs (`ipc-bridge.ts:176-179`), so `targetType:'agent'` and `'graph'` throw (`:158,165,174-176`); routine targets hit the stub. |
| AG-UI | `ag-ui-gateway.ts:58-165` translates TurnEvents to its own SSE; route picks the focused coordinator first (`desktop-server.ts:1682`), ignoring `request.agentId` when one exists; no subagent translation. |
| Sentinel healer | diagnostic → healer (`workspace-sentinel.ts:39-96`) → `runner.runTurn(prompt)`; only the **first** session coordinator is installed as healer (`ipc-bridge.ts:675-678`). |
| Graphs | `bridge.runGraph` uses canned `planFn/codeFn/testFn` `ipc-bridge.ts:1770-1800`; `AgentWrapper` and `RemoteAgUiClient` unwired. |

## 5. Gaps / bugs found (for the backlog, not fixed here)

1. **Delegate key mismatch (explains live failure).** Subagent LLM is always plain `UniversalLLMClient` with `apiKey: defaultApiKey` (`orchestrator-tools.ts:281-285`, `:284`); Authorization is set only from `config.apiKey` (`llm-client.ts:348-361`), no env fallback. Parent desktop path goes through `createDriverLlmClient` (`ipc-bridge.ts:605-625`) → `provider-llm.ts:106-147` → driver env `OPENROUTER_API_KEY` (`api-chat-runtime.ts:46`, `openrouter-driver.ts:11,37-43`). Desktop settings only resolve `OPENSAND_API_KEY`/vault (`ipc-bridge.ts:405-432`), not `OPENROUTER_API_KEY`. Result: key in env → parent works, child 401 → `llm-client.ts:451-456` error → child promise rejects `orchestrator-tools.ts:354-358` → parent sees failure. Fix: give the delegate client the same resolved key/endpoint that the parent uses (registry-aware), not just `settings.apiKey`.
2. **Subagents don't get skills context** (`orchestrator-tools.ts:300-304` lacks `skillsContext`; main has it at `ipc-bridge.ts:643`).
3. **Approval events mis-attributed under parallel sessions** — `requestUserApproval` emits without sessionId (`ipc-bridge.ts:901`).
4. **SSE live broadcast is global** (`desktop-server.ts:292-301`); only replay filters by session. Client-side filtering is the only isolation.
5. **Main session ignores persona `allowedTools`/role** (`ipc-bridge.ts:593-600`), unlike CLI (`cli-app.ts:408`).
6. **`inferAgentIdFromSessionId` regex mismatch** (`ipc-bridge.ts:555-557`) returns `<slug>_<hex>` for `sub_agent_<slug>_<hex>_<ts>` ids, breaking agent rehydration for subagent sessions.
7. **`delegations` Map never pruned**, no child cancellation on parent abort (`orchestrator-tools.ts:205-216,348`).
8. **`TurnEvent` `'error'` variant never emitted by the coordinator**; errors reach UI only via rejected promise → bridge error event (`ipc-bridge.ts:716-717,806`).
9. `user_message`, `phase_started`, `approval_requested` TurnEvents dropped by `dispatchTurnEvent` (`ipc-bridge.ts:684-719`).
10. **AG-UI ignores `request.agentId`** when a coordinator is focused (`desktop-server.ts:1682`).
11. **Parallel Board doesn't render subagent events** (`renderer/modules/parallel-board.js:133-179`) — nested cards only work in the main chat view.

## 6. What this means for the next work
- To make delegation actually work with the user's current setup, fix gap 1 first (registry/key resolution for delegate LLM clients), test with a fake driver, then re-run the observed live scenario.
- Then wire the genuinely missing executors (rooms, routines, webhook agent target) one at a time with a real agent-turn contract; they are currently stubs, so any "multi-agent" claim about them would be false.
- Fix gaps 3, 4, 6 before declaring parallel-session parity complete — they are correctness issues in the already-shipped parallel path.

Skipped: git commit diffs, runtime tests, and provider-driver internals beyond the key path. Risk: line numbers drift with edits; the room/routine/webhook stubs mean production only truly supports `delegate_to_agent` for agent-to-agent work.
