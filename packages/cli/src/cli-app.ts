import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import { registerNativeTools } from "@opensand/native-bridge";
import { runStateMigrations } from "@opensand/shared";
import {
  UniversalLLMClient,
  AgentCoordinator,
  McpManager,
  registerOrchestratorTools,
  AgentRecord,
  GitManager,
  MemoryStore,
  MemoStore,
  ApprovalDecision,
  listSessions,
  SessionSummary,
  SessionLockManager,
  SessionLockedError,
  SessionLockHandle,
  loadSessionMetadata,
} from "@opensand/coordinator";
import { sigIntAction, formatResumeHint } from "./interrupt.js";
import { matchSession, validateResumeEnvironment } from "./sessions.js";
import { parseCliArgs, CliConfig, probeLocalOllama, validateConfig } from "./config.js";
import { TerminalUI } from "./terminal-ui.js";
import { runDoctorProbes } from "./doctor.js";
import { getFleetStatus } from "./status.js";
import {
  generateZshCompletion,
  generateBashCompletion,
  getReplCompletions,
} from "./completion.js";

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
  --resume [id]            Resume a saved session (omit id for the most recent)
  --continue, -c           Resume the most recent session
  --worktree [name]        Run in an isolated Git worktree sandbox (CCD & Codex parity)
  --list-tools             List all active OS, orchestrator, and MCP tools
  --list-bots              List all registered bot personas in the Agent Store
  --list-tasks             List all agent tasks and milestones
  --auto-approve, -y       Auto-approve tool execution (non-interactive mode)
  --help, -h               Show this help message
  --version, -v            Show version
  completion <bash|zsh>    Generate shell completion script
  doctor [--json]          Run environment diagnostics
  uninstall [--yes]        Remove local data in ~/.opensand

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

  try {
    const migration = runStateMigrations(path.join(os.homedir(), ".opensand", "state"));
    if (migration.migrated) {
      console.log(
        `State schema upgraded v${migration.from} -> v${migration.to}` +
          (migration.backupDir ? ` (backup ${migration.backupDir})` : ""),
      );
    }
  } catch (err) {
    console.error(`Cannot start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const config = parseCliArgs(argv);
  const ui = new TerminalUI();

  if (argv[0] === "retention" || argv[0] === "prune") {
    const { evaluateRetention, pruneSessions } = await import("@opensand/coordinator");
    const sub = argv[1] || "status";
    if (sub === "status" || sub === "dry-run") {
      const { kept, removed } = await evaluateRetention();
      console.log(`Sessions: ${kept.length} kept, ${removed.length} over policy (keep 30, age 90d, keep-recent 7d)`);
      for (const c of removed.slice(0, 10)) {
        console.log(`  over: ${c.sessionId} (${new Date(c.mtimeMs).toISOString().slice(0, 10)})`);
      }
      if (removed.length > 10) console.log(`  ... and ${removed.length - 10} more`);
      if (sub === "status") {
        console.log("Run 'opensand retention prune' to delete the over-policy sessions.");
      }
    } else if (sub === "prune") {
      const { removed } = await pruneSessions();
      console.log(`Pruned ${removed.length} session directories.`);
      for (const c of removed.slice(0, 10)) {
        console.log(`  removed: ${c.sessionId}`);
      }
    }
    process.exit(0);
  }

  if (argv[0] === "uninstall") {
    const baseDir = path.join(os.homedir(), ".opensand");
    const appSupport = [
      path.join(os.homedir(), "Library", "Application Support", "OpenSand"),
      path.join(os.homedir(), "Library", "Application Support", "@opensand"),
      path.join(os.homedir(), "Library", "Caches", "OpenSand"),
      path.join(os.homedir(), "Library", "Preferences", "com.opensand.agent.plist"),
      path.join(os.homedir(), "Library", "Saved Application State", "com.opensand.agent.savedState"),
    ];
    const targets = [baseDir, ...appSupport].filter((dir) => fsSync.existsSync(dir));

    if (targets.length === 0) {
      console.log("Nothing to remove: no local OpenSand data found.");
      return;
    }

    console.log("This removes OpenSand's local data:");
    for (const target of targets) console.log(`  ${target}`);
    console.log("The app itself is separate: drag OpenSand.app from Applications to the Trash.");

    if (!argv.includes("--yes") && !argv.includes("-y")) {
      const rl = readline.createInterface({ input, output });
      const answer = await rl.question('Type "remove" to delete this data: ');
      rl.close();
      if (answer.trim() !== "remove") {
        console.log("Cancelled. Nothing was deleted.");
        return;
      }
    }

    for (const target of targets) {
      await fs.rm(target, { recursive: true, force: true });
      console.log(`removed ${target}`);
    }
    console.log("Done. Launch the app again and it starts from a clean first run.");
    return;
  }

  if (argv[0] === "doctor" || argv.includes("--doctor")) {
    const { probes, allCriticalPassed } = await runDoctorProbes({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      model: config.model,
    });

    if (argv.includes("--json")) {
      console.log(JSON.stringify({
        version: "0.1.0",
        generatedAt: new Date().toISOString(),
        allCriticalPassed,
        probes,
      }, null, 2));
      if (!allCriticalPassed) process.exit(1);
      return;
    }

    console.log(`\n\x1b[1m=== OpenSand System Doctor & Environment Preflight ===\x1b[0m\n`);
    for (const p of probes) {
      const mark = p.status === "ok" ? "\x1b[32m✔\x1b[0m" : p.status === "warn" ? "\x1b[33m▲\x1b[0m" : "\x1b[31m✖\x1b[0m";
      console.log(`  ${mark} \x1b[1m[${p.category}]\x1b[0m \x1b[36m${p.name}\x1b[0m: ${p.message}`);
    }
    console.log("");
    if (allCriticalPassed) {
      console.log("\x1b[32m✔ All critical preflight probes passed! OpenSand is ready for autonomous execution.\x1b[0m\n");
    } else {
      console.log("\x1b[31m✖ One or more critical probes failed. Please check the logs above.\x1b[0m\n");
      process.exit(1);
    }
    return;
  }

  if (argv[0] === "status" || argv.includes("--status")) {
    const fleet = await getFleetStatus();
    console.log(`\n\x1b[1m=== OpenSand Universal Agent Fleet Status ===\x1b[0m`);
    console.log(`  🤖 Registered Agents:      ${fleet.agents.length}`);
    console.log(`  👥 Collaborative Rooms:    ${fleet.rooms.length}`);
    console.log(`  ⏱ Scheduled Routines:     ${fleet.routines.length}`);
    console.log(`  🧩 Recipe Skills:          ${fleet.skills.length}`);
    console.log(`  🔐 Encrypted Vault:        ${fleet.secrets.length} secrets, ${fleet.creds.length} credentials`);
    console.log(`  📎 Staged Attachments:     ${fleet.attachments.length} files`);
    console.log(`  📋 Active Tasks & Todos:   ${fleet.tasks.length} items`);
    console.log(`  🧠 Cognitive Memory Facts: ${fleet.memories.length} facts\n`);
    return;
  }

  // Shell Completion Generator
  if (config.completion) {
    if (config.completion === "zsh") {
      console.log(generateZshCompletion());
    } else {
      console.log(generateBashCompletion());
    }
    return;
  }

  // Git Worktree Sandbox Isolation (Parity with CCD git-worktrees & shadow sandboxing)
  if (config.worktree) {
    const gitManager = new GitManager();
    try {
      ui.printInfo(`🌿 Preparing isolated Git worktree sandbox: ${config.worktree}...`);
      const { worktreePath, branch } = await gitManager.createWorktree(config.worktree);
      ui.printSuccess(`🌿 Switched to isolated Git worktree: ${worktreePath} (branch: ${branch})`);
      process.chdir(worktreePath);
    } catch (err: any) {
      ui.printWarning(`Could not create Git worktree: ${err.message}. Continuing in current workspace.`);
    }
  }

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
  const {
    store: agentStore,
    taskStore,
    habitExtractor,
    vaultStore,
    skillStore,
    routineEngine,
    roomManager,
    gitManager,
    attachmentManager,
  } = registerOrchestratorTools({
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
      if (agent.model && agent.model !== "default") config.model = agent.model;
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
  // Stored memories were previously only injected by the desktop bridge; the
  // CLI started every session blind. Load them here so both surfaces agree.
  const memoryStore = new MemoryStore();
  const legacyContext = await memoryStore.getPromptMemoryContext().catch(() => "");
  // The real store: ~/.memory/memo.db, written by the `memo` tool.
  const memoContext = new MemoStore().formatForPrompt(process.cwd());
  const memoryContext = [legacyContext, memoContext].filter(Boolean).join("\n\n");

  // Session allowlist: tools+command-prefix pairs approved via
  // "allow for this session" auto-approve for the rest of the run.
  const sessionAllowlist = new Set<string>();
  const allowlistKey = (toolName: string, args: Record<string, any>): string => {
    if (toolName === "exec_command" && typeof args.command === "string") {
      return `exec_command:${args.command.trim().split(/\s+/)[0] ?? ""}`;
    }
    return toolName;
  };

  // Helper to build coordinator
  function createCoordinator(
    instructions?: string,
    modelOverride?: string,
    endpointOverride?: string,
    sessionIdOverride?: string
  ): AgentCoordinator {
    const targetModel = modelOverride || config.model;
    const targetEndpoint = endpointOverride || config.endpoint;

    const llmClient = new UniversalLLMClient({
      baseUrl: targetEndpoint,
      model: targetModel,
      apiKey: config.apiKey,
    });

    return new AgentCoordinator({
      sessionId: sessionIdOverride,
      llmClient,
      daemon,
      allowedTools: activeAgent?.allowedTools,
      systemPromptContext: {
        userInstructions: instructions,
        learnedRules,
        memoryContext,
      },
      onApprovalRequired: async (req) => {
        if (config.autoApprove) return true;
        // Session allowlist: tools+command-prefix pairs approved with
        // "allow for this session" auto-approve for the rest of the run.
        if (sessionAllowlist.has(allowlistKey(req.toolName, req.arguments))) {
          ui.printInfo(`Auto-approved (session allowlist): ${req.toolName}`);
          return true;
        }
        const decision: ApprovalDecision = await ui.promptApproval(
          req.toolName,
          req.arguments
        );
        if (decision === "allow_session") {
          sessionAllowlist.add(allowlistKey(req.toolName, req.arguments));
          ui.printSuccess("Added to session allowlist — future matching calls will auto-approve.");
          return true;
        }
        return decision === "allow_once";
      },
      onEvent: (event) => {
        switch (event.type) {
          case "text_delta":
            ui.onTextDelta(event.text);
            break;
          case "phase_started":
            ui.onPhaseStarted(event.phase, event.iteration, event.maxIterations);
            break;
          case "thought_delta":
            ui.onThoughtDelta(event.text);
            break;
          case "approval_requested":
            ui.noteApprovalRequired(event.request.toolName);
            break;
          case "tool_call_started":
            ui.onToolCallStart(event.toolCall);
            break;
          case "tool_call_completed":
            ui.onToolCallCompleted(event.toolCall, event.result);
            break;
          case "turn_completed":
            ui.onTurnCompleted(event.finalContent);
            break;
          case "error":
            ui.printError(event.error.message);
            break;
        }
      },
    });
  }

  let activeSessionId: string | undefined;

  if (config.resume) {
    const allSessions = await listSessions();
    if (config.resume === "latest") {
      const targetSession = allSessions[0];
      if (!targetSession) {
        ui.printError("No saved sessions to resume.");
      } else {
        activeSessionId = targetSession.sessionId;
        const dateStr = new Date(targetSession.mtimeMs).toISOString().slice(0, 10);
        console.log(`Resumed session ${targetSession.sessionId} (${targetSession.turns} user turns, ${dateStr})`);
      }
    } else {
      const match = matchSession(allSessions, config.resume);
      if (match.ambiguous) {
        console.error(`Session prefix '${config.resume}' is ambiguous. Use a full id:`);
        for (const s of match.ambiguous) console.error(`  ${s.sessionId}`);
        process.exitCode = 1;
        return;
      }
      const targetSession = match.session;
      if (!targetSession) {
        const recent = allSessions.slice(0, 5);
        if (recent.length > 0) {
          console.log("Recent sessions:");
          for (const s of recent) {
            console.log(`  ${s.sessionId}`);
          }
        }
        process.exitCode = 1;
        return;
      }
      activeSessionId = targetSession.sessionId;
      const dateStr = new Date(targetSession.mtimeMs).toISOString().slice(0, 10);
      console.log(`Resumed session ${targetSession.sessionId} (${targetSession.turns} user turns, ${dateStr})`);
    }
  }

  let sessionLockHandle: SessionLockHandle | undefined;

  const exitCleanup = () => {
    if (sessionLockHandle) {
      try {
        fsSync.unlinkSync(sessionLockHandle.lockPath);
      } catch {}
    }
  };
  process.on("exit", exitCleanup);

  if (activeSessionId) {
    const lockManager = new SessionLockManager();
    try {
      sessionLockHandle = await lockManager.acquire(activeSessionId);
    } catch (err) {
      if (err instanceof SessionLockedError) {
        ui.printError(`Session ${activeSessionId} is locked by active process (PID ${err.pid ?? "unknown"}).`);
        process.exitCode = 1;
        process.off("exit", exitCleanup);
        await daemon.stop();
        return;
      }
      throw err;
    }

    const sessionMeta = await loadSessionMetadata(activeSessionId);
    const resumeCheck = validateResumeEnvironment(sessionMeta, config);
    if (!resumeCheck.valid) {
      if (config.query) {
        ui.printError(resumeCheck.error || `Resume validation failed for session ${activeSessionId}`);
        process.exitCode = 1;
        await sessionLockHandle.release();
        process.off("exit", exitCleanup);
        await daemon.stop();
        return;
      } else if (resumeCheck.warning) {
        ui.printWarning(resumeCheck.warning);
      }
    }

    config.endpoint = resumeCheck.endpoint;
    config.model = resumeCheck.model;
    if (resumeCheck.apiKey) config.apiKey = resumeCheck.apiKey;
    if (resumeCheck.provider) config.provider = resumeCheck.provider;
  }

  let coordinator = createCoordinator(userInstructions, config.model, config.endpoint, activeSessionId);

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
    ui.beginTurn();
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
        process.exitCode = 130;
      } else if (err?.name === "NetworkError" || err?.isNetworkError) {
        ui.printError(`Network failure: ${err.message}`);
        process.exitCode = 1;
      } else {
        ui.printError(`Execution failed: ${err.message}`);
        process.exitCode = 1;
      }
    } finally {
      process.off("SIGINT", onSigInt);
      process.off("exit", exitCleanup);
      if (sessionLockHandle) {
        await sessionLockHandle.release();
        sessionLockHandle = undefined;
      }
      await daemon.stop();
    }
    return;
  }

  // Load registered bots and session IDs for dynamic REPL autocompletion
  const registeredBots = await agentStore.listAgents().catch(() => []);
  const knownBotNames = registeredBots.map((b) => b.name);
  const knownSessionIds = (await listSessions().catch(() => [])).map((s) => s.sessionId);

  // Interactive REPL loop with native tab autocompletion
  const rl = readline.createInterface({
    input,
    output,
    completer: (l: string) => getReplCompletions(l, knownBotNames, knownSessionIds),
  });

  let lastSigIntAt = 0;
  let exiting = false;
  // Set while a turn runs: Ctrl+C then cancels the turn instead of arming exit.
  // process.on("SIGINT") never fires here, because readline turns the keypress
  // into an interface event before Node raises a signal.
  let activeTurnAbort: AbortController | null = null;
  const onRlSigInt = () => {
    const action = sigIntAction(activeTurnAbort !== null, lastSigIntAt, Date.now());
    if (action === "cancel") {
      activeTurnAbort?.abort();
      return;
    }
    if (action === "exit") {
      console.log(`\nExiting OpenSand.\n${formatResumeHint(coordinator.sessionId)}`);
      process.exitCode = 130;
      exiting = true;
      rl.close();
      return;
    }
    lastSigIntAt = Date.now();
    rl.write(null, { ctrl: true, name: "u" });
    console.log("\n(press Ctrl+C again within 1.5s to exit, or Ctrl+D)");
  };
  rl.on("SIGINT", onRlSigInt);

  try {
    while (true) {
      const promptPrefix = activeAgent ? `\x1b[35m${activeAgent.name}>\x1b[0m ` : `\x1b[36mopensand>\x1b[0m `;
      let line: string;
      try {
        line = await rl.question(`\n${promptPrefix}`);
      } catch (err: any) {
        if (err?.code === "ABORT_ERR" || err?.name === "AbortError") {
          if (!exiting) {
            console.log(`\nExiting OpenSand.\n${formatResumeHint(coordinator.sessionId)}`);
          }
          break;
        }
        if (err?.code === "ERR_USE_AFTER_CLOSE") {
          // stdin ended (piped input) and closed readline; nothing left to read.
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
  /tools              List all active OS, orchestrator, and native tools
  /bots, /agents      List all registered bot personas in Agent Store
  /bot <name>         Switch active bot persona (e.g. '/bot cto' or '/bot default')
  /btw <question>     Ask ephemeral side-question using current work context (BTW parity)
  /rollback [turns]   Roll back conversation history by N turns (RollBack parity)
  /compact [keep]     Compact older conversation turns into a dense summary
  /sessions           List recent saved sessions
  /resume <id|latest> Resume a saved session
  /new                Start a fresh session
  /doctor             Run preflight diagnostics across host runtime, models, and tools
  /status             Show fleet status (agents, rooms, routines, skills, vault)
  /attach <file>      Stage a file or image attachment into session store
  /attachments        List all staged attachments
  /template export    Export bot persona into portable template JSON
  /template import    Import bot persona from template JSON
  /rooms              List all multi-agent collaborative rooms
  /room <id> <topic>  Convene a round-table deliberation and render consensus verdict
  /routines           List all scheduled automated background routines
  /routine run <id>   Trigger an immediate execution of a scheduled routine
  /skills             List all modular recipe skills
  /skill <name>       Inspect full markdown recipe instructions of a skill
  /vault              List encrypted secrets & credentials with masked values
  /git                Inspect git branch, status, staged & modified files
  /review [pr_or_ref] Run autonomous PR review bot on pull request diff
  /tasks              List active agent tasks and milestones
  /rules              Show continuous learning guidelines
  /tokens             Inspect real-time context token usage, bounds, and caching
  /verbose [thinking|tools|all|off]
                      Toggle verbose output: stream thinking, show tool args/results
  /quiet              Suppress thinking + tool progress (answers only)
  /clear              Clear terminal screen
  exit, quit, /exit   Terminate REPL session
`);
        continue;
      }

      if (trimmed === "/tokens" || trimmed === "/token-stats") {
        const estTokens = coordinator.estimateTokens();
        const userTurns = coordinator.history.filter((m) => m.role === "user").length;
        const toolTurns = coordinator.history.filter((m) => m.role === "tool").length;
        const asstTurns = coordinator.history.filter((m) => m.role === "assistant").length;
        console.log(`\n\x1b[1m=== Context Window & Token Efficiency Telemetry ===\x1b[0m`);
        console.log(`  📊 Estimated Context Footprint: \x1b[32m~${estTokens.toLocaleString()} tokens\x1b[0m`);
        console.log(`  🛡 Auto-Compaction Safety Limit: ~${coordinator.maxContextTokens.toLocaleString()} tokens`);
        console.log(`  🎯 Active Tool Scoping Mode:    \x1b[36m${coordinator.toolScopeMode}\x1b[0m`);
        console.log(`  💬 Dialogue History Breakdown:`);
        console.log(`     • User Turns:      ${userTurns}`);
        console.log(`     • Assistant Turns: ${asstTurns}`);
        console.log(`     • Tool Results:    ${toolTurns} (micro-compacted on older turns)`);
        console.log(`     • Total Messages:  ${coordinator.history.length}`);
        console.log(`  ⚡ Anthropic Prompt Caching:   Active (ephemeral system & tool break points)\n`);
        continue;
      }

      if (trimmed === "/clear") {
        console.clear();
        continue;
      }

      if (trimmed === "/quiet") {
        ui.setVerbosity("quiet");
        ui.printInfo("Output: quiet (tool progress and thinking hidden).");
        continue;
      }

      if (trimmed === "/verbose" || trimmed.startsWith("/verbose ")) {
        const mode = trimmed.slice(8).trim().toLowerCase();
        if (mode === "thinking" || mode === "tools" || mode === "all") {
          ui.setVerbosity("verbose");
        } else if (mode === "off" || mode === "normal") {
          ui.setVerbosity("normal");
        } else if (!mode) {
          ui.setVerbosity("verbose");
        } else {
          ui.printWarning("Usage: /verbose [thinking|tools|all|off]");
          continue;
        }
        ui.printInfo(
          `Output: ${ui.currentVerbosity === "verbose" ? "verbose (thinking + tool args/results shown)" : "normal"}.`
        );
        continue;
      }

      if (trimmed === "/doctor") {
        console.log(`\n\x1b[1m=== OpenSand System Doctor & Environment Preflight ===\x1b[0m\n`);
        const { probes } = await runDoctorProbes({
          endpoint: config.endpoint,
          apiKey: config.apiKey,
          model: config.model,
        });
        for (const p of probes) {
          const mark = p.status === "ok" ? "\x1b[32m✔\x1b[0m" : p.status === "warn" ? "\x1b[33m▲\x1b[0m" : "\x1b[31m✖\x1b[0m";
          console.log(`  ${mark} \x1b[1m[${p.category}]\x1b[0m \x1b[36m${p.name}\x1b[0m: ${p.message}`);
        }
        console.log("");
        continue;
      }

      if (trimmed === "/compact" || trimmed.startsWith("/compact ")) {
        const parts = trimmed.split(" ");
        const keepTurns = parts[1] ? parseInt(parts[1], 10) || 2 : 2;
        ui.printInfo(`Compacting dialogue history (keeping ${keepTurns} most recent turns)...`);
        const res = await coordinator.compactHistory({ keepRecentTurns: keepTurns });
        console.log(`\x1b[32m✔ Compaction complete:\x1b[0m Compacted ${res.compactedTurnCount} turns. Estimated tokens reduced from ${res.originalTokens} to ${res.compactedTokens}.`);
        continue;
      }

      if (trimmed === "/sessions") {
        const sessions = await listSessions();
        for (const s of sessions.slice(0, 10)) {
          const dateStr = new Date(s.mtimeMs).toISOString().slice(0, 10);
          const titlePart = s.title ? `  ${s.title}` : "";
          console.log(`${s.sessionId}  ${dateStr}  ${s.turns}${titlePart}`);
        }
        continue;
      }

      if (trimmed === "/resume" || trimmed.startsWith("/resume ")) {
        const arg = trimmed.slice(7).trim() || "latest";
        const sessions = await listSessions();
        const match = matchSession(sessions, arg);
        if (match.ambiguous) {
          ui.printError(`Multiple sessions match '${arg}': ${match.ambiguous.map((s) => s.sessionId).join(", ")}`);
          continue;
        }
        const target = match.session;
        if (!target) {
          if (arg === "latest") {
            ui.printError("No saved sessions to resume. Run /sessions to list them.");
          } else {
            ui.printError(`Session '${arg}' not found. Run /sessions to list them.`);
          }
          continue;
        }
        const lockManager = new SessionLockManager();
        let newLock: SessionLockHandle | undefined;
        try {
          newLock = await lockManager.acquire(target.sessionId);
        } catch (err) {
          if (err instanceof SessionLockedError) {
            ui.printError(`Session '${target.sessionId}' is locked by active process (PID ${err.pid ?? "unknown"}).`);
            continue;
          }
          throw err;
        }

        const sessionMeta = await loadSessionMetadata(target.sessionId);
        const resumeCheck = validateResumeEnvironment(sessionMeta, config);
        if (!resumeCheck.valid && resumeCheck.warning) {
          ui.printWarning(resumeCheck.warning);
        }

        if (sessionLockHandle) {
          await sessionLockHandle.release();
        }
        sessionLockHandle = newLock;
        activeSessionId = target.sessionId;
        config.endpoint = resumeCheck.endpoint;
        config.model = resumeCheck.model;
        if (resumeCheck.apiKey) config.apiKey = resumeCheck.apiKey;

        coordinator = createCoordinator(userInstructions, config.model, config.endpoint, activeSessionId);
        console.log(`Resumed session ${target.sessionId} (${target.turns} user turns)`);
        continue;
      }

      if (trimmed === "/new") {
        if (sessionLockHandle) {
          await sessionLockHandle.release();
          sessionLockHandle = undefined;
        }
        activeSessionId = undefined;
        coordinator = createCoordinator(userInstructions, config.model, config.endpoint);
        console.log(`Started a new session ${coordinator.sessionId}`);
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
            const icon = a.kind === "ROOM" ? "👥" : "🤖";
            console.log(`  \x1b[35m${icon} ${a.name}\x1b[0m (${a.role}) [ID: ${a.id}]`);
            console.log(`     \x1b[2mModel: ${a.model ?? "default"} | Tools: ${a.allowedTools ? a.allowedTools.join(", ") : "all"}\x1b[0m`);
          });
        }
        continue;
      }

      if (trimmed.startsWith("/bot ")) {
        const query = trimmed.slice(5).trim();
        if (query === "default" || query === "reset") {
          activeAgent = null;
          coordinator = createCoordinator(undefined, config.model, config.endpoint, activeSessionId);
          ui.printInfo("Switched active persona back to: ⚡ Default Assistant");
        } else {
          const agent = await agentStore.getAgent(query);
          if (agent) {
            activeAgent = agent;
            coordinator = createCoordinator(
              agent.systemPrompt,
              agent.model && agent.model !== "default" ? agent.model : config.model,
              agent.endpoint,
              activeSessionId
            );
            ui.printInfo(`Switched active persona to: 🤖 ${agent.name} (${agent.role})`);
          } else {
            ui.printError(`Agent '${query}' not found in Agent Store. Run /bots to inspect available agents.`);
          }
        }
        continue;
      }

      if (trimmed === "/rooms") {
        const rooms = await roomManager.listRooms();
        console.log(`\n\x1b[1m=== Multi-Agent Collaborative Rooms (${rooms.length}) ===\x1b[0m`);
        if (rooms.length === 0) {
          console.log("  No rooms created yet. Use create_room or the Desktop UI to create one.");
        } else {
          rooms.forEach((r) => {
            console.log(`  \x1b[34m👥 ${r.name}\x1b[0m [ID: ${r.roomId}]`);
            console.log(`     \x1b[2m${r.description} | Members: [${r.memberAgentIds.join(", ")}] | Discussions: ${r.discussionCount}\x1b[0m`);
          });
        }
        continue;
      }

      if (trimmed.startsWith("/room ")) {
        const parts = trimmed.slice(6).trim().split(" ");
        const roomIdOrName = parts[0];
        const topic = parts.slice(1).join(" ");
        if (!topic) {
          console.log("Usage: /room <roomId_or_name> <topic to deliberate on>");
          continue;
        }

        const room = await roomManager.getRoom(roomIdOrName);
        if (!room) {
          ui.printError(`Room '${roomIdOrName}' not found. Run /rooms to list rooms.`);
          continue;
        }

        ui.printInfo(`Convening deliberation in '${room.name}' on: "${topic}"...`);
        const disc = await roomManager.runRoomDiscussion(room.roomId, topic);
        console.log(`\n\x1b[1m=== Deliberation Results (${disc.turns.length} turns) ===\x1b[0m`);
        disc.turns.forEach((t) => {
          console.log(`\n\x1b[36mTurn ${t.turnIndex}: ${t.memberName} (${t.memberRole})\x1b[0m\n${t.content}`);
        });
        console.log(`\n\x1b[32m${disc.consensus}\x1b[0m`);
        continue;
      }

      if (trimmed === "/routines") {
        const routines = await routineEngine.listRoutines();
        console.log(`\n\x1b[1m=== Scheduled Background Routines (${routines.length}) ===\x1b[0m`);
        if (routines.length === 0) {
          console.log("  No routines scheduled yet. Use create_routine to add one.");
        } else {
          routines.forEach((r) => {
            const mark = r.isEnabled ? "\x1b[32m●\x1b[0m" : "\x1b[90m○\x1b[0m";
            const nextRun = r.nextRunAtMs ? new Date(r.nextRunAtMs).toLocaleTimeString() : "Disabled";
            console.log(`  ${mark} \x1b[33m⏱ ${r.name}\x1b[0m [ID: ${r.routineId}]`);
            console.log(`     \x1b[2mSchedule: ${r.triggerDescription} | Next: ${nextRun} | Runs: ${r.runCount} | Status: ${r.lastRunStatus || "idle"}\x1b[0m`);
          });
        }
        continue;
      }

      if (trimmed.startsWith("/routine run ")) {
        const routineId = trimmed.slice(13).trim();
        ui.printInfo(`Triggering routine '${routineId}'...`);
        try {
          const res = await routineEngine.triggerRoutine(routineId);
          console.log(`\x1b[32m✔ Executed '${res.routine.name}':\x1b[0m\n${res.result}`);
        } catch (err: any) {
          ui.printError(`Failed to run routine: ${err.message}`);
        }
        continue;
      }

      if (trimmed === "/skills") {
        const skills = await skillStore.listSkills();
        console.log(`\n\x1b[1m=== Modular Recipe Skills (${skills.length}) ===\x1b[0m`);
        if (skills.length === 0) {
          console.log("  No skills in library. Use add_skill to register recipes.");
        } else {
          skills.forEach((s) => {
            console.log(`  \x1b[35m🧩 ${s.name}\x1b[0m [${s.category || "general"}] - \x1b[2m${s.description || "No description"}\x1b[0m`);
          });
        }
        continue;
      }

      if (trimmed.startsWith("/skill ")) {
        const name = trimmed.slice(7).trim();
        const skill = await skillStore.getSkill(name);
        if (!skill) {
          ui.printError(`Skill '${name}' not found.`);
        } else {
          console.log(`\n\x1b[1m=== Skill: ${skill.name} ===\x1b[0m`);
          console.log(`Description: ${skill.description || "None"}\n`);
          console.log(skill.content);
        }
        continue;
      }

      if (trimmed === "/vault") {
        const secrets = await vaultStore.listSecrets();
        const credentials = await vaultStore.listCredentials();
        console.log(`\n\x1b[1m=== Encrypted Vault: ${secrets.length} Secrets, ${credentials.length} Credentials ===\x1b[0m`);
        console.log("\x1b[1mSecrets:\x1b[0m");
        if (secrets.length === 0) {
          console.log("  (No secrets stored)");
        } else {
          secrets.forEach((s) => {
            console.log(`  🔑 \x1b[33m${s.name}\x1b[0m - \x1b[2m${s.preview}\x1b[0m (${s.description || "no description"})`);
          });
        }
        console.log("\x1b[1mCredentials:\x1b[0m");
        if (credentials.length === 0) {
          console.log("  (No credentials stored)");
        } else {
          credentials.forEach((c) => {
            console.log(`  👤 \x1b[36m${c.title}\x1b[0m (${c.username || "user"}) [Sites: ${(c.sites || []).join(", ") || "Any"}]`);
          });
        }
        continue;
      }

      if (trimmed === "/git" || trimmed === "/status") {
        const status = await gitManager.getStatus();
        console.log(`\n\x1b[1m=== Git Repository Status ===\x1b[0m`);
        console.log(`  Branch: \x1b[32m${status.branch}\x1b[0m | Clean: ${status.isClean ? "✔ Yes" : "✖ No"}`);
        if (status.staged.length > 0) {
          console.log(`  Staged files (${status.staged.length}): ${status.staged.join(", ")}`);
        }
        if (status.modified.length > 0) {
          console.log(`  Modified files (${status.modified.length}): ${status.modified.join(", ")}`);
        }
        if (status.untracked.length > 0) {
          console.log(`  Untracked files (${status.untracked.length}): ${status.untracked.join(", ")}`);
        }
        continue;
      }

      if (trimmed.startsWith("/review")) {
        const ref = trimmed.slice(7).trim() || "HEAD";
        ui.printInfo(`Running PR review bot on '${ref}'...`);
        const review = await gitManager.reviewPullRequest(ref);
        const color = review.verdict === "APPROVED" ? "\x1b[32m" : review.verdict === "CHANGES_REQUESTED" ? "\x1b[31m" : "\x1b[33m";
        console.log(`\n\x1b[1m=== PR Review Verdict: ${color}${review.verdict}\x1b[0m\x1b[1m ===\x1b[0m`);
        console.log(`${review.summary}\n`);
        if (review.issues.length > 0) {
          console.log("\x1b[1mIssues Identified:\x1b[0m");
          review.issues.forEach((iss, idx) => {
            const sevColor = iss.severity === "critical" ? "\x1b[31m[CRITICAL]\x1b[0m" : "\x1b[33m[WARNING]\x1b[0m";
            console.log(`  ${idx + 1}. ${sevColor} \x1b[36m${iss.file}${iss.line ? `:${iss.line}` : ""}\x1b[0m - ${iss.comment}`);
          });
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

      if (trimmed.startsWith("/btw ")) {
        const question = trimmed.slice(5).trim();
        if (!question) {
          console.log("Usage: /btw <ephemeral question about current work>");
          continue;
        }
        ui.printInfo(`Answering ephemeral question: "${question}"...`);
        try {
          const ans = await coordinator.askSideQuestion(question);
          console.log(`\n\x1b[35m💬 [BTW Answer]:\x1b[0m\n${ans}\n`);
        } catch (err: any) {
          ui.printError(`Side-question error: ${err.message}`);
        }
        continue;
      }

      if (trimmed === "/rollback" || trimmed.startsWith("/rollback ") || trimmed === "/rewind") {
        const parts = trimmed.split(" ");
        const turns = parts[1] ? parseInt(parts[1], 10) || 1 : 1;
        ui.printInfo(`Rolling back conversation by ${turns} turn(s)...`);
        const res = await coordinator.rollbackTurns(turns);
        console.log(`\x1b[32m✔ Rolled back ${res.removedMessages} messages (${res.remainingMessages} messages remaining in history).\x1b[0m`);
        continue;
      }

      if (trimmed.startsWith("/attach ")) {
        const filePath = trimmed.slice(8).trim();
        ui.printInfo(`Staging attachment '${filePath}'...`);
        try {
          const att = await attachmentManager.stageFile(filePath);
          console.log(`\x1b[32m✔ Attachment staged:\x1b[0m`);
          console.log(`  ID: ${att.id} | File: ${att.filename} | Size: ${att.sizeBytes} B | SHA: ${att.sha256.slice(0, 16)}...`);
          console.log(`  Local Path: ${att.localPath}`);
        } catch (err: any) {
          ui.printError(`Failed to stage attachment: ${err.message}`);
        }
        continue;
      }

      if (trimmed === "/attachments") {
        const list = await attachmentManager.listAttachments();
        console.log(`\n\x1b[1m=== Staged Attachments (${list.length}) ===\x1b[0m`);
        if (list.length === 0) {
          console.log("  No attachments staged. Use /attach <path> to stage one.");
        } else {
          list.forEach((a) => {
            console.log(`  📎 \x1b[36m${a.filename}\x1b[0m [ID: ${a.id}] (${a.sizeBytes} bytes, ${a.mimeType})`);
            console.log(`     \x1b[2mPath: ${a.localPath}\x1b[0m`);
          });
        }
        continue;
      }

      if (trimmed.startsWith("/template export ")) {
        const agentName = trimmed.slice(17).trim();
        try {
          const tpl = await agentStore.exportTemplate(agentName);
          const outPath = `./${tpl.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}.template.json`;
          await fs.writeFile(outPath, JSON.stringify(tpl, null, 2), "utf-8");
          console.log(`\x1b[32m✔ Exported template for '${tpl.name}' to ${outPath}\x1b[0m`);
        } catch (err: any) {
          ui.printError(`Export template failed: ${err.message}`);
        }
        continue;
      }

      if (trimmed.startsWith("/template import ")) {
        const tplPath = trimmed.slice(17).trim();
        try {
          const raw = await fs.readFile(tplPath, "utf-8");
          const agent = await agentStore.importTemplate(raw);
          console.log(`\x1b[32m✔ Imported template as new bot persona: '${agent.name}' (ID: ${agent.id})\x1b[0m`);
        } catch (err: any) {
          ui.printError(`Import template failed: ${err.message}`);
        }
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
      ui.beginTurn();
      const turnAbort = new AbortController();
      activeTurnAbort = turnAbort;

      try {
        try {
          await coordinator.runTurn(trimmed, turnAbort.signal);
        } catch (firstErr: any) {
          const isNetErr =
            firstErr?.isNetworkError ||
            firstErr?.name === "NetworkError" ||
            firstErr?.code === "ECONNRESET" ||
            firstErr?.code === "ETIMEDOUT" ||
            firstErr?.code === "ECONNREFUSED" ||
            firstErr?.code === "ENOTFOUND" ||
            firstErr?.code === "EAI_AGAIN";

          if (isNetErr && !turnAbort.signal.aborted) {
            ui.printWarning(`Network error encountered: ${firstErr.message}\nRetrying turn once in 1s...`);
            await new Promise((r) => setTimeout(r, 1000));
            await coordinator.runTurn(trimmed, turnAbort.signal);
          } else {
            throw firstErr;
          }
        }
        const estTokens = coordinator.estimateTokens();
        const userTurns = coordinator.history.filter((m) => m.role === "user").length;
        console.log(`\x1b[2m[context: ~${estTokens.toLocaleString()} tokens | ${userTurns} turns | toolScope: ${coordinator.toolScopeMode}]\x1b[0m\n`);
      } catch (err: any) {
        if (turnAbort.signal.aborted || err?.name === "AbortError" || err?.code === "ABORT_ERR") {
          ui.onCancelled();
          ui.printInfo("\n[Turn cancelled by user]");
        } else if (err?.isNetworkError || err?.name === "NetworkError") {
          ui.printError(`Network failure: ${err.message}\n(REPL ready for your next command)`);
        } else {
          ui.printError(`Turn failed: ${err.message}`);
        }
      } finally {
        activeTurnAbort = null;
        lastSigIntAt = 0;
      }
    }
  } finally {
    rl.off("SIGINT", onRlSigInt);
    rl.close();
    process.off("exit", exitCleanup);
    if (sessionLockHandle) {
      await sessionLockHandle.release();
      sessionLockHandle = undefined;
    }
    await daemon.stop();
  }
}
