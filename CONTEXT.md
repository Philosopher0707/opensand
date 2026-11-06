# CONTEXT.md: Grok Bot Reverse-Engineering & OpenSand Clean-Room Implementation

**Date:** 2026-11-01  
**Project:** OpenSand (`~/dev/opensand`)  
**Target Reverse-Engineered:** Grok Bot macOS Desktop App (`/Applications/Grok Bot.app`, Bundle ID: `com.anysphere.sand`, Version: 0.78.1)  
**Status:** Phases 1–12 Fully Implemented & Hardened (122/122 unit & integration tests passing, 100% green, 61 active registered tools)

---

## 1. Executive Summary & Goals

The user requested a complete byte-level reverse engineering of the Grok Bot desktop application, uncovering all wire protocols, IPC topologies, Protobuf schemas, ConnectRPC endpoints, and local execution state machines. 

The ultimate goal was to design and build a clean-room, local-first universal coding agent (**OpenSand**) in `~/dev/opensand` that:
1. Replaces proprietary xAI/Anysphere cloud infrastructure (`api2.cursor.sh` ConnectRPC) with standard OpenAI-compatible streaming function calling (`/v1/chat/completions`) and Anthropic (`/v1/messages`).
2. Retains full functional parity with Grok Bot's local execution safety, preflight bash validation, atomic file operations, dual-mode authorization gates, and on-disk transcript formats.
3. Incorporates native macOS system capabilities (offline Apple Vision OCR via Neural Engine, ScreenCaptureKit window frame capture, Seatbelt-sandboxed 1Password CLI runner, read-only macOS Messages inspector, and native Speech synthesis).
4. Delivers autonomous multi-agent orchestration (`create_agent`, `list_agents`, `delegate_to_agent`), task management, continuous habit learning (`extract_user_habits`), and stdio MCP server support.
5. Provides both an interactive terminal REPL and one-shot CLI runner supporting local models (Ollama, vLLM, LM Studio) and cloud endpoints (OpenAI, DeepSeek, OpenRouter, Anthropic proxies), plus a web/desktop shell.

---

## 2. Reverse-Engineering Discoveries (Grok Bot Anatomy)

### 2.1 Topology & Process Architecture
* **Main Process**: Hardened Electron host (`main-core.cjs` $\rightarrow$ `main-app.cjs`). Fuses enabled: `OnlyLoadAppFromAsar`, `EnableEmbeddedAsarIntegrityValidation`, `RunAsNode` disabled.
* **Agent Coordinator Process**: Spawned via Electron `utilityProcess.fork()` with:
  ```json
  "--bootstrap={\"processConfig\":{\"appVersion\":\"0.78.1\",\"isPackaged\":true,\"dataDir\":\"~/Library/Application Support/Grok Bot\"}}"
  ```
* **IPC Channels**: 3 transferred `MessagePort` channels between Main and UtilityProcess:
  * `controlPort`: Lifecycle, crash telemetry, gate toggles.
  * `dataPort`: Stream chunks, tool requests, output envelopes.
  * `mainDataPort`: Window management, native menu, keychain credentials.

### 2.2 Wire Protocol & RPC Services
* **ConnectRPC Engine**: Communicated with `https://api2.cursor.sh` over HTTP/2 using binary Protobuf framing.
* **RPC Catalog**: 582 distinct RPC methods across 7 services cataloged in:
  * [`all_rpc_functions_catalog.md`](file:///Users/philosopher/.gemini/antigravity-cli/brain/cd7866de-1de3-4c4b-a336-de8db1f0fc83/all_rpc_functions_catalog.md)
  * [`all_rpc_functions.json`](file:///Users/philosopher/.gemini/antigravity-cli/brain/cd7866de-1de3-4c4b-a336-de8db1f0fc83/all_rpc_functions.json)
* **Bidirectional Execution Channel**: Streaming ConnectRPC method `OpenGrokBotUserComputerRequest` with 10 inbound frame kinds (`exec`, `upload`, `download`, `cancel`, `retire_approval`, `messages_op`, `local_tool`, `discover_ai_tool`, `put_file_to_url`, `get_file_from_url`) and 12 outbound frames.

### 2.3 Local Execution State Machine (`~/Library/Application Support/Grok Bot/`)
Atomic JSON files managed the execution daemon lifecycle:
* `local-exec-daemon.json`: PID, start timestamp, inflight task counter, generation counter.
* `local-exec-daemon-connection.json`: IPC bearer token and port.
* `local-exec-supervisor.json`: Watchdog heartbeat timestamps.
* `local-computer-use-gate.json`: Autonomous execution gate toggle (`allowed: boolean`).
* `local-device-tools-gate.json`: Screen capture and OCR gate toggle (`allowed: boolean`).
* `standing-allowlist.json`: Pre-approved command prefix allowlist.

### 2.4 Transcript Format
Located at `{{agentTranscriptsPath}}/*.txt`:
```
<user_query>
user query string
</user_query>

assistant:
assistant text response

[Tool call]
Tool: tool_name
Arguments: {...}

[Tool result]
tool output payload
```

### 2.5 Cognitive Memory System (Grok Bot 7-Layer Architecture)
Decompiled and extracted from `main-app.cjs`, `main-core.cjs`, and ConnectRPC services:
* **Layer 1: Episodic Recall (`VH.recall`)**: Backwards sequence crawling (`beforeSeq`, `nextBeforeSeq`, 256 msgs/chunk, 16-page max depth = 4096 messages) with inter-agent context tailing (`getAgentTranscriptTail`, `hasOverheard`).
* **Layer 2: Discrete Fact Store (`GrokBotMemoryFact`)**: Atomic facts (`fact_id`, `text`, `learned_at_ms`) manipulated via `UpdateMemory(action, scope, tier, text)`. Tiers separate enduring instructions (`profile`) from historical context (`log`).
* **Layer 3: Agent Shards & Folders (`GrokBotAgentDefinitionMemoryShard`)**: Isolated scopes (`user`, `agent`, `team`) with hierarchical subfolders (`profile/`, `logs/`).
* **Layer 4: Continuous Habit & Intent Engine (`user_intent_config`)**: Background pipeline parsing `<user_query>` tags in transcripts. Requires a strict **4-conversation citation threshold** before promoting behavioral habits into rules.
* **Layer 5: Team Consensus Review Queue (`PromoteGrokBotMemoriesToTeam`)**: Writes to team memory require peer/human approval via `GrokBotTeamReviewItem` (`PENDING`, `APPROVED`, `REJECTED`). Approved facts are compiled into natural prose (`GrokBotTeamContextSummary`).
* **Layer 6: Capability Injections & Memory Import (`<imported_memory>`)**: Universal import container with category tags (`Instructions`, `Identity`, `Career`, `Projects`, `Preferences`) and credential scrubbing (`sk-`, `AKIA`, `password=`).
* **Layer 7: Encrypted Client Persistence**: Account-scoped local storage with atomic writes and flush deadlines on exit.

---

## 3. OpenSand Implementation Topology (`~/dev/opensand`)

OpenSand is organized as a pnpm TypeScript monorepo with 4 packages:

### 3.1 [`packages/local-exec-daemon`](file:///Users/philosopher/dev/opensand/packages/local-exec-daemon) (Phase 1)
* **`bash-validator.ts`**: Preflight bash syntax parser. Detects unclosed single quotes, double quotes, backticks, parentheses, braces, brackets, and trailing escape characters. Blocks destructive patterns (`rm -rf /`, raw device rewrites, fork bombs).
* **`file-ops.ts`**: Atomic file operations. `writeFileOperation` writes to a temporary file with `0600` permissions and atomically renames to destination; computes SHA-256 digest. `readFileOperation` supports line range slicing (`start_line`, `end_line`). `listDirectoryOperation` scans files recursively with type and mtime metadata.
* **`state-manager.ts`**: Manages `~/.opensand/state/` JSON files (`local-exec-daemon.json`, `local-exec-supervisor.json`, `local-computer-use-gate.json`, `local-device-tools-gate.json`, `standing-allowlist.json`) using atomic temporary-file renames.
* **`command-runner.ts`**: Spawns bash processes with execution timeouts, SIGTERM $\rightarrow$ SIGKILL termination ladders, and output buffering.
* **`tool-registry.ts`**: Maps tools to OpenAI function schemas (`exec_command`, `read_file`, `write_file`, `list_directory`). Enforces dual-authorization gates (standing allowlist match vs. explicit approval ID).
* **`daemon.ts`**: Coordinates lifecycle, pulses background supervisor heartbeats, and dispatches tool execution.
* **Tests**: 29 unit tests (`test/*.test.ts`) covering all modules with 100% pass rate.

### 3.2 [`packages/coordinator`](file:///Users/philosopher/dev/opensand/packages/coordinator) (Phase 2 & Orchestration)
* **`sse-parser.ts`**: Universal stream parser converting raw `Uint8Array` chunks into parsed SSE events, handling fragmented TCP packets, CRLF/LF line splits, and keep-alive comments.
* **`llm-client.ts`**: Universal streaming LLM client for any OpenAI-compatible `/v1/chat/completions` endpoint. Captures local reasoning tokens (`delta.reasoning_content` / `delta.thought`) and accumulates streaming tool-call deltas across multi-token arguments.
* **`anthropic-client.ts`**: Anthropic `/v1/messages` client supporting Claude 3.7 Sonnet extended thinking (`thinking_delta`) and tool calling.
* **`mcp-client.ts`**: Zero-dependency stdio JSON-RPC 2.0 MCP client and multi-server manager reading `~/.opensand/mcp.json`. Exposes external tools with namespace prefixes (`${serverName}__${toolName}`) under OpenSand security gates.
* **`agent-store.ts`**: Persistent multi-agent store in `~/.opensand/agents/`. Manages subagent definitions with persona names, custom system instructions, model overrides, and `allowedTools` whitelisting.
* **`task-store.ts`**: Actionable agent task store matching Grok Bot contracts (`ListGrokBotAgentTasks`, `CreateGrokBotAgentTask`, `UpdateGrokBotAgentTask`) persisted in `~/.opensand/tasks/`.
* **`habit-extractor.ts`**: Continuous learning engine matching Grok Bot contract 8.1.B. Scans past session transcripts (`~/.opensand/sessions/*.txt`), identifies recurring user feedback/preferences, and updates `~/.opensand/learned_rules.md`.
* **`memory-store.ts`**: Clean-room implementation of Grok Bot 7-layer memory architecture. Manages discrete fact storage (`MemoryFact`), scope isolation (`user`, `agent`, `team`), tier classification (`profile` vs `log`), team consensus queue (`TeamReviewItem`), user-to-team promotion (`promoteMemoriesToTeam`), natural language prose summary generator (`getTeamContextSummary`), and `<imported_memory>` parser with credential redaction.
* **`orchestrator-tools.ts`**: Registers memory meta-tools into `LocalExecDaemon` (`update_memory`, `recall_memories`, `import_memory`, `list_team_review_items`, `resolve_team_review_item`) alongside agent lifecycle and task tools.
* **`vault-store.ts`**: Pure native AES-256-GCM encrypted secrets and credentials vault (`~/.opensand/vault/`) with PBKDF2 (100k rounds) key derivation and hardware-bound salt (`.vault.salt`). Automatically scrubs secrets from all tool outputs and logs.
* **`skill-store.ts`**: Modular recipe skills engine matching Grok Bot contracts. Parses YAML frontmatter `---`, enforces 256KB max size bound (`k = 256e3`) and 250 max skills cap (`MAX_BOT_SKILLS = 250`), with dynamic prompt mounting (`~/.opensand/skills/`).
* **`routine-engine.ts`**: Scheduled background automations engine supporting 5-part cron syntax (`minute hour dom month dow`, ranges, steps `*/n`, lists) and interval frequencies (`every 30m`), executing tasks via autonomous subagents (`~/.opensand/routines/`).
* **`room-manager.ts`**: Multi-agent collaborative rooms (`kind: "ROOM"`) enabling round-table deliberations across teams of specialized bot personas with synthesized consensus drafts (`~/.opensand/rooms/`).
* **`git-manager.ts`**: Autonomous git and PR manager: repository status, diff analysis, isolated git worktree spawning, conventional commit drafting, and autonomous PR review bot scanning diffs for security and quality regressions.
* **`workspace-sentinel.ts`**: Debounced `fs.watch` file monitor, automated test/build health verification, and self-healing diagnostic logging.
* **`transcript-manager.ts`**: Manages `~/.opensand/sessions/<sessionId>/`. Appends structured JSONL events to `transcript.jsonl` and formats human-readable `transcript.txt` with `<user_query>` Grok Bot parity tags.
* **`system-prompt.ts`**: Dynamically builds agent instructions including date, host OS, architecture, working directory, user rules, active profile/team memory facts, and mounted skill recipes.
* **`coordinator.ts`**: Autonomous multi-turn turn loop. Dispatches queries to LLM, streams tokens to UI, intercepts tool calls, verifies gates/prompts user approval, delegates execution to daemon, appends results, and loops back to LLM until completion.
* **Tests**: 61 unit and integration tests (`test/*.test.ts`) covering SSE, prompt generation, transcripts, Anthropic client, MCP manager, agent store, task store, habit extractor, memory store, vault store, skill store, routine engine, room manager, git manager, sentinel, and autonomous tool loops.

### 3.3 [`packages/native-bridge`](file:///Users/philosopher/dev/opensand/packages/native-bridge) (Phase 3 & Browser Automation)
* **`native/sand-vision.swift`**: Swift 6.2 source utilizing Apple `Vision.framework` (`VNRecognizeTextRequest`). Compiled to standalone ARM64 Mach-O binary `bin/sand-vision`. Extracts text, confidence scores, and bounding boxes completely offline via Apple Neural Engine (`recognize_screen_text`).
* **`native/sand-window-capture.swift`**: Swift source utilizing CoreGraphics / ScreenCaptureKit. Compiled to standalone ARM64 Mach-O binary `bin/sand-window-capture`. Lists open on-screen windows (`list_windows`) and captures individual window frames (`capture_window`).
* **`browser-bridge.ts`**: Pure native Node 22 fetch + HTML-to-Markdown parser (`fetch_web_page`), live multi-engine search (`web_search`), and native AppleScript Safari inspector (`safari_inspect_active_tab`).
* **`messages-reader.ts`**: Read-only SQLite inspector for local macOS Messages database (`messages_get_recent`, `messages_search`).
* **`speech-bridge.ts`**: Native macOS speech synthesizer utilizing Apple Speech (`speak_text`).
* **`op-launcher.ts`**: 1Password hardened runner. Generates and executes macOS Seatbelt sandbox profiles (`sandbox-exec -p ...`) that deny access to raw credential databases while enabling biometric CLI unlock (`op_exec`).
* **`native-tools.ts`**: Registers native tools into the daemon tool registry under `deviceTools` and `computerUse` permission gates.
* **Tests**: 11 unit tests (`test/*.test.ts`) covering OCR, window listing, Messages, speech synthesis, Seatbelt policy generation, and browser automation.

### 3.4 [`packages/cli`](file:///Users/philosopher/dev/opensand/packages/cli) (Phase 4 & REPL Commands)
* **`config.ts`**: Multi-tiered CLI argument and configuration resolver (`--endpoint`, `--model`, `--api-key`, `--bot`, `--auto-approve` / `-y`). Loads persistent settings from `~/.opensand/config.json`, env vars, or auto-probes local Ollama.
* **`terminal-ui.ts`**: ANSI styling engine with live streaming text, tool execution cards (`⚡ [Tool]`, `✔ [Result]`), and interactive readline approval prompts (`[y/N]`).
* **`cli-app.ts`**: Main entrypoint supporting both one-shot commands (`opensand "query"`) and interactive REPL sessions (`opensand`) with first-class slash commands (`/help`, `/tools`, `/bots`, `/bot <name>`, `/rooms`, `/room <id> <topic>`, `/routines`, `/routine run <id>`, `/skills`, `/skill <name>`, `/vault`, `/git`, `/review [ref]`, `/tasks`, `/rules`, `/clear`). Handles `SIGINT` / `Ctrl+C` gracefully without unhandled abort crashes.
* **`bin.ts`**: Executable binary wrapper distributed to `dist/src/bin.js` and global `~/bin/opensand`.
* **Tests**: 7 unit tests (`test/*.test.ts`) covering flag parsing, configuration hierarchy, and REPL slash commands.

### 3.5 [`packages/desktop`](file:///Users/philosopher/dev/opensand/packages/desktop) (Phase 5 & Multi-Tab Dashboard)
* **`main.ts` & `tray.ts`**: Electron Main process lifecycle, menubar tray icon (`OpenSand: Ready/Thinking/Executing`), global hotkey (`Cmd+Shift+Space`), and secure IPC message router.
* **`preload.ts`**: Hardened context bridge (`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`) exposing `window.opensand`.
* **`desktop-server.ts`**: Zero-dependency local HTTP/SSE UI server running at `http://127.0.0.1:3456`, serving REST endpoints (`/api/agents`, `/api/tasks`, `/api/learned-rules`, `/api/routines`, `/api/rooms`, `/api/skills`, `/api/vault`, `/api/settings`, `/api/tokens`, `/api/models`), unified Connect/RPC gateways (`/aiserver.v1.*`), AG-UI protocol handlers, and real-time SSE stream (`/api/events`). Enforces token-based session authentication (`server.token` with 0600 permissions), cookie exchange (`POST /api/auth/token-exchange`), and Host/Origin boundary checks. `GET /api/settings` uses `getSanitizedSettingsResolved()`: it resolves the vault `default-api-key` at startup, so the API key shows as `********` immediately after boot; a blank API key on save means "keep the saved key" (both UI `app.js` omits it and `ipc-bridge.ts:updateSettings()` deletes `''` like `'********'`).
* **`renderer/`**: Interactive dark mode chat UI with streaming Markdown, live tool execution status cards, interactive permission approval modals ("Approve Once", "Always Allow", "Reject"), model settings panel, and interactive authentication dialog (`#authModal`) with dynamic token attachment.
* **Tests**: 57 unit tests (`test/*.test.ts`) covering IPC bridge, standing allowlist additions, REST endpoints, unified RPC services, AG-UI gateway, webhook rate limiting, and token authentication.

---

## 4. Verification & Health Summary

* **Monorepo Build**: `pnpm build` (`tsc -b` across all 5 packages) $\rightarrow$ 0 errors.
* **Test Suite**: `pnpm test` (`node --test` across all 5 packages) $\rightarrow$ **173 passed, 0 failed, 100% green**:
  * `@opensand/local-exec-daemon`: 29 passed
  * `@opensand/coordinator`: 67 passed
  * `@opensand/native-bridge`: 11 passed
  * `@opensand/cli`: 9 passed
  * `@opensand/desktop`: 57 passed
* **Active Tool Catalog**: **61 fully registered tools** spanning core bash/file ops, native macOS vision/windows/audio, web browser automation, multi-agent orchestration, cognitive memories, encrypted vault, modular skills, scheduled routines, group rooms, git lifecycle, workspace sentinel, attachment staging, agent templates, and context auto-compaction.
* **Backend Audit & Resilience Hardening**:
  * All 14 audit findings remediated across security, storage, resilience, networking, and deploy vectors.
  * DNS rebinding / host header check, strict origin verification, and HTTP keep-alive timeouts.
  * Anti-chaining tool allowlist and path traversal boundary checks.
  * 2MB HTTP body and 25MB file size safety ceilings.
  * Subprocess and HTTP request abort watchdogs with env credential purging.
* **Live Model Dogfooding**:
  * End-to-end verified on local Ollama `qwen3:8b`:
    - Discovered registered agents via `list_agents`.
    - Autonomously created `CTO Bot` persona (`agent_cto_bot_bc125a5f`) via `create_agent`.
    - Delegated architecture tasks to `CTO Bot` subagent via `delegate_to_agent`, generating isolated transcripts.
    - Successfully queried running macOS applications via `list_windows`.
    - Successfully synthesized native speech aloud via `speak_text`.
* **Packaging & PATH**:
  * `~/bin/opensand`: Standalone executable CLI binary on user PATH.
  * `~/bin/opensand-cto`: Dedicated executable launcher for CTO subagent persona.
  * `dist/bundle/OpenSand.app`: macOS Application bundle with embedded Mach-O binaries (`sand-vision`, `sand-window-capture`), `Info.plist`, and launcher script.
* **Git Repository**: Clean git working tree on `main` branch.

---

## 5. Artifacts & Reference Paths

* **Architecture Specification**: [`DESIGN.md`](file:///Users/philosopher/DESIGN.md)
* **Exhaustive Contracts**: [`grok_bot_clean_room_complete_contracts.md`](file:///Users/philosopher/.gemini/antigravity-cli/brain/cd7866de-1de3-4c4b-a336-de8db1f0fc83/grok_bot_clean_room_complete_contracts.md)
* **ConnectRPC Catalog**: [`all_rpc_functions_catalog.md`](file:///Users/philosopher/.gemini/antigravity-cli/brain/cd7866de-1de3-4c4b-a336-de8db1f0fc83/all_rpc_functions_catalog.md) & [`all_rpc_functions.json`](file:///Users/philosopher/.gemini/antigravity-cli/brain/cd7866de-1de3-4c4b-a336-de8db1f0fc83/all_rpc_functions.json)
* **OpenSand Source Code**: [`/Users/philosopher/dev/opensand`](file:///Users/philosopher/dev/opensand)
