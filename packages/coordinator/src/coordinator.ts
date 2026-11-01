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

export interface CoordinatorOptions {
  llmClient: UniversalLLMClient;
  daemon: LocalExecDaemon;
  sessionId?: string;
  systemPromptContext?: SystemPromptContext;
  allowedTools?: string[];
  vaultStore?: VaultStore;
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
  public readonly vaultStore?: VaultStore;

  private messages: ChatMessage[] = [];
  private onApprovalRequired?: ApprovalHandler;
  private onEvent?: TurnEventListener;
  private maxTurnIterations: number;
  private initialized = false;

  constructor(options: CoordinatorOptions) {
    this.llmClient = options.llmClient;
    this.daemon = options.daemon;
    this.sessionId = options.sessionId ?? `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.transcript = new TranscriptManager(this.sessionId, options.sessionsBaseDir);
    this.allowedTools = options.allowedTools;
    this.vaultStore = options.vaultStore;
    this.onApprovalRequired = options.onApprovalRequired;
    this.onEvent = options.onEvent;
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

  private emit(event: TurnEvent): void {
    if (this.onEvent) {
      try {
        this.onEvent(event);
      } catch {
        // Event listener errors should not disrupt the agent turn loop
      }
    }
  }

  /**
   * Run a full multi-turn conversational tool-calling interaction turn.
   */
  async runTurn(userQuery: string, signal?: AbortSignal): Promise<string> {
    // 1. Record User Message
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

        this.emit({ type: "tool_call_completed", toolCall: tc, result: execResult });
        this.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: safeContent,
        });

        await this.transcript.appendJsonl({
          role: "tool",
          tool_call_id: tc.id,
          result: execResult,
        });
      }

      // Loop continues: LLM evaluates tool results
    }

    // Safety circuit breaker hit
    const fallbackMessage = `Execution limit reached: max turn iterations (${this.maxTurnIterations}) reached. Type 'continue' to proceed.`;
    this.emit({ type: "turn_completed", finalContent: fallbackMessage });
    await this.transcript.writeHumanReadableTranscript(this.messages);
    return fallbackMessage;
  }
}
