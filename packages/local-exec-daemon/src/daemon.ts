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
} from "./types.js";

export interface DaemonOptions {
  stateDir?: string;
  heartbeatIntervalMs?: number;
  initialGates?: Partial<PermissionGates>;
}

export class LocalExecDaemon {
  public readonly state: StateManager;
  public readonly tools: ToolRegistry;
  public readonly policy: PolicyEngine;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private inflightCount = 0;
  private generation = 1;
  private startedAt = 0;
  private isRunning = false;
  private heartbeatIntervalMs: number;

  constructor(options: DaemonOptions = {}) {
    this.state = new StateManager(options.stateDir);
    this.tools = new ToolRegistry();
    this.policy = new PolicyEngine({ storageDir: options.stateDir });
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5000;
  }

  get running(): boolean {
    return this.isRunning;
  }

  get inflight(): number {
    return this.inflightCount;
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

      return await this.tools.dispatch(name, args, effectiveContext);
    } finally {
      this.inflightCount = Math.max(0, this.inflightCount - 1);
    }
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
