import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import * as fs from "node:fs/promises";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import { registerNativeTools } from "@opensand/native-bridge";
import { UniversalLLMClient, AgentCoordinator } from "@opensand/coordinator";
import { parseCliArgs, CliConfig } from "./config.js";
import { TerminalUI } from "./terminal-ui.js";

export async function runCli(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`OpenSand - Universal Open-Source Desktop Agent CLI

Usage:
  opensand [options] [query]

Options:
  --model <model>           Model name (default: $OPENSAND_MODEL or gpt-4o)
  --endpoint <url>          Endpoint URL (default: $OPENSAND_ENDPOINT or https://api.openai.com/v1)
  --api-key <key>           API Key (default: $OPENSAND_API_KEY or $OPENAI_API_KEY)
  --auto-approve, -y        Auto-approve all tool operations without prompting
  --system-prompt <file>    Custom system prompt file path
  --help, -h                Show help
  --version, -v             Show version

Examples:
  opensand "List all git branches and check status"
  opensand --model llama3 --endpoint http://localhost:11434/v1
  opensand --auto-approve
`);
    return;
  }

  if (argv.includes("--version") || argv.includes("-v")) {
    console.log("opensand 0.1.0");
    return;
  }

  const config = parseCliArgs(argv);
  const ui = new TerminalUI();

  // 1. Initialize Local Execution Daemon & Native Tools
  const daemon = new LocalExecDaemon();
  registerNativeTools(daemon);
  await daemon.start();

  if (config.autoApprove) {
    await daemon.updateGates({
      computerUseAllowed: true,
      deviceToolsAllowed: true,
    });
  }

  // 2. Custom system prompt if supplied
  let userInstructions: string | undefined;
  if (config.systemPromptFile) {
    try {
      userInstructions = await fs.readFile(config.systemPromptFile, "utf-8");
    } catch (err: any) {
      console.error(`Warning: failed to read system prompt file: ${err.message}`);
    }
  }

  // 3. Initialize Universal LLM Client
  const llmClient = new UniversalLLMClient({
    baseUrl: config.endpoint,
    model: config.model,
    apiKey: config.apiKey,
  });

  // 4. Initialize Agent Coordinator
  const coordinator = new AgentCoordinator({
    llmClient,
    daemon,
    systemPromptContext: {
      userInstructions,
    },
    onApprovalRequired: async (req) => {
      if (config.autoApprove) return true;
      return ui.promptApproval(req.toolName, req.arguments);
    },
    onEvent: (event) => {
      switch (event.type) {
        case "text_delta":
          ui.onTextDelta(event.text);
          break;
        case "tool_call_started":
          ui.onToolCallStart(event.toolCall);
          break;
        case "tool_call_completed":
          ui.onToolCallCompleted(event.toolCall, event.result);
          break;
        case "turn_completed":
          ui.onTurnCompleted();
          break;
      }
    },
  });

  try {
    // One-shot mode
    if (config.query) {
      ui.printBanner(config.model, config.endpoint);
      console.log(`Query: ${config.query}\n`);
      await coordinator.runTurn(config.query);
      return;
    }

    // Interactive REPL Mode
    ui.printBanner(config.model, config.endpoint);
    const rl = readline.createInterface({ input, output });

    while (true) {
      ui.printPromptPrefix();
      const line = await rl.question("");
      const trimmed = line.trim();

      if (!trimmed) continue;
      if (trimmed === "exit" || trimmed === "quit" || trimmed === "/exit") {
        console.log("Goodbye!");
        break;
      }

      try {
        await coordinator.runTurn(trimmed);
      } catch (err: any) {
        console.error(`\nTurn error: ${err.message}\n`);
      }
    }

    rl.close();
  } finally {
    await daemon.stop();
  }
}
