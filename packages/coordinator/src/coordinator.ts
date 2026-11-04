import { LocalExecDaemon, ToolExecutionResult } from "@opensand/local-exec-daemon";
import { UniversalLLMClient, ConsolidatedAssistantResponse } from "./llm-client.js";
import {
  ChatMessage,
  ToolCall,
  ApprovalRequest,
  ApprovalHandler,
  TurnEventListener,
  TurnEvent,
} from "./types.js";
import { TranscriptManager } from "./transcript-manager.js";
import { buildSystemPrompt, SystemPromptContext } from "./system-prompt.js";
import { VaultStore } from "./vault-store.js";
import { LifecycleHooks, HookDispatcher } from "./hooks.js";
import {
  truncateToolOutput,
  foldHistoricalToolResults,
  selectActiveTools,
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
}

export class AgentCoordinator {
  public readonly llmClient: UniversalLLMClient;
  public readonly daemon: LocalExecDaemon;
  public readonly transcript: TranscriptManager;
  public readonly sessionId: string;
  public readonly allowedTools?: string[];
  public readonly toolScopeMode: "core" | "auto" | "all";
  public readonly maxContextTokens: number;
  public readonly vaultStore?: VaultStore;
  public readonly hookDispatcher: HookDispatcher;

  private messages: ChatMessage[] = [];
  private onApprovalRequired?: ApprovalHandler;
  private eventListeners: Set<TurnEventListener> = new Set();
  private maxTurnIterations: number;
  private initialized = false;

  constructor(options: CoordinatorOptions) {
    this.llmClient = options.llmClient;
    this.daemon = options.daemon;
    this.sessionId = options.sessionId ?? `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.transcript = new TranscriptManager(this.sessionId, options.sessionsBaseDir);
    this.allowedTools = options.allowedTools;
    this.toolScopeMode = options.toolScopeMode ?? "auto";
    this.maxContextTokens = options.maxContextTokens ?? getModelMaxContextTokens(options.llmClient?.model);
    this.vaultStore = options.vaultStore;
    this.hookDispatcher = new HookDispatcher(options.hooks);
    this.onApprovalRequired = options.onApprovalRequired;
    if (options.onEvent) {
      this.eventListeners.add(options.onEvent);
    }
    this.maxTurnIterations = options.maxTurnIterations ?? 50;

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

      await this.hookDispatcher.dispatchSessionStart({
        sessionId: this.sessionId,
        systemPrompt: this.messages[0]?.content ?? undefined,
      });
    }

    // 1. Fold historical tool results from older turns to prevent memory and token explosion
    this.messages = foldHistoricalToolResults(this.messages, 2);

    // 2. Trigger auto-compaction if context footprint exceeds threshold
    if (this.estimateTokens() > this.maxContextTokens) {
      await this.compactHistory({ keepRecentTurns: 2 });
    }

    // 3. Record User Message
    this.messages.push({
      role: "user",
      content: userQuery,
    });

    this.emit({ type: "user_message", content: userQuery });
    await this.transcript.appendJsonl({ role: "user", content: userQuery });

    let iterations = 0;

    // 2. Multi-turn Agent Tool Loop
    while (iterations < this.maxTurnIterations) {
      iterations++;

      let toolDefs = this.daemon.getToolDefinitions();
      if (this.allowedTools && this.allowedTools.length > 0) {
        toolDefs = toolDefs.filter((d) => this.allowedTools!.includes(d.function.name));
      } else {
        toolDefs = selectActiveTools(toolDefs, userQuery, this.toolScopeMode);
      }

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
      await this.transcript.appendJsonl({
        role: "assistant",
        content: assistantMsg.content,
        tool_calls: assistantMsg.tool_calls,
      });

      // If no tool calls, the model concluded its response
      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        const finalContent = assistantMsg.content ?? "";
        this.emit({ type: "turn_completed", finalContent });
        await this.transcript.writeHumanReadableTranscript(this.messages);
        await this.hookDispatcher.dispatchStop({
          sessionId: this.sessionId,
          finalContent,
        });
        return finalContent;
      }

      // If the model called tools, execute each one
      for (const tc of assistantMsg.tool_calls) {
        this.emit({ type: "tool_call_started", toolCall: tc });

        // Enforce agent allowedTools whitelist policy
        if (this.allowedTools && this.allowedTools.length > 0 && !this.allowedTools.includes(tc.function.name)) {
          const unauthorizedResult: ToolExecutionResult = {
            status: "error",
            error: {
              code: "UNAUTHORIZED_TOOL",
              message: `Tool '${tc.function.name}' is not in this agent's authorized tools list: [${this.allowedTools.join(", ")}]`,
            },
          };
          this.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify(unauthorizedResult),
          });
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
          this.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify(parseErrorResult),
          });
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
          this.emit({ type: "tool_call_completed", toolCall: tc, result: hookDeniedResult });
          this.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify(hookDeniedResult),
          });
          await this.transcript.appendJsonl({
            role: "tool",
            tool_call_id: tc.id,
            result: hookDeniedResult,
          });
          continue;
        }

        if (preHook.modifiedArgs) {
          args = { ...args, ...preHook.modifiedArgs };
        }

        // Check if gate approval is needed
        let approvalGranted = false;
        const gates = await this.daemon.getGates();

        // Check if this requires manual approval
        const isExecCommand = tc.function.name === "exec_command";
        const cmd = typeof args.command === "string" ? args.command.trim() : "";
        const hasChaining = /[;&|`]|\$\(|\n/.test(cmd);
        const isAllowlisted =
          isExecCommand &&
          !hasChaining &&
          gates.standingAllowlist.some((pat) => {
            if (pat.endsWith("*")) {
              const prefix = pat.slice(0, -1).trim();
              return cmd === prefix || cmd.startsWith(`${prefix} `);
            }
            return cmd === pat || cmd.startsWith(`${pat} `);
          });

        const needsApproval =
          (isExecCommand && !gates.computerUseAllowed && !isAllowlisted);

        if (needsApproval && this.onApprovalRequired) {
          const approvalId = `appr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const req: ApprovalRequest = {
            approvalId,
            toolName: tc.function.name,
            arguments: args,
            reason: `Execution of tool '${tc.function.name}' requires explicit approval.`,
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
            this.emit({ type: "tool_call_completed", toolCall: tc, result: rejectedResult });
            this.messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify(rejectedResult),
            });
            await this.transcript.appendJsonl({
              role: "tool",
              tool_call_id: tc.id,
              result: rejectedResult,
            });
            continue;
          }
        }

        // Execute tool via daemon
        const execResult = await this.daemon.executeTool(tc.function.name, args, {
          approvalGranted,
          permissionGates: gates,
        });

        const rawContent = JSON.stringify(execResult.output ?? execResult.error);
        const safeContent = this.vaultStore ? this.vaultStore.redactText(rawContent) : rawContent;
        const boundedContent = truncateToolOutput(safeContent, {
          maxCharacters: 16000,
          headCharacters: 10000,
          tailCharacters: 5000,
        });

        this.emit({ type: "tool_call_completed", toolCall: tc, result: execResult });
        this.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: boundedContent,
        });

        await this.transcript.appendJsonl({
          role: "tool",
          tool_call_id: tc.id,
          result: execResult,
        });

        // Lifecycle Hook: PostToolUse
        await this.hookDispatcher.dispatchPostToolUse({
          sessionId: this.sessionId,
          toolName: tc.function.name,
          args,
          result: execResult,
        });
      }

      // Auto-compact if tool results pushed context above the safety limit
      if (this.estimateTokens() > this.maxContextTokens) {
        await this.compactHistory({ keepRecentTurns: 2 });
      }

      // Loop continues: LLM evaluates tool results
    }

    // Safety circuit breaker hit
    const fallbackMessage = `Execution limit reached: max turn iterations (${this.maxTurnIterations}) reached. Type 'continue' to proceed.`;
    this.emit({ type: "turn_completed", finalContent: fallbackMessage });
    await this.transcript.writeHumanReadableTranscript(this.messages);
    await this.hookDispatcher.dispatchStop({
      sessionId: this.sessionId,
      finalContent: fallbackMessage,
    });
    return fallbackMessage;
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

    // Rewrite human readable transcript
    await this.transcript.writeHumanReadableTranscript(this.messages);
    await this.transcript.appendJsonl({
      role: "system",
      event: "rollback",
      turnsRolledBack: turnCount,
      removedMessages,
      remainingMessages: this.messages.length,
    });

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

    await this.transcript.writeHumanReadableTranscript(this.messages);
    await this.transcript.appendJsonl({
      role: "system",
      event: "compacted",
      compactedTurns: cutTurnIndex,
      originalTokens,
      compactedTokens,
    });

    return {
      originalTokens,
      compactedTokens,
      compactedTurnCount: cutTurnIndex,
    };
  }
}
