import path from "node:path";
import { EVENT } from "../event-projections.js";
import type { TranscriptManager } from "../transcript-manager.js";
import type { LocalExecDaemon } from "@opensand/local-exec-daemon";
import type { HookDispatcher } from "../hooks.js";
import type { ApprovalHandler, TurnEvent, ChatMessage, SessionMetadata } from "../types.js";
import type { ExternalEngineConfig, EngineDetectionResult } from "./types.js";
import { listModels } from "./model-discovery.js";

// @ts-ignore - plain .mjs vendor files
import { runTurn as runAgentTurn, ENGINES, findBinary, engineVersion, versionStatus } from "./vendor/agent_wrap.mjs";
// @ts-ignore - plain .mjs vendor files
import { explainError, ENGINE_FACTS } from "./vendor/engine_facts.mjs";

export interface ExternalEngineTurnRunnerOptions {
  config: ExternalEngineConfig;
  sessionId: string;
  workspaceDir: string;
  transcript: TranscriptManager;
  daemon?: LocalExecDaemon;
  hookDispatcher?: HookDispatcher;
  onApprovalRequired?: ApprovalHandler;
  onEvent?: (event: TurnEvent) => void;
  systemPrompt?: string;
  sandboxProfile?: "read-only" | "workspace-write" | "full";
}

export class ExternalEngineTurnRunner {
  public readonly config: ExternalEngineConfig;
  public readonly sessionId: string;
  public readonly workspaceDir: string;
  public readonly transcript: TranscriptManager;
  public readonly daemon?: LocalExecDaemon;
  public readonly hookDispatcher?: HookDispatcher;
  public readonly onApprovalRequired?: ApprovalHandler;
  public readonly onEvent?: (event: TurnEvent) => void;
  public readonly systemPrompt?: string;
  public readonly sandboxProfile?: "read-only" | "workspace-write" | "full";

  constructor(options: ExternalEngineTurnRunnerOptions) {
    this.config = options.config;
    this.sessionId = options.sessionId;
    this.workspaceDir = options.workspaceDir;
    this.transcript = options.transcript;
    this.daemon = options.daemon;
    this.hookDispatcher = options.hookDispatcher;
    this.onApprovalRequired = options.onApprovalRequired;
    this.onEvent = options.onEvent;
    this.systemPrompt = options.systemPrompt;
    this.sandboxProfile = options.sandboxProfile;
  }

  async runTurn(userQuery: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) {
      throw new DOMException("Turn was cancelled by user", "AbortError");
    }

    const spec = (ENGINES as any)[this.config.engine] || (ENGINE_FACTS as any)[this.config.engine];
    const engineLabel = spec?.label || this.config.engine;
    const isClaude = this.config.engine === "claude";

    // 0. Binary existence check
    const bin = findBinary(this.config.engine, { bin: this.config.binaryPath });
    if (!bin) {
      if (isClaude) {
        throw new Error("Install Claude Code: run `npm install -g @anthropic-ai/claude-code` or visit the Anthropic installation guide to get started.");
      }
      throw new Error(`Install ${engineLabel}: ensure the engine binary is installed and available on PATH.`);
    }

    // 0. Version evaluation check
    try {
      const v = await engineVersion(bin);
      if (v) {
        const vStat = versionStatus(this.config.engine, v);
        if (vStat.status === "older") {
          const minVer = vStat.tested?.[0] || "a supported version";
          if (isClaude) {
            throw new Error(`Update Claude Code to ${minVer} (installed: ${vStat.version || v}): run \`npm update -g @anthropic-ai/claude-code\` to update.`);
          }
          throw new Error(`Update ${engineLabel} to ${minVer} (installed: ${vStat.version || v}): update the binary to a supported version.`);
        }
      }
    } catch (err: any) {
      if (err instanceof Error && (err.message.startsWith("Update ") || err.message.startsWith("Install "))) {
        throw err;
      }
      // If version probe failed or timed out, proceed to runAgentTurn
    }

    // 1. Session Continuity: Load metadata for resumeId
    const metadata = await this.transcript.loadMetadata();
    let resumeId: string | undefined = undefined;
    if (metadata?.externalEngine?.engine === this.config.engine && metadata.externalEngine.sessionId) {
      resumeId = metadata.externalEngine.sessionId;
    }

    let assistantText = "";
    const activeToolCalls = new Map<string, any>();

    // Map mode: plan mode if explicit or read-only profile
    const runMode = (this.config.mode === "plan" || this.sandboxProfile === "read-only") ? "plan" : "agent";

    // Build the approve callback
    const approveCallback = async (params: { engine: string; tool: string; input: any; mode: string }): Promise<boolean> => {
      // Rule: Plan mode hard-denies all mutations and ExitPlanMode
      if (this.config.mode === "plan" || params.mode !== "agent") {
        return false;
      }

      // Rule: Fail closed - if no approver is configured, deny
      if (!this.onApprovalRequired) {
        return false;
      }

      // Check daemon boundary policy if available
      if (this.daemon) {
        const policy = this.daemon.evaluatePolicy(params.tool, params.input);
        if (policy.action === "DENY") {
          return false;
        }
      }

      try {
        const approvalId = `appr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const ok = await this.onApprovalRequired({
          approvalId,
          toolName: params.tool,
          arguments: typeof params.input === "object" && params.input !== null ? params.input : { raw: params.input },
          reason: `External engine (${params.engine}) requested tool: ${params.tool}`,
        });
        return ok === true;
      } catch {
        return false;
      }
    };

    // Forward events to OpenSand event stream and transcript
    const handleEvent = async (ev: any) => {
      if (!ev || typeof ev !== "object") return;

      switch (ev.type) {
        case "session": {
          if (ev.id) {
            const currentMeta: SessionMetadata = (await this.transcript.loadMetadata()) || {
              sessionId: this.sessionId,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              model: ev.model || this.config.model || this.config.engine,
              endpoint: "external",
            };
            currentMeta.externalEngine = {
              engine: this.config.engine,
              sessionId: ev.id,
              model: ev.model || this.config.model,
              binaryPath: this.config.binaryPath,
            };
            currentMeta.updatedAt = new Date().toISOString();
            await this.transcript.saveMetadata(currentMeta);
          }
          break;
        }

        case "thinking": {
          if (ev.text) {
            this.onEvent?.({ type: "thought_delta", text: ev.text });
          }
          break;
        }

        case "text": {
          if (ev.text) {
            assistantText += ev.text;
            this.onEvent?.({ type: "text_delta", text: ev.text });
          }
          break;
        }

        case "tool_call": {
          const tc = {
            id: ev.id,
            type: "function" as const,
            function: {
              name: ev.name,
              arguments: typeof ev.input === "string" ? ev.input : JSON.stringify(ev.input ?? {}),
            },
          };
          activeToolCalls.set(ev.id, tc);
          this.onEvent?.({ type: "tool_call_started", toolCall: tc });
          await this.transcript.recordEvent(EVENT.modelCompletion, {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [tc],
            },
          });
          break;
        }

        case "tool_result": {
          const isError = Boolean(ev.isError);
          const content = typeof ev.output === "string" ? ev.output : JSON.stringify(ev.output ?? "");
          const tc = activeToolCalls.get(ev.id) ?? {
            id: ev.id,
            type: "function" as const,
            function: { name: "tool", arguments: "{}" },
          };
          this.onEvent?.({
            type: "tool_call_completed",
            toolCall: tc,
            result: isError ? { status: "error", error: { code: "TOOL_ERROR", message: content } } : { status: "ok", output: content },
          });
          await this.transcript.recordEvent(EVENT.toolCompleted, {
            message: {
              role: "tool",
              tool_call_id: ev.id,
              content,
            },
          });
          break;
        }

        case "subagent": {
          this.onEvent?.({
            type: "subagent",
            subagent: { parentId: ev.parent, depth: 1 },
            event: ev.event,
          } as any);
          break;
        }

        case "usage": {
          this.onEvent?.({
            type: "usage_reported",
            usage: {
              inputTokens: ev.inputTokens,
              outputTokens: ev.outputTokens,
            },
          } as any);
          break;
        }
      }
    };

    // Execute through agent_wrap.mjs
    const result = await runAgentTurn({
      engine: this.config.engine,
      prompt: userQuery,
      cwd: this.workspaceDir,
      mode: runMode,
      model: this.config.model,
      resumeId,
      systemPrompt: this.systemPrompt,
      bin: this.config.binaryPath,
      timeoutMs: this.config.timeoutMs,
      idleMs: this.config.idleMs,
      signal,
      approve: approveCallback,
      onEvent: (ev: any) => {
        handleEvent(ev).catch((err) => {
          console.warn("[external-engine-runner] handleEvent failed:", err);
        });
      },
    });

    // Save final session metadata if returned
    if (result.sessionId) {
      const currentMeta: SessionMetadata = (await this.transcript.loadMetadata()) || {
        sessionId: this.sessionId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        model: result.model || this.config.model || this.config.engine,
        endpoint: "external",
      };
      currentMeta.externalEngine = {
        engine: this.config.engine,
        sessionId: result.sessionId,
        model: result.model || this.config.model,
        binaryPath: this.config.binaryPath,
      };
      currentMeta.updatedAt = new Date().toISOString();
      await this.transcript.saveMetadata(currentMeta);
    }

    if (result.status === "aborted" || signal?.aborted) {
      await this.transcript.writeProjections().catch(() => {});
      throw new DOMException("Turn was cancelled by user", "AbortError");
    }

    if (result.status === "timeout" || result.status === "idle") {
      await this.transcript.writeProjections().catch(() => {});
      throw new Error(`${engineLabel} timed out: no output was received before the timeout limit. Try sending a shorter prompt or check the engine status.`);
    }

    if (result.status === "failed" || result.status === "not_found" || (result.error && result.status !== "completed")) {
      await this.transcript.writeProjections().catch(() => {});
      const rawError = result.error || "";

      // 1. Usage or rate limit
      if (/usage limit|rate limit|quota/i.test(rawError)) {
        const resetMatch = rawError.match(/resets?\s+(?:at\s+|in\s+)?([0-9a-zA-Z:_\s\-\+\/]+?)(?=[.,;\n\)]|$)/i);
        const resetTime = resetMatch ? resetMatch[1].trim() : null;
        if (resetTime) {
          throw new Error(`${isClaude ? "Claude" : engineLabel} usage limit reached, resets at ${resetTime}. Switch to another model in Settings or try again after reset.`);
        }
        throw new Error(`${isClaude ? "Claude" : engineLabel} usage limit reached, try again later or switch to another model in Settings.`);
      }

      // 2. Not signed in / auth failure (delegate to explainError directly)
      if (/not logged in|log ?in|authenticat|unauthori[sz]ed|401|invalid api key|credentials/i.test(rawError)) {
        const explained = explainError(this.config.engine, rawError, {
          settings: "Settings",
          emptyIsRefusal: true,
        });
        const cleaned = explained.replace(new RegExp(`^${engineLabel}:\\s*${engineLabel}:\\s*`, "i"), `${engineLabel}: `);
        throw new Error(cleaned);
      }

      // 3. Mid-turn crash / non-zero exit / segmentation fault
      if (/ended before its answer was complete|crash|segmentation fault|exited with code/i.test(rawError)) {
        throw new Error(`${engineLabel} stopped unexpectedly mid-turn. Send another message to continue the session or try again.`);
      }

      // 4. General explanation via explainError
      const explained = explainError(this.config.engine, rawError, {
        settings: "Settings",
        emptyIsRefusal: true,
      });
      const cleaned = explained.replace(new RegExp(`^${engineLabel}:\\s*${engineLabel}:\\s*`, "i"), `${engineLabel}: `);
      throw new Error(cleaned);
    }

    const finalContent = result.text || assistantText || "";
    const assistantMessage: ChatMessage = { role: "assistant", content: finalContent };
    await this.transcript.recordEvent(EVENT.modelCompletion, {
      message: assistantMessage,
      usage: result.usage,
    });

    await this.transcript.writeProjections().catch((err) => {
      console.warn("[external-engine-runner] writeProjections failed:", err);
    });

    return finalContent;
  }
}

export const DETECTABLE_ENGINE_IDS = [
  "claude",
  "codex",
  "copilot",
  "antigravity",
  "opencode",
  "workbuddy",
] as const satisfies readonly ExternalEngineConfig["engine"][];

export async function detectEngines(options: { endpoint?: string; provider?: "openai" | "anthropic" | "openrouter"; apiKey?: string } = {}): Promise<EngineDetectionResult[]> {
  const results: EngineDetectionResult[] = [];
  const openSandModels = await listModels({ engine: "opensand", ...options });
  results.push({ engine: "opensand", label: "OpenSand", installed: true, binaryPath: null, version: null, versionStatus: "unchecked", authenticated: false, ...openSandModels });
  for (const id of DETECTABLE_ENGINE_IDS) {
    const spec = (ENGINES as any)[id] || (ENGINE_FACTS as any)[id];
    const bin = findBinary(id);
    let version: string | null = null;
    let vStatus: "tested" | "newer" | "older" | "unknown" | "unchecked" = "unchecked";
    if (bin) {
      try {
        version = await engineVersion(bin);
        if (version) {
          const s = versionStatus(id, version);
          vStatus = s.status as any;
        }
      } catch {
        // ignore
      }
    }
    results.push({
      engine: id,
      label: spec?.label || id,
      installed: Boolean(bin),
      binaryPath: bin,
      version,
      versionStatus: vStatus,
      authenticated: false,
      ...(await listModels({ engine: id, binary: bin })),
    });
  }
  return results;
}
