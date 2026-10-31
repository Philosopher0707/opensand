import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { LocalExecDaemon, ToolDefinition } from "@opensand/local-exec-daemon";
import { AgentStore, AgentRecord } from "./agent-store.js";
import { TaskStore, AgentTask, TaskStatus, TaskPriority } from "./agent-tasks.js";
import { HabitExtractor } from "./habit-extractor.js";
import { UniversalLLMClient } from "./llm-client.js";
import { AgentCoordinator } from "./coordinator.js";

export interface RegisterOrchestratorToolsOptions {
  daemon: LocalExecDaemon;
  store?: AgentStore;
  taskStore?: TaskStore;
  habitExtractor?: HabitExtractor;
  defaultEndpoint?: string;
  defaultModel?: string;
  defaultApiKey?: string;
  sessionsBaseDir?: string;
}

export function registerOrchestratorTools(options: RegisterOrchestratorToolsOptions): {
  store: AgentStore;
  taskStore: TaskStore;
  habitExtractor: HabitExtractor;
} {
  const { daemon } = options;
  const store = options.store ?? new AgentStore();
  const taskStore = options.taskStore ?? new TaskStore();
  const sessionsBaseDir = options.sessionsBaseDir ?? path.join(os.homedir(), ".opensand", "sessions");
  const habitExtractor = options.habitExtractor ?? new HabitExtractor({ sessionsDir: sessionsBaseDir });

  // 1. Tool: create_agent (Parity with CreateGrokBotAgent / CreateGrokBotAgentFromTemplate)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "create_agent",
        description: "Dynamically construct, configure, and register a new autonomous agent persona or subagent into the persistent Agent Store.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The human-readable name of the agent (e.g. 'CTO Bot', 'Code Reviewer').",
            },
            role: {
              type: "string",
              description: "The primary job title or role description of this agent.",
            },
            system_prompt: {
              type: "string",
              description: "The comprehensive system instructions, behavioral guidelines, and operating principles for this agent.",
            },
            model: {
              type: "string",
              description: "Optional model identifier to use when this agent is invoked (e.g. 'qwen3:8b', 'claude-3-7-sonnet', 'gpt-4o').",
            },
            allowed_tools: {
              type: "array",
              items: { type: "string" },
              description: "Optional list of tool names this agent is authorized to invoke (default: all registered tools).",
            },
          },
          required: ["name", "role", "system_prompt"],
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      const record = await store.createAgent({
        name: args.name,
        role: args.role,
        systemPrompt: args.system_prompt,
        model: args.model,
        allowedTools: args.allowed_tools,
      });

      return JSON.stringify({
        status: "success",
        message: `Agent [${record.name}] created and registered successfully in Agent Store.`,
        agent: {
          id: record.id,
          name: record.name,
          role: record.role,
          model: record.model ?? "default",
          allowedTools: record.allowedTools ?? "all",
        },
      }, null, 2);
    },
  });

  // 2. Tool: list_agents (Parity with ListGrokBotAgents)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "list_agents",
        description: "List all registered autonomous agents, personas, and subagents currently available in the Agent Store.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    handler: async () => {
      const agents = await store.listAgents();
      return JSON.stringify(
        agents.map((a) => ({
          id: a.id,
          name: a.name,
          role: a.role,
          model: a.model ?? "default",
          allowedTools: a.allowedTools ?? "all",
          updatedAt: new Date(a.updatedAt).toISOString(),
        })),
        null,
        2
      );
    },
  });

  // 3. Tool: delegate_to_agent (Parity with GrokBot Subagent Delegation & SendPrompt)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "delegate_to_agent",
        description: "Delegate a task or query to a registered subagent persona. Spawns an isolated subagent turn loop with that agent's system prompt and returns the result.",
        parameters: {
          type: "object",
          properties: {
            agent_id_or_name: {
              type: "string",
              description: "The ID or name of the registered agent to delegate to (e.g. 'cto', 'CTO Bot', 'agent_cto_...').",
            },
            task: {
              type: "string",
              description: "The prompt, instructions, or coding task for the subagent to execute.",
            },
          },
          required: ["agent_id_or_name", "task"],
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      const agent = await store.getAgent(args.agent_id_or_name);
      if (!agent) {
        throw new Error(`Subagent [${args.agent_id_or_name}] not found in Agent Store. Use list_agents to inspect available agents.`);
      }

      // Create isolated LLM client for this subagent
      const subagentLlm = new UniversalLLMClient({
        baseUrl: agent.endpoint ?? options.defaultEndpoint ?? "http://127.0.0.1:11434/v1",
        model: agent.model ?? options.defaultModel ?? "qwen3:8b",
        apiKey: options.defaultApiKey,
      });

      const subsessionId = `sub_${agent.id}_${Date.now()}`;
      const subCoordinator = new AgentCoordinator({
        llmClient: subagentLlm,
        daemon,
        sessionId: subsessionId,
        sessionsBaseDir,
        allowedTools: agent.allowedTools,
        systemPromptContext: {
          userInstructions: agent.systemPrompt,
        },
      });

      const finalResponse = await subCoordinator.runTurn(args.task);
      return JSON.stringify({
        status: "completed",
        subagent: {
          id: agent.id,
          name: agent.name,
          role: agent.role,
          sessionId: subsessionId,
        },
        response: finalResponse,
      }, null, 2);
    },
  });

  // 4. Tool: get_agent_tail (Parity with OpenAgentTail / GetAgentTranscriptTail)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "get_agent_tail",
        description: "Retrieve recent transcript lines from any agent session log on disk (Grok Bot OpenAgentTail parity).",
        parameters: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The session identifier to tail.",
            },
            limit_lines: {
              type: "number",
              description: "Maximum number of recent lines to return (default: 50).",
            },
          },
          required: ["session_id"],
        },
      },
    },
    handler: async (args) => {
      const transcriptFile = path.join(sessionsBaseDir, args.session_id, "transcript.txt");
      try {
        const text = await fs.readFile(transcriptFile, "utf-8");
        const lines = text.split("\n");
        const limit = args.limit_lines ?? 50;
        const tail = lines.slice(-limit).join("\n");
        return tail;
      } catch {
        throw new Error(`Session transcript not found for session ID: ${args.session_id}`);
      }
    },
  });

  // 5. Tool: discover_tools (Parity with GrokBotUserComputerDiscoverAiTool)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "discover_tools",
        description: "Discover all AI tools, native hardware bridges, MCP server tools, and orchestrator capabilities currently available in OpenSand (Grok Bot DiscoverAiTool parity).",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    handler: async () => {
      const defs = daemon.getToolDefinitions();
      return JSON.stringify({
        totalTools: defs.length,
        tools: defs.map((d) => ({
          name: d.function.name,
          description: d.function.description,
          parameters: Object.keys(d.function.parameters.properties || {}),
        })),
      }, null, 2);
    },
  });

  // 6. Tool: create_agent_task (Parity with GrokBot ListGrokBotAgentTasks / CreateTask)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "create_agent_task",
        description: "Create and track an actionable work item, todo, or milestone for this agent or subagent.",
        parameters: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Short summary of the task.",
            },
            description: {
              type: "string",
              description: "Detailed description of requirements or acceptance criteria.",
            },
            priority: {
              type: "string",
              enum: ["low", "medium", "high", "urgent"],
              description: "Priority of the task (default: 'medium').",
            },
            agent_id: {
              type: "string",
              description: "Optional agent ID assigned to this task.",
            },
          },
          required: ["title"],
        },
      },
    },
    handler: async (args) => {
      const task = await taskStore.createTask({
        title: args.title,
        description: args.description,
        priority: args.priority as TaskPriority,
        agentId: args.agent_id,
      });
      return JSON.stringify({ status: "success", task }, null, 2);
    },
  });

  // 7. Tool: list_agent_tasks (Parity with ListGrokBotAgentTasks / ListGrokBotAgentTodos)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "list_agent_tasks",
        description: "List all active, in-progress, or completed agent tasks and todos.",
        parameters: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["todo", "in_progress", "done", "blocked"],
              description: "Filter tasks by status.",
            },
            agent_id: {
              type: "string",
              description: "Filter tasks by assigned agent.",
            },
          },
        },
      },
    },
    handler: async (args) => {
      const tasks = await taskStore.listTasks({
        status: args.status as TaskStatus,
        agentId: args.agent_id,
      });
      return JSON.stringify(tasks, null, 2);
    },
  });

  // 8. Tool: update_agent_task (Parity with MarkGrokBotAgentTaskDone / Task Pinned)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "update_agent_task",
        description: "Update task status (e.g. mark 'done'), priority, or pinning.",
        parameters: {
          type: "object",
          properties: {
            task_id: {
              type: "string",
              description: "The ID of the task to update.",
            },
            status: {
              type: "string",
              enum: ["todo", "in_progress", "done", "blocked"],
              description: "New status.",
            },
            pinned: {
              type: "boolean",
              description: "Whether the task should be pinned to the top.",
            },
          },
          required: ["task_id"],
        },
      },
    },
    handler: async (args) => {
      const updated = await taskStore.updateTask(args.task_id, {
        status: args.status as TaskStatus,
        pinned: args.pinned,
      });
      return JSON.stringify({ status: "success", task: updated }, null, 2);
    },
  });

  // 9. Tool: extract_user_habits (Parity with GrokBot Continuous User Learning Engine)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "extract_user_habits",
        description: "Analyze historical conversation transcripts, identify user corrections and habits, and update learned_rules.md (Grok Bot Continuous Learning parity).",
        parameters: {
          type: "object",
          properties: {
            max_chats: {
              type: "number",
              description: "Maximum number of recent chats to analyze (default: 50).",
            },
          },
        },
      },
    },
    handler: async (args) => {
      const report = await habitExtractor.analyzeTranscripts(args.max_chats ?? 50);
      return JSON.stringify({
        status: "success",
        transcriptsAnalyzed: report.totalTranscriptsAnalyzed,
        queriesExtracted: report.extractedQueriesCount,
        correctionsFound: report.correctionsCount,
        rulesLearned: report.rules.length,
        summary: report.markdownSummary,
      }, null, 2);
    },
  });

  return { store, taskStore, habitExtractor };
}
