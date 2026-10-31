# AGENTS_LEARNING.md: Architectural Insights, Traps & Operating Rules

**Document Purpose:** Persistent reference for coding agents working on OpenSand or similar agentic architectures. Captures root causes, verified solutions, and non-obvious failure modes discovered during reverse engineering and clean-room implementation.

---

## 1. Binary Forensics & Electron Architecture

### 1.1 ASAR Header & Payload Offset Formula
* **Trap:** Attempting to read files out of an unpacked ASAR by slicing directly at `header_size` causes byte misalignment and `UnicodeDecodeError` on UTF-8 text assets (e.g. `index.html`).
* **Root Cause:** The Electron ASAR format begins with a 4-byte magic size, followed by a 4-byte header size (`header_size`), followed by a 4-byte JSON size, followed by the JSON string. The actual binary payload starts at `8 + total_size` (aligned to 4-byte boundary).
* **Rule:** Always verify file chunk block SHA-256 hashes against the extracted payload to validate alignment before extracting bundles.

### 1.2 Electron Fuses vs. UtilityProcess Bundles
* **Trap:** Assuming an Electron agent binary contains native C++/Rust logic and trying to disassemble it with Ghidra/Rizin.
* **Root Cause:** Modern Electron desktop apps (including Grok Bot) disable `RunAsNode` via fuses on the main helper executable, but spawn the agent worker using `utilityProcess.fork()`. The utility process runs a bundled CommonJS file (`dist/main/agent-bundle.cjs`).
* **Rule:** Before launching native reverse-engineering tools, inspect the Electron launch arguments and IPC descriptors. If `--bootstrap=` is passed with `processConfig`, the agent core is Node.js JavaScript, not Mach-O.

### 1.3 Multiplexed MessagePort Channels
* **Pattern:** Grok Bot uses 3 dedicated `MessagePort` channels transferred between Electron Main and UtilityProcess:
  1. `controlPort`: Daemon health, crash reports, supervisor pulse.
  2. `dataPort`: Token streaming, tool execution envelopes, file transfers.
  3. `mainDataPort`: Native window operations, menus, Keychain token access.
* **Insight:** Separating control signals from heavy data streams prevents backpressure on the streaming channel from stalling supervisor watchdogs or window controls.

---

## 2. Shell Execution & Bash Validation Traps

### 2.1 The Hyphen Word-Boundary Regex Trap
* **Bug:** A regex intended to match `rm -rf /` using `/\brm\b.*\b-rf\b/` fails to match `rm -rf /`.
* **Root Cause:** In regular expressions, `\b` matches an ASCII word boundary (transition between `\w` and `\W`). Space `' '` is `\W` and hyphen `'-'` is also `\W`. Therefore, between a space and a hyphen, **there is NO word boundary**! `\b-` will never match after a whitespace character.
* **Fix:** Match whitespace preceding the hyphen, and put the word boundary after the flag letter:
  ```ts
  /\brm\b(?:\s+--?[a-zA-Z0-9-]+)*\s+-(?:[a-zA-Z]*r[a-zA-Z]*f|[a-zA-Z]*f[a-zA-Z]*r)\b(?:\s+--?[a-zA-Z0-9-]+)*\s+(?:\/|\/\*|~)(?:\s|$)/
  ```

### 2.2 Pre-Flight Validation vs. Runtime Timeouts
* **Insight:** Relying solely on execution timeouts (`timeout_ms`) for broken shell commands is a major failure mode. An unclosed single quote (`echo 'hello`) causes bash to wait indefinitely for input on stdin. While a 60s timeout terminates it eventually, it degrades the agent turn loop by 60 seconds per error.
* **Rule:** Always run pre-flight lexical validation (balanced single quotes, double quotes, backticks, parentheses, braces) *before* spawning child processes. Syntax errors should fail in 0.1ms without touching the OS shell.

---

## 3. macOS Sandboxing & Toolchain Constraints

### 3.1 Swift Module Cache Permissions
* **Bug:** Running `swiftc -O native.swift` inside a sandboxed terminal environment fails with:
  `<unknown>:0: error: unable to open output file '/var/folders/.../SwiftShims.pcm': 'Operation not permitted'`
* **Root Cause:** By default, clang and the Swift driver write intermediate module caches to macOS user cache directories (`/var/folders/...`), which are blocked under sandboxes.
* **Fix:** Explicitly redirect the module cache to `/tmp` (which has unrestricted write access in the sandbox):
  ```bash
  swiftc -module-cache-path /tmp/clang-cache -O native.swift -o bin/native
  ```

### 3.2 Loopback TCP Network Restrictions in Sandboxes
* **Bug:** Node tests using `http.createServer()` and `fetch("http://127.0.0.1:<port>")` fail with:
  `Error: connect EPERM 127.0.0.1:<port> - Local (0.0.0.0:0)`
* **Root Cause:** Security sandboxes disable network socket operations completely, including loopback TCP sockets (`127.0.0.1`).
* **Fix:** Design LLM clients to accept an optional injectable `fetch` function (`config.fetch ?? globalThis.fetch`). In unit tests, inject an in-memory mock `fetch` returning a `ReadableStream`. This runs hermetically in <5ms with 0 network calls and zero `EPERM` issues.

---

## 4. TypeScript ESM & Path Resolution Rules

### 4.1 `import.meta.dirname` in Monorepo Package Trees
* **Trap:** Using `path.join(import.meta.dirname, "..", "bin")` works when running TypeScript directly with loaders, but breaks once compiled to `dist/src/index.js`.
* **Root Cause:** In source, `import.meta.dirname` is `packages/pkg/src` (`..` is package root). In compiled output, it is `packages/pkg/dist/src` (`..` is `dist`, NOT package root; package root is `../..`).
* **Rule:** When locating sibling resource directories (`bin/`, `native/`), check both candidate paths:
  ```ts
  const candidateDist = path.join(import.meta.dirname, "..", "..", "bin", binaryName);
  const candidateSrc = path.join(import.meta.dirname, "..", "bin", binaryName);
  const binPath = fsSync.existsSync(candidateDist) ? candidateDist : candidateSrc;
  ```

### 4.2 Safe State Persistence via Atomic Temporary Renames
* **Rule:** Never write directly to a state file (`fs.writeFile("daemon.json", ...)`). A crash mid-write corrupts JSON and leaves the supervisor unable to parse state.
* **Pattern:** Always write to a unique temporary file (`.daemon.json.<timestamp>.<random>.tmp`) with restricted mode `0600`, and then perform an atomic rename (`fs.rename`). On POSIX systems, `rename` is guaranteed atomic.

---

## 5. Security & Gate Enforcement

### 5.1 Dual-Authorization Model
* All execution must pass through the permission gate:
  1. If `computerUseAllowed` is true $\rightarrow$ Auto-approve.
  2. If the command prefix is present in `standingAllowlist` $\rightarrow$ Auto-approve.
  3. If explicit one-time `approvalGranted` is passed $\rightarrow$ Execute.
  4. Otherwise $\rightarrow$ Return `status: "permission_pending"` with an `approvalId` and notify the UI/user.
* **Golden Rule:** Never silently execute non-allowlisted shell commands without user confirmation.

---

## 6. CLI & Interactive Terminal Engineering

### 6.1 Node.js `readline/promises` Ctrl+C `AbortError` Trap
* **Trap:** Using `await rl.question(...)` from `node:readline/promises` without catching `AbortError` causes Node to throw `AbortError: Aborted with Ctrl+C (code: ABORT_ERR)` when the user presses `Ctrl+C` while awaiting input, dumping an unhandled rejection stack trace.
* **Root Cause:** In Node 18+, `readline/promises` triggers an internal abort controller on `SIGINT` when a question is pending.
* **Fix:** Always wrap the REPL input prompt in a try/catch block:
  ```ts
  try {
    const input = await rl.question(prompt);
  } catch (err: any) {
    if (err.name === "AbortError" || err.code === "ABORT_ERR") {
      terminalUI.printInfo("\nExiting OpenSand.");
      break;
    }
    throw err;
  }
  ```

---

## 7. LLM Provider Hierarchy & Zero-Config Local Defaults

### 7.1 Unauthenticated Cloud Endpoint Trap
* **Trap:** Defaulting to `https://api.openai.com/v1` and `gpt-4o` when no `$OPENAI_API_KEY` is present causes immediate `401 Unauthorized` errors when running the CLI without arguments (`opensand`).
* **Root Cause:** Hardcoding cloud defaults without checking credential presence creates a broken out-of-the-box experience.
* **Rule:** Resolve provider configurations hierarchically:
  1. Explicit CLI flags (`--endpoint`, `--model`, `--api-key`).
  2. Environment variables (`$OPENSAND_ENDPOINT`, `$OPENAI_API_KEY`, etc.).
  3. Persistent user settings (`~/.opensand/config.json`).
  4. Local inference probe (test `http://127.0.0.1:11434` with a 300ms timeout). If alive, default to local Ollama with zero required keys.
  5. If neither local nor cloud keys exist, guide the user on how to run Ollama or configure their API key before attempting network calls.

---

## 8. Multi-Agent Delegation & Context Isolation

### 8.1 Subagent Transcript Hygiene & Grok Bot Parity
* **Trap:** Sharing the coordinator's message history directly with subagents pollutes context windows and leads to persona leakage.
* **Pattern:** OpenSand replicates Grok Bot's `CreateGrokBotAgent` and `OpenAgentTail` architecture:
  - Subagents run in isolated turn loops with dedicated session IDs (`sub_<agentId>_<timestamp>`).
  - System prompts and tool whitelists (`allowedTools`) are enforced at the subagent level.
  - The parent coordinator only receives the synthesized final output from `delegate_to_agent`, maintaining minimal token overhead.

---

## 9. macOS Native Bridges & Graceful Permission Degradation

### 9.1 Apple TCC Permissions (Screen Recording, Full Disk Access)
* **Trap:** Hard crashing when reading `~/Library/Messages/chat.db` or invoking ScreenCaptureKit if permissions have not been granted in macOS System Settings.
* **Rule:** System bridges must never crash the coordinator. Detect `EPERM` / `ENOENT` or TCC denials, format a structured diagnostic message instructing the user which toggle to enable in System Settings $\rightarrow$ Privacy & Security, and allow the model to report this gracefully to the user.
