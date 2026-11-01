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
  defaultEndpoint?: string;
  defaultModel?: string;
  defaultApiKey?: string;
  sessionsBaseDir?: string;
}

export function registerOrchestratorTools(options: RegisterOrchestratorToolsOptions): {
  store: AgentStore;
  taskStore: TaskStore;
  habitExtractor: HabitExtractor;
  memoryStore: MemoryStore;
  vaultStore: VaultStore;
  skillStore: SkillStore;
} {
  const { daemon } = options;
  const store = options.store ?? new AgentStore();
  const taskStore = options.taskStore ?? new TaskStore();
  const memoryStore = options.memoryStore ?? new MemoryStore();
  const vaultStore = options.vaultStore ?? new VaultStore();
  const skillStore = options.skillStore ?? new SkillStore({ agentStore: store });
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

  return { store, taskStore, habitExtractor, memoryStore, vaultStore, skillStore };
}
