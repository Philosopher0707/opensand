# Step 3 Pluggable Driver Architecture & Builder Implementation Brief

**Author:** Ada (AI Systems Architect)  
**Date:** 2026-11-25  
**Status:** Decided & Build-Ready (Execution Brief for Dex and Nova)  
**Parent Architecture:** [OpenSand Architecture v2](architecture-v2.md), [External Coding Engines](external-engines.md), [Batch Merge Train](batch-merge-train.md)

---

## 1. Executive Summary & Context

In OpenSand Architecture v2 (`docs/design/architecture-v2.md` §1 & §2.1), the system transitions from ad-hoc coding-agent execution to a decoupled, declarative engine architecture modeled on OpenMausBot (`server/engine-versions.ts:25`, `server/runtime/capabilities.ts:20`).

Currently, external engine execution is routed through a monolithic class in `packages/coordinator/src/engines/external-engine-runner.ts`:
- `ExternalEngineTurnRunnerOptions` (`packages/coordinator/src/engines/external-engine-runner.ts:14`)
- `ExternalEngineTurnRunner` (`packages/coordinator/src/engines/external-engine-runner.ts:27`)
- `detectEngines` (`packages/coordinator/src/engines/external-engine-runner.ts:347`)
- Engine types in `packages/coordinator/src/engines/types.ts:1` (`ExternalEngineConfig`, `EngineDetectionResult`)

While this monolithic runner proved the initial slice-1 execution with Claude Code and vendored wrapper scripts, it exhibits four severe architectural bottlenecks:
1. **Hardcoded Engine Branching:** New engines require modifying internal `switch`/`case` branches and vendor wrapper mappings inside `external-engine-runner.ts`.
2. **Missing Capability Matrix:** The coordinator and UI cannot inspect whether a configured engine supports thread resumption, subagent nesting, autonomous review loops, or dynamic model discovery without executing a turn.
3. **Implicit Process Management:** Subprocess lifecycle and process-group isolation (`-$PGID`) are handled ad-hoc, risking orphaned child processes on turn timeouts or user aborts.
4. **Tight IPC Coupling:** `packages/desktop/src/ipc-bridge.ts:786` calls `detectEngines()` directly, bypassing runtime driver registration and dynamic discovery.

This specification formalizes the Step 3 architecture into declarative driver interfaces, a central `DriverRegistry`, an `ENGINE_VERSIONS` pin matrix, an `ENGINES` capability matrix, and dedicated drivers (`ClaudeDriver`, `OpenCodeDriver`, `OpenAIDriver`, `CustomAcpDriver`). It provides 2 non-overlapping builder PR briefs allowing Dex and Nova to implement the driver subsystem in parallel once PR #266 lands.

---

## 2. Declarative Driver Architecture

The target architecture replaces the monolithic runner with a modular driver registry:

```mermaid
flowchart TD
    subgraph IPCBridge["packages/desktop/src/ipc-bridge.ts:786"]
        Bridge["IPCBridge.detectEngines()"]
        RunQuery["IPCBridge.sendQuery()"]
    end

    subgraph Coordinator["packages/coordinator/src/coordinator.ts"]
        AgentCoord["AgentCoordinator.runExternalEngineTurn()"]
    end

    subgraph DriverRegistryModule["packages/coordinator/src/engines/registry.ts"]
        Registry["DriverRegistry (Singleton)"]
        PinMatrix["ENGINE_VERSIONS Pin Matrix"]
        CapMatrix["ENGINES Capability Matrix"]
    end

    subgraph DriverInterface["packages/coordinator/src/engines/driver.ts"]
        EngineDriver["<<interface>> EngineDriver"]
    end

    subgraph Drivers["Dedicated Engine Drivers"]
        Claude["ClaudeDriver (CLI stdio)"]
        OpenCode["OpenCodeDriver (CLI / ACP)"]
        OpenAI["OpenAIDriver (HTTP / SSE)"]
        CustomACP["CustomAcpDriver (Universal ACP)"]
    end

    subgraph ProcessLifecycle["packages/coordinator/src/engines/process-group.ts"]
        PG["ProcessGroupManager (Detached -$PGID Kill)"]
    end

    Bridge -->|detectAll()| Registry
    RunQuery --> AgentCoord
    AgentCoord -->|get(engineId)| Registry

    Registry --> PinMatrix
    Registry --> CapMatrix
    Registry --> EngineDriver

    EngineDriver <|.. Claude
    EngineDriver <|.. OpenCode
    EngineDriver <|.. OpenAI
    EngineDriver <|.. CustomACP

    Claude --> PG
    OpenCode --> PG
    CustomACP --> PG
```

### 2.1 EngineDriver Interface

Every engine is governed by a declarative interface defined in `packages/coordinator/src/engines/driver.ts`:

```typescript
import type { TurnEvent, ChatMessage, SessionMetadata, ApprovalHandler } from "../types.js";
import type { LocalExecDaemon } from "@opensand/local-exec-daemon";
import type { HookDispatcher } from "../hooks.js";
import type { TranscriptManager } from "../transcript-manager.js";
import type { ModelDiscovery } from "./model-discovery.js";
import type { EngineCapabilities } from "./capabilities.js";
import type { EngineVersionPin, EngineVersionReport } from "./versions.js";
import type { EngineDetectionResult, ExternalEngineConfig } from "./types.js";

export type EngineId =
  | "claude"
  | "codex"
  | "copilot"
  | "antigravity"
  | "opencode"
  | "workbuddy"
  | "openai-compat"
  | "custom-acp";

export interface DriverTurnParams {
  sessionId: string;
  workspaceDir: string;
  userQuery: string;
  transcript: TranscriptManager;
  config: ExternalEngineConfig;
  daemon?: LocalExecDaemon;
  hookDispatcher?: HookDispatcher;
  onApprovalRequired?: ApprovalHandler;
  onEvent?: (event: TurnEvent) => void;
  systemPrompt?: string;
  sandboxProfile?: "read-only" | "workspace-write" | "full";
}

export interface DriverTurnResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number; costEstimateUsd?: number };
  sessionTainted?: boolean;
}

export interface EngineDriver {
  /** Unique engine identifier matching config.engine */
  readonly id: EngineId;
  /** Human-readable display name */
  readonly label: string;
  /** Primary vendor or protocol provider */
  readonly provider: string;
  /** Static capability flags */
  readonly capabilities: EngineCapabilities;
  /** Pinned version constraints and probe configuration */
  readonly versionPin: EngineVersionPin;

  /** Probe local environment for binary installation and version compatibility */
  detect(): Promise<EngineDetectionResult>;

  /** Perform active handshake to determine runtime version status */
  probeVersion(): Promise<EngineVersionReport>;

  /** Discover available models dynamically via CLI probe or remote endpoint */
  discoverModels(): Promise<ModelDiscovery>;

  /** Execute a single turn within the engine's execution context */
  runTurn(params: DriverTurnParams, signal?: AbortSignal): Promise<DriverTurnResult>;

  /** Abort any running process or child task associated with this session */
  abortSession(sessionId: string): Promise<void>;
}
```

### 2.2 DriverRegistry Service

The `DriverRegistry` (`packages/coordinator/src/engines/registry.ts`) manages registered drivers, lookup resolution, and aggregate detection:

```typescript
export class DriverRegistry {
  private static instance: DriverRegistry | null = null;
  private readonly drivers = new Map<EngineId, EngineDriver>();

  public static getInstance(): DriverRegistry {
    if (!DriverRegistry.instance) {
      DriverRegistry.instance = new DriverRegistry();
    }
    return DriverRegistry.instance;
  }

  public register(driver: EngineDriver): void {
    if (this.drivers.has(driver.id)) {
      throw new Error(`Engine driver already registered for id: ${driver.id}`);
    }
    this.drivers.set(driver.id, driver);
  }

  public get(id: EngineId): EngineDriver | undefined {
    return this.drivers.get(id);
  }

  public require(id: EngineId): EngineDriver {
    const driver = this.drivers.get(id);
    if (!driver) {
      throw new Error(`Unregistered engine driver: '${id}'. Check DriverRegistry initialization.`);
    }
    return driver;
  }

  public list(): EngineDriver[] {
    return Array.from(this.drivers.values());
  }

  public async detectAll(): Promise<EngineDetectionResult[]> {
    const results = await Promise.all(this.list().map((driver) => driver.detect()));
    return results;
  }

  public async discoverAllModels(): Promise<Record<string, ModelDiscovery>> {
    const entries = await Promise.all(
      this.list().map(async (driver) => [driver.id, await driver.discoverModels()] as const)
    );
    return Object.fromEntries(entries);
  }
}
```

---

## 3. Version Pin & Capability Matrices

### 3.1 ENGINE_VERSIONS Pin Matrix

Modelled after OpenMausBot's `server/engine-versions.ts:25`, OpenSand defines pinned target and minimum versions for every engine CLI in `packages/coordinator/src/engines/versions.ts`:

```typescript
export interface EngineVersionPin {
  /** Target recommended version installed or tested */
  target: string;
  /** Minimum version verified for reliable turn execution */
  minimum: string;
  /** Command line arguments to probe version */
  probeArgs: readonly string[];
  /** Flag indicating whether ACP initialize handshake is supported */
  acpArgs?: readonly string[];
  /** Parser function extracting semver string from stdout/stderr */
  parseVersion: (stdout: string) => string | null;
}

export type VersionStatus = "tested" | "newer" | "older" | "unknown" | "unchecked";

export interface EngineVersionReport {
  version: string | null;
  status: VersionStatus;
  minimum: string;
  target: string;
  error?: string;
}

export const ENGINE_VERSIONS: Readonly<Record<EngineId, EngineVersionPin>> = {
  claude: {
    target: "latest",
    minimum: "2.1.267",
    probeArgs: ["--version"],
    parseVersion: (s) => s.match(/([0-9]+\.[0-9]+\.[0-9]+)/)?.[1] ?? null,
  },
  opencode: {
    target: "2.2.5",
    minimum: "1.19.4",
    probeArgs: ["--version"],
    acpArgs: ["acp"],
    parseVersion: (s) => s.match(/([0-9]+\.[0-9]+\.[0-9]+)/)?.[1] ?? null,
  },
  codex: {
    target: "0.167.0",
    minimum: "0.146.0",
    probeArgs: ["--version"],
    parseVersion: (s) => s.match(/([0-9]+\.[0-9]+\.[0-9]+)/)?.[1] ?? null,
  },
  copilot: {
    target: "1.0.106",
    minimum: "1.0.103",
    probeArgs: ["--version"],
    acpArgs: ["--acp", "--stdio"],
    parseVersion: (s) => s.match(/([0-9]+\.[0-9]+\.[0-9]+)/)?.[1] ?? null,
  },
  antigravity: {
    target: "0.8.2",
    minimum: "0.7.0",
    probeArgs: ["--version"],
    parseVersion: (s) => s.match(/([0-9]+\.[0-9]+\.[0-9]+)/)?.[1] ?? null,
  },
  workbuddy: {
    target: "1.2.0",
    minimum: "1.0.0",
    probeArgs: ["--version"],
    parseVersion: (s) => s.match(/([0-9]+\.[0-9]+\.[0-9]+)/)?.[1] ?? null,
  },
  "openai-compat": {
    target: "v1",
    minimum: "v1",
    probeArgs: [],
    parseVersion: () => "v1",
  },
  "custom-acp": {
    target: "acp-1.0",
    minimum: "acp-1.0",
    probeArgs: ["--version"],
    acpArgs: ["--acp"],
    parseVersion: (s) => s.match(/([0-9]+\.[0-9]+\.[0-9]+)/)?.[1] ?? "acp-1.0",
  },
};
```

### 3.2 ENGINES Capability Matrix

Modelled after OpenMausBot's `server/runtime/capabilities.ts:20`, OpenSand specifies static and runtime capabilities in `packages/coordinator/src/engines/capabilities.ts`:

```typescript
export interface EngineCapabilities {
  /** Supports resuming existing session ID without replaying full history */
  resume: boolean;
  /** Supports spawning isolated subagent child processes */
  subagents: boolean;
  /** Supports autonomous native self-review / approval loop */
  nativeReviewer: boolean;
  /** Supports live model discovery (CLI probe or remote API) */
  modelDiscovery: boolean;
  /** Max turn iterations for non-autonomous completion endpoints */
  stepCap?: number;
  /** Permitted approval modes */
  approvalModes: readonly ("ask" | "auto_edit" | "full")[];
}

export const ENGINES: Readonly<Record<EngineId, EngineCapabilities>> = {
  claude: {
    resume: true,
    subagents: false,
    nativeReviewer: true,
    modelDiscovery: false,
    approvalModes: ["ask", "auto_edit", "full"],
  },
  opencode: {
    resume: true,
    subagents: true,
    nativeReviewer: true,
    modelDiscovery: true,
    approvalModes: ["ask", "auto_edit", "full"],
  },
  codex: {
    resume: true,
    subagents: false,
    nativeReviewer: false,
    modelDiscovery: false,
    approvalModes: ["ask", "auto_edit"],
  },
  copilot: {
    resume: true,
    subagents: false,
    nativeReviewer: false,
    modelDiscovery: false,
    approvalModes: ["ask", "auto_edit"],
  },
  antigravity: {
    resume: true,
    subagents: true,
    nativeReviewer: true,
    modelDiscovery: true,
    approvalModes: ["ask", "auto_edit", "full"],
  },
  workbuddy: {
    resume: false,
    subagents: false,
    nativeReviewer: false,
    modelDiscovery: false,
    stepCap: 64,
    approvalModes: ["ask", "auto_edit"],
  },
  "openai-compat": {
    resume: false,
    subagents: false,
    nativeReviewer: false,
    modelDiscovery: true,
    stepCap: 64,
    approvalModes: ["ask", "full"],
  },
  "custom-acp": {
    resume: true,
    subagents: true,
    nativeReviewer: true,
    modelDiscovery: false,
    approvalModes: ["ask", "auto_edit", "full"],
  },
};
```

---

## 4. Concrete Engine Drivers & Process Lifecycle

### 4.1 Driver Implementation Profiles

| Driver Class | File Location | Target Engine(s) | Execution Mode & Protocol |
|---|---|---|---|
| `ClaudeDriver` | `packages/coordinator/src/engines/drivers/claude-driver.ts` | `claude` | Anthropic Claude Code CLI via stream-json stdio and `--permission-prompt-tool stdio`. |
| `OpenCodeDriver` | `packages/coordinator/src/engines/drivers/opencode-driver.ts` | `opencode` | OpenCode CLI via ACP stdio interface or JSON-RPC model probe (`opencode api model.list`). |
| `OpenAIDriver` | `packages/coordinator/src/engines/drivers/openai-driver.ts` | `openai-compat` | HTTP / Server-Sent Events (SSE) streaming runner with native tool-calling completion loop. |
| `CustomAcpDriver` | `packages/coordinator/src/engines/drivers/custom-acp-driver.ts` | `custom-acp`, `codex`, `copilot`, `antigravity`, `workbuddy` | Universal Agent Client Protocol (ACP) driver running configured CLI binary over stdio. |

### 4.2 Process Group (`-$PGID`) Cleanup Invariant

External engine CLI binaries frequently launch worker threads, language compilers (`tsc`, `rustc`), and child processes. If OpenSand cancels a turn or encounters an idle timeout, sending a standard `child.kill("SIGTERM")` only signals the parent CLI process, leaving orphaned child processes running indefinitely.

To prevent process leaks, `packages/coordinator/src/engines/process-group.ts` provides strict process-group lifecycle control:

1. **Detached Spawning:** Always spawn external engine processes in detached mode (`detached: true`), ensuring the child process becomes the leader of its own process group (`PGID = child.pid`).
2. **Two-Stage Process Group Termination:**
   ```typescript
   export async function terminateProcessGroup(pid: number, graceMs = 2000): Promise<void> {
     try {
       // Negative PID targets the entire process group (-$PGID)
       process.kill(-pid, "SIGTERM");
     } catch (err: any) {
       if (err.code === "ESRCH") return; // Process already exited
       throw err;
     }

     const exited = await waitForProcessExit(pid, graceMs);
     if (!exited) {
       try {
         // Forceful kill if process did not exit cleanly within grace period
         process.kill(-pid, "SIGKILL");
       } catch (err: any) {
         if (err.code === "ESRCH") return;
         throw err;
       }
     }
   }
   ```
3. **Session Abort Map:** Each driver maintains an active session map (`Map<string, { pid: number; abortController: AbortController }>`). When `driver.abortSession(sessionId)` is invoked, the abort controller signals abortion and `terminateProcessGroup(pid)` tears down the process tree.

---

## 5. Wiring into Desktop IPC & Coordinator

### 5.1 Desktop IPC Bridge Integration (`packages/desktop/src/ipc-bridge.ts:786`)

Currently, `packages/desktop/src/ipc-bridge.ts:786` calls the legacy `detectEngines()` function:
```typescript
// Legacy packages/desktop/src/ipc-bridge.ts:786
public async detectEngines(): Promise<EngineDetectionResult[]> {
  return detectEngines();
}
```

Under Step 3, the bridge delegates directly to the `DriverRegistry`:
```typescript
// Target packages/desktop/src/ipc-bridge.ts:786
public async detectEngines(): Promise<EngineDetectionResult[]> {
  const registry = DriverRegistry.getInstance();
  return registry.detectAll();
}
```

### 5.2 Coordinator Execution Seam (`packages/coordinator/src/coordinator.ts:727`)

In `packages/coordinator/src/coordinator.ts`, `runExternalEngineTurn()` resolves the active driver and executes the turn:

```typescript
// packages/coordinator/src/coordinator.ts:727
const registry = DriverRegistry.getInstance();
const driver = registry.require(config.engine as EngineId);

const result = await driver.runTurn({
  sessionId: this.sessionId,
  workspaceDir: this.workspaceDir,
  userQuery,
  transcript: this.transcript,
  config,
  daemon: this.daemon,
  hookDispatcher: this.hookDispatcher,
  onApprovalRequired: this.onApprovalRequired,
  onEvent: this.onEvent,
  systemPrompt: this.systemPrompt,
  sandboxProfile: this.sandboxProfile,
}, signal);

return result.text;
```

### 5.3 Deprecation & Backward-Compatibility Seam

To maintain 100% backward compatibility with existing tests during the migration, `packages/coordinator/src/engines/external-engine-runner.ts` is retained as a thin facade wrapping `DriverRegistry`:
- `detectEngines()` calls `DriverRegistry.getInstance().detectAll()`.
- `ExternalEngineTurnRunner.runTurn()` delegates directly to `DriverRegistry.getInstance().require(this.config.engine).runTurn(...)`.

---

## 6. Builder Work Breakdown Structure (Dex & Nova)

Implementation is split into two strictly non-overlapping PR briefs that can execute concurrently once PR #266 lands.

### Brief 3A: Engine Driver Interfaces, Pin Matrix, Capability Matrix & Driver Registry
- **Assignee:** Dex (Software Engineer)
- **Goal:** Establish declarative driver contracts, pin matrix, capability table, and the singleton `DriverRegistry` with 100% unit test coverage.
- **File Allow-List (Strictly No Overlap):**
  - `packages/coordinator/src/engines/driver.ts` (NEW)
  - `packages/coordinator/src/engines/capabilities.ts` (NEW)
  - `packages/coordinator/src/engines/versions.ts` (NEW)
  - `packages/coordinator/src/engines/registry.ts` (NEW)
  - `packages/coordinator/src/engines/types.ts` (EDIT: export new types)
  - `packages/coordinator/test/driver-registry.test.ts` (NEW)
  - `packages/coordinator/test/capabilities.test.ts` (NEW)
- **Done When:**
  1. `pnpm --filter @opensand/coordinator test` passes with zero failures.
  2. `driver-registry.test.ts` verifies:
     - Driver registration, duplicate registration rejection, and required lookup errors.
     - `detectAll()` correctly aggregates detection results across registered drivers.
     - Capability matrix reflects expected flags for all 8 engine types.
     - Semver version probe logic returns exact statuses (`tested`, `newer`, `older`, `unknown`).
  3. No code outside `packages/coordinator/src/engines/` and its unit tests is modified.

### Brief 3B: Concrete Engine Drivers, Process-Group Isolation & IPC Wiring
- **Assignee:** Nova (Frontend / Systems Engineer)
- **Goal:** Implement concrete driver classes (`ClaudeDriver`, `OpenCodeDriver`, `OpenAIDriver`, `CustomAcpDriver`), detached process-group termination (`process-group.ts`), and wire `packages/desktop/src/ipc-bridge.ts:786` and `packages/coordinator/src/coordinator.ts`.
- **File Allow-List (Strictly No Overlap):**
  - `packages/coordinator/src/engines/process-group.ts` (NEW)
  - `packages/coordinator/src/engines/drivers/claude-driver.ts` (NEW)
  - `packages/coordinator/src/engines/drivers/opencode-driver.ts` (NEW)
  - `packages/coordinator/src/engines/drivers/openai-driver.ts` (NEW)
  - `packages/coordinator/src/engines/drivers/custom-acp-driver.ts` (NEW)
  - `packages/coordinator/src/engines/external-engine-runner.ts` (EDIT: facade delegation)
  - `packages/coordinator/src/coordinator.ts` (EDIT: route via DriverRegistry)
  - `packages/desktop/src/ipc-bridge.ts` (EDIT: consume DriverRegistry at line 786)
  - `packages/coordinator/test/process-group.test.ts` (NEW)
  - `packages/coordinator/test/drivers-integration.test.ts` (NEW)
- **Done When:**
  1. `pnpm --filter @opensand/coordinator test` and `pnpm --filter @opensand/desktop test` pass.
  2. `process-group.test.ts` proves that killing a detached process group cleanly terminates child worker processes within grace period without orphan leaks.
  3. All concrete drivers register into `DriverRegistry` upon coordinator startup.
  4. Desktop `GET /api/engines/detect` returns dynamic capabilities and detection results.
