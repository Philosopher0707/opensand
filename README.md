# OpenSand

**OpenSand** is a high-performance, clean-room, open-source desktop and CLI coding agent derived from byte-level reverse engineering of the Grok Bot desktop application (`com.anysphere.sand`).

It replaces proprietary cloud ConnectRPC backends with universal OpenAI-compatible streaming function calling (`/v1/chat/completions`), allowing seamless operation with local models (Ollama, vLLM, LM Studio) or cloud endpoints (OpenAI, DeepSeek, OpenRouter, Anthropic proxies).

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
           - list_directory
```

---

## Monorepo Packages

| Package | Description | Tests |
|---|---|---|
| [`@opensand/local-exec-daemon`](./packages/local-exec-daemon) | Local execution engine with preflight bash syntax & safety validation, atomic file I/O with SHA-256 digests, and crash-resilient JSON state files. | 27 passing |
| [`@opensand/coordinator`](./packages/coordinator) | Multi-turn streaming agent turn loop, universal SSE parser, OpenAI `/v1/chat/completions` client, and Grok Bot human-readable transcript parity. | 9 passing |
| [`@opensand/native-bridge`](./packages/native-bridge) | Native Apple Vision offline OCR (`sand-vision`), ScreenCaptureKit window capture (`sand-window-capture`), and 1Password Seatbelt hardened launcher. | 5 passing |
| [`@opensand/cli`](./packages/cli) | Interactive terminal REPL and one-shot execution CLI with live token streaming and permission approval modals. | 3 passing |

---

## Quick Start

### 1. Build and Test
```bash
pnpm install
pnpm build
pnpm test
```

### 2. Run with Local Ollama (Zero Cloud Dependency)
```bash
# Pull model in Ollama
ollama run llama3.1

# Launch OpenSand
./packages/cli/dist/src/bin.js --endpoint http://localhost:11434/v1 --model llama3.1
```

### 3. Run with OpenAI or DeepSeek
```bash
export OPENAI_API_KEY="sk-..."
./packages/cli/dist/src/bin.js --model gpt-4o

# Or DeepSeek
export OPENSAND_ENDPOINT="https://api.deepseek.com/v1"
export OPENSAND_API_KEY="sk-..."
./packages/cli/dist/src/bin.js --model deepseek-chat
```

### 4. One-Shot Command Execution
```bash
./packages/cli/dist/src/bin.js --auto-approve "List git branches and format status summary"
```

---

## Security & Permission Model

OpenSand follows a strict dual-authorization gate model:
1. **Standing Allowlists**: Benign commands (e.g. `ls`, `git status`, file reads in workspace) are auto-approved.
2. **Approval Prompts**: Destructive commands (e.g. `rm`, overwriting system files, executing unknown scripts) trigger an interactive authorization prompt.
3. **Safety Gate**: Pre-flight bash validator rejects dangerous patterns (`rm -rf /`, raw device rewrites, fork bombs) and unclosed syntax *before* the shell executes.
4. **Hardened 1Password Runner**: Executes `op` CLI inside a macOS Seatbelt sandbox profile, preventing access to raw database containers.

---

## License

MIT
