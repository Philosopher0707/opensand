# OpenSand

**OpenSand** is a high-performance, clean-room, open-source desktop and CLI coding agent derived from byte-level reverse engineering of the Grok Bot desktop application (`com.anysphere.sand`, v0.78.1).

It replaces proprietary cloud ConnectRPC backends with universal OpenAI-compatible streaming function calling (`/v1/chat/completions`) and Anthropic (`/v1/messages`), allowing seamless operation with local models (Ollama, vLLM, LM Studio) or cloud endpoints (OpenAI, DeepSeek, OpenRouter, Anthropic proxies).

---

## Architecture Overview

```
                               ┌──────────────────────────────────────────────┐
                               │                 OpenSand UI                  │
                               │          CLI REPL / Desktop Shell            │
                               └──────────────────────┬───────────────────────┘
                                                      │
                                                      ▼
 ┌────────────────────────┐      Streaming Turn Loop  │
 │ OpenAI-Compatible LLM  │ ◄─────────────────────────┤
 │ (Ollama/DeepSeek/etc.) │ ─── SSE (tokens/tools) ──►│
 └────────────────────────┘                           ▼
                                           @opensand/coordinator
                                     (State Machine & Transcript Log)
                                     (Agent Store & Orchestrator Meta-Tools)
                                     (Task Store & Habit Extractor)
                                                      │
                                                      │ Tool Dispatch & Approvals
                                                      ▼
                                        @opensand/local-exec-daemon
                                    (State Machine, Preflight & Runner)
                                         │                      │
                    ┌────────────────────┴─────────┐            │
                    ▼                              ▼            ▼
              Core Tools:                    Native Bridge:     Gate Policies:
            - exec_command                 - sand-vision      - computer-use-gate
            - read_file                    - sand-window-cap  - device-tools-gate
            - write_file (atomic)          - op-launcher      - standing-allowlist
            - list_directory               - messages-reader
            - create_agent                 - speech-bridge
            - list_agents
            - delegate_to_agent
            - create_agent_task
            - list_agent_tasks
            - extract_user_habits
```

---

## Monorepo Packages

| Package | Description | Tests |
|---|---|---|
| [`@opensand/local-exec-daemon`](./packages/local-exec-daemon) | Local execution engine with preflight bash syntax & safety validation, atomic file I/O with SHA-256 digests, and crash-resilient JSON state files. | 29 passing |
| [`@opensand/coordinator`](./packages/coordinator) | Multi-turn streaming agent loop, universal SSE parser, OpenAI `/v1/chat/completions` + Anthropic `/v1/messages` client, native MCP client, persistent Agent Store, Task Store, Habit Extractor, and Grok Bot transcript parity. | 30 passing |
| [`@opensand/native-bridge`](./packages/native-bridge) | Native Apple Vision offline OCR (`sand-vision`), ScreenCaptureKit window capture (`sand-window-capture`), 1Password Seatbelt launcher, macOS Messages reader, and Speech Synthesis. | 6 passing |
| [`@opensand/cli`](./packages/cli) | Interactive terminal REPL and one-shot execution CLI with live token streaming, bot persona switcher (`--bot`), and permission approval prompts. | 7 passing |
| [`@opensand/desktop`](./packages/desktop) | Desktop GUI shell with macOS menubar tray, multi-bot switcher, live streaming chat, task management, learned guidelines modal, and local webview server. | 5 passing |

**Total Test Coverage: 77/77 automated unit and integration tests passing (100% green).**

---

## Security & Resilience Hardening (Backend Audit)

OpenSand was audited against the Backend Playbook (7 batches: Security, Storage, Resilience, Caching/Messaging, Networking/APIs, Reliability/Observability, Build/Deploy) with 14 hardening fixes:

- **DNS Rebinding & Host Validation**: Desktop server strictly verifies `Host` header (`127.0.0.1`, `localhost`) to prevent rebinding attacks.
- **Strict Origin Check**: Replaced wildcard CORS with strict validation rejecting any external origin with `403 Forbidden`.
- **Path Traversal Guards**: Strict regex (`/^[a-zA-Z0-9_-]+$/`) and `path.resolve` boundary verification across session and task filesystem loaders.
- **Anti-Chaining Tool Allowlist**: Auto-approvals strictly reject shell chaining operators (`;`, `&&`, `|`, `` ` ``, `$()`) to prevent command piggybacking.
- **Generic Binary Restriction**: Prevents blanket allowlisting of generic interpreters (`node`, `python`, `bash`, `cat`, `curl`); requires exact command matching.
- **DoS Body Bounds & Read Caps**: Desktop HTTP requests bounded to 2MB ceiling with stream destruction and 413 rejection; `read_file` bounded to 25MB safety ceiling.
- **HTTP & Subprocess Watchdogs**: LLM API calls enforce configurable 120s timeouts with `AbortSignal.any()`; native Swift/macOS bridges bounded by 15-20s SIGKILL watchdogs.
- **HTML Sanitization & CSP**: Desktop UI renders user-controlled bot and task metadata via `escapeHtml()`; server enforces strict CSP (`default-src 'self'`).
- **Child Process Env Sanitization**: Subprocesses spawned by `exec_command` purge sensitive host API tokens (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GITHUB_PERSONAL_ACCESS_TOKEN`, `AWS_SECRET_ACCESS_KEY`) from environment inheritance.
- **Atomic File Operations**: Habit rules and state files use atomic `.tmp` + rename pattern with 0600 file modes.

---

## Autonomous Multi-Agent Orchestration

OpenSand implements Grok Bot's dynamic agent orchestration model (`CreateGrokBotAgent`, `ListGrokBotAgents`, `OpenAgentTail`) as first-class meta-tools:

- **`create_agent`**: Autonomous agents can dynamically construct, configure, and persist specialized subagent personas with unique system prompts and model overrides into `~/.opensand/agents/`.
- **`list_agents`**: Query all available registered bot personas.
- **`delegate_to_agent`**: Delegate complex tasks to subagents. Spawns an isolated turn loop with that subagent's prompt, records distinct transcripts, and returns the result to the caller agent.
- **`create_agent_task` / `list_agent_tasks` / `update_agent_task`**: Manage actionable work items and todos (`ListGrokBotAgentTasks` parity).
- **`extract_user_habits`**: Continuous learning engine matching Grok Bot contract 8.1.B that analyzes past conversation transcripts (`~/.opensand/sessions/*.txt`), detects repeated user corrections and preferences, and maintains `~/.opensand/learned_rules.md`.

---

## Model Context Protocol (MCP) Integration

OpenSand includes a zero-dependency JSON-RPC 2.0 client that connects to standard community MCP servers over `stdio`. Configure external servers in `~/.opensand/mcp.json`:

```json
{
  "mcpServers": {
    "sqlite": {
      "command": "uvx",
      "args": ["mcp-server-sqlite", "--db-path", "./data.db"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..."
      }
    }
  }
}
```

Discovered MCP tools are dynamically exposed to the model as `${serverName}__${toolName}` and pass through OpenSand's dual-authorization security gates.

---

## Native macOS System Capabilities

OpenSand includes native macOS bridges providing deep system integration without third-party cloud APIs:

- **Apple Vision Offline OCR (`sand-vision`)**: Uses Apple's Neural Engine (`Vision.framework`) for offline text extraction with bounding boxes and confidence scores (`recognize_screen_text`).
- **ScreenCaptureKit Window Capture (`sand-window-capture`)**: Discovers running application windows and captures individual window frames to disk (`list_windows`, `capture_window`).
- **macOS Messages Reader (`messages-reader`)**: Read-only SQLite inspector for local iMessage database (`messages_get_recent`, `messages_search`).
- **Native Speech Synthesis (`speech-bridge`)**: Speaks text aloud using macOS Apple Speech (`speak_text`).
- **Seatbelt 1Password Launcher (`op-launcher`)**: Runs 1Password CLI within a macOS Seatbelt sandbox profile denying raw database access while supporting biometric unlock (`op_exec`).

---

## Configuration Resolution Hierarchy

When launching OpenSand, endpoints and API keys are automatically resolved through a fail-safe hierarchy:

1. **CLI Flags**: `--endpoint <url>`, `--model <name>`, `--api-key <key>`, `--bot <id>`
2. **Environment Variables**: `$OPENSAND_ENDPOINT`, `$OPENSAND_MODEL`, `$OPENSAND_API_KEY`, `$OPENAI_API_KEY`
3. **Persistent Config**: `~/.opensand/config.json` (saved via Desktop UI or CLI settings)
4. **Local Ollama Auto-Detect**: If no cloud key is provided, OpenSand checks `http://127.0.0.1:11434/v1`. If available, it connects automatically with zero configuration.
5. **Cloud Default**: `https://api.openai.com/v1` (reports actionable setup instructions if no API key is set).

---

## CLI & Global REPL Usage

OpenSand installs standalone executables on your system PATH (`~/bin/opensand` and `~/bin/opensand-cto`):

### Interactive REPL
```bash
# Launch default agent REPL
opensand

# Launch directly into the CTO Bot persona
opensand-cto

# Launch with explicit local endpoint
opensand --endpoint http://127.0.0.1:11434/v1 --model qwen3:8b
```

### REPL Slash Commands
Inside the interactive prompt (`opensand> `), use built-in slash commands:
- `/help` - Show available REPL slash commands
- `/tools` - Inspect all registered Core, Native, and MCP tools
- `/bots` - List registered subagents and active persona
- `/bot <name>` - Switch active bot persona on the fly (e.g. `/bot cto`)
- `/tasks` - Display registered agent tasks and status
- `/rules` - View learned user habits and behavior rules
- `/clear` - Clear terminal screen
- `exit` or `Ctrl+C` - Cleanly exit the session

### One-Shot Execution
```bash
# Execute prompt with automatic tool approval
opensand -y "List all open windows on this machine"

# Delegate to CTO persona
opensand --bot cto -y "Review repo architecture and outline our technical debt"
```

---

## Quick Start

### 1. Build and Test
```bash
pnpm install
pnpm build
pnpm test
```

### 2. Package Standalone Binaries
```bash
./scripts/package-cli.sh
# Creates ~/bin/opensand, ~/bin/opensand-cto, and dist/bundle/OpenSand.app
```

### 3. Launch Desktop GUI
```bash
# Start background web desktop server
node packages/desktop/dist/src/desktop-server.js
# Access at http://127.0.0.1:3456 in your browser
```
