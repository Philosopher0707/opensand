import { LocalExecDaemon, ToolExecutionResult, PolicyDecision, ToolDefinition } from "@opensand/local-exec-daemon";
import { isParallelSafeTool } from "./tool-parallelism.js";
import { UniversalLLMClient, ConsolidatedAssistantResponse } from "./llm-client.js";
import {
  ChatMessage,
  ToolCall,
  ApprovalRequest,
  ApprovalHandler,
  TurnEventListener,
  TurnEvent,
  SubagentInfo,
} from "./types.js";
import { TranscriptManager } from "./transcript-manager.js";
import { EVENT } from "./event-projections.js";
import { buildSystemPrompt, SystemPromptContext } from "./system-prompt.js";
import { VaultStore } from "./vault-store.js";
import { McpManager } from "./mcp-manager.js";
import { LifecycleHooks, HookDispatcher } from "./hooks.js";
import {
  truncateToolOutput,
  foldHistoricalToolResults,
  selectActiveTools,
  selectActiveToolsForModel,
  recommendToolScopeMode,
  getModelMaxContextTokens,
} from "./token-hygiene.js";

export interface CoordinatorOptions {
  llmClient: UniversalLLMClient;
  daemon: LocalExecDaemon;
  sessionId?: string;
  systemPromptContext?: SystemPromptContext;
  allowedTools?: string[];
  toolScopeMode?: "core" | "auto" | "all";
  maxContextTokens?: number;
  vaultStore?: VaultStore;
  hooks?: LifecycleHooks;
  onApprovalRequired?: ApprovalHandler;
  onEvent?: TurnEventListener;
  maxTurnIterations?: number;
  sessionsBaseDir?: string;
  /** Delegation depth: how many delegate_to_agent hops above this coordinator. */
  subagentDepth?: number;
  mcpManager?: McpManager;
}

export class AgentCoordinator {
  public readonly llmClient: UniversalLLMClient;
  public readonly daemon: LocalExecDaemon;
  public readonly transcript: TranscriptManager;
  public readonly sessionId: string;
  public readonly allowedTools?: string[];
  public readonly toolScopeMode: "core" | "auto" | "all";
  public maxContextTokens: number;
  public readonly vaultStore?: VaultStore;
  public readonly hookDispatcher: HookDispatcher;
  public readonly mcpManager?: McpManager;

  private messages: ChatMessage[] = [];
  private declaredCapabilities = new Set<string>();
  private onApprovalRequired?: ApprovalHandler;
  private eventListeners: Set<TurnEventListener> = new Set();
  private maxTurnIterations: number;
  private readonly subagentDepth: number;
  private initialized = false;

  constructor(options: CoordinatorOptions) {
    this.llmClient = options.llmClient;
    this.daemon = options.daemon;
    this.sessionId = options.sessionId ?? `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.transcript = new TranscriptManager(this.sessionId, options.sessionsBaseDir);
    this.allowedTools = options.allowedTools;
    this.maxContextTokens = options.maxContextTokens ?? getModelMaxContextTokens(options.llmClient?.model);
    this.toolScopeMode = options.toolScopeMode ?? recommendToolScopeMode(options.llmClient?.model, this.maxContextTokens, { allowedTools: this.allowedTools });
    this.vaultStore = options.vaultStore;
    this.hookDispatcher = new HookDispatcher(options.hooks);
    this.onApprovalRequired = options.onApprovalRequired;
    if (options.onEvent) {
      this.eventListeners.add(options.onEvent);
    }
    this.maxTurnIterations = options.maxTurnIterations ?? 150;
    this.subagentDepth = options.subagentDepth ?? 0;
    this.mcpManager = options.mcpManager;

    // Initialize system message
    const systemPrompt = buildSystemPrompt(options.systemPromptContext);
    this.messages.push({
      role: "system",
      content: systemPrompt,
    });
  }

  get history(): ReadonlyArray<ChatMessage> {
    return this.messages;
  }

  public addEventListener(listener: TurnEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private emit(event: TurnEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // Event listener errors should not disrupt the agent turn loop
      }
    }
  }

  /**
   * Run a full multi-turn conversational tool-calling interaction turn.
   */
  /**
   * Returns active tool definitions for the current turn, strictly constrained by allowedTools whitelist when present.
   */
  public getActiveToolDefinitions(userQuery?: string): ToolDefinition[] {
    let toolDefs = this.daemon.getToolDefinitions();
    if (this.allowedTools !== undefined) {
      toolDefs = toolDefs.filter((d) => this.allowedTools!.includes(d.function.name));
    } else if (this.declaredCapabilities.size > 0) {
      // Model has declared capabilities (via discover_tools) — scope by them
      toolDefs = selectActiveToolsForModel(toolDefs, [...this.declaredCapabilities]);
    } else {
      toolDefs = selectActiveTools(toolDefs, userQuery, this.toolScopeMode);
    }
    return toolDefs;
  }

  async runTurn(userQuery: string, signal?: AbortSignal): Promise<string> {
    if (!this.initialized) {
      this.initialized = true;

      // Hydrate historical turns from disk if resuming an existing session
      if (this.messages.length <= 1) {
        const history = await this.transcript.loadHistory();
        if (history.length > 0) {
          const nonSystem = history.filter((m) => m.role !== "system");
          const historicalSummary = history.find(
            (m) => m.role === "system" && m.content?.includes("<historical_context_summary>")
          );
          if (historicalSummary) {
            this.messages.splice(1, 0, historicalSummary);
          }
          this.messages.push(...nonSystem);
        }
      }

      await this.transcript.recordBaseline(this.messages, { model: this.llmClient.model });

      await this.hookDispatcher.dispatchSessionStart({
        sessionId: this.sessionId,
        systemPrompt: this.messages[0]?.content ?? undefined,
      });
    }

    // 1. Fold historical tool results from older turns to prevent memory and token explosion
    const folded = foldHistoricalToolResults(this.messages, 2);
    const foldChanges = folded.flatMap((message, index) => (message === this.messages[index] ? [] : [{ index, message }]));
    this.messages = folded;
    if (foldChanges.length > 0) {
      await this.transcript.recordEvent(EVENT.turnFolded, { changes: foldChanges });
    }

    // 2. Trigger auto-compaction if context footprint exceeds threshold
    if (this.estimateTokens() > this.maxContextTokens) {
      await this.compactHistory({ keepRecentTurns: 2 });
    }

    // 3. Record User Message
    const userMessage: ChatMessage = { role: "user", content: userQuery };
    this.messages.push(userMessage);

    this.emit({ type: "user_message", content: userQuery });
    await this.transcript.recordEvent(EVENT.turnStarted, { message: userMessage });

    let iterations = 0;

    // 2. Multi-turn Agent Tool Loop
    while (iterations < this.maxTurnIterations) {
      iterations++;
      this.emit({ type: "phase_started", phase: "thinking", iteration: iterations, maxIterations: this.maxTurnIterations });

      const toolDefs = this.getActiveToolDefinitions(userQuery);

      const { stream, getConsolidated } = await this.llmClient.streamCompletion(
        this.messages,
        toolDefs,
        signal
      );

      // Stream delta tokens to UI/listener
      for await (const delta of stream) {
        if (signal?.aborted) {
          throw new DOMException("Turn was cancelled by user", "AbortError");
        }
        if (delta.thinking) {
          this.emit({ type: "thought_delta", text: delta.thinking });
        }
        if (delta.content) {
          this.emit({ type: "text_delta", text: delta.content });
        }
      }

      if (signal?.aborted) {
        throw new DOMException("Turn was cancelled by user", "AbortError");
      }

      const assistantMsg = getConsolidated();
      this.messages.push(assistantMsg);
      await this.transcript.recordEvent(EVENT.modelCompletion, { message: assistantMsg });

      // If no tool calls, the model concluded its response
      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        const finalContent = assistantMsg.content ?? "";
        this.emit({ type: "turn_completed", finalContent });
        await this.transcript.writeProjections();
        await this.hookDispatcher.dispatchStop({
          sessionId: this.sessionId,
          finalContent,
        });
        return finalContent;
      }

      // Execute tool calls in model-declared order. Independent read-only
      // tools may be collected into parallel batches; every other tool is a
      // barrier and retains the sequential hook/policy/approval path.
      const prepared: {
        tc: (typeof assistantMsg.tool_calls)[number];
        args?: Record<string, any>;
        blockedResult?: ToolExecutionResult;
        approvalGranted?: boolean;
        execution?: {
          gates: Awaited<ReturnType<LocalExecDaemon["getGates"]>>;
          policy: PolicyDecision;
          approvalGranted: boolean;
        };
      }[] = [];
      // The loop has moved from thinking to tool execution for this iteration.
      // Emit once per batch (not per tool) so the label stays stable. Inside the
      // prepare loop tools start individually, but the phase label is per iteration.
      this.emit({ type: "phase_started", phase: "executing", iteration: iterations, maxIterations: this.maxTurnIterations });
      for (const tc of assistantMsg.tool_calls) {
        this.emit({ type: "tool_call_started", toolCall: tc });

        // Enforce agent allowedTools whitelist policy
        if (this.allowedTools !== undefined && !this.allowedTools.includes(tc.function.name)) {
          const unauthorizedResult: ToolExecutionResult = {
            status: "error",
            error: {
              code: "UNAUTHORIZED_TOOL",
              message: `Tool '${tc.function.name}' is not in this agent's authorized tools list: [${this.allowedTools.join(", ")}]`,
            },
          };
          prepared.push({ tc, blockedResult: unauthorizedResult });
          continue;
        }

        let args: Record<string, any> = {};
        try {
          args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch (err: any) {
          const parseErrorResult: ToolExecutionResult = {
            status: "error",
            error: {
              code: "INVALID_JSON_ARGUMENTS",
              message: `Malformed JSON tool arguments: ${err.message}`,
            },
          };
          prepared.push({ tc, blockedResult: parseErrorResult });
          continue;
        }

        // Lifecycle Hook: PreToolUse (Parity with Claude Code PreToolUse auditing & filtering)
        const preHook = await this.hookDispatcher.dispatchPreToolUse({
          sessionId: this.sessionId,
          toolName: tc.function.name,
          args,
        });

        if (!preHook.proceed) {
          const hookDeniedResult: ToolExecutionResult = {
            status: "error",
            error: {
              code: "PRE_TOOL_HOOK_DENIED",
              message: preHook.reason || `Tool '${tc.function.name}' execution was denied by PreToolUse hook policy.`,
            },
          };
          prepared.push({ tc, blockedResult: hookDeniedResult });
          continue;
        }

        if (preHook.modifiedArgs) {
          args = { ...args, ...preHook.modifiedArgs };
        }

        // Declarative boundary policy (fail-closed), evaluated for EVERY tool —
        // not just exec_command. DENY is hard-blocked here and again in the
        // daemon; REQUIRE_APPROVAL prompts the user. This replaces the old
        // exec-only regex approval gate.
        const gates = await this.daemon.getGates();
        const policy: PolicyDecision = this.daemon.evaluatePolicy(tc.function.name, args);

        if (policy.action === "DENY") {
          const deniedResult: ToolExecutionResult = {
            status: "error",
            error: {
              code: "POLICY_DENIED",
              message: `Policy Boundary Violation: ${policy.reason}`,
            },
          };
          prepared.push({ tc, blockedResult: deniedResult });
          continue;
        }

        let approvalGranted = false;
        let needsApproval = policy.action === "REQUIRE_APPROVAL";

        // exec_command additionally honors the computer-use gate + standing
        // allowlist unless policy already said it needs approval.
        if (tc.function.name === "exec_command") {
          const cmd = typeof args.command === "string" ? args.command.trim() : "";
          const hasChaining = /[;&|`]|\$\(|\n/.test(cmd);
          const isAllowlisted =
            !hasChaining &&
            gates.standingAllowlist.some((pat) => {
              if (pat.endsWith("*")) {
                const prefix = pat.slice(0, -1).trim();
                return cmd === prefix || cmd.startsWith(`${prefix} `);
              }
              return cmd === pat || cmd.startsWith(`${pat} `);
            });
          if (!gates.computerUseAllowed && !isAllowlisted) {
            needsApproval = true;
          }
        }

        if (needsApproval && this.onApprovalRequired) {
          const approvalId = `appr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const req: ApprovalRequest = {
            approvalId,
            toolName: tc.function.name,
            arguments: args,
            reason: policy.reason || `Execution of tool '${tc.function.name}' requires explicit approval.`,
          };

          this.emit({ type: "approval_requested", request: req });
          approvalGranted = await this.onApprovalRequired(req);

          if (!approvalGranted) {
            const rejectedResult: ToolExecutionResult = {
              status: "error",
              error: {
                code: "PERMISSION_DENIED",
                message: "Tool execution was rejected by user.",
              },
            };
            prepared.push({ tc, blockedResult: rejectedResult });
            continue;
          }
        }

        prepared.push({
          tc,
          args,
          approvalGranted,
          execution: { gates, policy, approvalGranted: approvalGranted || policy.action === 'ALLOW' },
        });
        continue;
      }

      // Preserve model-declared ordering for messages/events while allowing
      // consecutive read-only calls in one Promise.all batch. Sequential
      // barriers flush any preceding read-only batch.
      let pendingParallel: typeof prepared = [];
      const commitPrepared = async (
        item: (typeof prepared)[number],
        execResult: ToolExecutionResult,
        isBlocked: boolean = false
      ) => {
        if (item.tc.function.name === "discover_tools") this.harvestDiscoverToolsOutput(execResult);
        await this.commitToolResult(item.tc, item.args ?? {}, execResult, isBlocked);
      };
      const flushParallel = async () => {
        if (pendingParallel.length === 0) return;
        const batch = pendingParallel;
        pendingParallel = [];
        const results = await Promise.all(batch.map(async (item) => {
          if (!item.execution || !item.args) {
            return { status: "error" as const, error: { code: "TOOL_EXECUTION_NOT_PREPARED", message: "Tool execution was not prepared." } } satisfies ToolExecutionResult;
          }
          return this.daemon.executeTool(item.tc.function.name, item.args, {
            approvalGranted: item.execution.approvalGranted,
            permissionGates: item.execution.gates,
            subagent: this.buildDelegationContext(item.tc.function.name),
          });
        }));
        for (let i = 0; i < batch.length; i++) {
          await commitPrepared(batch[i], results[i]);
        }
      };

      for (const item of prepared) {
        // Blocked results are terminal and must be materialized, even when
        // the tool itself is read-only. Never batch them with execution.
        if (item.blockedResult) {
          await flushParallel();
          await commitPrepared(item, item.blockedResult, true);
          continue;
        }
        if (!isParallelSafeTool(item.tc.function.name)) {
          await flushParallel();
          if (item.execution && item.args) {
            const execResult = await this.daemon.executeTool(item.tc.function.name, item.args, {
              approvalGranted: item.execution.approvalGranted,
              permissionGates: item.execution.gates,
              subagent: this.buildDelegationContext(item.tc.function.name),
            });
            await commitPrepared(item, execResult);
          }
        } else {
          pendingParallel.push(item);
        }
      }
      await flushParallel();

      // Auto-compact if tool results pushed context above the safety limit
      if (this.estimateTokens() > this.maxContextTokens) {
        await this.compactHistory({ keepRecentTurns: 2 });
      }

      // Loop continues: LLM evaluates tool results
    }

    // Safety circuit breaker hit
    const fallbackMessage = `Execution limit reached: max turn iterations (${this.maxTurnIterations}) reached. Type 'continue' to proceed.`;
    this.emit({ type: "turn_completed", finalContent: fallbackMessage });
    await this.transcript.writeProjections();
    await this.hookDispatcher.dispatchStop({
      sessionId: this.sessionId,
      finalContent: fallbackMessage,
    });
    return fallbackMessage;
  }

  /**
   * Build the delegation context so delegate_to_agent can stream the child
   * turn's events up to the UI. Only meaningful for delegate_to_agent;
   * other tools get `undefined` (no-op). Depth is capped so the UI card
   * tree stays bounded — delegation beyond the cap still runs, just without
   * live streaming.
   */
  private buildDelegationContext(toolName: string): { onEvent: (event: TurnEvent, info: SubagentInfo) => void; depth: number; sessionId: string } | undefined {
    if (toolName !== "delegate_to_agent") return undefined;
    const MAX_DELEGATION_DEPTH = 3;
    const depth = this.subagentDepth + 1;
    if (depth > MAX_DELEGATION_DEPTH) return undefined;
    return {
      depth,
      sessionId: this.sessionId,
      onEvent: (event: TurnEvent, info: SubagentInfo) => {
        // Forward to this coordinator's listeners, wrapped so the UI can
        // attribute the event to the child. The child turn's own sessionId
        // arrives on `info` (set by the orchestrator tool); emit-time
        // listener errors are contained in emit().
        this.emit({
          type: "subagent",
          subagent: { ...info, depth: info.depth ?? depth },
          event,
        });
      },
    };
  }

  private harvestDiscoverToolsOutput(execResult: ToolExecutionResult): void {
    try {
      const parsed = JSON.parse(String(execResult.output ?? ""));
      const caps = Array.isArray(parsed.capabilities) ? parsed.capabilities : [];
      for (const c of caps) {
        if (typeof c === "string" && c.trim()) {
          this.declaredCapabilities.add(c.toLowerCase().trim());
        }
      }
      const named = Array.isArray(parsed.tools)
        ? parsed.tools.filter((t: any) => t?.capabilities).flatMap((t: any) => t.capabilities)
        : [];
      for (const c of named) {
        if (typeof c === "string" && c.trim()) {
          this.declaredCapabilities.add(c.toLowerCase().trim());
        }
      }
    } catch {
      // discover_tools output is not JSON — ignore
    }
  }

  private async commitToolResult(
    tc: { id: string; function: { name: string } },
    args: Record<string, any>,
    execResult: ToolExecutionResult,
    isBlocked: boolean = false
  ): Promise<void> {
    const rawContent = isBlocked
      ? JSON.stringify(execResult)
      : JSON.stringify(execResult.output ?? execResult.error);
    const safeContent = this.vaultStore ? this.vaultStore.redactText(rawContent) : rawContent;
    const boundedContent = truncateToolOutput(safeContent, {
      maxCharacters: 16000,
      headCharacters: 10000,
      tailCharacters: 5000,
    });
    this.emit({ type: "tool_call_completed", toolCall: tc as any, result: execResult });
    const toolMessage: ChatMessage = { role: "tool", tool_call_id: tc.id, content: boundedContent };
    this.messages.push(toolMessage);
    await this.transcript.recordEvent(EVENT.toolCompleted, { message: toolMessage });
    await this.hookDispatcher.dispatchPostToolUse({
      sessionId: this.sessionId,
      toolName: tc.function.name,
      args,
      result: execResult,
    });
  }

  /**
   * Ask an ephemeral side-question (Grok Bot "BTW" prompt parity, Section 8.1.A).
   * Evaluates the query against active conversation context without modifying
   * session history or appending to the persistent transcript.
   */
  async askSideQuestion(question: string, signal?: AbortSignal): Promise<string> {
    const BTW_PROMPT_TEMPLATE = `You are answering a single ephemeral question about the user's current work. Use the provided conversation as context and respond directly in one answer. Do not ask follow-up questions, do not request mode switches, and do not mention tool limitations unless absolutely necessary.
If the conversation does not contain enough to answer, say so briefly.

${question}`;

    const ephemeralMessages: ChatMessage[] = [
      ...this.messages,
      {
        role: "user",
        content: BTW_PROMPT_TEMPLATE,
      },
    ];

    const { stream, getConsolidated } = await this.llmClient.streamCompletion(
      ephemeralMessages,
      [], // No tools in side-questions
      signal
    );

    for await (const delta of stream) {
      if (delta.content) {
        this.emit({ type: "text_delta", text: delta.content });
      }
    }

    const res = getConsolidated();
    return res.content ?? "";
  }

  /**
   * Roll back the conversation by N user turns (Grok Bot RollBackGrokBotConversation parity).
   * Rewinds the in-memory message history and rewrites the on-disk transcript.
   */
  async rollbackTurns(turnCount = 1): Promise<{ removedMessages: number; remainingMessages: number }> {
    if (turnCount <= 0) {
      return { removedMessages: 0, remainingMessages: this.messages.length };
    }

    // Find user message boundaries
    const userIndices: number[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      if (this.messages[i].role === "user") {
        userIndices.push(i);
      }
    }

    if (userIndices.length === 0) {
      return { removedMessages: 0, remainingMessages: this.messages.length };
    }

    // Target the index to cut from
    const targetTurnIndex = Math.max(0, userIndices.length - turnCount);
    const cutIndex = userIndices[targetTurnIndex];

    const originalLength = this.messages.length;
    this.messages = this.messages.slice(0, cutIndex);
    const removedMessages = originalLength - this.messages.length;

    await this.transcript.recordEvent(EVENT.turnRollback, {
      keepLength: cutIndex,
      turnsRolledBack: turnCount,
      removedMessages,
    });
    await this.transcript.writeProjections();

    return { removedMessages, remainingMessages: this.messages.length };
  }

  /**
   * Estimate the token footprint of the current active dialogue context.
   * Uses an accurate ~3.8 chars/token blended heuristic for code and natural language.
   */
  estimateTokens(): number {
    let totalChars = 0;
    for (const msg of this.messages) {
      if (msg.content) {
        totalChars += msg.content.length;
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          totalChars += tc.function.name.length + (tc.function.arguments?.length || 0);
        }
      }
    }
    return Math.ceil(totalChars / 3.8);
  }

  /**
   * Compact conversation history by condensing older turns into a dense summary,
   * preserving system instructions and the most recent active turns.
   */
  async compactHistory(options?: {
    keepRecentTurns?: number;
    customSummary?: string;
  }): Promise<{ originalTokens: number; compactedTokens: number; compactedTurnCount: number }> {
    const keepRecentTurns = options?.keepRecentTurns ?? 2;
    const originalTokens = this.estimateTokens();

    const userIndices: number[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      if (this.messages[i].role === "user") {
        userIndices.push(i);
      }
    }

    if (userIndices.length <= keepRecentTurns) {
      return { originalTokens, compactedTokens: originalTokens, compactedTurnCount: 0 };
    }

    const cutTurnIndex = userIndices.length - keepRecentTurns;

    // Lifecycle Hook: PreCompact (Parity with Claude Code PreCompact memory extraction)
    await this.hookDispatcher.dispatchPreCompact({
      sessionId: this.sessionId,
      turnCount: cutTurnIndex,
      tokensBefore: originalTokens,
    });

    const cutMessageIndex = userIndices[cutTurnIndex];

    const systemMessage = this.messages[0];
    const olderMessages = this.messages.slice(1, cutMessageIndex);
    const recentMessages = this.messages.slice(cutMessageIndex);

    let summaryText = options?.customSummary;
    if (!summaryText) {
      const bulletPoints: string[] = [];
      let currentQuery = "";
      for (const msg of olderMessages) {
        if (msg.role === "user") {
          currentQuery = (msg.content || "").replace(/\n+/g, " ").slice(0, 120);
        } else if (msg.role === "assistant" && currentQuery) {
          const respSnippet = (msg.content || "").replace(/\n+/g, " ").slice(0, 150);
          bulletPoints.push(`- User: "${currentQuery}" -> Assistant: "${respSnippet}"`);
          currentQuery = "";
        }
      }

      summaryText = `<historical_context_summary>\n## Compacted Prior History (${olderMessages.length} messages summarized):\n${bulletPoints.join("\n") || "- Earlier conversational turns completed successfully."}\n</historical_context_summary>`;
    }

    const summaryMessage: ChatMessage = {
      role: "system",
      content: summaryText,
    };

    this.messages = [systemMessage, summaryMessage, ...recentMessages];
    const compactedTokens = this.estimateTokens();

    await this.transcript.recordEvent(EVENT.turnCompacted, {
      keepFrom: cutMessageIndex,
      summary: summaryText,
      compactedTurns: cutTurnIndex,
      originalTokens,
      compactedTokens,
    });
    await this.transcript.writeProjections();

    return {
      originalTokens,
      compactedTokens,
      compactedTurnCount: cutTurnIndex,
    };
  }
}
