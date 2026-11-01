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
| [`@opensand/coordinator`](./packages/coordinator) | Multi-turn streaming agent loop, universal SSE parser, OpenAI & Anthropic clients, native MCP client, persistent Agent Store, Task Store, Habit Extractor, 7-Layer Memory System, Local Encrypted Vault, Recipe Skills Engine, Routine Engine, Multi-Agent Rooms, Git Manager, Workspace Sentinel, Attachment Staging, and Side-Question/Rollback/Compaction engines. | 67 passing |
| [`@opensand/native-bridge`](./packages/native-bridge) | Native Apple Vision offline OCR (`sand-vision`), ScreenCaptureKit window capture (`sand-window-capture`), 1Password Seatbelt launcher, macOS Messages reader, Speech Synthesis, and Browser Automation (`web_search`, `fetch_web_page`, Safari tab inspector). | 11 passing |
| [`@opensand/cli`](./packages/cli) | Interactive terminal REPL with live token streaming, bot persona switcher (`--bot`), system doctor (`opensand doctor`), fleet status (`opensand status`), first-class slash commands, and permission approval prompts. | 9 passing |
| [`@opensand/desktop`](./packages/desktop) | Multi-tab Desktop GUI & REST server (`http://127.0.0.1:3456`) with Chat, Rooms, Routines, Skills, Vault, Memory Review Queue, Task Management, Attachments, and local webview shell. | 6 passing |

**Total Test Coverage: 122/122 automated unit and integration tests passing (100% green).**

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

## 7-Layer Memory System (Grok Bot 1:1 Clean-Room Parity)

OpenSand implements a 1:1 clean-room replica of Grok Bot's multi-tier cognitive memory architecture across seven distinct operational layers:

```
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 7: Encrypted Client Persistence (~/.opensand/memory/*.json)     │
│          Atomic file transactions with 0600 modes & flush deadlines    │
├────────────────────────────────────────────────────────────────────────┤
│ Layer 6: Capability Injections (<imported_memory>, credential filter)  │
├────────────────────────────────────────────────────────────────────────┤
│ Layer 5: Team Consensus Review Queue (HITL approval / reject workflow)  │
├────────────────────────────────────────────────────────────────────────┤
│ Layer 4: Habit & Intent Extractor (4-conversation citation threshold)  │
├────────────────────────────────────────────────────────────────────────┤
│ Layer 3: Agent Shards & Folders (Profile tier vs Episodic Log tier)   │
├────────────────────────────────────────────────────────────────────────┤
│ Layer 2: Discrete Fact Memory (UpdateMemory write/forget tool)         │
├────────────────────────────────────────────────────────────────────────┤
│ Layer 1: Episodic Transcript Recaller (Context tailing & crawling)    │
└────────────────────────────────────────────────────────────────────────┘
```

1. **Layer 1: Episodic Recall (`recall_memories`)**: Crawls recent session transcripts and semantic memory stores. Provides context-tailing across collaborating subagents.
2. **Layer 2: Discrete Fact Store (`update_memory`)**: Structured fact storage (`GrokBotMemoryFact` parity: `fact_id`, `text`, `learned_at_ms`). Handles discrete atomic facts tagged by `tier` (`profile` for enduring identity/rules vs `log` for episodic historical records).
3. **Layer 3: Agent Definition Shards & Folders**: Distinct isolated memory scopes (`user`, `agent`, `team`) persisted in `~/.opensand/memory/`. Agents can maintain private scratchpads or inherit shared organizational profiles.
4. **Layer 4: Continuous Habit & Intent Engine (`extract_user_habits`)**: Analyzes `<user_query>` dialogue segments across session transcripts. Enforces Grok Bot's strict **4-citation evidence rule** before promoting repeated patterns to enduring behavior guidelines in `~/.opensand/learned_rules.md`.
5. **Layer 5: Team Consensus Review Queue (`PromoteGrokBotMemoriesToTeam`)**: When an agent attempts to write to `scope: "team"`, facts are placed in a human-in-the-loop review queue (`TeamReviewItem`: `PENDING`, `APPROVED`, `REJECTED`). Once approved, facts are synthesized into a cohesive natural-language narrative (`GrokBotTeamContextSummary`).
6. **Layer 6: Capability Injections & Import Protocol (`<imported_memory>`)**: Implements Grok Bot's capability injection protocol. Imports memory blocks from other assistants (`Instructions`, `Identity`, `Career`, `Projects`, `Preferences`) with built-in credential redaction (`sk-`, `AKIA`, `password=`).
7. **Layer 7: Resilient Local Persistence**: Atomic writes with `.tmp` staging, SHA-256 verification, and strict file security modes (`0600`).

---

## Subsystems & Parity Extensions

### 1. Local Encrypted Secrets Vault (`VaultStore`)
- **Zero-Dependency Cryptography**: Uses Node 22 native `node:crypto` with AES-256-GCM authenticated encryption and PBKDF2 (100,000 rounds) key derivation.
- **Hardware Salt Binding**: Salt file generated per host at `~/.opensand/vault/.vault.salt` with `0600` permissions.
- **Automatic Tool Output Redaction**: All secrets registered in the vault are actively monitored; any appearance of secret values in tool execution output or console logs is automatically scrubbed into `[REDACTED_VAULT_SECRET:<NAME>]`.
- **Meta-Tools**: `vault_store_secret`, `vault_list_secrets`, `vault_delete_secret`, `vault_store_credential`, `vault_list_credentials`.

### 2. Modular Recipe Skills Engine (`SkillStore`)
- **Grok Bot Clean-Room Parity**: Matches Grok Bot's internal `.cursor/skills-cursor/<name>/SKILL.md` format and contract constraints.
- **YAML Frontmatter Parser**: Parses standard frontmatter (`name`, `description`, `category`, `disableModelPruning`) with Markdown heading 1 fallbacks.
- **Safety Bounds**: Strict `256KB` file limit check (`k = 256e3`) and `250` maximum skills cap (`MAX_BOT_SKILLS = 250`).
- **Dynamic Persona Mounting**: Mount skills to specific bot personas (`mount_skill`) so their recipes are dynamically injected into the system prompt.
- **Meta-Tools**: `add_skill`, `list_skills`, `mount_skill`, `unmount_skill`.

### 3. Scheduled Background Routines & Automations (`RoutineEngine`)
- **5-Field Cron Parser**: Pure native cron engine supporting `minute hour dom month dow`, step notation (`*/n`), lists (`1,15,30`), ranges (`1-5`), and wildcard matches.
- **Interval Tickers**: Configurable frequency triggers (e.g. `every 30m`, `every 2h`).
- **Autonomous Subagent Runner**: Executes scheduled routines in the background, delegating tasks to designated bot personas, persisting logs, and tracking next execution times.
- **Meta-Tools**: `create_routine`, `list_routines`, `set_routine_enabled`, `trigger_routine`, `delete_routine`.

### 4. Multi-Agent Group Rooms (`RoomManager`)
- **Collaborative Deliberation**: Group rooms (`kind: "ROOM"`) coordinate multiple bot personas (e.g. CTO Bot, QA Engineer, Security Auditor) in a round-table format.
- **Sequential Context Propagation**: Each persona observes the conversation prompt and prior members' turns, responding in order.
- **Synthesized Consensus Draft**: OpenSand aggregates all turns into an actionable consensus resolution, noting agreements and dissents.
- **Meta-Tools**: `create_room`, `list_rooms`, `set_room_members`, `run_room_discussion`, `delete_room`.

### 5. Autonomous Web Browser & Safari Automation (`BrowserBridge`)
- **Fast Lightweight Extraction**: Native Node 22 `fetch` + semantic HTML-to-Markdown parser strips navigation, ads, and scripts into clean Markdown in <50ms.
- **Live Search**: Instant multi-engine query synthesis (DuckDuckGo Instant Answers + Wikipedia API).
- **Safari Active Tab Inspector**: Native AppleScript bridge queries current active Safari URL and page title without requiring browser extensions.
- **Tools**: `web_search`, `fetch_web_page`, `safari_inspect_active_tab`.

### 6. Autonomous Git & GitHub PR Lifecycle Manager (`GitManager`)
- **Structured Git Status & Diff**: Direct repository inspection returning parsed branch, staged/modified/untracked files, insertion/deletion stats, and commit logs.
- **Parallel Worktree Spawner**: Creates isolated git worktrees (`git worktree add`) for safe parallel development without modifying the main tree.
- **Auto-Commit Generator**: Generates concise conventional commit messages based on staged diff analysis.
- **Autonomous PR Reviewer**: Scans git diffs against security and code quality rules, checking for exposed API keys (`sk-[a-zA-Z0-9]{20,}`), raw `console.log` debug statements, and type-safety escapes (`@ts-ignore`, `: any`).
- **Tools**: `git_status`, `git_diff_summary`, `git_worktree_create`, `git_auto_commit`, `gh_pr_review`.

### 7. Workspace Sentinel & Self-Healing Watcher (`WorkspaceSentinel`)
- **Debounced Filesystem Sentinel**: Watches workspace directories with configurable debounce (`500ms`) and file ignore rules (`node_modules`, `.git`, `dist`).
- **Health Verification**: Automatically triggers fast test or build verification commands upon code changes.
- **Diagnostic Logging**: Collects build failures and test regressions for autonomous self-healing loops.
- **Tools**: `start_workspace_watcher`, `list_workspace_watchers`, `stop_workspace_watcher`, `get_sentinel_diagnostic_logs`.

### 8. Ephemeral Side-Question ("BTW") Engine
- **Grok Bot Contract 8.1.A Parity**: Implements `glass_btw_side_question_prompt_config`.
- **Zero History Pollution**: Answers immediate side inquiries using full session context without altering the conversation history or appending tool invocations to the persistent transcript.
- **REPL & REST Access**: Available via `/btw <question>` in the CLI REPL and `POST /api/btw`.

### 9. Conversation Rollback & Rewind Engine
- **Grok Bot Rollback Parity**: Implements `RollBackGrokBotConversation`.
- **Atomic History Rewind**: Rewinds in-memory message history by N user turns and synchronizes on-disk `transcript.txt` and `transcript.jsonl`.
- **REPL & REST Access**: Available via `/rollback [turns]` in the CLI REPL and `POST /api/rollback`.

### 10. Attachment Staging & File Hashing Store (`AttachmentManager`)
- **Grok Bot Attachment Parity**: Matches Grok Bot's `stageAttachmentFile` and `stageAttachmentBytes`.
- **SHA-256 Content Addressing**: Stages files and binary buffers into `~/.opensand/attachments/<hash>/` with MIME type detection and metadata persistence.
- **Tools**: `stage_attachment`, `list_attachments`.
- **REPL & REST Access**: `/attach <file_path>`, `/attachments`, and `GET` / `POST` / `DELETE` `/api/attachments`.

### 11. Portable Agent Templates (`AgentStore`)
- **Grok Bot Template Parity**: Matches Grok Bot's `GrokBotTemplate` export and import architecture (`CreateGrokBotTemplate`, `CreateGrokBotAgentFromTemplate`).
- **Shareable Artifacts**: Exports bot personas into standalone `.template.json` files and creates bots from templates with system instructions, allowed tools, and metadata preserved.
- **Tools**: `export_agent_template`, `import_agent_template`.
- **REPL & REST Access**: `/template export <name>`, `/template import <file>`, and `GET /api/templates/:id` / `POST /api/templates/import`.

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

### System Health & Fleet Preflight
```bash
# Run comprehensive environment, model connectivity, and tool integrity doctor
opensand doctor

# Inspect overall fleet statistics across agents, rooms, routines, and vault
opensand status
```

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
- `/tools` - Inspect all 61 active Core, Native, Orchestrator, and MCP tools
- `/bots`, `/agents` - List registered subagents and active persona
- `/bot <name>` - Switch active bot persona on the fly (e.g. `/bot cto` or `/bot default`)
- `/btw <question>` - Ask ephemeral side-question using current work context (BTW prompt parity)
- `/rollback [turns]` - Roll back conversation history by N turns (RollBack parity)
- `/compact [keep]` - Compact dialogue history by condensing older turns into a dense summary
- `/doctor` - Run system preflight diagnostics across host runtime, models, and tools
- `/status` - Display fleet summary (agents, rooms, routines, skills, vault)
- `/attach <file>` - Stage a file or image attachment into session store
- `/attachments` - List all staged attachments
- `/template export` - Export bot persona into portable template JSON
- `/template import` - Import bot persona from template JSON
- `/rooms` - List all multi-agent collaborative rooms
- `/room <id> <topic>` - Convene a multi-agent round-table deliberation and consensus draft
- `/routines` - List all scheduled background automations
- `/routine run <id>` - Trigger immediate execution of a scheduled routine
- `/skills` - List all modular recipe skills
- `/skill <name>` - Inspect the full markdown recipe and instructions of a skill
- `/vault` - Inspect encrypted secrets & credentials with masked previews
- `/git` - Inspect git branch, staged, modified, and untracked files
- `/review [ref]` - Run autonomous PR review bot on pull request or commit diff
- `/tasks` - Display registered agent tasks and status
- `/rules` - View continuous learned user habits and behavior rules
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
