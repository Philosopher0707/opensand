# CONTEXT.md: Grok Bot Reverse-Engineering & OpenSand Clean-Room Implementation

**Date:** 2026-10-31  
**Project:** OpenSand (`~/dev/opensand`)  
**Target Reverse-Engineered:** Grok Bot macOS Desktop App (`/Applications/Grok Bot.app`, Bundle ID: `com.anysphere.sand`, Version: 0.78.1)  
**Status:** Phases 1–4 Fully Implemented & Tested (44/44 unit & integration tests passing)

---

## 1. Executive Summary & Goals

The user requested a complete byte-level reverse engineering of the Grok Bot desktop application, uncovering all wire protocols, IPC topologies, Protobuf schemas, ConnectRPC endpoints, and local execution state machines. 

The ultimate goal was to design and build a clean-room, local-first universal coding agent (**OpenSand**) in `~/dev/opensand` that:
1. Replaces proprietary xAI/Anysphere cloud infrastructure (`api2.cursor.sh` ConnectRPC) with standard OpenAI-compatible streaming function calling (`/v1/chat/completions`).
2. Retains full functional parity with Grok Bot's local execution safety, preflight bash validation, atomic file operations, dual-mode authorization gates, and on-disk transcript formats.
3. Incorporates native macOS system capabilities (offline Apple Vision OCR via Neural Engine, ScreenCaptureKit window frame capture, Seatbelt-sandboxed 1Password CLI runner).
4. Provides both an interactive terminal REPL and one-shot CLI runner supporting local models (Ollama, vLLM, LM Studio) and cloud endpoints (OpenAI, DeepSeek, OpenRouter, Anthropic proxies).

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
* **Tests**: 27 unit tests (`test/*.test.ts`) covering all modules with 100% pass rate.

### 3.2 [`packages/coordinator`](file:///Users/philosopher/dev/opensand/packages/coordinator) (Phase 2)
* **`sse-parser.ts`**: Stream parser converting raw `Uint8Array` chunks into parsed SSE events, handling fragmented TCP packets, CRLF/LF line splits, and keep-alive comments.
* **`llm-client.ts`**: Universal streaming LLM client for any OpenAI-compatible `/v1/chat/completions` endpoint. Accumulates streaming tool-call delta chunks across multi-token arguments.
* **`transcript-manager.ts`**: Manages `~/.opensand/sessions/<sessionId>/`. Appends structured JSONL events to `transcript.jsonl` and formats human-readable `transcript.txt` with `<user_query>` Grok Bot parity tags.
* **`system-prompt.ts`**: Dynamically builds agent instructions including date, host OS, architecture, working directory, and user rules.
* **`coordinator.ts`**: Autonomous multi-turn turn loop. Dispatches queries to LLM, streams tokens to UI, intercepts tool calls, verifies gates/prompts user approval, delegates execution to daemon, appends results, and loops back to LLM until completion.
* **Tests**: 9 unit and integration tests (`test/*.test.ts`) covering SSE, prompt generation, transcripts, and autonomous tool loops.

### 3.3 [`packages/native-bridge`](file:///Users/philosopher/dev/opensand/packages/native-bridge) (Phase 3)
* **`native/sand-vision.swift`**: Swift 6.2 source utilizing Apple `Vision.framework` (`VNRecognizeTextRequest`). Compiled to standalone ARM64 Mach-O binary `bin/sand-vision`. Extracts text, confidence scores, and bounding boxes completely offline via Apple Neural Engine.
* **`native/sand-window-capture.swift`**: Swift source utilizing CoreGraphics / ScreenCaptureKit. Compiled to standalone ARM64 Mach-O binary `bin/sand-window-capture`. Lists open on-screen windows (`--list`) and captures individual window frames (`--window <id> --out <path>`).
* **`op-launcher.ts`**: 1Password hardened runner. Generates and executes macOS Seatbelt sandbox profiles (`sandbox-exec -p ...`) that deny access to raw credential databases while enabling biometric CLI unlock.
* **`native-tools.ts`**: Registers `recognize_screen_text`, `list_windows`, `capture_window`, and `op_exec` into the daemon tool registry under `deviceTools` and `computerUse` permission gates.
* **Tests**: 5 unit tests (`test/*.test.ts`) covering OCR, window listing, and Seatbelt policy generation.

### 3.4 [`packages/cli`](file:///Users/philosopher/dev/opensand/packages/cli) (Phase 4)
* **`config.ts`**: CLI argument parser (`--endpoint`, `--model`, `--api-key`, `--auto-approve` / `-y`, `--system-prompt`).
* **`terminal-ui.ts`**: ANSI styling engine with live streaming text, tool execution cards (`⚡ [Tool]`, `✔ [Result]`), and interactive readline approval prompts (`[y/N]`).
* **`cli-app.ts`**: Main entrypoint supporting both one-shot commands (`opensand "query"`) and interactive REPL sessions (`opensand`).
* **`bin.ts`**: Executable binary (`dist/src/bin.js`).
* **Tests**: 3 unit tests (`test/*.test.ts`) covering flag parsing and configuration.

### 3.5 [`packages/desktop`](file:///Users/philosopher/dev/opensand/packages/desktop) (Phase 5)
* **`main.ts` & `tray.ts`**: Electron Main process lifecycle, menubar tray icon (`OpenSand: Ready/Thinking/Executing`), global hotkey (`Cmd+Shift+Space`), and secure IPC message router.
* **`preload.ts`**: Hardened context bridge (`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`) exposing `window.opensand`.
* **`desktop-server.ts`**: Zero-dependency local HTTP/SSE UI server enabling the desktop app to run in browser windows or lightweight webviews without requiring Electron.
* **`renderer/`**: Interactive dark mode chat UI with streaming Markdown, live tool execution status cards, interactive permission approval modals ("Approve Once", "Always Allow", "Reject"), and model settings panel.
* **Tests**: 5 unit tests (`test/*.test.ts`) covering IPC bridge, standing allowlist additions, and REST endpoints.

---

## 4. Verification & Health Summary

* **Monorepo Build**: `pnpm build` (`tsc -b` across all 5 packages) $\rightarrow$ 0 errors.
* **Test Suite**: `pnpm test` (`node --test` across all 5 packages) $\rightarrow$ **56 passed, 0 failed, 100% green**:
  * `@opensand/local-exec-daemon`: 27 passed
  * `@opensand/coordinator`: 16 passed (including Anthropic `/v1/messages`, extended thinking & native MCP client/manager)
  * `@opensand/native-bridge`: 5 passed
  * `@opensand/cli`: 3 passed
  * `@opensand/desktop`: 5 passed
* **Packaging**:
  * `dist/bin/opensand`: Standalone executable CLI binary.
  * `dist/bundle/OpenSand.app`: macOS Application bundle with embedded Mach-O binaries (`sand-vision`, `sand-window-capture`), `Info.plist`, and launcher script.
* **Git Repository**: Clean git working tree on `main` branch.

---

## 5. Artifacts & Reference Paths

* **Architecture Specification**: [`DESIGN.md`](file:///Users/philosopher/DESIGN.md)
* **Exhaustive Contracts**: [`grok_bot_clean_room_complete_contracts.md`](file:///Users/philosopher/.gemini/antigravity-cli/brain/cd7866de-1de3-4c4b-a336-de8db1f0fc83/grok_bot_clean_room_complete_contracts.md)
* **ConnectRPC Catalog**: [`all_rpc_functions_catalog.md`](file:///Users/philosopher/.gemini/antigravity-cli/brain/cd7866de-1de3-4c4b-a336-de8db1f0fc83/all_rpc_functions_catalog.md) & [`all_rpc_functions.json`](file:///Users/philosopher/.gemini/antigravity-cli/brain/cd7866de-1de3-4c4b-a336-de8db1f0fc83/all_rpc_functions.json)
* **OpenSand Source Code**: [`/Users/philosopher/dev/opensand`](file:///Users/philosopher/dev/opensand)
