import type { GrantsStore } from "@opensand/shared";
import { PtySessionManager } from "./pty-manager.js";
import { StateManager } from "./state-manager.js";
import { ToolRegistry, ToolExecutionContext, CustomToolRegistration } from "./tool-registry.js";
import { PolicyEngine, PolicyDecision } from "./policy-engine.js";
import {
  DaemonState,
  DaemonConnection,
  DaemonSupervisorHeartbeat,
  PermissionGates,
  ToolDefinition,
  ToolExecutionResult,
  DaemonLivenessResult,
} from "./types.js";

export interface DaemonOptions {
  stateDir?: string;
  heartbeatIntervalMs?: number;
  initialGates?: Partial<PermissionGates>;
  /** Source of standing exec permission. Default: grants.json beside the state dir (see StateManager). */
  grants?: GrantsStore;
}

export class LocalExecDaemon {
  public readonly state: StateManager;
  public readonly tools: ToolRegistry;
  public readonly policy: PolicyEngine;
  public readonly pty: PtySessionManager;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private inflightCount = 0;
  private generation = 1;
  private startedAt = 0;
  private isRunning = false;
  private heartbeatIntervalMs: number;

  constructor(options: DaemonOptions = {}) {
    this.state = new StateManager(options.stateDir, options.grants);
    this.pty = new PtySessionManager();
    this.tools = new ToolRegistry({ ptyManager: this.pty, enablePty: true });
    this.policy = new PolicyEngine({ storageDir: options.stateDir });
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5000;
  }

  get running(): boolean {
    return this.isRunning;
  }

  get inflight(): number {
    return this.inflightCount;
  }

  async isDaemonRunning(): Promise<DaemonLivenessResult> {
    return this.state.isDaemonRunning();
  }

  public async ensureStarted(): Promise<void> {
    if (this.isRunning) {
      const probe = await this.state.isDaemonRunning();
      if (!probe.running || (probe.pid && probe.pid !== process.pid)) {
        await this.stop();
        await this.start();
      } else {
        await this.pulseDaemonState().catch(() => {});
      }
      return;
    }

    await this.start();
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    await this.state.ensureDirectory();
    this.startedAt = Date.now();
    this.isRunning = true;

    // Load or initialize generation
    const existing = await this.state.readDaemonState();
    if (existing) {
      this.generation = (existing.generation || 0) + 1;
    }

    // Write initial daemon state
    await this.pulseDaemonState();

    // Pulse supervisor heartbeat
    await this.pulseSupervisor();

    // Start background heartbeat
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.pulseSupervisor();
        await this.pulseDaemonState();
      } catch (err) {
        // Silently preserve daemon loop if state write transiently fails
      }
    }, this.heartbeatIntervalMs);

    // Unref heartbeat timer so it doesn't prevent graceful Node process exit if needed
    this.heartbeatTimer.unref();
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.isRunning = false;
    await this.pulseDaemonState();
    await this.pty.closeAll().catch(() => {});
  }

  private async pulseDaemonState(): Promise<void> {
    const daemonState: DaemonState = {
      pid: process.pid,
      startedAt: this.startedAt,
      servingAt: this.isRunning ? Date.now() : undefined,
      inflightCount: this.inflightCount,
      generation: this.generation,
    };
    await this.state.writeDaemonState(daemonState);
  }

  private async pulseSupervisor(): Promise<void> {
    const heartbeat: DaemonSupervisorHeartbeat = {
      pid: process.pid,
      at: Date.now(),
    };
    await this.state.writeSupervisorHeartbeat(heartbeat);
  }

  /**
   * Return OpenAI function definitions for all registered tools.
   */
  getToolDefinitions(): ToolDefinition[] {
    return this.tools.getDefinitions();
  }

  /**
   * Register a custom tool into this daemon.
   */
  registerCustomTool(registration: CustomToolRegistration): void {
    this.tools.registerCustomTool(registration);
  }

  unregisterCustomTool(name: string): boolean {
    return this.tools.unregisterCustomTool(name);
  }

  /**
   * Execute a tool through the daemon with active gate enforcement.
   */
  /**
   * Evaluate the fail-closed boundary policy for a would-be tool call.
   * Exposed so the turn loop can gate BEFORE dispatch (so REQUIRE_APPROVAL
   * reaches the user instead of returning permission_pending from the
   * registry) and so policy is never bypassed by only checking exec_command.
   */
  evaluatePolicy(
    tool: string,
    args: Record<string, any>,
    context?: { actor?: string; initiator?: 'user' | 'routine' | 'sentinel' | 'subagent' }
  ): PolicyDecision {
    return this.policy.evaluate({ tool, args, actor: context?.actor, initiator: context?.initiator });
  }

  async executeTool(
    name: string,
    args: Record<string, any>,
    context?: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    this.inflightCount++;
    try {
      // Evaluate fail-closed boundary policy (re-evaluated here as the
      // authoritative second gate, independent of the coordinator's check)
      const decision = this.policy.evaluate({ tool: name, args });

      if (decision.action === 'DENY') {
        return {
          status: 'error',
          error: {
            code: 'POLICY_DENIED',
            reason: 'policy',
            message: `Policy Boundary Violation: ${decision.reason}`,
          },
        };
      }

      // REQUIRE_APPROVAL is enforced upstream by the turn loop (it prompts
      // the user and passes approvalGranted). If execution reaches here
      // without it, fail closed rather than silently running the tool.
      if (decision.action === 'REQUIRE_APPROVAL' && !context?.approvalGranted) {
        return {
          status: 'permission_pending',
          approvalId: context?.approvalId ?? `req-${Date.now()}`,
          error: {
            code: 'PERMISSION_REQUIRED',
            reason: 'approval_required',
            message: `Policy requires approval: ${decision.reason}`,
          },
        };
      }

      // Refresh current permission gates if not explicitly passed
      let effectiveContext = context;
      if (!context?.permissionGates) {
        const gates = await this.state.readPermissionGates();
        effectiveContext = {
          ...context,
          permissionGates: gates,
        };
      }

      effectiveContext = await this.recheckStandingGrants(name, effectiveContext);

      return await this.tools.dispatch(name, args, effectiveContext);
    } finally {
      this.inflightCount = Math.max(0, this.inflightCount - 1);
    }
  }

  /**
   * A caller may pass a gate snapshot taken before it waited on a human. Right before spawning, if the
   * decision could rest on a standing grant, compare the snapshot's epoch with the current one (lock-free)
   * and re-read the gates when they differ, so a revoke that landed in between is not ignored.
   * A grants.json that cannot be read now counts as a difference, and the fresh read then denies.
   */
  private async recheckStandingGrants(name: string, context?: ToolExecutionContext): Promise<ToolExecutionContext | undefined> {
    const gates = context?.permissionGates;
    // Only snapshots this daemon took carry an epoch; a hand-built gate object is the caller's own.
    if (!gates || gates.grantsEpoch === undefined || context?.approvalGranted || (name !== "exec_command" && name !== "pty_spawn")) return context;
    let current: number | undefined;
    try {
      current = this.state.grantsStore.getEpochSync();
    } catch {
      current = undefined;
    }
    if (current !== undefined && current === gates.grantsEpoch) return context;
    const fresh = await this.state.readPermissionGates();
    const { standingGrants, standingAllowlist, grantsEpoch, grantsError } = fresh;
    const refreshed: PermissionGates = { ...gates, standingGrants, standingAllowlist, grantsEpoch };
    if (grantsError) refreshed.grantsError = true; else delete refreshed.grantsError;
    return { ...context, permissionGates: refreshed };
  }

  /**
   * Read active permission gates.
   */
  async getGates(): Promise<PermissionGates> {
    return this.state.readPermissionGates();
  }

  /**
   * Update active permission gates.
   */
  async updateGates(gates: Partial<PermissionGates>): Promise<void> {
    await this.state.writePermissionGates(gates);
  }
}
