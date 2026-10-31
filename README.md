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
| [`@opensand/local-exec-daemon`](./packages/local-exec-daemon) | Local execution engine with preflight bash syntax & safety validation, atomic file I/O with SHA-256 digests, and crash-resilient JSON state files. | 27 passing |
| [`@opensand/coordinator`](./packages/coordinator) | Multi-turn streaming agent loop, universal SSE parser, OpenAI `/v1/chat/completions` + Anthropic `/v1/messages` client, native MCP client, persistent Agent Store, Task Store, Habit Extractor, and Grok Bot transcript parity. | 25 passing |
| [`@opensand/native-bridge`](./packages/native-bridge) | Native Apple Vision offline OCR (`sand-vision`), ScreenCaptureKit window capture (`sand-window-capture`), 1Password Seatbelt launcher, macOS Messages reader, and Speech Synthesis. | 6 passing |
| [`@opensand/cli`](./packages/cli) | Interactive terminal REPL and one-shot execution CLI with live token streaming, bot persona switcher (`--bot`), and permission approval prompts. | 4 passing |
| [`@opensand/desktop`](./packages/desktop) | Desktop GUI shell with macOS menubar tray, multi-bot switcher, live streaming chat, task management, learned guidelines modal, and local webview server. | 5 passing |

**Total Test Coverage: 67/67 automated unit and integration tests passing (100% green).**

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

## Quick Start

### 1. Build and Test
```bash
pnpm install
pnpm build
pnpm test
```

### 2. Run with Local Ollama (e.g. Qwen 2.5 / 3)
```bash
# One-shot query with auto-approval
./dist/bin/opensand --endpoint http://127.0.0.1:11434/v1 --model qwen3:8b -y "Inspect this repo"

# Run as specific agent persona
./dist/bin/opensand --endpoint http://127.0.0.1:11434/v1 --model qwen3:8b --bot cto "Audit architecture"

# Interactive REPL
./dist/bin/opensand --endpoint http://127.0.0.1:11434/v1 --model qwen3:8b
```

### 3. Launch Desktop GUI
```bash
# Start background web desktop server
node packages/desktop/dist/src/desktop-server.js
# Access at http://127.0.0.1:3456 in your browser
```
