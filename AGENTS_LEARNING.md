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

---

## 10. Web UI & Desktop Server Authentication

### 10.1 Silent 401 & UI Deadlock in Asynchronous Turn Loops
* **Trap:** If frontend methods like `client.sendQuery()` return `res.json()` without verifying `res.ok`, an unauthorized (401) or internal server error (500) returns an error object (e.g. `{ error: "Unauthorized: ..." }`) without throwing. The turn loop caller (e.g. `executeUserTurn`) checks `if (res && res.sessionId)`, which is false, bypassing the `catch (err)` block.
* **Root Cause:** When `catch` is never executed, `setTurnBusy(false)` is never called, leaving the chat UI permanently frozen with `<span class="typing-shimmer">Thinking…</span>` and the input textarea disabled.
* **Rule:** All frontend client methods calling backend APIs must verify `if (!res.ok)` and throw descriptive `Error` instances containing the server message or HTTP status. Turn execution pipelines must guarantee that any failure clears the busy state (`setTurnBusy(false)`), resets status indicators, and displays the error message directly in the message feed.

### 10.2 Supervisor Script Timestamp Desynchronization
* **Trap:** Using `find ... -newer "$marker"` inside a file watcher loop to detect source changes across a monorepo can cause infinite build and restart loops.
* **Root Cause:** If an edit is made in a dependency package (such as `coordinator`), `pnpm -r build` runs `tsc -b`. If the target package (`desktop`) did not change, `tsc` will not re-emit or touch the marker file (`desktop/dist/src/desktop-server.js`). On the next iteration of the watcher, the modified source file in `coordinator` remains newer than the marker file, triggering another build and restart loop every 2 seconds.
* **Rule:** Explicitly update the mtime of the marker file (`touch "$marker"`) after any successful monorepo build in file-watching supervisor scripts.

### 10.3 Dynamic Authentication Header & Token Exchange Flow
* **Trap:** Wrapping `window.fetch` only if an authentication token is present at page load. If the user arrives without credentials and subsequently authenticates or exchanges a token, subsequent fetch requests fail to include the `Authorization` header.
* **Rule:** Install the fetch interceptor unconditionally. In the interceptor, read the active token dynamically from client instance state or `sessionStorage`. Intercept 401 status responses globally to present the authentication modal, and provide `POST /api/auth/token-exchange` so web clients can obtain a secure HttpOnly session cookie without exposing long-lived tokens in query strings or browser history.

---

## 11. Settings, Cache Invalidation & Verification Traps

### 11.1 A gate that only ever passed is not proven
* **Trap:** `scripts/verify.sh`'s zero-test guard matched only `ℹ tests` (Node 26 reporter). CI runs Node 22, which prints `# tests 39`, so the guard read **0 tests for every package** and failed the first push — while local runs stayed green.
* **Root Cause:** The gate was written against the local runtime and never observed failing on the runtime that runs it.
* **Rule:** Any parser/gate over tool output must accept both reporter shapes (`(#|ℹ) (tests|pass) [0-9]+`), and a new or changed gate must be proven twice: it passes on good input and **fails on a deliberately broken input** (a throwaway 0-test package), on the same Node major as CI.

### 11.2 Cached objects capture config; changing settings must invalidate them
* **Trap:** Fixing the endpoint in Settings did not fix the open chat. `createSessionCoordinator` returns `coordinatorMap.get(...)` first, and `updateSettings` cleared only `this.coordinator`. The open session kept its old `UniversalLLMClient` with the old `baseUrl`, so it kept failing while a **new** session worked — which reads as "the app is broken".
* **Root Cause:** Per-session caches outlive the settings they were built from.
* **Rule:** When a cached object is constructed from settings, every settings write that can affect it must clear the whole cache (`coordinatorMap.clear()`), and the test must cover the **recovery path** (change setting → same session works), not only the fresh path.

### 11.3 A blank endpoint becomes a hostless URL and a useless error
* **Trap:** `baseUrl: ""` makes `resolveEndpoint()` return `/v1/chat/completions`; `fetch()` throws `Invalid URL`, surfaced as `Failed to connect to LLM at /v1/chat/completions: Invalid URL`.
* **Root Cause:** `updateSettings` persisted any string; nothing required a scheme, and the client built a URL from an empty base.
* **Rule:** Validate at the settings trust boundary (trim + `^https?://`, otherwise keep the working value) and refuse to build a URL from a blank base with an error that names the fix ("LLM endpoint is not configured. Open Settings…"). Never let `??` stand in for `||` on an endpoint: `""` is falsy but not nullish (`orchestrator-tools.ts`, subagent client).

### 11.4 Cold local models look like broken deployments
* **Trap:** A live probe failed at 60s right after a server restart; the first diagnosis ("stale server") was wrong. The local `qwen3:8b` needed 60s+ for its first token on a cold start, then 16.7s warm.
* **Root Cause:** Latency budget of local inference was never measured; a single failed attempt was treated as a cause.
* **Rule:** Before blaming a process, measure: time one real turn cold and warm. Treat a first-run timeout as latency until a warm retry proves otherwise, and warm the model before running live probes or demos.

### 11.5 Green unit tests do not prove user behaviour
* **Trap:** 334 tests passed while mid-turn `Ctrl+C` was dead (readline turns `SIGINT` into an interface event, so `process.on("SIGINT")` never fires) and a corrupt `messages.json` session was invisible in `/sessions` but still resumable.
* **Root Cause:** The suite exercised branches, not the interactive surface the user actually touches.
* **Rule:** For anything terminal- or UI-driven (prompt handling, resume, streaming, cancellation), prove it end-to-end with a pty or a live server run before claiming it works. Unit tests are necessary, not sufficient.

### 11.6 Bypassed hooks and half-tracked packages hide the gate
* **Trap:** Two commits were landed with `--no-verify` because the pre-commit hook ran a flaky live probe. Separately, `packages/vscode-extension/` sat untracked inside the workspace glob: local runs counted 352 tests while CI counted 334, untracked code entered the build, and its hardcoded 60s live-probe timeout kept turning `verify.sh` red on a cold model.
* **Root Cause:** A flaky gate was routed around instead of fixed, and a workspace package was neither tracked nor excluded.
* **Rule:** Never bypass a gate to land work: fix or narrow the gate in the same change. Every workspace package is either tracked or explicitly excluded from the glob, and any live probe gets a timeout that matches measured cold-start latency (>=120s) or skips when the server is cold.

### 11.7 Local green is not CI green
* **Rule:** After every push, read the actual CI run (`gh run view <id> --json status,conclusion`). Claim "green" only from that result, and if it fails, fix the cause before the next push instead of re-running until it passes.
