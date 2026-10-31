import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ToolCall } from "@opensand/coordinator";
import { ToolExecutionResult } from "@opensand/local-exec-daemon";

// ANSI Styling Helpers
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";

export class TerminalUI {
  private inStreamToken = false;

  printBanner(model: string, endpoint: string): void {
    console.log(`${BOLD}${CYAN}=== OpenSand Universal Agent ===${RESET}`);
    console.log(`${DIM}Model:${RESET} ${BOLD}${model}${RESET} | ${DIM}Endpoint:${RESET} ${endpoint}`);
    console.log(`${DIM}Type 'exit' or Ctrl+C to terminate.${RESET}\n`);
  }

  printPromptPrefix(): void {
    output.write(`${BOLD}${MAGENTA}opensand>${RESET} `);
  }

  printInfo(text: string): void {
    console.log(`${DIM}${text}${RESET}`);
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

  onTextDelta(text: string): void {
    if (!this.inStreamToken) {
      output.write(`\n${BOLD}${CYAN}Assistant:${RESET}\n`);
      this.inStreamToken = true;
    }
    output.write(text);
  }

  onToolCallStart(toolCall: ToolCall): void {
    this.inStreamToken = false;
    let previewArgs = toolCall.function.arguments;
    if (previewArgs.length > 80) {
      previewArgs = previewArgs.slice(0, 77) + "...";
    }
    console.log(`\n${BOLD}${YELLOW}⚡ [Tool]${RESET} ${toolCall.function.name}: ${DIM}${previewArgs}${RESET}`);
  }

  onToolCallCompleted(toolCall: ToolCall, result: ToolExecutionResult): void {
    if (result.status === "ok") {
      console.log(`${GREEN}✔ [Result]${RESET} ${toolCall.function.name} succeeded`);
    } else {
      console.log(`${RED}✖ [Error]${RESET} ${toolCall.function.name}: ${result.error?.message}`);
    }
  }

  onTurnCompleted(): void {
    this.inStreamToken = false;
    output.write("\n\n");
  }

  async promptApproval(toolName: string, args: Record<string, any>): Promise<boolean> {
    const rl = readline.createInterface({ input, output });
    try {
      console.log(`\n${BOLD}${YELLOW}⚠️  Tool '${toolName}' requires authorization:${RESET}`);
      console.log(`${DIM}${JSON.stringify(args, null, 2)}${RESET}`);
      try {
        const answer = await rl.question(`${BOLD}Approve execution? [y/N]: ${RESET}`);
        return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
      } catch (err: any) {
        if (err?.code === "ABORT_ERR" || err?.name === "AbortError") {
          console.log(`\n${DIM}Approval rejected (interrupted).${RESET}`);
          return false;
        }
        throw err;
      }
    } finally {
      rl.close();
    }
  }
}
