import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import * as fs from "node:fs/promises";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import { registerNativeTools } from "@opensand/native-bridge";
import {
  UniversalLLMClient,
  AgentCoordinator,
  McpManager,
  registerOrchestratorTools,
  AgentRecord,
} from "@opensand/coordinator";
import { parseCliArgs, CliConfig, probeLocalOllama, validateConfig } from "./config.js";
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
  --list-tools             List all active OS, orchestrator, and MCP tools
  --list-bots              List all registered bot personas in the Agent Store
  --list-tasks             List all agent tasks and milestones
  --auto-approve, -y       Auto-approve tool execution (non-interactive mode)
  --help, -h               Show this help message
  --version, -v            Show version

Interactive REPL Commands:
  /help                    Show available REPL commands
  /tools                   List all active registered tools
  /bots                    List all registered bot personas
  /bot <name>              Switch active bot persona on the fly
  /tasks                   List active agent tasks
  /rules                   View learned continuous user guidelines
  /clear                   Clear terminal screen
  exit, quit, /exit        Exit REPL

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

  // If endpoint is cloud OpenAI default and no key is provided, check if local Ollama is alive
  const explicitEndpoint = argv.includes("--endpoint");
  const hasValidApiKey = Boolean(config.apiKey && config.apiKey.trim() !== "" && config.apiKey !== "none");
  if (!explicitEndpoint && !hasValidApiKey && config.endpoint.includes("api.openai.com")) {
    const local = await probeLocalOllama(400);
    if (local) {
      config.endpoint = local.endpoint;
      if (!argv.includes("--model") && !process.env.OPENSAND_MODEL) {
        config.model = local.model;
      }
      config.apiKey = "none";
      ui.printInfo(`💡 Auto-detected local Ollama (${config.model}) at ${config.endpoint}`);
    }
  }

  // Preflight validation for credentials
  const validation = validateConfig(config);
  if (!validation.valid && validation.warning) {
    ui.printWarning(validation.warning);
  }

  // 1. Initialize Local Execution Daemon & Native Tools
  const daemon = new LocalExecDaemon();
  registerNativeTools(daemon);
  await daemon.start();

  // Initialize Orchestrator Meta-Tools (create_agent, list_agents, delegate_to_agent)
  const { store: agentStore, taskStore, habitExtractor } = registerOrchestratorTools({
    daemon,
    defaultEndpoint: config.endpoint,
    defaultModel: config.model,
    defaultApiKey: config.apiKey,
  });

  // Handle direct listing flags
  if (config.listTools) {
    const defs = daemon.getToolDefinitions();
    console.log(`\n\x1b[1m=== Active Registered OpenSand Tools (${defs.length}) ===\x1b[0m`);
    defs.forEach((d, i) => {
      console.log(`  \x1b[36m${(i + 1).toString().padStart(2, " ")}. ${d.function.name.padEnd(24, " ")}\x1b[0m \x1b[2m${d.function.description.slice(0, 75)}\x1b[0m`);
    });
    console.log("");
    await daemon.stop();
    return;
  }

  if (config.listBots) {
    const agents = await agentStore.listAgents();
    console.log(`\n\x1b[1m=== Registered Agent Store Personas (${agents.length}) ===\x1b[0m`);
    if (agents.length === 0) {
      console.log("  No custom agents registered yet. Use create_agent to add bots.");
    } else {
      agents.forEach((a) => {
        console.log(`  \x1b[35m🤖 ${a.name}\x1b[0m (${a.role}) [ID: ${a.id}]`);
        console.log(`     \x1b[2mModel: ${a.model ?? "default"} | Tools: ${a.allowedTools ? a.allowedTools.join(", ") : "all"}\x1b[0m`);
      });
    }
    console.log("");
    await daemon.stop();
    return;
  }

  if (config.listTasks) {
    const tasks = await taskStore.listTasks();
    console.log(`\n\x1b[1m=== OpenSand Tasks & Milestones (${tasks.length}) ===\x1b[0m`);
    if (tasks.length === 0) {
      console.log("  No active tasks.");
    } else {
      tasks.forEach((t) => {
        const mark = t.status === "done" ? "\x1b[32m✔\x1b[0m" : "\x1b[33m⏳\x1b[0m";
        console.log(`  ${mark} [${t.priority.toUpperCase()}] ${t.title} (${t.status})`);
      });
    }
    console.log("");
    await daemon.stop();
    return;
  }

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
  let activeAgent: AgentRecord | null = null;

  if (config.bot) {
    const agent = await agentStore.getAgent(config.bot);
    if (agent) {
      activeAgent = agent;
      userInstructions = agent.systemPrompt;
      if (agent.model) config.model = agent.model;
      if (agent.endpoint) config.endpoint = agent.endpoint;
      ui.printInfo(`🤖 Activated Bot Persona from Agent Store: ${agent.name} (${agent.role})`);
    } else {
      console.error(`Warning: Bot persona '${config.bot}' not found in Agent Store. Run 'opensand --list-bots'.`);
    }
  } else if (config.systemPromptFile) {
    try {
      userInstructions = await fs.readFile(config.systemPromptFile, "utf-8");
    } catch (err: any) {
      console.error(`Warning: failed to read system prompt file: ${err.message}`);
    }
  }

  const learnedRules = await habitExtractor.getLearnedRulesMarkdown();

  // Helper to build coordinator
  function createCoordinator(instructions?: string, modelOverride?: string, endpointOverride?: string): AgentCoordinator {
    const targetModel = modelOverride || config.model;
    const targetEndpoint = endpointOverride || config.endpoint;

    const llmClient = new UniversalLLMClient({
      baseUrl: targetEndpoint,
      model: targetModel,
      apiKey: config.apiKey,
    });

    return new AgentCoordinator({
      llmClient,
      daemon,
      allowedTools: activeAgent?.allowedTools,
      systemPromptContext: {
        userInstructions: instructions,
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
          case "thought_delta":
            // Render thinking in dimmed italics if present
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
  }

  let coordinator = createCoordinator(userInstructions, config.model, config.endpoint);

  ui.printBanner(config.model, config.endpoint);
  if (mcpCount > 0) {
    ui.printInfo(`Loaded ${mcpCount} external MCP server(s)`);
  }

  // 3. Execution mode: single query or interactive REPL
  if (config.query) {
    const isCloudOpenAI =
      config.endpoint.includes("api.openai.com") ||
      (!config.endpoint.includes("127.0.0.1") &&
        !config.endpoint.includes("localhost") &&
        !config.endpoint.includes("192.168.") &&
        !config.endpoint.includes("10."));
    const hasApiKey = Boolean(config.apiKey && config.apiKey.trim() !== "" && config.apiKey !== "none");
    if (isCloudOpenAI && !hasApiKey) {
      ui.printError(
        `Cannot execute query: No API key configured for ${config.endpoint}.\n` +
        `  Fix: Set OPENAI_API_KEY="sk-..." or run with local Ollama: opensand --endpoint http://127.0.0.1:11434/v1 --model qwen3:8b`
      );
      process.exitCode = 1;
      await daemon.stop();
      return;
    }

    ui.printUserTurn(config.query);
    const queryAbort = new AbortController();
    const onSigInt = () => {
      queryAbort.abort();
    };
    process.on("SIGINT", onSigInt);

    try {
      await coordinator.runTurn(config.query, queryAbort.signal);
      console.log("\n");
    } catch (err: any) {
      if (queryAbort.signal.aborted || err?.name === "AbortError" || err?.code === "ABORT_ERR") {
        ui.printInfo("\n[Execution cancelled by user]");
      } else {
        ui.printError(`Execution failed: ${err.message}`);
      }
      process.exitCode = 1;
    } finally {
      process.off("SIGINT", onSigInt);
      await daemon.stop();
    }
    return;
  }

  // Interactive REPL loop
  const rl = readline.createInterface({ input, output });

  try {
    while (true) {
      const promptPrefix = activeAgent ? `\x1b[35m${activeAgent.name}>\x1b[0m ` : `\x1b[36mopensand>\x1b[0m `;
      let line: string;
      try {
        line = await rl.question(`\n${promptPrefix}`);
      } catch (err: any) {
        if (err?.code === "ABORT_ERR" || err?.name === "AbortError") {
          console.log("\nExiting OpenSand.");
          break;
        }
        throw err;
      }

      const trimmed = line.trim();

      if (!trimmed) continue;
      if (trimmed === "exit" || trimmed === "quit" || trimmed === "/exit") {
        break;
      }

      // REPL Built-in Slash Commands
      if (trimmed === "/help") {
        console.log(`
Available OpenSand REPL Commands:
  /tools              List all active OS, orchestrator, and MCP tools
  /bots, /agents      List all registered bot personas in Agent Store
  /bot <name>         Switch active bot persona (e.g. '/bot cto' or '/bot default')
  /tasks              List active agent tasks and milestones
  /rules              Show continuous learning guidelines
  /clear              Clear terminal screen
  exit, quit, /exit   Terminate REPL session
`);
        continue;
      }

      if (trimmed === "/clear") {
        console.clear();
        continue;
      }

      if (trimmed === "/tools") {
        const defs = daemon.getToolDefinitions();
        console.log(`\n\x1b[1m=== Active Registered OpenSand Tools (${defs.length}) ===\x1b[0m`);
        defs.forEach((d, i) => {
          console.log(`  \x1b[36m${(i + 1).toString().padStart(2, " ")}. ${d.function.name.padEnd(24, " ")}\x1b[0m \x1b[2m${d.function.description.slice(0, 75)}\x1b[0m`);
        });
        continue;
      }

      if (trimmed === "/bots" || trimmed === "/agents") {
        const agents = await agentStore.listAgents();
        console.log(`\n\x1b[1m=== Registered Agent Store Personas (${agents.length}) ===\x1b[0m`);
        if (agents.length === 0) {
          console.log("  No custom agents registered yet. Use create_agent to add bots.");
        } else {
          agents.forEach((a) => {
            console.log(`  \x1b[35m🤖 ${a.name}\x1b[0m (${a.role}) [ID: ${a.id}]`);
            console.log(`     \x1b[2mModel: ${a.model ?? "default"} | Tools: ${a.allowedTools ? a.allowedTools.join(", ") : "all"}\x1b[0m`);
          });
        }
        continue;
      }

      if (trimmed.startsWith("/bot ")) {
        const query = trimmed.slice(5).trim();
        if (query === "default" || query === "reset") {
          activeAgent = null;
          coordinator = createCoordinator(undefined, config.model, config.endpoint);
          ui.printInfo("Switched active persona back to: ⚡ Default Assistant");
        } else {
          const agent = await agentStore.getAgent(query);
          if (agent) {
            activeAgent = agent;
            coordinator = createCoordinator(agent.systemPrompt, agent.model, agent.endpoint);
            ui.printInfo(`Switched active persona to: 🤖 ${agent.name} (${agent.role})`);
          } else {
            ui.printError(`Agent '${query}' not found in Agent Store. Run /bots to inspect available agents.`);
          }
        }
        continue;
      }

      if (trimmed === "/tasks") {
        const tasks = await taskStore.listTasks();
        console.log(`\n\x1b[1m=== OpenSand Tasks & Milestones (${tasks.length}) ===\x1b[0m`);
        if (tasks.length === 0) {
          console.log("  No active tasks.");
        } else {
          tasks.forEach((t) => {
            const mark = t.status === "done" ? "\x1b[32m✔\x1b[0m" : "\x1b[33m⏳\x1b[0m";
            console.log(`  ${mark} [${t.priority.toUpperCase()}] ${t.title} (${t.status})`);
          });
        }
        continue;
      }

      if (trimmed === "/rules") {
        const rules = await habitExtractor.getLearnedRulesMarkdown();
        console.log(`\n\x1b[1m=== Continuous Learned User Guidelines ===\x1b[0m\n${rules || "No rules extracted yet."}`);
        continue;
      }

      // Preflight check for unauthenticated cloud endpoint
      const isCloudOpenAI =
        config.endpoint.includes("api.openai.com") ||
        (!config.endpoint.includes("127.0.0.1") &&
          !config.endpoint.includes("localhost") &&
          !config.endpoint.includes("192.168.") &&
          !config.endpoint.includes("10."));
      const hasApiKey = Boolean(config.apiKey && config.apiKey.trim() !== "" && config.apiKey !== "none");
      if (isCloudOpenAI && !hasApiKey) {
        ui.printError(
          `Cannot execute turn: No API key configured for ${config.endpoint}.\n` +
          `  Fix: Set OPENAI_API_KEY="sk-..." or run opensand --endpoint http://127.0.0.1:11434/v1 --model qwen3:8b`
        );
        continue;
      }

      // Normal turn execution with interrupt support
      ui.printUserTurn(trimmed);
      const turnAbort = new AbortController();
      const onSigInt = () => {
        turnAbort.abort();
      };
      process.on("SIGINT", onSigInt);

      try {
        await coordinator.runTurn(trimmed, turnAbort.signal);
        console.log("\n");
      } catch (err: any) {
        if (turnAbort.signal.aborted || err?.name === "AbortError" || err?.code === "ABORT_ERR") {
          ui.printInfo("\n[Turn cancelled by user]");
        } else {
          ui.printError(`Turn failed: ${err.message}`);
        }
      } finally {
        process.off("SIGINT", onSigInt);
      }
    }
  } finally {
    rl.close();
    await daemon.stop();
  }
}
