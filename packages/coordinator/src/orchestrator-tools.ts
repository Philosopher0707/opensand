import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { LocalExecDaemon, ToolDefinition } from "@opensand/local-exec-daemon";
import { AgentStore, AgentRecord } from "./agent-store.js";
import { TaskStore, AgentTask, TaskStatus, TaskPriority } from "./agent-tasks.js";
import { HabitExtractor } from "./habit-extractor.js";
import { MemoryStore, MemoryScope, MemoryTier } from "./memory-store.js";
import { VaultStore, VaultItemKind } from "./vault-store.js";
import { SkillStore } from "./skill-store.js";
import { RoutineEngine } from "./routine-engine.js";
import { RoomManager } from "./room-manager.js";
import { GitManager } from "./git-manager.js";
import { WorkspaceSentinel } from "./workspace-sentinel.js";
import { AttachmentManager } from "./attachment-manager.js";
import { UniversalLLMClient } from "./llm-client.js";
import { AgentCoordinator } from "./coordinator.js";

export interface RegisterOrchestratorToolsOptions {
  daemon: LocalExecDaemon;
  store?: AgentStore;
  taskStore?: TaskStore;
  habitExtractor?: HabitExtractor;
  memoryStore?: MemoryStore;
  vaultStore?: VaultStore;
  skillStore?: SkillStore;
  routineEngine?: RoutineEngine;
  roomManager?: RoomManager;
  gitManager?: GitManager;
  workspaceSentinel?: WorkspaceSentinel;
  attachmentManager?: AttachmentManager;
  defaultEndpoint?: string;
  defaultModel?: string;
  defaultApiKey?: string;
  sessionsBaseDir?: string;
  repoRoot?: string;
}

export function registerOrchestratorTools(options: RegisterOrchestratorToolsOptions): {
  store: AgentStore;
  taskStore: TaskStore;
  habitExtractor: HabitExtractor;
  memoryStore: MemoryStore;
  vaultStore: VaultStore;
  skillStore: SkillStore;
  routineEngine: RoutineEngine;
  roomManager: RoomManager;
  gitManager: GitManager;
  workspaceSentinel: WorkspaceSentinel;
  attachmentManager: AttachmentManager;
} {
  const { daemon } = options;
  const store = options.store ?? new AgentStore();
  const taskStore = options.taskStore ?? new TaskStore();
  const memoryStore = options.memoryStore ?? new MemoryStore();
  const vaultStore = options.vaultStore ?? new VaultStore();
  const skillStore = options.skillStore ?? new SkillStore({ agentStore: store });
  const routineEngine = options.routineEngine ?? new RoutineEngine(undefined, vaultStore);
  const roomManager = options.roomManager ?? new RoomManager(undefined, store, vaultStore);
  const gitManager = options.gitManager ?? new GitManager(options.repoRoot);
  const workspaceSentinel = options.workspaceSentinel ?? new WorkspaceSentinel();
  const attachmentManager = options.attachmentManager ?? new AttachmentManager();
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

  // 10. Tool: update_memory (Parity with GrokBot UpdateMemory tool)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "update_memory",
        description: "Save, update, or forget a discrete fact about the user, team, or agent persona (Grok Bot UpdateMemory parity).",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["write", "forget"],
              description: "Action to perform: 'write' to store a fact, 'forget' to remove it.",
            },
            text: {
              type: "string",
              description: "The fact content (e.g. '[2026-11-01] - Prefers TypeScript strict mode').",
            },
            scope: {
              type: "string",
              enum: ["user", "agent", "team"],
              description: "Scope of the memory: 'user' (default), 'agent', or 'team'.",
            },
            tier: {
              type: "string",
              enum: ["profile", "log"],
              description: "Memory tier: 'profile' for core identity/instructions, 'log' for episodic/project history (default: 'log').",
            },
            agent_id: {
              type: "string",
              description: "Optional agent ID when scope is 'agent'.",
            },
            fact_id: {
              type: "string",
              description: "Optional fact ID when action is 'forget'.",
            },
          },
          required: ["action", "text"],
        },
      },
    },
    handler: async (args) => {
      const action = args.action as "write" | "forget";
      const scope = (args.scope as MemoryScope) ?? "user";
      const tier = (args.tier as MemoryTier) ?? "log";

      if (scope === "team") {
        // Queue proposal in Team Review Queue (Grok Bot consensus parity)
        const reviewItem = await memoryStore.addReviewItem({
          proposedBy: args.agent_id ?? "agent",
          change: {
            action,
            memoryType: tier,
            text: args.text,
          },
        });
        return JSON.stringify({
          status: "review_queued",
          message: `Team memory change queued for human-in-the-loop consensus review (ID: ${reviewItem.itemId}).`,
          reviewItem,
        }, null, 2);
      }

      if (action === "write") {
        const fact = await memoryStore.addMemory({
          text: args.text,
          scope,
          tier,
          agentId: args.agent_id,
        });
        return JSON.stringify({
          status: "success",
          message: `Memory fact stored in scope [${scope}] (tier: ${tier}).`,
          fact,
        }, null, 2);
      }

      // action === "forget"
      let forgotten = false;
      if (args.fact_id) {
        forgotten = await memoryStore.forgetMemory(args.fact_id, scope, args.agent_id);
      } else {
        const matches = await memoryStore.listMemories({ scope, agentId: args.agent_id, query: args.text });
        if (matches.length > 0) {
          forgotten = await memoryStore.forgetMemory(matches[0].factId, scope, args.agent_id);
        }
      }

      return JSON.stringify({
        status: forgotten ? "success" : "not_found",
        message: forgotten ? "Fact forgotten successfully." : "No matching fact found to forget.",
      }, null, 2);
    },
  });

  // 11. Tool: recall_memories (Parity with GrokBot ListGrokBotUserBotMemories & SortMemories)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "recall_memories",
        description: "Recall and search stored discrete facts across user, agent, and team memory tiers (Grok Bot ListGrokBotUserBotMemories / SortMemories parity).",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Optional text search query to filter facts.",
            },
            scope: {
              type: "string",
              enum: ["user", "agent", "team", "all"],
              description: "Scope to recall: 'user', 'agent', 'team', or 'all' (default: 'all').",
            },
            tier: {
              type: "string",
              enum: ["profile", "log", "all"],
              description: "Memory tier: 'profile', 'log', or 'all' (default: 'all').",
            },
            agent_id: {
              type: "string",
              description: "Optional agent ID to recall persona-specific memories.",
            },
          },
        },
      },
    },
    handler: async (args) => {
      const facts = await memoryStore.listMemories({
        query: args.query,
        scope: args.scope as any,
        tier: args.tier as any,
        agentId: args.agent_id,
      });
      return JSON.stringify({
        totalMemories: facts.length,
        memories: facts,
      }, null, 2);
    },
  });

  // 12. Tool: import_memory (Parity with GrokBot grok_bot_memory_import & <imported_memory>)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "import_memory",
        description: "Import a batch of exported memories from another AI assistant (ChatGPT, Claude, etc.) into discrete structured facts with automatic tier categorization (Grok Bot grok_bot_memory_import parity).",
        parameters: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "The raw exported memory markdown text containing sections (Instructions, Identity, Career, Projects, Preferences).",
            },
            scope: {
              type: "string",
              enum: ["user", "agent"],
              description: "Target scope for imported facts (default: 'user').",
            },
            agent_id: {
              type: "string",
              description: "Optional agent ID if importing for a specific agent.",
            },
          },
          required: ["text"],
        },
      },
    },
    handler: async (args) => {
      const result = await memoryStore.importMemoryText(
        args.text,
        (args.scope as MemoryScope) ?? "user",
        args.agent_id
      );
      return JSON.stringify({
        status: "success",
        savedCount: result.savedCount,
        skippedCount: result.skippedCount,
        message: `Imported ${result.savedCount} facts successfully (${result.skippedCount} skipped/duplicates).`,
        facts: result.facts,
      }, null, 2);
    },
  });

  // 13. Tool: list_team_review_items (Parity with GrokBot ListGrokBotTeamReviewItems)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "list_team_review_items",
        description: "List pending, approved, or rejected proposals in the team memory and skill review queue (Grok Bot ListGrokBotTeamReviewItems parity).",
        parameters: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["pending", "approved", "rejected"],
              description: "Filter proposals by review status (default: 'pending').",
            },
            limit: {
              type: "number",
              description: "Maximum number of items to return (default: 50).",
            },
          },
        },
      },
    },
    handler: async (args) => {
      const items = await memoryStore.listReviewItems({
        status: args.status,
        limit: args.limit ?? 50,
      });
      return JSON.stringify({
        totalItems: items.length,
        items,
      }, null, 2);
    },
  });

  // 14. Tool: resolve_team_review_item (Parity with GrokBot ResolveGrokBotTeamReviewItem)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "resolve_team_review_item",
        description: "Approve or reject a proposed memory change in the team review queue (Grok Bot ResolveGrokBotTeamReviewItem parity).",
        parameters: {
          type: "object",
          properties: {
            item_id: {
              type: "string",
              description: "The unique identifier of the review item to resolve.",
            },
            decision: {
              type: "string",
              enum: ["approve", "reject"],
              description: "Review decision: 'approve' to accept and commit the change, 'reject' to discard.",
            },
          },
          required: ["item_id", "decision"],
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      const item = await memoryStore.resolveReviewItem(
        args.item_id,
        args.decision as "approve" | "reject"
      );
      return JSON.stringify({
        status: "success",
        message: `Review item [${item.itemId}] has been ${item.status}.`,
        item,
      }, null, 2);
    },
  });

  // 15. Tool: vault_store_secret (Parity with PutGrokBotSecret)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "vault_store_secret",
        description: "Securely encrypt and store a secret (API token, private key, password) in the local encrypted vault.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The name/identifier of the secret (e.g. 'OPENAI_API_KEY', 'NVIDIA_API_KEY').",
            },
            value: {
              type: "string",
              description: "The plaintext secret value to encrypt.",
            },
            description: {
              type: "string",
              description: "Optional human-readable description of what this secret is used for.",
            },
          },
          required: ["name", "value"],
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      const stored = await vaultStore.putSecret({
        name: args.name,
        value: args.value,
        description: args.description,
      });
      return JSON.stringify({
        status: "success",
        message: `Secret '${stored.name}' securely stored in local encrypted vault (ID: ${stored.id}).`,
        secret: {
          id: stored.id,
          name: stored.name,
          description: stored.description,
          preview: `${stored.value.slice(0, 3)}...${stored.value.slice(-3)}`,
        },
      }, null, 2);
    },
  });

  // 16. Tool: vault_list_secrets (Parity with ListGrokBotSecrets)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "vault_list_secrets",
        description: "List all secrets stored in the local encrypted vault. Returns metadata and truncated previews only, never raw secrets.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    handler: async () => {
      const secrets = await vaultStore.listSecrets();
      return JSON.stringify(secrets, null, 2);
    },
  });

  // 17. Tool: vault_delete_secret (Parity with DeleteGrokBotSecret)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "vault_delete_secret",
        description: "Delete a secret from the local encrypted vault by name or ID.",
        parameters: {
          type: "object",
          properties: {
            name_or_id: {
              type: "string",
              description: "The name or ID of the secret to delete.",
            },
          },
          required: ["name_or_id"],
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      const deleted = await vaultStore.deleteSecret(args.name_or_id);
      return JSON.stringify({
        status: deleted ? "success" : "not_found",
        deleted,
        nameOrId: args.name_or_id,
      }, null, 2);
    },
  });

  // 18. Tool: vault_store_credential (Parity with PutGrokBotVaultCredential)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "vault_store_credential",
        description: "Store a full structured account credential (title, username, password, websites) in the encrypted vault.",
        parameters: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Title/label for this credential (e.g. 'AWS Production', 'GitHub Work').",
            },
            username: {
              type: "string",
              description: "Account username, email, or client ID.",
            },
            password: {
              type: "string",
              description: "Account password, secret key, or token.",
            },
            notes: {
              type: "string",
              description: "Optional private notes.",
            },
            sites: {
              type: "array",
              items: { type: "string" },
              description: "Optional list of domains or URLs this credential applies to.",
            },
            kind: {
              type: "string",
              enum: ["API_KEY", "PASSWORD", "TOKEN", "SSH_KEY", "CERTIFICATE", "OTHER"],
              description: "Type of credential (default: 'API_KEY').",
            },
          },
          required: ["title", "username"],
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      const cred = await vaultStore.putCredential({
        title: args.title,
        username: args.username,
        password: args.password,
        notes: args.notes,
        sites: args.sites,
        kind: args.kind as VaultItemKind,
      });
      return JSON.stringify({
        status: "success",
        message: `Credential '${cred.title}' securely stored in vault (ID: ${cred.id}).`,
        credential: {
          id: cred.id,
          title: cred.title,
          username: cred.username,
          kind: cred.kind,
          hasPassword: Boolean(cred.password),
        },
      }, null, 2);
    },
  });

  // 19. Tool: vault_list_credentials (Parity with ListGrokBotVaultCredentials)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "vault_list_credentials",
        description: "List all credentials stored in the local encrypted vault with metadata (no plaintext passwords).",
        parameters: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["API_KEY", "PASSWORD", "TOKEN", "SSH_KEY", "CERTIFICATE", "OTHER"],
              description: "Optional filter by credential kind.",
            },
          },
        },
      },
    },
    handler: async (args) => {
      const creds = await vaultStore.listCredentials({ kind: args.kind as VaultItemKind });
      return JSON.stringify(creds, null, 2);
    },
  });

  // 20. Tool: add_skill (Parity with AddGrokBotAgentSkill)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "add_skill",
        description: "Create or update a modular recipe skill pack that can be mounted to any agent persona.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The name/identifier of the skill (e.g. 'postgresql-optimization', 'appsec-audit').",
            },
            description: {
              type: "string",
              description: "Short summary of what this skill enables or enforces.",
            },
            content: {
              type: "string",
              description: "Detailed markdown instructions, rules, patterns, and examples for this skill.",
            },
            category: {
              type: "string",
              description: "Optional category tag (e.g. 'database', 'security', 'frontend', 'devops').",
            },
          },
          required: ["name", "description", "content"],
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      const skill = await skillStore.createSkill({
        name: args.name,
        description: args.description,
        content: args.content,
        category: args.category,
      });
      return JSON.stringify({
        status: "success",
        message: `Skill '${skill.name}' created and saved to skills library (ID: ${skill.id}).`,
        skill,
      }, null, 2);
    },
  });

  // 21. Tool: list_skills (Parity with ListGrokBotAgentSkills)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "list_skills",
        description: "List all available modular recipe skills in the skills library.",
        parameters: {
          type: "object",
          properties: {
            category: {
              type: "string",
              description: "Optional category filter.",
            },
          },
        },
      },
    },
    handler: async (args) => {
      const skills = await skillStore.listSkills(args.category);
      return JSON.stringify(skills, null, 2);
    },
  });

  // 22. Tool: mount_skill (Parity with AddGrokBotAgentSkill / Mount to agent)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "mount_skill",
        description: "Mount/attach a modular skill to an agent persona so the skill's instructions are automatically active.",
        parameters: {
          type: "object",
          properties: {
            agent_id_or_name: {
              type: "string",
              description: "The agent ID or name to mount the skill to.",
            },
            skill_id_or_name: {
              type: "string",
              description: "The skill ID or name to mount.",
            },
          },
          required: ["agent_id_or_name", "skill_id_or_name"],
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      const res = await skillStore.mountSkillToAgent(args.agent_id_or_name, args.skill_id_or_name);
      return JSON.stringify({
        status: "success",
        message: `Skill mounted to agent '${res.agentId}'. Active skills: [${res.mountedSkills.join(", ")}].`,
        result: res,
      }, null, 2);
    },
  });

  // 23. Tool: unmount_skill (Parity with RemoveGrokBotAgentSkill)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "unmount_skill",
        description: "Unmount/detach a modular skill from an agent persona.",
        parameters: {
          type: "object",
          properties: {
            agent_id_or_name: {
              type: "string",
              description: "The agent ID or name to unmount the skill from.",
            },
            skill_id_or_name: {
              type: "string",
              description: "The skill ID or name to unmount.",
            },
          },
          required: ["agent_id_or_name", "skill_id_or_name"],
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      const res = await skillStore.unmountSkillFromAgent(args.agent_id_or_name, args.skill_id_or_name);
      return JSON.stringify({
        status: "success",
        message: `Skill unmounted from agent '${res.agentId}'. Active skills: [${res.mountedSkills.join(", ")}].`,
        result: res,
      }, null, 2);
    },
  });

  // 24. Tool: create_routine (Parity with GrokBotAgentRoutine)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "create_routine",
        description: "Create a scheduled recurring routine or background automation for an agent (e.g. hourly health checks, nightly security audits).",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The descriptive title of the routine.",
            },
            prompt: {
              type: "string",
              description: "The action prompt/instructions to execute whenever the routine triggers.",
            },
            schedule_type: {
              type: "string",
              enum: ["interval", "cron"],
              description: "Schedule trigger type: 'interval' (every N minutes) or 'cron' (5-field cron expression).",
            },
            interval_minutes: {
              type: "number",
              description: "For interval schedules: interval frequency in minutes (e.g. 15, 60, 1440).",
            },
            cron: {
              type: "string",
              description: "For cron schedules: standard 5-part cron syntax (e.g. '0 9 * * *' for 9 AM daily).",
            },
            agent_id: {
              type: "string",
              description: "Optional agent persona assigned to execute the routine (defaults to 'default').",
            },
          },
          required: ["name", "prompt", "schedule_type"],
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      const routine = await routineEngine.createRoutine({
        name: args.name,
        prompt: args.prompt,
        scheduleType: args.schedule_type,
        intervalMinutes: args.interval_minutes,
        cron: args.cron,
        agentId: args.agent_id,
      });
      return JSON.stringify({
        status: "success",
        message: `Created scheduled routine '${routine.name}' (${routine.routineId}). Next run at: ${routine.nextRunAtMs ? new Date(routine.nextRunAtMs).toISOString() : "Disabled"}.`,
        routine,
      }, null, 2);
    },
  });

  // 25. Tool: list_routines (Parity with ListGrokBotAgentRoutines)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "list_routines",
        description: "List all background automated routines and their next scheduled execution times.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    requiresGate: "computerUse",
    handler: async () => {
      const routines = await routineEngine.listRoutines();
      return JSON.stringify({
        status: "success",
        count: routines.length,
        routines,
      }, null, 2);
    },
  });

  // 26. Tool: set_routine_enabled (Parity with SetGrokBotAgentRoutineEnabled)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "set_routine_enabled",
        description: "Enable or disable a background scheduled routine.",
        parameters: {
          type: "object",
          properties: {
            routine_id: {
              type: "string",
              description: "The unique ID of the routine.",
            },
            is_enabled: {
              type: "boolean",
              description: "True to enable and schedule, false to pause.",
            },
          },
          required: ["routine_id", "is_enabled"],
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      const routine = await routineEngine.setRoutineEnabled(args.routine_id, args.is_enabled);
      return JSON.stringify({
        status: "success",
        message: `Routine '${routine.name}' is now ${routine.isEnabled ? "enabled" : "disabled"}.`,
        routine,
      }, null, 2);
    },
  });

  // 27. Tool: trigger_routine
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "trigger_routine",
        description: "Immediately execute a scheduled routine out of sequence and record execution logs.",
        parameters: {
          type: "object",
          properties: {
            routine_id: {
              type: "string",
              description: "The unique ID of the routine to trigger.",
            },
          },
          required: ["routine_id"],
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      const res = await routineEngine.triggerRoutine(args.routine_id);
      return JSON.stringify({
        status: res.status,
        message: `Routine '${res.routine.name}' executed.`,
        result: res.result,
        routine: res.routine,
      }, null, 2);
    },
  });

  // 28. Tool: delete_routine (Parity with DeleteGrokBotAgentAutomation)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "delete_routine",
        description: "Permanently delete a scheduled background routine.",
        parameters: {
          type: "object",
          properties: {
            routine_id: {
              type: "string",
              description: "The unique ID of the routine to delete.",
            },
          },
          required: ["routine_id"],
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      const deleted = await routineEngine.deleteRoutine(args.routine_id);
      return JSON.stringify({
        status: deleted ? "success" : "not_found",
        message: deleted ? `Routine '${args.routine_id}' deleted successfully.` : `Routine '${args.routine_id}' not found.`,
      }, null, 2);
    },
  });

  // 29. Tool: create_room (Parity with CreateGrokBotRoom)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "create_room",
        description: "Create a collaborative multi-agent group room (kind: 'ROOM') where multiple specialist agent personas deliberate and solve problems together.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The title of the room (e.g. 'Security Architecture Board', 'Product Release Team').",
            },
            description: {
              type: "string",
              description: "The mission or purpose of this multi-agent collaborative room.",
            },
            member_agent_ids: {
              type: "array",
              items: { type: "string" },
              description: "List of agent persona IDs that belong to this room.",
            },
          },
          required: ["name", "description", "member_agent_ids"],
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      const room = await roomManager.createRoom({
        name: args.name,
        description: args.description,
        memberAgentIds: args.member_agent_ids,
      });
      return JSON.stringify({
        status: "success",
        message: `Created room '${room.name}' (${room.roomId}) with ${room.memberAgentIds.length} member agents.`,
        room,
      }, null, 2);
    },
  });

  // 30. Tool: list_rooms
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "list_rooms",
        description: "List all multi-agent rooms and their member agent rosters.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    requiresGate: "computerUse",
    handler: async () => {
      const rooms = await roomManager.listRooms();
      return JSON.stringify({
        status: "success",
        count: rooms.length,
        rooms,
      }, null, 2);
    },
  });

  // 31. Tool: set_room_members (Parity with SetGrokBotRoomMembers)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "set_room_members",
        description: "Update the member agent roster of a multi-agent room.",
        parameters: {
          type: "object",
          properties: {
            room_id: {
              type: "string",
              description: "The unique ID of the room.",
            },
            member_agent_ids: {
              type: "array",
              items: { type: "string" },
              description: "The new array of member agent IDs.",
            },
          },
          required: ["room_id", "member_agent_ids"],
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      const room = await roomManager.setRoomMembers(args.room_id, args.member_agent_ids);
      return JSON.stringify({
        status: "success",
        message: `Room '${room.name}' members updated to [${room.memberAgentIds.join(", ")}].`,
        room,
      }, null, 2);
    },
  });

  // 32. Tool: run_room_discussion (Parity with RequestGrokBotRoomMemberTurn / DeliverGrokBotRoomMemberTurnResult)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "run_room_discussion",
        description: "Convene a multi-agent round-table meeting in a room on a given topic, collecting contributions from each specialist agent and synthesizing a consensus agreement.",
        parameters: {
          type: "object",
          properties: {
            room_id: {
              type: "string",
              description: "The ID of the room.",
            },
            topic: {
              type: "string",
              description: "The question, proposal, or problem to evaluate in the round-table discussion.",
            },
          },
          required: ["room_id", "topic"],
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      const res = await roomManager.runRoomDiscussion(args.room_id, args.topic);
      return JSON.stringify({
        status: "success",
        discussionId: res.discussionId,
        roomName: res.roomName,
        topic: res.topic,
        turnsCount: res.turns.length,
        consensus: res.consensus,
      }, null, 2);
    },
  });

  // 33. Tool: delete_room
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "delete_room",
        description: "Delete a multi-agent group room.",
        parameters: {
          type: "object",
          properties: {
            room_id: {
              type: "string",
              description: "The ID of the room to delete.",
            },
          },
          required: ["room_id"],
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      const deleted = await roomManager.deleteRoom(args.room_id);
      return JSON.stringify({
        status: deleted ? "success" : "not_found",
        message: deleted ? `Room '${args.room_id}' deleted successfully.` : `Room '${args.room_id}' not found.`,
      }, null, 2);
    },
  });

  // 34. Tool: git_status
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "git_status",
        description: "Inspect the current git branch, clean status, and lists of modified, staged, and untracked files.",
        parameters: {
          type: "object",
          properties: {
            repo_dir: {
              type: "string",
              description: "Optional repository path (defaults to current working directory).",
            },
          },
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      const status = await gitManager.getStatus(args.repo_dir);
      return JSON.stringify({
        status: "success",
        ...status,
      }, null, 2);
    },
  });

  // 35. Tool: git_diff_summary
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "git_diff_summary",
        description: "Get git diff statistics (insertions, deletions, files changed) and raw diff patch.",
        parameters: {
          type: "object",
          properties: {
            staged: {
              type: "boolean",
              description: "True to inspect staged (--cached) diff, false for working tree diff.",
            },
            repo_dir: {
              type: "string",
              description: "Optional repository path.",
            },
          },
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      const diffSummary = await gitManager.getDiff(args.staged, args.repo_dir);
      return JSON.stringify({
        status: "success",
        filesChanged: diffSummary.filesChanged,
        insertions: diffSummary.insertions,
        deletions: diffSummary.deletions,
        diff: diffSummary.diff.slice(0, 15000), // Protect context window
      }, null, 2);
    },
  });

  // 36. Tool: git_worktree_create
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "git_worktree_create",
        description: "Create an isolated git worktree directory for autonomous parallel work on a feature branch without disrupting the main workspace.",
        parameters: {
          type: "object",
          properties: {
            branch_name: {
              type: "string",
              description: "The name of the branch to create and checkout in the worktree.",
            },
            repo_dir: {
              type: "string",
              description: "Optional repository root path.",
            },
          },
          required: ["branch_name"],
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      const wt = await gitManager.createWorktree(args.branch_name, undefined, args.repo_dir);
      return JSON.stringify({
        status: "success",
        message: `Created isolated git worktree at ${wt.worktreePath} on branch ${wt.branch}.`,
        worktree: wt,
      }, null, 2);
    },
  });

  // 37. Tool: git_auto_commit
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "git_auto_commit",
        description: "Stage all modified files and commit with a concise conventional commit message.",
        parameters: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "Optional custom commit message (e.g. 'feat(auth): add vault integration'). If omitted, automatically inferred from staged files.",
            },
            repo_dir: {
              type: "string",
              description: "Optional repository path.",
            },
          },
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      const commit = await gitManager.autoCommit(args.message, args.repo_dir);
      return JSON.stringify({
        status: "success",
        message: `Committed ${commit.commitHash} on ${commit.branch}: "${commit.message}"`,
        commit,
      }, null, 2);
    },
  });

  // 38. Tool: gh_pr_review
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "gh_pr_review",
        description: "Autonomous PR review agent: inspects pull request diffs, checks for hardcoded credentials, anti-patterns, and rule violations, and outputs a structured review verdict.",
        parameters: {
          type: "object",
          properties: {
            pr_reference: {
              type: "string",
              description: "Pull request number, URL, or branch name (e.g. '12', 'HEAD', 'feature-auth').",
            },
            repo_dir: {
              type: "string",
              description: "Optional repository path.",
            },
          },
          required: ["pr_reference"],
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      const review = await gitManager.reviewPullRequest(args.pr_reference, args.repo_dir);
      return JSON.stringify({
        status: "success",
        verdict: review.verdict,
        summary: review.summary,
        issuesCount: review.issues.length,
        issues: review.issues,
      }, null, 2);
    },
  });

  // 39. Tool: start_workspace_watcher
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "start_workspace_watcher",
        description: "Launch background file sentinel to monitor workspace changes and run automated debounced test/build verification checks.",
        parameters: {
          type: "object",
          properties: {
            target_dir: {
              type: "string",
              description: "The directory to watch (e.g. './src' or repository root).",
            },
            check_command: {
              type: "string",
              description: "Optional command to run on file change (e.g. 'pnpm test' or 'tsc -b').",
            },
            auto_heal: {
              type: "boolean",
              description: "Whether the sentinel should automatically attempt to diagnose and heal detected failures.",
            },
            debounce_ms: {
              type: "number",
              description: "Debounce delay in milliseconds before triggering health checks (default: 500).",
            },
          },
          required: ["target_dir"],
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      const watcher = await workspaceSentinel.startWatcher({
        targetDir: args.target_dir,
        checkCommand: args.check_command,
        autoHeal: args.auto_heal,
        debounceMs: args.debounce_ms,
      });
      return JSON.stringify({
        status: "success",
        message: `Workspace sentinel active on ${watcher.targetDir} (${watcher.id}).`,
        watcher,
      }, null, 2);
    },
  });

  // 40. Tool: list_workspace_watchers
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "list_workspace_watchers",
        description: "List all active workspace sentinels and their target directories.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    requiresGate: "computerUse",
    handler: async () => {
      const watchers = workspaceSentinel.getWatchers();
      return JSON.stringify({
        status: "success",
        count: watchers.length,
        watchers,
      }, null, 2);
    },
  });

  // 41. Tool: stop_workspace_watcher
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "stop_workspace_watcher",
        description: "Stop an active workspace sentinel watcher.",
        parameters: {
          type: "object",
          properties: {
            watcher_id: {
              type: "string",
              description: "The unique ID of the watcher to stop.",
            },
          },
          required: ["watcher_id"],
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      const stopped = workspaceSentinel.stopWatcher(args.watcher_id);
      return JSON.stringify({
        status: stopped ? "success" : "not_found",
        message: stopped ? `Stopped watcher '${args.watcher_id}'.` : `Watcher '${args.watcher_id}' not found.`,
      }, null, 2);
    },
  });

  // 42. Tool: get_sentinel_diagnostic_logs
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "get_sentinel_diagnostic_logs",
        description: "Retrieve recent health check, build error, and self-healing diagnostic events from workspace sentinels.",
        parameters: {
          type: "object",
          properties: {
            watcher_id: {
              type: "string",
              description: "Optional watcher ID to filter logs.",
            },
          },
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      const logs = workspaceSentinel.getLogs(args.watcher_id);
      return JSON.stringify({
        status: "success",
        count: logs.length,
        logs: logs.slice(-20),
      }, null, 2);
    },
  });

  // 43. Tool: stage_attachment (Parity with Grok Bot stageAttachmentFile / stageAttachmentBytes)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "stage_attachment",
        description: "Stage a local file or artifact into the agent attachments store, generating SHA-256 and metadata for session context.",
        parameters: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "Absolute or relative file path to stage as an attachment.",
            },
          },
          required: ["file_path"],
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      try {
        const record = await attachmentManager.stageFile(args.file_path);
        return JSON.stringify({
          status: "success",
          attachment: record,
        }, null, 2);
      } catch (err: any) {
        return JSON.stringify({
          status: "error",
          message: err.message,
        });
      }
    },
  });

  // 44. Tool: list_attachments
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "list_attachments",
        description: "List all staged file attachments and their local file paths.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    handler: async () => {
      const list = await attachmentManager.listAttachments();
      return JSON.stringify({
        status: "success",
        count: list.length,
        attachments: list,
      }, null, 2);
    },
  });

  // 45. Tool: export_agent_template (Parity with Grok Bot CreateGrokBotTemplate / export)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "export_agent_template",
        description: "Export a registered bot persona into a portable reusable agent template JSON.",
        parameters: {
          type: "object",
          properties: {
            agent_id_or_name: {
              type: "string",
              description: "Agent ID or unique name to export as a template.",
            },
          },
          required: ["agent_id_or_name"],
        },
      },
    },
    handler: async (args) => {
      try {
        const template = await store.exportTemplate(args.agent_id_or_name);
        return JSON.stringify({
          status: "success",
          template,
        }, null, 2);
      } catch (err: any) {
        return JSON.stringify({
          status: "error",
          message: err.message,
        });
      }
    },
  });

  // 46. Tool: import_agent_template (Parity with Grok Bot CreateGrokBotAgentFromTemplate)
  daemon.registerCustomTool({
    definition: {
      type: "function",
      function: {
        name: "import_agent_template",
        description: "Import a reusable agent template JSON and register it as a new bot persona.",
        parameters: {
          type: "object",
          properties: {
            template_json: {
              type: "string",
              description: "Serialized JSON string of the agent template.",
            },
          },
          required: ["template_json"],
        },
      },
    },
    requiresGate: "computerUse",
    handler: async (args) => {
      try {
        const agent = await store.importTemplate(args.template_json);
        return JSON.stringify({
          status: "success",
          agent,
        }, null, 2);
      } catch (err: any) {
        return JSON.stringify({
          status: "error",
          message: err.message,
        });
      }
    },
  });

  return { store, taskStore, habitExtractor, memoryStore, vaultStore, skillStore, routineEngine, roomManager, gitManager, workspaceSentinel, attachmentManager };
}
