# AGENTS_LEARNING.md: Architectural Insights, Traps & Operating Rules

**Document Purpose:** Persistent reference for coding agents working on OpenSand or similar agentic architectures. Captures root causes, verified solutions, and non-obvious failure modes discovered during reverse engineering and clean-room implementation.

Before any job, read [docs/STANDARDS.md](docs/STANDARDS.md) — the condensed definition of done, workflow, evidence, review, learning and error rules.

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
  2. If the command has an `always` `exec_command` grant in `grants.json` $\rightarrow$ Auto-approve.
  3. If explicit one-time `approvalGranted` is passed $\rightarrow$ Execute.
  4. Otherwise $\rightarrow$ Return `status: "permission_pending"` with an `approvalId` and notify the UI/user.
* **Golden Rule:** Never silently execute shell commands without a standing grant or user confirmation.

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

### 11.8 An unwired preload script leaves the native bridge dead
* **Trap:** `preload.ts` existed in `packages/desktop/src/preload.ts` implementing `contextBridge.exposeInMainWorld('opensand', ...)`, but `packages/desktop/src/main.ts` omitted `preload` in `BrowserWindow.webPreferences`. As a result, `window.opensand` was permanently `undefined` in the real app, and `renderer/app.js` silently degraded to HTTP fallback without any error or test failure. Furthermore, in `"type": "module"` packages, compiling `preload.ts` to `preload.js` emits `export {};`, which causes sandboxed Electron CommonJS loaders to crash with `SyntaxError: Unexpected token 'export'`.
* **Root Cause:** Unit tests exercised classes in isolation using in-memory stubs and never launched a real Electron window to verify that the bridge was exposed to the renderer window.
* **Rule:** Electron sandboxed preloads must compile to CommonJS (`.cts` $\rightarrow$ `.cjs`). The preload path must be wired explicitly in `webPreferences.preload` using robust dist-relative path resolution (`import.meta.url` / `import.meta.dirname`). Every app bridge must have an automated real-Electron gate test in CI/test suites that launches the dev window and asserts `typeof window.<bridge> === 'object'` and round-trips an IPC call, proven to fail when the preload wiring is removed.

### 11.9 Electron apps launched from Finder have cwd "/"
* **Trap:** OpenSand 0.1.5 launched from Finder/Dock hung forever on the first message with the thinking spinner. The bridge defaulted `workspaceDir` to `process.cwd()`, which is `/` for a GUI launch, so the session coordinator asked `requestFolderTrust("/")` and the turn waited on an approval nobody could see was about it.
* **Root Cause:** GUI launches have no meaningful working directory; `/` is a filesystem root, never a user workspace. The approval card that should have answered it also threw `ReferenceError: render is not defined` (its factory was called without the `render` option it expected), so the card's buttons never reached the app.
* **Rule:** Never derive a session workspace from `process.cwd()` without guarding the filesystem root (`path.dirname(dir) === dir`) and falling back to `os.homedir()`; an explicit `workspaceDir` still wins. Renderer widgets must render through their own exported function, call the side effect before mutating UI state, and keep the card when that call fails. Both fixes carry a test proven to fail when reverted.

### 11.10 The engine package's own tests flake under local load
* **Trap:** While landing an unrelated change, `packages/engine` failed on "force shutdown exits immediately" (2253 ms against a hard 2000 ms budget) and, in another run, on "keeps the log after SIGKILL and replays it from a fresh process". Both also failed on the untouched base commit: three runs of the pristine base produced one failure, three runs of the branch produced one failure each in a different test.
* **Root Cause:** `node --test` runs the package's test files in parallel and several of them spawn processes and drive git; on a loaded machine the spawn-and-exit tests miss their wall-clock budgets. The flake is load, not the change under test.
* **Rule:** When a test fails in a package you did not touch, reproduce it on the base commit before blaming your change, and report it as pre-existing rather than re-running until it passes. A test with a hard wall-clock budget around a process spawn must measure a generous multiple of the observed cold duration, or wait on an event instead of a timer.

### 11.11 A field named "diff" that holds only hashes is still untrusted input
* **Trap:** The mission review input's `diff` was `diff <baseTree> -> <finalTree>`, both git tree ids, so no hostile text could reach it and no honest red test could be written for it.
* **Root Cause:** The field is filled from a command's stdout (`git write-tree`). The current git prints hex, but the field is workspace-derived text by contract, and it will hold real diff text the moment the feature grows.
* **Rule:** Escape workspace-derived text at the point it enters a prompt, whatever it currently contains, and when a red test for such a field seems impossible, inject at the only seam that fills it (here: a `git` shim that prints a hostile tree id) instead of skipping the test or weakening the assertion.

### 11.12 A second engine in the window's IPC path makes a working HTTP fix invisible
* **Trap:** Installed 0.1.6, the owner's message sat on "Thinking…" with no trust card. `main.ts` built `new DesktopIpcBridge()` in the constructor and every `opensand:*` IPC handler (plus the `event` forwarder) used it, while `DesktopServer` held its own bridge. `GET /api/approvals` was `[]`, `GET /api/sessions` showed 0 messages, and the same message over `POST /api/query` asked `folder.trust` and answered correctly — so the engine was fine and only the window was talking to a second copy. Reopening the window also added another `bridge.on('event')` listener, and the inline approval queue rendered below the 740px window ("y=740"), so even a delivered card could not be seen or answered.
* **Root Cause:** Two `DesktopIpcBridge` instances per app, created independently at `main.ts` and `desktop-server.ts`. Nothing in the suite asserted that the window's handlers use `server.getBridge()`, so every HTTP test passed while the window path was dead.
* **Rule:** One engine per app; a fix verified only through HTTP must also be driven through the window's IPC path. `DesktopApp` takes its bridge from `server.getBridge()` after `server.start()`, the event forwarder is registered once, and both properties are asserted by a test that builds the real `DesktopApp` with a fake electron module and a temp `baseDir`, proven red when the second bridge or the per-window listener returns. Anything the turn waits on must also be visible where the user is looking: assert the card's on-screen bounds in a real window, not just its presence in the DOM.


### 11.13 Auto-approve mode (-y) must not grant persistent standing instructions or memories without explicit opt-in
* **Trap:** Running `opensand -y` or enabling desktop auto-approve allowed models to call `add_skill`, `mount_skill`, `update_memory`, and `import_memory` automatically. A model could plant a persistent instruction or memory in a single run that would be loaded into every future prompt.
* **Root Cause:** Auto-approve mode treated all tool calls uniformly, returning `true` on the approval hook without distinguishing transient operations (`exec_command`, local edits) from persistent state modifications that survive across sessions.
* **Rule:** Auto-approve (`-y` / `--auto-approve`) only covers transient operations. Persistent changes (skill write/mount, memory write/import) always require human confirmation. In interactive mode, prompt the user; when no human approver is present, fail closed with a clear refusal message. Auto-approving persistent changes requires an explicit, intentional opt-in flag (`--auto-approve-persistent`) that defaults to off and is never enabled implicitly.

### 11.14 Compaction summaries and MCP tool results must never inject plain-text SYSTEM: directives
* **Trap:** Outside text arriving via context compaction summaries or external MCP tool results could contain leading `SYSTEM:` lines or arrive with role `system`, leading LLMs to interpret untrusted data as privileged system instructions.
* **Root Cause:** Historical context summaries were injected into the message history with `role: "system"` instead of clearly-labelled untrusted user data (`role: "user"`), and MCP tool outputs lacked normalization for leading `SYSTEM:` prefixes across line breaks before being delivered to the model.
* **Rule:** Outside text must never reach the model with role `system` or containing un-neutralized `SYSTEM:` directive prefixes. All context compaction summaries must use `role: "user"` and be fenced as delimited data. Any leading `SYSTEM:` / `system:` line prefixes in untrusted text or MCP tool results must be neutralized to `[SYSTEM]:` / `[system]:` so that prompt-fencing and role-based instruction semantics are strictly preserved.

---

## 12. Concurrency & Shared Temp State

### 12.1 A tool that mutates state with no lock breaks under its own concurrency
* **Trap:** `delegate_to_agent` returned `status: "error"` in ~4 of every 160 coordinator suite runs (10 parallel streams). Logs showed `fatal: failed to read .git/worktrees/<peer>/commondir: Undefined error: 0`. Two writers into the same seam, both in `packages/coordinator/src/git-manager.ts`: `removeWorktree` ran `git worktree prune` (old line 462), and `prune` deletes any registration whose worktree path is missing — which is exactly what a peer `git worktree add` looks like before it creates the directory; and `worktree add` in `createWorktree` (line 242) enumerates every registration in the repo, so two concurrent adds can read a peer's still-empty `commondir` and die. `errno 0` (not ENOENT) is the tell: the file exists but has nothing in it yet.
* **Root Cause:** git holds no lock across separate `worktree add` / `worktree remove` invocations, and delegations run in **separate OS processes**, so an in-process mutex or "remove the prune call" only shrinks the window (4/80 → 1/80) instead of closing it.
* **Rule:** never run a repo-wide git cleanup (`worktree prune`, `gc`, `worktree repair`) from code that can run in parallel; serialise every worktree change across processes — `withWorktreeLock` now holds `EventLogLock` on `git rev-parse --git-common-dir` around add and remove. Never fix such a race with a retry or a raised timeout, and never leave `git worktree prune` in a teardown path: it deletes other processes' in-flight work. Prove it with a seeded half-created registration (survives a removal) and with an injected git runner that holds one `worktree add` open while asserting a second never starts — a 2.5% flake is not evidence either way, only the deterministic test is.

### 12.2 Two copies of `scripts/verify.sh` cannot share `${TMPDIR}/opensand-verify`
* **Trap:** a `SKIP_INSTALL=1 bash scripts/verify.sh` failed with "Package @opensand/desktop has TypeScript sources in src/ but reported 0 tests" right after desktop had passed 161 tests, and `grep` reported the per-package log as missing.
* **Root Cause:** every run does `rm -rf "$LOG_DIR"; mkdir -p "$LOG_DIR"` on a folder derived from `TMPDIR` alone. A leftover verify.sh from an earlier call wiped the log mid-run; the guard then read a file that no longer existed. The script and the tests were fine.
* **Rule:** one verify.sh per machine at a time. A missing log means another run owns the folder — wait or kill it and re-run, never "fix" the guard.

### 12.3 A timestamp-only fixture path collides in parallel suites
* **Trap:** `packages/coordinator/test/connectors.test.ts` keys its fixture on `opensand-connectors-test-${Date.now()}`. Two suite processes starting in the same millisecond share it, and one test then compares against the other's OAuth state (`oauth_linear_<hash>`) — 2/80 runs, invisible when the file runs alone.
* **Rule:** fixtures that must be isolated use `fs.mkdtemp` (unique suffix), never a bare timestamp; CI and the load loop run many suites at once.
* **Fixed (#64):** `connectors.test.ts`, `skill-store.test.ts` and `vault-store.test.ts` now use `fs.mkdtempSync`. Forcing the clock (`Date.now = () => fixed`) reproduced the collision 23/24 before the fix and 0/24 after, which is how a sub-3% flake gets proven.

### 12.4 Measuring process operation budgets before warmup races cold start
* **Trap:** In `packages/engine`, the test "force shutdown exits immediately" in `lifecycle.test.ts` failed under concurrency/load (11/80 failures under 80-runner load, 73/80 in mutation probe), exceeding its 2 s wall-clock budget (measuring 2.2–3.3 s).
* **Root Cause:** `started = Date.now()` was captured immediately after calling `new EngineProcess(dir)`. Because `spawn()` returns asynchronously before the Node child process has launched, the 2-second wall-clock budget measured cold Node process boot, ESM module graph loading/parsing, and V8 initialization under load, rather than shutdown duration. The shutdown itself takes < 50 ms.
* **Rule:** Never assert a latency budget on a child process operation before proving the child process is alive and responsive (e.g. by pinging it first over RPC, as the graceful shutdown and SIGTERM tests do). Warm up the child before starting the clock.

### 12.5 Same-millisecond entity creation without monotonic tiebreakers produces non-deterministic IDs and sort order
* **Trap:** When creating tasks via `TaskStore.createTask()` in the same millisecond or with a frozen clock, IDs contained random hex (`crypto.randomBytes(4)`) and `listTasks()` tie-breaking (`a.id < b.id`) resolved to non-deterministic pseudo-random ordering instead of creation order, causing flakiness in parallel or high-throughput task pipelines.
* **Root Cause:** Keying entities on `Date.now()` + random bytes provides uniqueness across processes but lacks determinism and monotonic ordering within the same millisecond.
* **Rule:** When multiple entities share a timestamp, tiebreakers must be strictly deterministic (e.g. monotonic sequence counter within the timestamp `task_${now}_${seq}`). Enforce via frozen-clock tests asserting stable ordering and deterministic IDs. Automated with `verify.sh` test tmpdir guard enforcing unique directory isolation (`mkdtemp` / `tempDir()`) across all test suites.

### 12.6 Ambient Git hook environment leaks into test Git calls and corrupts shared worktree configuration
* **Trap:** During test execution under Git hooks (or verify scripts executed via pre-commit), running Git commands in tests (e.g. `untrusted-agent-input.test.ts:207`) inherited ambient `GIT_DIR` and `GIT_COMMON_DIR`. When `git init -q` executed inside a newly created fixture directory while `GIT_DIR` pointed to a worktree path, Git detected that `cwd != GIT_DIR` and assumed the target was a bare repository, rewriting `core.bare = true` in the shared `.git/config` of the main repository. This broke all Git commands across the main checkout and all active worktrees.
* **Root Cause:** Git hooks export `GIT_DIR`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, and other `GIT_*` variables to child processes. Worktrees share `.git/config` via `GIT_COMMON_DIR`. Any test executing `git init` or other Git commands without completely scrubbing all `GIT_*` environment variables risks targeting the common repository instead of the fixture directory.
* **Rule:** All test Git invocations must sanitize the process environment using `cleanGitEnv()`, completely stripping all `GIT_*` environment variables (`for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k]`). Automated with a pre- and post-test `core.bare` tripwire in `scripts/verify.sh` comparing common git config before and after running test suites.

### 12.7 MCP tool output must be fenced in wrapUntrusted at registration time
* **Trap:** When hardening against hostile outside text entering the model prompt, PR #71 neutralised leading `SYSTEM:` lines in `McpManager.registerServerTools` but returned the output unfenced. Adversarial payloads containing prompt injections, role swaps, or fake closing delimiters (e.g. `</data_source>`) reached consumers (such as direct daemon execution via desktop IPC or tests) unfenced, and fake closing delimiters were not escaped.
* **Root Cause:** Relabelling `SYSTEM:` lines without wrapping in `wrapUntrusted` only addresses leading role text while leaving prompt delimiters and adversarial tags open.
* **Rule:** Route all MCP tool output (both formatted text and the JSON.stringify fallback) through `wrapUntrusted` from `@opensand/shared` with `source: "mcp"` and `origin: qualifiedName`. This escapes fake closing delimiters, neutralises `SYSTEM:` lines, bounds length, and ensures the payload arrives inside exactly one fence. Automated with `system-text-guard.test.ts` asserting fence boundaries, delimiter escaping, and single-fence arrival across direct daemon execution and coordinator history.

### 12.8 Incoming app requests via protocol gateways must be attributed and delimiter-escaped before reaching the model
* **Trap:** An incoming AG-UI protocol request forwarded raw user text directly from `latestMessage.content` to `coordinator.runTurn(query)` with no caller attribution or delimiter escaping. A caller or malicious third-party app could pass prompt injections or fake delimiter tags (e.g. `</data_source>`) or supply a hostile `agentId` with embedded newlines and tags that split the attribution header and forged delimiters.
* **Root Cause:** Treating protocol gateway inputs as bare raw user queries without sanitizing caller metadata (`request.agentId`) or escaping untrusted prompt delimiters in the query text.
* **Rule:** Gateway requests carrying user authority must be explicitly attributed (`[App request · <appId>]`) and have their query text escaped via `escapeUntrustedText` before reaching `runTurn`. Caller-supplied identifiers must be stripped of newlines/control characters and escaped so they cannot break attribution headers or forge delimiters. Do not wrap in `<data_source>` fences because authorized app actions carry the user's intent to act, but do prevent delimiter forging and header splitting. Automated with `ag-ui-gateway.test.ts` verifying attribution format, delimiter escaping, newline stripping, and missing agentId fallback.

### 12.9 Delegated sub-agent tasks must be attributed and delimiter-escaped before dispatching to runTurn
* **Trap:** In `delegate_to_agent`, the orchestrator forwarded `args.task` directly to `subCoordinator.runTurn(args.task)`. Because `args.task` is authored by the parent model (which may have consumed untrusted tool or file data), the sub-agent received the delegated task as a plain user-role turn with no attribution, masquerading as the user's direct words. Furthermore, unescaped fake closing tags (e.g. `</data_source>`) or leading `SYSTEM:` directives in the delegated task reached the sub-agent prompt unescaped, and a hostile parent agent name could inject newlines into attribution headers.
* **Root Cause:** Treating delegated subagent tasks as direct user instructions without attributing the calling agent persona or escaping delimiter tags before entering `runTurn`.
* **Rule:** Sub-agent tasks delegated via `delegate_to_agent` must be attributed (`[Delegated task · from <parentName>]`) and escaped with `escapeUntrustedText` before calling `subCoordinator.runTurn`. The parent agent identifier must be sanitized using `sanitizeAttributionId` (stripping CR/LF, control characters, U+2028/U+2029, and escaping delimiter tags, falling back to `"orchestrator"`). Do not fence in `<data_source>` (the sub-agent must still execute the prompt), but prevent delimiter forging, header splitting, and role spoofing. Automated with `agent-store.test.ts` and `untrusted-text.test.ts` verifying task attribution, newline stripping, delimiter escaping, and tool output wrapping.

### 12.10 Git step snapshots require clean ambient environment, committer flags, and ref sanitization
* **Trap:** When capturing workspace snapshots as hidden git refs (`createStepSnapshot`) via `runCommandOperation`, three hurdles occurred:
  1. Under git hooks (such as pre-commit), ambient `GIT_DIR` and `GIT_WORK_TREE` leaked from `process.env` through `sanitizedEnv` in `command-runner.ts`, causing git in non-git fixture directories to target the parent repository and report them as git repos.
  2. In minimal environments or fresh test repositories without global git identity configured, `git commit-tree` failed with "Committer identity unknown".
  3. In Docker containers running as root on Linux (`verify-linux.sh`), `chmod 0o555` directory permissions do not block writes due to `CAP_DAC_OVERRIDE`. Simulating directory update failures portably requires placing a non-directory file along the path to cause `ENOTDIR`.
* **Root Cause:** `command-runner.ts` preserved ambient `GIT_*` variables when merging process environment, `git commit-tree` requires committer details even when creating standalone snapshot commits, and root bypasses POSIX read-only directory permissions.
* **Rule:** Strip all ambient `GIT_*` variables in `command-runner.ts` unless explicitly specified in `input.env`, pass `-c user.name=OpenSand -c user.email=opensand@local -c commit.gpgsign=false` to `git commit-tree`, sanitize ref names using `sanitizeRefName`, and force directory lock failures using blocking files rather than permission bits. Automated with `missions-snapshots.test.ts` verifying snapshots across multi-step missions, state preservation, GC survival, non-git directories, and forced failures.
### 12.11 Preact headless DOM event listener normalization and roving focus microtask batching
* **Trap:** When testing Preact components with a minimal fake DOM mock in Node.js test runners:
  1. Preact diffing checks `"onclick" in node` and `"onkeydown" in node`. If missing on `FakeNode`, Preact preserves camel case (`"KeyDown"` instead of `"keydown"`), causing `addEventListener` and lowercase `dispatchEvent` to mismatch. Furthermore, Preact eventProxy requires `this` to be the target node (`this.l[...]`).
  2. Sequential keyboard dispatches (e.g. `ArrowDown` followed immediately by `Enter`) fail to select the second row when dispatched synchronously in the same tick, because Preact batches hook state updates (`setFocusIdx`) asynchronously.
* **Root Cause:** Preact relies on standard DOM element property presence for event attribute normalization and batches state updates across ticks.
* **Rule:** In custom headless DOM nodes for Preact, wrap property access in a Proxy where `prop.startsWith("on")` returns true, normalize event types to lowercase in `addEventListener` and `dispatchEvent`, invoke listener callbacks with `this` bound to the target node, and await a microtask tick (`setTimeout(r, 10)`) between sequential roving keyboard navigation events. Automated in `inbox-component.test.ts` and `window-harness.test.ts`.

### 12.12 Workspace step snapshot restoration requires isolated index isolation, exclusion of pre-restore trees from future deletion sets, directory symlink write-through defense, and submodule preservation
* **Trap:** When implementing Time Machine workspace step restoration (`restoreSnapshot`):
  1. If the mandatory pre-restore safety snapshot tree ($\mathcal{T}_{\text{pre}}$) is included in the set of later trees ($\mathcal{F}_{\text{later}}$) to compute files to delete, newly created untracked user files present on disk after the mission ended are treated as deletion candidates and unlinked during restore.
  2. Running `git read-tree` or `git checkout-index` during emergency rollback or printing a manual recovery command without `GIT_INDEX_FILE` silently overwrites the user's `.git/index`.
  3. Attempting to sanitize workspace directory symlinks along target snapshot paths by unlinking them destroys user symlinks. Checking out files through directory symlinks risks write-through attacks to external filesystem targets.
  4. Gitlink entries (mode `160000`, submodules) in target snapshot trees cause checkout-index collisions or unwanted recursive checkout if not filtered.
* **Root Cause:** Deletion candidate derivation must differentiate between mission-introduced step snapshots and the ambient pre-restore safety anchor; git porcelain/plumbing commands default to `.git/index` unless redirected via `GIT_INDEX_FILE`; directory symlinks must never be unlinked or traversed; and submodules represent pointers rather than plain files.
* **Rule:** Compute deletion sets $\mathcal{F}_{\text{later}}$ strictly from mission step snapshots $s-j$ with $j > \text{targetSeq}$, completely excluding the pre-restore tree. Run all git plumbing (`read-tree`, `checkout-index`) with an isolated temporary index (`GIT_INDEX_FILE`), including automatic rollback and printed manual recovery commands. If a directory along a target path is an existing symlink on disk, refuse the entire restore before modifying disk, naming the path. Strip gitlink entries (mode `160000`) from the temporary index via `git update-index --force-remove` and leave submodule directories untouched on disk. Automated with `missions-restore.test.ts` verifying C1-C6, mutation probes, git index preservation, symlink refusal, and submodule skipping.

### 12.13 Restoring a mutation probe with `git checkout -- <file>` also discards the uncommitted feature edit
* **Trap:** During a mutation probe of `mission-timeline-model.ts` (uncommitted edits in the same file), `git checkout -- <file>` "restored" the file to HEAD and silently wiped the feature change; the next test run failed for the wrong reason.
* **Root Cause:** The restore command assumed a clean base; the working tree held the only copy of the change.
* **Rule:** Before mutating an uncommitted file, copy it aside (`/bin/cp -f f /tmp/f.bak`) and restore from the copy, then `diff -q` it. Use `git checkout` only on committed files.

### 12.14 Restore UI ships without a file preview or a desktop transport (mission timeline "Restore to this step")
* **Trap:** The engine's `restoreSnapshot` has no dry-run (file lists come back only after the workspace is changed), and `packages/desktop` has no channel to the engine RPC (`main.ts`/`preload.cts` expose no restore method).
* **Rule:** The confirm dialog shows the step summary and the effect, never an invented file list; the renderer calls `window.opensand.restoreMissionSnapshot` and shows an error when it is absent. Do not claim restore works in the packaged app until main/preload wire it to the engine.

### 12.15 A prompt that mixes harness text with caller text must delimit the caller's part
* **Trap:** `AgentCoordinator.askSideQuestion` interpolated the caller's question straight into the BTW prompt, so a question carrying `</data_source>` or a leading `SYSTEM:` line reached the model with the raw structure of the prompt: a forged closing delimiter, or a line the model reads as a system directive. Every other prompt that embeds caller text (the compaction summary, the AG-UI app request, the delegated sub-agent task) had been escaped; this one had not.
* **Root Cause:** The audit followed the tool-output path, where untrusted text is fenced as data, and missed the other family: text that carries intent to act and must stay an instruction but still must not forge structure. Each such site needs its own escaping, and there is no shared seam that applies it for you.
* **Rule:** Every prompt that embeds text from outside the harness escapes that text the same way, even when the text is the user's own and must remain an instruction: escape the delimiters and neutralise `SYSTEM:` lines, never fence it as data (that would neuter the intent). Keep one helper for it (`escapeQuotedText` in `coordinator.ts`) and add a test per site that drives the real prompt and asserts the forged delimiter arrives escaped and the system line is neutralised. Automated with `coordinator.test.ts` ("escapes a hostile side-question so it cannot forge a delimiter or a system line"), verified red on `c7c4002` and by a mutation probe.
### 12.16 Release prep: `docker system prune` does not free images, and a failed zsh glob aborts the whole `rm`
* **Trap:** Two hurdles while reclaiming disk at 97% full (7.0 GiB free) before cutting v0.1.8:
  1. `docker system prune -f` reported `Total reclaimed space: 0B` with 11 images, 0 containers and 4.38 GB marked reclaimable. `docker system prune` only removes *dangling* images; every tagged image survives.
  2. `rm -rf "$wt/node_modules" "$wt"/packages/*/node_modules …` freed 0 KB across 30 worktrees. In zsh an unmatched glob prints `no matches found` and aborts the *whole* command line before `rm` runs, so `node_modules` and 496 MB `dist` trees survived a cleanup whose per-worktree line still printed a success.
* **Root Cause:** `prune` without `-a` is scoped to dangling images, and zsh's default `NOMATCH` makes an unmatched glob a fatal expansion error rather than an empty list.
* **Rule:** Measure on `/System/Volumes/Data` (`df /` reports the read-only system volume and hides the real free space; the data volume said 7.0 GiB while `/` said 4.3 GiB). Reclaim worktree build output with `setopt nullglob` (or bash) and guard each path with `[[ -e ]]`. Do not reach for `docker image prune -a` as a reflex: `node:22-bookworm` is required by `verify-linux.sh`, and other tagged images belong to other projects.

### 12.17 A surviving mutation is a coverage gap, not proof — tighten the fixture until the mutated line is on the executed path
* **Trap:** Two mutation attempts against the Time Machine restore C1 invariant (`computeFilesToDelete` must never unlink user files outside the snapshot's tracked set) both stayed green (11/11):
  1. Deleting `if (untrackedPreFiles.has(file)) continue;` — `missions-restore.test.ts` Test 2 creates its untracked user files *after* the base tree is pinned, so they never reach `filesInLaterSteps` and never hit that guard.
  2. The first version of the new regression test created the file before step 1. `createStepSnapshot`/`treeOf` run `git add -A` into a temporary index, so the file landed in the *target* tree too and the loop exited at `if (targetFiles.has(file)) continue;` — one line above the guard.
  The failing state only appears when a file is present at the base pin, absent from the target snapshot, and present in a later snapshot: create it at mission start, delete it in step 1, recreate and `git add` it in step 2.
* **Root Cause:** `treeOf` uses `git add -A` against a throwaway index, so "untracked" files are in the base tree and in every snapshot taken while they exist on disk. Which `continue` a test exercises depends on exactly when the file exists relative to each snapshot.
* **Rule:** A green mutation proves only that the mutated line was not reached. Re-read the candidate filters in execution order, build the fixture that reaches the mutated line, and re-mutate until it goes red — then the test is the witness. `missions-restore.test.ts` Test 10 (C1) now covers the pre-mission untracked guard and turns red when it is removed.

### 12.18 Artifact Canvas (#82): renderer read fields the engine never sends; gutter in its own scroll box; nested-template escapes
* **Trap:** (1) The renderer's edit_file handler read `target`/`replacement`, but the engine sends `old_string`/`new_string` and returns no file content, so the Code tab showed only the replacement. (2) The line-number gutter sat outside the `<pre>` that scrolled, so numbers stayed fixed. (3) `toggleCanvas`, the header close button and Esc all called the close-all path, dropping every tab. (4) In the real-window test the injected runner lives in a `String.raw` template; `'\n'` and `\d` inside a nested normal template became a real newline and the in-page script died with "Script failed to execute".
* **Root Cause:** Handler written against an assumed event shape; one scroll container per column; hide and close-all sharing one function.
* **Rule:** Drive the real event shape (real-window test sends tool_call/tool_result over `opensand:event`). Gutter and code share ONE scroll container with a sticky gutter. Hiding the panel never touches tabs (`hideCanvas`); only `closeTab`/`closeArtifact` remove them. In injected runners use `String.fromCharCode(10)` and `[0-9]`, never backslash escapes. Closed in 12.19: the bridge now has `readWorkspaceFile`.

### 12.19 Restore wiring + file read: the engine is not embedded in the desktop; a mutation survived on a redundant guard; `cp` prompted mid-probe
* **Trap:** (1) The desktop shell had no path to the mission engine's `restoreSnapshot` (the engine is a separate stdio-RPC package and the desktop did not depend on it), so the shipped Restore button said "not available in this build". (2) A first mutation probe on `readWorkspaceFile` (dropping the lexical `inside()` gate) stayed green because the later `realpath` check refuses the same paths; but without the gate an outside path that does not exist answers `not_found`, which leaks what exists elsewhere. (3) In a restore-then-probe command, `cp` hit an interactive-overwrite alias and the whole call hung until the shell limit, losing its output; an earlier `sed` that removed one line of a two-line object entry broke the preload's syntax and `tsc` failed while stale `dist` still ran.
* **Root Cause:** A feature built in the renderer against a bridge call nobody implemented; two checks covering the same outcome with different side effects; shell aliases and line-oriented edits on multi-line constructs.
* **Rule:** Reuse the engine's own handler (`createMissionHandlers(new MissionRunnerManager(stateDir))['mission.Missions.restoreSnapshot']`) through a workspace dependency, never a second engine; trust and active-mission gates stay the engine's. The running-mission check only sees the restored mission's own log, not another process's missions on the same workspace (known gap). The restore deletes only files that appear in later snapshot trees, so test with a file created in an earlier step. Test the file read for `..`, foreign absolute paths, file and directory symlinks out, a sibling `<root>-evil`, and nonexistent outside paths (must say `outside`). In probes use `command cp -f` and `diff -q`, and run `tsc` and check its exit before trusting a red. Automated: `workspace-file-read.test.ts`, `mission-restore.test.ts`, `canvas-unseen-edit.test.ts`, `restore-real-window.test.ts` (real engine mission, real Electron, files read from disk). Both mutants of the read confinement now go red.

### 12.20 `mktemp` ignores `$TMPDIR` inside the workspace-write seatbelt profile, so a custom TMPDIR fails the sandbox test
* **Trap:** `SKIP_INSTALL=1 TMPDIR=$(mktemp -d) bash scripts/verify.sh` failed on 8e04979 in `packages/local-exec-daemon` `sandbox-macos.test.ts` "succeeds for temp directory writes and mktemp (Test 3 extension)": actual stdout was only `node_wrote_ok`, expected also `temp_ok`. Run twice, the same test passes with the default TMPDIR and fails with a custom one, so it looks like a regression in the release being cut.
* **Root Cause:** `buildMacosProfile` allowlists write paths from `tempDir ?? process.env.TMPDIR ?? os.tmpdir()` (`macos-profile.ts:100`), so with a custom TMPDIR only that subdirectory is writable. `mktemp` does not honour `$TMPDIR` for its default template on macOS: it falls back to the per-user temp root `/var/folders/<xx>/<hash>/T/`, which is now outside the allowlist. The shell fails with `mktemp: mkstemp failed on /var/folders/…/T/tmp.XXXX: Operation not permitted`, so `echo temp_ok > "$TFILE"` never runs, while the following `node -e` writes to `os.tmpdir()` (= the custom TMPDIR, allowlisted) and succeeds — hence a green `node_wrote_ok` and an exit code of 0.
* **Rule:** Diagnose a sandbox test by running it twice, once with the default TMPDIR and once with `TMPDIR=$(mktemp -d)`; a default-only pass is a fixture/profile mismatch, not a product regression. Fixtures that need a temp file inside the sandbox should write to `os.tmpdir()` (or an explicit path) rather than rely on `mktemp` defaults. Note the product consequence: an agent command that runs bare `mktemp` is denied whenever OpenSand runs with TMPDIR set to a subdirectory, which is common in CI and containers — worth a deliberate decision (allow the per-user temp root, or document the constraint) rather than a test-only fix.

### 12.21 Widening a sandbox allowlist silently disarms the containment tests that lived inside it
* **Trap:** Allowing the per-user temp root in the macOS workspace-write profile (so macOS's `mktemp`, which ignores `$TMPDIR`, stops failing under a custom TMPDIR) turned three passing containment tests red: "fails when writing outside the workspace", "names the path a write outside the workspace was refused at" and the macOS PTY "write outside the workspace" cases. All three built their "outside" fixture under `os.tmpdir()` — the very directory that had just become writable — so their escape file was created and the test failed. The same fixtures made the *new* "a write outside the allowlist is still denied" test pass on the unfixed tree, which proves it was not testing the allowlist.
* **Root Cause:** A containment test's fixture must be outside every writable path, and the writable set changed underneath it. `os.tmpdir()` is not a neutral place: on macOS it is the per-user temp root, which the sandbox now allows.
* **Rule:** When a sandbox allowlist widens, re-check every test that proves containment: move its fixture to a location that is still outside the allowlist (the system temp, `/tmp`, on macOS) and assert the target does not exist afterwards. Never place a "must be denied" target under a path the sandbox permits. A containment test that also passes before the change is not evidence. Automated with `sandbox-macos.test.ts` ("sandboxed mktemp works when TMPDIR points at a subfolder", "still denies a write outside the workspace and the temp areas"), red on `8a98cbf` and by a mutation probe that drops the per-user temp root.

### 12.22 Fixed shared log directory in `scripts/verify.sh` clobbered parallel runs; fixed with per-run `mktemp -d`
* **Trap:** Running two instances of `scripts/verify.sh` concurrently (e.g. parallel runs or background tasks sharing a temp folder) caused one run to wipe or overwrite the other's test logs, leading to corrupted output, masked failure diagnostics, or false zero-test failures.
* **Root Cause:** `scripts/verify.sh` used a static path `LOG_DIR="${TMPDIR:-/tmp}/opensand-verify"` and wiped it with `rm -rf "$LOG_DIR"; mkdir -p "$LOG_DIR"`. Concurrently running processes shared the exact same per-package log paths (`@fake__target.log`), overwriting each other's test output mid-suite.
* **Rule:** Never use static un-isolated directories in `TMPDIR` for logs or workspaces. Use `LOG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/opensand-verify.XXXXXX")`. On failure, print both the unique log directory (`verify error: Log directory: $LOG_DIR`) and the per-package log file (`verify error: Full output: $log`). Enforced by `scripts/verify-selftest.sh` with a parallel-runs test case that runs concurrent passing and failing suites sharing `TMPDIR` and proves log isolation.

### 12.23 Time Machine restore preview (#90): factoring restore without ref creation; protocol method count guard; witness invariant
* **Trap:** Adding `mission.Missions.previewRestore` to `METHODS` in `@opensand/protocol` caused `packages/protocol/test/names.test.ts` to fail because it asserted `METHODS.length === 22`.
* **Root Cause:** `@opensand/protocol` tests maintain an exact guard on the number of registered RPC methods to prevent accidental drift.
* **Rule:** When registering a new RPC method in OSP, update `names.test.ts` expected count and assert `isKnownMethod` for the new method. Ensure preview shares Phase 1 target resolution and Phase 3 deletion computation with `restoreSnapshot` through factored helpers (`resolveAndValidateRestoreTarget`, `computeFilesToDelete`), capturing the workspace tree via a temporary index (`treeOf`) so refs, `.git/index`, files, and logs remain completely untouched (verified by read-only witness tests and mutation probes).

### 12.24 Restore preview UI: Preact `eventProxy` `this` binding in headless FakeNode; matching confirm dialog buttons to preview groups and zero-changes state
* **Trap:** In headless Preact component testing with a minimal DOM `FakeNode`, calling `cancelBtn.click()` did not call the `onClick` handler because `dispatchEvent` invoked `this._listeners[type.toLowerCase()](event)` where `this` became the plain `_listeners` dictionary rather than the `FakeNode` element. Preact's internal `eventProxy` expects `this._listeners[event.type]` on the target element itself.
* **Root Cause:** Calling `this._listeners[type](e)` lost the element `this` context for Preact's event handler dispatch.
* **Rule:** In minimal headless DOM implementations for Preact, invoke `this._listeners[event.type.toLowerCase()]?.call(this, event)`. Ensure the preview dialog displays deleted files first with warning styling, isolates changed back and recreated files into dedicated sections, suppresses the Confirm button on zero changes or error, and traps focus with Escape cancellation.

### 12.25 Intermittent failure in real-window canvas test (#82): waiting on fixed sleeps instead of settled DOM state
* **Trap:** In CI run 43807118873 on macOS, `Canvas #82 in the real Electron window` failed with `AssertionError: the edit is visible in the full file` (`actual: false, expected: true`) at `canvas-real-window.test.ts:149`. The test passed on Linux and in subsequent runs, exhibiting an intermittent race condition.
* **Root Cause:** In `packages/desktop/test/canvas-real-window.test.ts:87`, the runner dispatched `edit_file` over Electron IPC (`win.webContents.send('opensand:event')`) and then waited on a fixed delay `await sleep(500)` before sampling `js(STATE)`. Under heavy CI load, the Chromium renderer had not yet processed the IPC message and rendered the highlighted 1,500 lines into `#canvasCodeContent` when the 500ms elapsed. Consequently, the canvas code pane still displayed the unedited `write_file` content (`tabs === 1`, `codeLines === 1500`, but `codeHasMarker === false`).
* **Rule:** Never use fixed delays (`await sleep(N)`) or retry loops to wait for UI updates in real-window / browser tests. Wait for the real settled state via an in-page predicate (e.g. `await wait("document.querySelector('.canvas-code-pre') && document.querySelector('.canvas-code-pre').textContent.includes('EDITED_MARKER')")`). Replace every fixed sleep in the interaction flow with explicit settled DOM condition checks (file content loaded, marker present, tab count reached, scroll position reached, canvas hidden/shown). Demonstrated the failure deterministically by lowering sleep to 0ms, and verified 20/20 consecutive passes locally.

### 12.26 Packaged app launch verification must not run when installed app is running or sharing `~/.opensand`
* **Trap:** Attempting to launch an unpacked Electron bundle from a temporary directory while the user has an installed OpenSand application running causes `app.requestSingleInstanceLock()` to reject the launch and refocus/activate the user's running app window. Furthermore, `DesktopApp` and `DesktopServer` default to `~/.opensand`, risking contamination or mutation of the user's active session state, auth tokens (`server.token`), and state migrations.
* **Root Cause:** Electron's single-instance lock (`app.requestSingleInstanceLock()`) is scoped to the application identifier and triggers the primary instance's `second-instance` handler rather than running isolated. In addition, `DesktopApp` instantiated in `main.ts` does not parse command-line flags (such as `--base-dir`) or check an environment variable override for `baseDir` before starting `DesktopServer`.
* **Rule:** Before attempting local release bundle execution, verify whether an instance is already running (`pgrep -lf OpenSand`) and whether state isolation is supported. If a running instance is detected or the runtime hardcodes the user's home state folder (`~/.opensand`), skip launch verification with explicit justification rather than interfering with the user's workspace or running application.

### 12.27 Time Machine fork engine RPCs (#95): witness git invariant verification, no-op fork check, lineage ref placement, and macOS shebang AUTH_EXEC trap
* **Trap 1 (macOS shebang AUTH_EXEC trap):** When creating temporary mock executable scripts in tests (e.g. `shim-bin/git`) on macOS with Endpoint Security active (such as `com.nordvpn.macos.Shield`), starting the file with `#!/bin/sh` causes macOS kernel Endpoint Security to intercept the execution (`AUTH_EXEC`) and hang indefinitely waiting on authorization checks on the untrusted temp script.
* **Root Cause 1:** The macOS kernel authorization daemon blocks process launch on untrusted temporary files executed via shebang interpreters. When the shebang `#!/bin/sh` is omitted, the kernel returns `ENOEXEC` upon execution, causing `bash`/`sh` subshells to execute the script directly as shell commands without invoking dyld shebang auth checks, executing in milliseconds instead of deadlocking.
* **Rule 1:** When scaffolding temporary executable shims or test commands on macOS test suites, avoid `#!/bin/sh` shebangs in dynamically generated scripts under temp directories, or execute them via explicit shell invocation.
* **Trap 2 (Time Machine fork git-invariants & lineage refs):** Forking a mission must restore workspace files to an earlier step's tree without modifying any existing git refs, branch pointers, git stash, or `.git/index`. Furthermore, the new mission must establish lineage refs (`refs/opensand/missions/<id>/base` pointing to the parent step's tree and `refs/opensand/missions/<id>/fork-parent` pointing to the parent mission) and reject no-op forks where the target step is already the latest completed step.
* **Root Cause 2:** In-place restoration risks mutating `.git/index` or workspace git state unless performed using a temporary index (`GIT_INDEX_FILE`) and verified against byte-identical witness invariants (`.git/HEAD`, `.git/refs/heads/*`, `sha256(.git/index)`, and stash list).
* **Rule 2:** In Time Machine fork, verify that workspace file tree matches target step while preserving git repository invariants byte-for-byte; reject no-op forks with `-32602` when target step is the latest completed step; and atomically write lineage refs and the `mission.forked` event before starting execution.

### 12.28 Smoke gate integrity: launch shipped artifact directly (#97)
* **Trap:** A smoke gate must launch the shipped artifact; injecting repo code or a repo runtime turns it into a false pass.
* **Root Cause:** When an unpacked packaged app failed to initialize in an ad-hoc temp directory under macOS traced execution or predated native smoke mode, falling back to launching the repository Electron binary (`packages/desktop/node_modules/.bin/electron`) or injecting updated repository entrypoints (`dist/src/main.js`) caused the test to verify workspace code rather than the shipped binary artifact.
* **Rule:** Packaged smoke tests must execute the shipped application executable (`$APP_DIR/Contents/MacOS/OpenSand`) directly without runtime shims or repo code overrides. If a bundle predates isolated state and smoke mode, exit non-zero with `UNVERIFIED` (exit 2) rather than falsifying verification by executing local workspace code.

### 12.29 Automated PR gate and hermetic selftest harness
* **Trap:** Pre-merge review scripts that create checkpoint tags and merge pull requests must strictly verify tag integrity on the remote origin before issuing the merge command. Relying solely on `git push` exit status leaves an unverified window where a push failure, existing tag collision, or network race leaves the repository without a valid pre-merge checkpoint tag. In addition, when writing mock test shims on macOS with active Endpoint Security (`Shield`), scripts starting with `#!/bin/sh` hang on `AUTH_EXEC` interception (Rule 12.27), and directory label mismatches (`_` vs `-`) silently bypass mock data.
* **Root Cause:** A pre-merge gate must treat tag creation and remote existence as an atomic pre-condition for merging: if `git ls-remote --tags origin <tag>` does not return the exact commit SHA of `origin/main`, the merge must abort immediately.
* **Rule:** `scripts/pr-gate.sh` enforces the 5-step pre-merge sequence: (1) PR is OPEN, MERGEABLE, and both Linux and macOS CI jobs report SUCCESS (exiting 3 if pending); (2) PR baseRefOid matches `origin/main` exactly; (3) diff contains no forbidden lockfiles, `.github/` files, or binaries unless overridden with `--allow-lockfile`/`--allow-binary`; (4) checkpoint tag `checkpoint/<YYYY-MM-DD>/main-before-pr-<N>` is created, pushed, and confirmed via `git ls-remote --tags origin <tag>` to point at the current main SHA; (5) only then `gh pr merge --merge` is executed and the merge commit printed. Selftest harness must be completely hermetic with shebang-free test stubs.

### 12.30 Automated release pipeline and staged execution
* **Trap:** Multi-stage release automations must remain resilient to asynchronous CI gates, handle artifact verification cleanly, and avoid destructive local installation. If a release script attempts to execute all steps synchronously without handling pending bump PR CI, it forces manual step restarts or leads to untracked tag collisions.
* **Root Cause:** Releasing involves coordinating across git branches, GitHub PR checks, tag creation, artifact build/download, smoke checks, DMG plist inspection, and local install. If intermediate gates fail or require async wait (e.g. bump PR CI pending), the script must cleanly propagate exit 3 with instructions to resume later, and smoke test failures must propagate exit 2 rather than continuing.
* **Rule:** `scripts/release.sh` executes the 8 release steps sequentially with `--dry-run` inspection and optional `--install`. When checking bump PR CI, exit 3 signals pending CI. When verifying smoke checks, exit 2 halts release immediately. DMG Info.plist `CFBundleShortVersionString` is verified before any installation occurs. When `--install` is supplied, any existing local application at `/Applications/OpenSand.app` is archived to `~/dev/_archive/<date>-OpenSand-<old-version>/` before installing the newly built bundle and stripping quarantine attributes.
### 12.31 Safe disk reclamation and scratch worktree garbage collection
* **Trap:** Automated disk reclamation scripts run the risk of purging active development worktrees, dirty branches, or critical project installations if scoping is broad or lacks rigorous pre-flight validation.
* **Root Cause:** In agentic workflows, multiple scratch worktrees are spawned under `~/dev/_scratch/*`. Some may contain active uncommitted edits or unmerged experimental branches. Deleting build artifacts (`node_modules`, `dist`) indiscriminately can corrupt in-flight agent sessions or discard uncommitted debugging state.
* **Rule:** `scripts/clean-disk.sh` enforces a strict fail-closed safety gate: (1) default is dry-run, requiring explicit `--yes` to delete; (2) strictly forbid touches to `~/dev/opensand`, `~/.opensand`, or `/Applications/OpenSand.app`; (3) worktrees in `~/dev/_scratch/*` must pass both `git status --porcelain` (dirty check) and `git merge-base --is-ancestor HEAD origin/main` (merged check) before any `node_modules` or `dist` candidate is deleted; (4) displays `df -h /` before and after cleanup.
### 12.32 Scripts directory catalog integrity and selftest enforcement
* **Trap:** As operational automations and gatekeepers grow, orphan or undocumented scripts proliferate, their triggers and exit codes become ambiguous, and critical pre-merge or release gates risk being added without hermetic verification suites.
* **Root Cause:** Without an enforced catalog and verification check, developers and coding agents accumulate ad-hoc scripts in `scripts/` without clear owners, triggers, or selftests.
* **Rule:** All executable and automation scripts in `scripts/` must be cataloged in `scripts/README.md` specifying purpose, usage, exit codes, selftest, and trigger. Furthermore, all gate and critical release scripts (`*-gate.sh`, `release.sh`, `clean-disk.sh`, `verify.sh`, `check-scripts-catalog.sh`) must provide a corresponding hermetic selftest (`*-selftest.sh`). This is enforced automatically in `scripts/verify.sh` via `scripts/check-scripts-catalog.sh`.

### 12.33 Unified worktree lifecycle automation and shared safety predicate
* **Trap:** When multiple bots and developers create ad-hoc scratch worktrees manually, stale branches accumulate, review worktrees risk colliding with active feature branches, and different cleanup tools implement inconsistent dirty/merged checks.
* **Root Cause:** Without a centralized lifecycle CLI (`scripts/worktree.sh`) and a shared safety helper (`scripts/lib/worktree-safety.sh`), cleanup tools (`clean-disk.sh`, `worktree.sh done`, `worktree.sh prune`) implement duplicated or divergent safety checks, increasing the risk of deleting uncommitted changes or active experimental branches.
* **Rule:** All bot and developer worktrees under `~/dev/_scratch/*` must be managed via `scripts/worktree.sh`: (1) `new <job-name>` bases strictly on `origin/main` (fetching origin first), refusing if path or branch already exists or if disk space is < 3 GB after cleanup; (2) `review <PR>` creates a detached, read-only review worktree; (3) `done <job-name>` and `prune` delete worktrees only if clean and merged into `origin/main` using the shared `scripts/lib/worktree-safety.sh` helper; (4) `list` displays real-time branch, dirty status, merge status, disk size, and commit dates across all active worktrees.

### 12.34 Time Machine Fork UI: real-window verification, test stash isolation, Preact input event debouncing, and git index invariants
* **Trap 1 (git stash push -u rolled back uncommitted mission files in test):** In `fork-real-window.test.ts`, running `git stash push -u -m "user stash"` after running the scripted mission stashed the uncommitted mission files (`file.txt` and `extra.txt`), accidentally rolling the workspace back to the initial commit (which was already step 1). The subsequent fork request on step 1 was rejected by the engine with `No-op fork: workspace is already at the target snapshot`.
* **Root Cause 1:** `git stash push -u` stashes all uncommitted and untracked changes across the entire workspace. Because the scripted mission wrote files directly to the working directory without git-committing them, stashing them wiped the mission's working changes.
* **Rule 1:** When testing git stash preservation during workspace restore/fork, capture the user stash *before* running the scripted mission (or stash isolated files specifically) so that the mission's uncommitted modifications remain present in the working tree for the restore/fork operation to act upon.
* **Trap 2 (Preact `input` state updates in headless `FakeNode` tests):** Dispatching an `input` event on `<textarea class="fork-instruction-input">` in `FakeNode` and immediately clicking the confirm button resulted in `newInstruction` being `undefined` because Preact batches DOM updates across microtasks/frames.
* **Root Cause 2:** Preact's hook state update (`setInstruction`) is processed asynchronously in the microtask queue.
* **Rule 2:** In headless Preact component testing with synthetic DOM events, insert a brief microtask delay (`await new Promise((r) => setTimeout(r, 20))`) between dispatching input change events and triggering action buttons that read component state.
### 12.34 Merge when green, and never clean a live worktree
* **Trap:** PR #98 was reviewed and declared finished while its macOS CI job was still running, so the merge was done by hand later; and `worktree.sh prune` / `clean-disk.sh` judged a worktree only by "clean and merged", so a worktree with an open PR or an agent editing gitignored files could be cleaned under its owner.
* **Root Cause:** The gate refused pending CI (exit 3) but offered no way to wait for it, so the wait became a manual step that gets skipped. The cleanup predicate had no notion of "in use": ignored files (`node_modules`, build output) never make `git status` dirty.
* **Rule:** `scripts/pr-gate.sh --when-green [--timeout <min>] <PR>` watches CI with `gh pr checks --watch` (default 40 min, then exit 3), exits 1 naming the failing job if CI is red, and only then runs the normal 5 checks. `scripts/lib/worktree-safety.sh` defines a live worktree (branch has an OPEN PR, or any file outside `.git` changed in the last 120 minutes, or the open-PR state cannot be read) and `worktree.sh prune` and `clean-disk.sh` skip it. Selftests prove each branch of the rule, and `scripts/mutation-probe.sh` proves the selftests can fail.

---

### 12.35 Phase 8 S4 resume: interrupt damage, target labels and the suite's old contract
* **Trap 1:** The interrupted run left `target-workspace.ts` importing `cleanGitEnv` from `workspace.ts` (it lives in `workspace-diff.ts`) and resolving the target bundle four levels up (`packages/dist/target` instead of `dist/target`); the build failed on a missing symbol and the container would have mounted a non-existent bundle.
* **Root Cause 1:** The run stopped mid-edit (OpenCode Go's 5-hour limit), so the WIP was syntactically complete but inconsistent with the modules it referenced.
* **Rule 1:** After resuming a WIP, build before adding new code, then fix the imports and path constants at their source; save the recovered WIP first so a wrong edit cannot discard it.
* **Trap 2:** The first container-suite run was `verified` but the receipt's target `result` was `applied` instead of `bind`; the single assertion failed while the mission itself passed.
* **Root Cause 2:** `emitTarget("apply", …)` hard-coded `result: "applied"` for every non-local workspace, overriding the container's derived `bind` label.
* **Rule 2:** Derive the receipt's target result from the workspace kind at the one emission site; keep the container/session identity in the harness event, never in agent output.
* **Trap 3:** `mission-suite-selftest.sh` still asserted the S1 contract that container and ssh exit 2, so the new target modes would have broken verification.
* **Root Cause 3:** Changing a script's argument contract without updating its selftest leaves a green suite with a stale gate.
* **Rule 3:** When a script's exit-code or argument contract changes, update its selftest in the same change and run it before merging.

### 12.36 Phase 8 S5 Linux build hurdles (2026-11-19)
* **Trap → cause → rule:** electron-builder derived an unsafe `executableName` and a nested `.deb` path from the staged scoped package `@opensand/desktop`, and fpm wanted a maintainer/homepage → set `executableName`, `linux.maintainer`, `extraMetadata.homepage` and `deb.artifactName` in `electron-builder.yml` ([lesson](docs/lessons/2026-11-19-electron-builder-linux-scoped-package.md)).
* **Trap → cause → rule:** a Mach-O helper still shipped inside the Linux `.deb` through `node_modules` after `extraResources` moved under `mac` → add a Linux-only `files` exclusion and keep the Mach-O gate in `smoke-linux.sh` ([lesson](docs/lessons/2026-11-19-linux-package-ships-macos-helpers.md)).
* **Trap → cause → rule:** the extracted packaged Electron app aborted on its setuid sandbox → the smoke launches it with `--no-sandbox` ([lesson](docs/lessons/2026-11-19-packaged-electron-smoke-needs-no-sandbox.md)).
* **Trap → cause → rule:** apt in a bare `ubuntu:22.04` container failed over HTTP and had no CA certs for HTTPS → seed the host CA bundle, switch sources to HTTPS, clear apt lists ([lesson](docs/lessons/2026-11-19-ubuntu-container-apt-needs-ca-certs.md)).
* **Trap → cause → rule:** a selftest mock logged `$*` after parsing shifted it away, so every pattern assertion failed → log raw arguments first ([lesson](docs/lessons/2026-11-19-mock-logs-args-before-shift.md)); wrapping an `if` block added a stray `fi` → read real boundaries and run `bash -n` ([lesson](docs/lessons/2026-11-19-wrap-branch-read-real-boundaries.md)).

### 12.37 Bot real-window tests took over the owner's screen (2026-11-24)
* **Trap:** Five bots ran desktop real-window tests at once; each spawned Electron directly, so visible windows popped up continuously, stole focus and added Dock icons, and the owner could not work. Pre-commit ran the same suite on every commit.
* **Root Cause:** There was no hidden-launch mode in `main.ts`, no single shared env helper for Electron spawns, no gate against bypassing that helper, and no skip for real-window tests in the commit hook.
* **Rule:** All automated Electron launches build their env with `hermeticElectronEnv()`, which sets `OPENSAND_HIDDEN_WINDOW=1`; `main.ts` then creates a hidden, non-focusable window, hides the Dock icon and skips the tray on macOS. `scripts/check-hidden-window-spawns.sh` (with selftest, in `verify.sh`) fails on a bypass, and pre-commit skips real-window tests unless `OPENSAND_PRECOMMIT_REAL_WINDOW=1`. Screenshots use `webContents.capturePage()`, never a screen grab. [checked: scripts/check-hidden-window-spawns-selftest.sh, packages/desktop/test/hidden-window.test.ts]

### 12.38 A bridge that starts async work in its constructor must await it in close()
* **Trap:** Main CI went red on macOS right after PR #209 merged (`workspace-default.test.ts`, `ENOTEMPTY` on the temp home) while the same PR's own macOS job had passed. Raising `maxRetries` on the test's `rmSync` did not help.
* **Root Cause:** `DesktopIpcBridge` fired `ensureApiKeyResolved()` without a handle; the vault directory mkdir it starts landed after `close()` resolved and during the test's `rmSync`, recreating an entry under the directory being removed. rimraf's sync retries do not wait for a pending promise.
* **Rule:** Any work a constructor starts without awaiting is stored on the instance and awaited in `close()`. Tests that own a bridge or server remove their temp dir with `closeThenRemove()` from `packages/desktop/test/teardown.ts`, and `scripts/check-test-teardown.sh` fails when one does not ([lesson](docs/lessons/2026-11-24-main-ci-red-after-pr-209-merge.md)).

New lessons are not added here any more: one file each in [`docs/lessons/`](docs/lessons/INDEX.md) (index generated by `scripts/lessons-index.sh`), so concurrent PRs never conflict on this file. Everything above stays as written.

---

### 12.37 CI security gates hurdles (2026-11-24)
* **Trap → cause → rule:** `scripts/worktree.sh new` refused to run because the shared base clone had an untracked lesson file left by another agent. The base is intentionally required to stay clean, and that file was not mine to remove. → Point `OPENSAND_BASE_DIR` at a fresh scratch clone so the script clones cleanly and the teammate's untracked file is left untouched.
* **Trap → cause → rule:** fetching the gitleaks release with `curl` from a plain shell timed out at 120 s with zero bytes downloaded. → Use `gh release download <tag> --repo gitleaks/gitleaks --pattern '<asset>' --clobber` (authenticated, fast) and still verify the published SHA-256 before use.
* **Trap → cause → rule:** `git ls-remote refs/tags/v4` returns the *tag object* SHA for annotated tags, not the commit SHA; pinning an action to it breaks `uses:`. → Resolve with `refs/tags/v4^{}` and pin the dereferenced commit (this is why `pnpm/action-setup` uses `b906aff…`, not `f40ffcd…`).
* **Trap → cause → rule:** two full `verify.sh` runs failed only in unrelated real-window tests: one screenshot test lost a race with other Electron windows in the parallel phase (passes in isolation), and `account-shortcuts-real-window.test.js` tripped the 120 s per-file ceiling (430/430 functional tests passed). A full run also rewrites two tracked artifact PNGs. → Treat these as environment flakiness, restore `packages/desktop/artifacts/*.png` after any full run, and judge the change by the named failing test run alone before spending another 15+ minutes on a full rerun.

### 12.38 Local test runs must not open Electron windows on the owner's Mac (2026-11-24)
* **Trap → cause → rule:** `pnpm test` (the default precommit command and part of `verify.sh`) recurses into `packages/desktop`, whose `scripts/desktop-test.js` launches all 22 `*-real-window.test.js` files one at a time in real, visible Electron windows; the constant pop-ups stop the owner from working. → Never run real-window tests or a full `verify.sh` locally. Set `OPENSAND_PRECOMMIT_TEST_CMD="pnpm --filter <touched package> test -- --test-name-pattern='^(?!.*real-window)'"` for the commit, never use `--no-verify`, and push so GitHub Actions runs the real-window tests — the CI run id is the proof. If a brief asks for a real-window test, still write it and say "run in CI only, until the hidden-window mode lands" in the PR body. `OPENSAND_SMOKE=1` already exists in `packages/desktop/src/main.ts` (`show: !isSmoke`, `focusable: !isSmoke`) and is the seed Dex's hidden-window mode will build on.
