import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ToolCall, TurnPhase, ApprovalDecision } from "@opensand/coordinator";
import { ToolExecutionResult } from "@opensand/local-exec-daemon";
import {
  parseToolArgs,
  summarizeToolCall,
  summarizeToolResult,
  previewToolOutput,
} from "./tool-summary.js";
import { TerminalSpinner } from "./spinner.js";

// ANSI Styling Helpers
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";

export type Verbosity = "quiet" | "normal" | "verbose";

interface RunningTool {
  toolCallId: string;
  name: string;
  startedAtMs: number;
}

export class TerminalUI {
  private inStreamToken = false;
  private verbosity: Verbosity = "normal";
  private readonly spinner = new TerminalSpinner();
  private readonly running = new Map<string, RunningTool>();
  private toolCount = 0;
  private turnStartedAtMs: number | null = null;
  private thinkingBuffer = "";
  private approvalNoticeShown = false;

  setVerbosity(v: Verbosity): void {
    this.verbosity = v;
  }

  get currentVerbosity(): Verbosity {
    return this.verbosity;
  }

  printBanner(model: string, endpoint: string): void {
    console.log(`${BOLD}${CYAN}=== OpenSand Universal Agent ===${RESET}`);
    console.log(`${DIM}Model:${RESET} ${BOLD}${model}${RESET} | ${DIM}Endpoint:${RESET} ${endpoint}`);
    console.log(`${DIM}Type 'exit' or Ctrl+C to terminate. During a turn: Ctrl+C cancels it.${RESET}`);
    console.log(`${DIM}REPL: /verbose thinking, /verbose tools (or /quiet) to tune output.${RESET}\n`);
  }

  printPromptPrefix(): void {
    output.write(`${BOLD}${MAGENTA}opensand>${RESET} `);
  }

  printInfo(text: string): void {
    console.log(`${DIM}${text}${RESET}`);
  }

  printSuccess(text: string): void {
    console.log(`${GREEN}✔ ${text}${RESET}`);
  }

  printWarning(text: string): void {
    console.log(`${YELLOW}⚠️  ${text}${RESET}`);
  }

  printError(text: string): void {
    console.log(`${RED}✖ ${text}${RESET}`);
  }

  printUserTurn(query: string): void {
    console.log(`\n${BOLD}${MAGENTA}User:${RESET} ${query}`);
  }

  /** Called when a user turn is submitted — resets per-turn state. */
  beginTurn(): void {
    this.onTurnStarted();
    this.spinner.start("Thinking", "thinking");
  }

  /** Mark the spinner as thinking (LLM streaming phase). */
  onThinking(): void {
    this.spinner.onPhaseChange("Thinking", "thinking");
  }

  /** Mark the spinner as running a tool (counts parallel tools). */
  onToolRunning(): void {
    const n = this.running.size;
    this.spinner.onPhaseChange(
      n > 1 ? `Running ${n} tools in parallel` : "Running tool",
      "tool"
    );
  }

  onTextDelta(text: string): void {
    this.spinner.clear();
    if (!this.inStreamToken) {
      output.write(`\n${BOLD}${CYAN}Assistant:${RESET}\n`);
      this.inStreamToken = true;
    }
    output.write(text);
  }

  onThoughtDelta(text: string): void {
    if (this.verbosity === "quiet") return;
    this.thinkingBuffer += text;
    if (this.verbosity === "verbose" && text) {
      this.spinner.clear();
      if (!this.inStreamToken) {
        output.write(`\n${DIM}💭 Thinking:${RESET}\n`);
        this.inStreamToken = true;
      }
      output.write(`${DIM}${text}${RESET}`);
    }
  }

  onToolCallStart(toolCall: ToolCall): void {
    this.inStreamToken = false;
    this.flushThinkingNote();
    const name = toolCall.function.name;
    const args = parseToolArgs(toolCall.function.arguments);
    this.running.set(toolCall.id, { toolCallId: toolCall.id, name, startedAtMs: Date.now() });
    this.toolCount += 1;

    if (this.verbosity === "quiet") {
      this.onToolRunning();
      return;
    }
    const summary = summarizeToolCall(name, args);
    this.spinner.finish(`${BOLD}${YELLOW}⚡ [Tool]${RESET} ${summary}`);
    this.onToolRunning();
  }

  onToolCallCompleted(toolCall: ToolCall, result: ToolExecutionResult): void {
    const rec = this.running.get(toolCall.id);
    this.running.delete(toolCall.id);
    const startedAt = rec?.startedAtMs;

    if (this.verbosity === "quiet") {
      if (result.status === "error") {
        this.spinner.finish(`${RED}✖ [Error]${RESET} ${toolCall.function.name}: ${result.error?.message ?? "failed"}`);
      }
      if (this.running.size > 0) this.onToolRunning();
      return;
    }

    const name = toolCall.function.name;
    const summary = summarizeToolResult(
      name,
      {
        status: result.status,
        output: result.output,
        error: result.error ? { message: result.error.message } : undefined,
      },
      startedAt
    );
    if (result.status === "ok") {
      this.spinner.finish(`${GREEN}✔ [Result]${RESET} ${name} — ${summary}`);
      const preview = previewToolOutput(name, result.output, result.status === "ok" ? 3 : 5);
      for (const line of preview) {
        console.log(`${DIM}  │ ${line}${RESET}`);
      }
    } else if (result.status === "permission_pending") {
      this.spinner.finish(`${YELLOW}⏳ [Pending]${RESET} ${name} — ${summary}`);
    } else {
      this.spinner.finish(`${RED}✖ [Error]${RESET} ${name} — ${summary}`);
      const preview = previewToolOutput(name, result.output, 5);
      for (const line of preview) {
        console.log(`${DIM}  │ ${line}${RESET}`);
      }
    }

    if (this.running.size > 0) this.onToolRunning();
  }

  onTurnStarted(): void {
    this.turnStartedAtMs = Date.now();
    this.toolCount = 0;
    this.thinkingBuffer = "";
    this.running.clear();
    this.approvalNoticeShown = false;
  }

  onTurnCompleted(finalContent?: string): void {
    this.inStreamToken = false;
    this.spinner.clear();
    this.running.clear();
    const elapsed =
      this.turnStartedAtMs != null
        ? Math.round((Date.now() - this.turnStartedAtMs) / 1000)
        : 0;
    const stats = `${this.toolCount} tool${this.toolCount === 1 ? "" : "s"}, ${elapsed}s`;

    if (finalContent && finalContent.includes("Execution limit reached")) {
      console.log(`\n${BOLD}${YELLOW}⚠️  [${finalContent}]${RESET}\n`);
    } else if (finalContent) {
      output.write("\n");
    } else {
      output.write("\n");
    }
    if (this.verbosity !== "quiet" || elapsed > 0) {
      console.log(`${DIM}[turn: ${stats}]${RESET}`);
    }
    this.turnStartedAtMs = null;
  }

  onCancelled(): void {
    this.spinner.clear();
    this.running.clear();
    this.inStreamToken = false;
    console.log(`${DIM}[turn cancelled]${RESET}`);
  }

  /** Show a one-time hint when an approval prompt appears. */
  noteApprovalRequired(toolName: string): void {
    this.spinner.clear();
    if (!this.approvalNoticeShown) {
      this.approvalNoticeShown = true;
      console.log(`${YELLOW}⏸️  Waiting for approval to run ${toolName}…${RESET}`);
    }
  }

  async promptApproval(toolName: string, args: Record<string, any>): Promise<ApprovalDecision> {
    this.spinner.onPhaseChange(`Paused — approval required`, "tool");
    this.noteApprovalRequired(toolName);
    const rl = readline.createInterface({ input, output });
    try {
      const summary = summarizeToolCall(toolName, args);
      console.log(`\n${BOLD}${YELLOW}⏸️  Approval required — run this tool?${RESET}`);
      console.log(`  ${BOLD}${summary}${RESET} ${DIM}(${toolName})${RESET}`);
      console.log(`${DIM}${safeJson(args)}${RESET}`);
      console.log(`${DIM}  y = allow once   s = allow for this session   n = deny${RESET}`);
      try {
        const answer = await rl.question(`${BOLD}Allow? [y/s/n]: ${RESET}`);
        const v = answer.trim().toLowerCase();
        if (v === "y" || v === "yes") return "allow_once";
        if (v === "s" || v === "session" || v === "always") return "allow_session";
        return "deny";
      } catch (err: any) {
        if (err?.code === "ABORT_ERR" || err?.name === "AbortError") {
          console.log(`\n${DIM}Approval rejected (interrupted).${RESET}`);
          return "deny";
        }
        throw err;
      }
    } finally {
      rl.close();
    }
  }

  /** Handle a phase_started event from the coordinator (P1). */
  onPhaseStarted(phase: TurnPhase, iteration: number, maxIterations: number): void {
    const step = `step ${iteration}/${maxIterations}`;
    if (phase === "thinking") {
      this.spinner.onPhaseChange(`Thinking… ${DIM}[${step}]${RESET}`, "thinking");
    } else {
      this.onToolRunning();
      if (this.verbosity !== "quiet" && !this.running.size) {
        this.spinner.onPhaseChange(`Executing tools… ${DIM}[${step}]${RESET}`, "tool");
      }
    }
  }

  private flushThinkingNote(): void {
    if (this.verbosity === "verbose" && this.thinkingBuffer.trim()) {
      console.log(`${DIM}💭 …${RESET}`);
    }
    this.thinkingBuffer = "";
  }
}

function safeJson(args: Record<string, any>): string {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}
