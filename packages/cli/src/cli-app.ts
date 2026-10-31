import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import * as fs from "node:fs/promises";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import { registerNativeTools } from "@opensand/native-bridge";
import { UniversalLLMClient, AgentCoordinator, McpManager, registerOrchestratorTools } from "@opensand/coordinator";
import { parseCliArgs, CliConfig } from "./config.js";
import { TerminalUI } from "./terminal-ui.js";

export async function runCli(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`
OpenSand - Universal Autonomous Coding Agent (Grok Bot Parity)

Usage:
  opensand [options] [query]

Options:
  --endpoint <url>         LLM API base URL (default: $OPENSAND_ENDPOINT or OpenAI)
  --model <name>           Model identifier (default: $OPENSAND_MODEL or gpt-4o)
  --api-key <key>          API key (default: $OPENSAND_API_KEY)
  --bot <id_or_name>       Activate a registered bot persona from Agent Store (e.g. 'cto')
  --system-prompt <file>   Path to custom instructions markdown/text file
  --auto-approve, -y       Auto-approve tool execution (non-interactive mode)
  --help, -h               Show this help message
  --version, -v            Show version

Examples:
  opensand "List on-screen windows and summarize open apps"
  opensand --bot cto "Audit packages/local-exec-daemon for security vulnerabilities"
  opensand --model qwen3:8b --endpoint http://127.0.0.1:11434/v1 "Inspect the repository"
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

  // Initialize Orchestrator Meta-Tools (create_agent, list_agents, delegate_to_agent)
  const { store: agentStore, habitExtractor } = registerOrchestratorTools({
    daemon,
    defaultEndpoint: config.endpoint,
    defaultModel: config.model,
    defaultApiKey: config.apiKey,
  });

  // Initialize MCP Manager & load configured servers
  const mcp = new McpManager({ daemon });
  const mcpCount = await mcp.startAll();

  if (config.autoApprove) {
    await daemon.updateGates({
      computerUseAllowed: true,
      deviceToolsAllowed: true,
    });
  }

  // 2. Custom system prompt or bot persona if supplied
  let userInstructions: string | undefined;
  if (config.bot) {
    const agent = await agentStore.getAgent(config.bot);
    if (agent) {
      userInstructions = agent.systemPrompt;
      if (agent.model) config.model = agent.model;
      if (agent.endpoint) config.endpoint = agent.endpoint;
      ui.printInfo(`🤖 Activated Bot Persona from Agent Store: ${agent.name} (${agent.role})`);
    } else {
      console.error(`Warning: Bot persona '${config.bot}' not found in Agent Store. Run 'opensand' and ask it to create_agent.`);
    }
  } else if (config.systemPromptFile) {
    try {
      userInstructions = await fs.readFile(config.systemPromptFile, "utf-8");
    } catch (err: any) {
      console.error(`Warning: failed to read system prompt file: ${err.message}`);
    }
  }

  const learnedRules = await habitExtractor.getLearnedRulesMarkdown();

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
      learnedRules,
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
        case "error":
          ui.printError(event.error.message);
          break;
      }
    },
  });

  ui.printBanner(config.model, config.endpoint);
  if (mcpCount > 0) {
    ui.printInfo(`Loaded ${mcpCount} external MCP server(s)`);
  }

  // 5. Execution mode: single query or interactive REPL
  if (config.query) {
    ui.printUserTurn(config.query);
    try {
      await coordinator.runTurn(config.query);
      console.log("\n");
    } catch (err: any) {
      ui.printError(`Execution failed: ${err.message}`);
      process.exitCode = 1;
    } finally {
      await daemon.stop();
    }
    return;
  }

  // Interactive REPL loop
  const rl = readline.createInterface({ input, output });

  try {
    while (true) {
      const line = await rl.question("\n\x1b[36mopensand>\x1b[0m ");
      const trimmed = line.trim();

      if (!trimmed) continue;
      if (trimmed === "exit" || trimmed === "quit" || trimmed === "/exit") {
        break;
      }

      ui.printUserTurn(trimmed);
      try {
        await coordinator.runTurn(trimmed);
        console.log("\n");
      } catch (err: any) {
        ui.printError(`Turn failed: ${err.message}`);
      }
    }
  } finally {
    rl.close();
    await daemon.stop();
  }
}
