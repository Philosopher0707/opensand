import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type HookEventName =
  | "SessionStart"
  | "PreToolUse"
  | "PostToolUse"
  | "PreCompact"
  | "Stop";

export interface SessionStartPayload {
  sessionId: string;
  systemPrompt?: string;
}

export interface PreToolUsePayload {
  sessionId: string;
  toolName: string;
  args: Record<string, any>;
}

export interface PreToolUseResult {
  proceed: boolean;
  modifiedArgs?: Record<string, any>;
  reason?: string;
}

export interface PostToolUsePayload {
  sessionId: string;
  toolName: string;
  args: Record<string, any>;
  result: any;
}

export interface PreCompactPayload {
  sessionId: string;
  turnCount: number;
  tokensBefore: number;
}

export interface StopPayload {
  sessionId: string;
  finalContent?: string;
}

export type SessionStartHookFn = (payload: SessionStartPayload) => Promise<void> | void;
export type PreToolUseHookFn = (
  payload: PreToolUsePayload
) => Promise<PreToolUseResult | boolean | void> | PreToolUseResult | boolean | void;
export type PostToolUseHookFn = (payload: PostToolUsePayload) => Promise<void> | void;
export type PreCompactHookFn = (payload: PreCompactPayload) => Promise<void> | void;
export type StopHookFn = (payload: StopPayload) => Promise<void> | void;

export interface LifecycleHooks {
  onSessionStart?: SessionStartHookFn;
  onPreToolUse?: PreToolUseHookFn;
  onPostToolUse?: PostToolUseHookFn;
  onPreCompact?: PreCompactHookFn;
  onStop?: StopHookFn;

  /**
   * Shell command hooks (parity with Anthropic Claude Code settings.json hook system).
   * Executed with payload passed via environment variable OPENSAND_HOOK_PAYLOAD (JSON).
   */
  commandHooks?: Partial<Record<HookEventName, string>>;
}

export class HookDispatcher {
  private hooks: LifecycleHooks;

  constructor(hooks: LifecycleHooks = {}) {
    this.hooks = hooks;
  }

  public setHooks(hooks: LifecycleHooks): void {
    this.hooks = hooks;
  }

  public async dispatchSessionStart(payload: SessionStartPayload): Promise<void> {
    if (this.hooks.onSessionStart) {
      await this.hooks.onSessionStart(payload);
    }
    if (this.hooks.commandHooks?.SessionStart) {
      await this.runCommandHook("SessionStart", this.hooks.commandHooks.SessionStart, payload);
    }
  }

  public async dispatchPreToolUse(payload: PreToolUsePayload): Promise<PreToolUseResult> {
    let proceed = true;
    let modifiedArgs: Record<string, any> | undefined;
    let reason: string | undefined;

    if (this.hooks.onPreToolUse) {
      const res = await this.hooks.onPreToolUse(payload);
      if (typeof res === "boolean") {
        proceed = res;
        if (!res) reason = "Rejected by onPreToolUse hook.";
      } else if (res && typeof res === "object") {
        if (typeof res.proceed === "boolean") proceed = res.proceed;
        if (res.modifiedArgs) modifiedArgs = res.modifiedArgs;
        if (res.reason) reason = res.reason;
      }
    }

    if (proceed && this.hooks.commandHooks?.PreToolUse) {
      const cmdResult = await this.runCommandHook("PreToolUse", this.hooks.commandHooks.PreToolUse, payload);
      if (cmdResult && !cmdResult.proceed) {
        proceed = false;
        reason = cmdResult.reason || "Rejected by command hook.";
      }
      if (cmdResult?.modifiedArgs) {
        modifiedArgs = cmdResult.modifiedArgs;
      }
    }

    return { proceed, modifiedArgs, reason };
  }

  public async dispatchPostToolUse(payload: PostToolUsePayload): Promise<void> {
    if (this.hooks.onPostToolUse) {
      await this.hooks.onPostToolUse(payload);
    }
    if (this.hooks.commandHooks?.PostToolUse) {
      await this.runCommandHook("PostToolUse", this.hooks.commandHooks.PostToolUse, payload);
    }
  }

  public async dispatchPreCompact(payload: PreCompactPayload): Promise<void> {
    if (this.hooks.onPreCompact) {
      await this.hooks.onPreCompact(payload);
    }
    if (this.hooks.commandHooks?.PreCompact) {
      await this.runCommandHook("PreCompact", this.hooks.commandHooks.PreCompact, payload);
    }
  }

  public async dispatchStop(payload: StopPayload): Promise<void> {
    if (this.hooks.onStop) {
      await this.hooks.onStop(payload);
    }
    if (this.hooks.commandHooks?.Stop) {
      await this.runCommandHook("Stop", this.hooks.commandHooks.Stop, payload);
    }
  }

  private async runCommandHook(
    event: HookEventName,
    command: string,
    payload: any
  ): Promise<{ proceed: boolean; reason?: string; modifiedArgs?: Record<string, any> } | void> {
    try {
      const jsonPayload = JSON.stringify(payload);
      const { stdout } = await execAsync(command, {
        env: {
          ...process.env,
          OPENSAND_HOOK_EVENT: event,
          OPENSAND_HOOK_PAYLOAD: jsonPayload,
        },
        timeout: 10000,
      });

      if (event === "PreToolUse" && stdout.trim()) {
        try {
          const parsed = JSON.parse(stdout.trim());
          if (typeof parsed.proceed === "boolean") {
            return {
              proceed: parsed.proceed,
              reason: parsed.reason,
              modifiedArgs: parsed.modifiedArgs,
            };
          }
        } catch {
          // If non-json output, exit code 0 implies proceed
        }
      }
    } catch (err: any) {
      if (event === "PreToolUse") {
        return {
          proceed: false,
          reason: `Command hook failed (exit code non-zero): ${err.message}`,
        };
      }
    }
  }
}
