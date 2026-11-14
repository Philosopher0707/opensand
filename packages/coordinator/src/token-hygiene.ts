import { unwrapUntrusted } from "@opensand/shared";
import { ChatMessage } from "./types.js";
import { ToolDefinition } from "@opensand/local-exec-daemon";

export interface TruncationOptions {
  /**
   * Maximum total characters allowed for a single tool output.
   * Default: 16,000 characters (~4,200 tokens).
   */
  maxCharacters?: number;

  /**
   * Number of characters to retain from the beginning of the output (headers, command start).
   * Default: 10,000 characters (~2,600 tokens).
   */
  headCharacters?: number;

  /**
   * Number of characters to retain from the end of the output (exit codes, summaries, test results).
   * Default: 5,000 characters (~1,300 tokens).
   */
  tailCharacters?: number;
}

/**
 * Truncate massive tool outputs with head/tail preservation and clear boundary markers.
 * Prevents a single tool execution from flooding context with 100k+ tokens.
 */
export function truncateToolOutput(
  content: string,
  options?: TruncationOptions
): string {
  const maxChars = options?.maxCharacters ?? 16000;
  if (!content || content.length <= maxChars) {
    return content;
  }

  const headChars = options?.headCharacters ?? 10000;
  const tailChars = options?.tailCharacters ?? 5000;
  const omitted = content.length - headChars - tailChars;

  if (omitted <= 0) {
    return content.slice(0, maxChars);
  }

  const head = content.slice(0, headChars);
  const tail = content.slice(content.length - tailChars);

  return `${head}\n\n[... Tool output truncated: ${omitted.toLocaleString()} characters omitted for token efficiency. Specify narrower arguments (e.g. start_line, grep, head/tail) if you need a specific section. ...]\n\n${tail}`;
}

/**
 * Fold older tool execution results in dialogue history into concise references.
 * Preserves full tool outputs for the most recent `keepRecentTurns` user turns,
 * and collapses older verbose tool messages into compact summaries.
 */
export function foldHistoricalToolResults(
  messages: ChatMessage[],
  keepRecentTurns = 2,
  maxHistoricalLength = 400
): ChatMessage[] {
  if (messages.length === 0) return [];

  // Find user turn boundaries
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") {
      userIndices.push(i);
    }
  }

  if (userIndices.length <= keepRecentTurns) {
    return messages;
  }

  // Messages before this cutoff index belong to older turns and should be folded
  const cutoffIndex = userIndices[userIndices.length - keepRecentTurns];

  return messages.map((msg, idx) => {
    if (idx >= cutoffIndex) {
      return msg;
    }

    // Fold old bulky tool results
    if (msg.role === "tool" && msg.content && msg.content.length > maxHistoricalLength) {
      const charCount = msg.content.length;
      let shortSummary = `[Past tool output folded: ${charCount.toLocaleString()} chars condensed for token efficiency]`;

      try {
        const parsed = JSON.parse(unwrapUntrusted(msg.content));
        if (parsed.status === "ok" && parsed.output?.path) {
          shortSummary = `[Past tool output folded: read_file "${parsed.output.path}" (${charCount.toLocaleString()} chars)]`;
        } else if (parsed.status === "ok" && typeof parsed.output?.exitCode === "number") {
          shortSummary = `[Past tool output folded: exec_command exited with code ${parsed.output.exitCode} (${charCount.toLocaleString()} chars)]`;
        } else if (parsed.status === "ok") {
          shortSummary = `[Past tool output folded: execution succeeded (${charCount.toLocaleString()} chars)]`;
        }
      } catch {
        // Not JSON
      }

      return {
        ...msg,
        content: shortSummary,
      };
    }

    return msg;
  });
}

/**
 * Per-tool capability hint used by the model-driven scope selector.
 * The model declares which capabilities it needs per turn via
 * `selectActiveToolsForModel()`; it never sees hidden tools it cannot call.
 * Keys not listed default to CORE.
 */
export interface ToolDiscoverySummary {
  totalTools: number;
  capabilities: string[];
  tools: Array<{
    name: string;
    description: string;
    parameters: string[];
    capabilities: string[];
  }>;
}

export function buildToolDiscoverySummary(defs: ToolDefinition[]): ToolDiscoverySummary {
  const tools = defs.map((d) => ({
    name: d.function.name,
    description: d.function.description,
    parameters: Object.keys((d.function.parameters as any)?.properties || {}),
    capabilities: TOOL_CAPABILITY_HINTS[d.function.name] ?? (d.function.name.includes("__") ? ["mcp", d.function.name.split("__")[0]] : ["core"]),
  }));
  const capabilities = [...new Set(tools.flatMap((tool) => tool.capabilities))].sort();
  return { totalTools: tools.length, capabilities, tools };
}

export const TOOL_CAPABILITY_HINTS: Record<string, string[]> = {
  create_agent_task: ["tasks"],
  list_agent_tasks: ["tasks"],
  update_agent_task: ["tasks"],
  delete_agent_task: ["tasks"],
  recall_memories: ["memory"],
  store_memory: ["memory"],
  update_memory: ["memory"],
  forget_memory: ["memory"],
  import_memory: ["memory"],
  vault_list_secrets: ["vault"],
  vault_store_secret: ["vault"],
  vault_delete_secret: ["vault"],
  vault_list_credentials: ["vault"],
  vault_store_credential: ["vault"],
  vault_delete_credential: ["vault"],
  list_skills: ["skills"],
  add_skill: ["skills"],
  mount_skill: ["skills"],
  unmount_skill: ["skills"],
  delete_skill: ["skills"],
  create_routine: ["routines"],
  list_routines: ["routines"],
  set_routine_enabled: ["routines"],
  trigger_routine: ["routines"],
  delete_routine: ["routines"],
  get_routine_logs: ["routines"],
  create_room: ["rooms"],
  list_rooms: ["rooms"],
  set_room_members: ["rooms"],
  run_room_discussion: ["rooms"],
  delete_room: ["rooms"],
  start_workspace_watcher: ["sentinel"],
  list_workspace_watchers: ["sentinel"],
  stop_workspace_watcher: ["sentinel"],
  stage_attachment: ["attachments"],
  list_attachments: ["attachments"],
  delete_attachment: ["attachments"],
  export_agent_template: ["templates"],
  import_agent_template: ["templates"],
  recognize_screen_text: ["vision"],
  capture_window: ["vision"],
  list_windows: ["vision"],
  inspect_active_app: ["vision"],
  show_notification: ["vision"],
  discover_tools: ["discovery"],
  show_app_access: ["connectors"],
  list_connectors: ["connectors"],
  slack_post_message: ["connectors", "slack"],
  linear_create_issue: ["connectors", "linear"],
  github_app_action: ["connectors", "github"],
  list_gallery_templates: ["templates", "gallery"],
  install_gallery_template: ["templates", "gallery"],
  list_mcp_servers: ["mcp"],
  add_mcp_server: ["mcp"],
  remove_mcp_server: ["mcp"],
};

/** Rough per-tool prompt-token cost (name + description + params). */
export function estimateToolCost(tool: ToolDefinition): number {
  const fn = tool.function;
  const params = JSON.stringify(fn.parameters?.properties ?? {});
  return Math.ceil((fn.name.length + fn.description.length + params.length) / 3.8);
}

/**
 * Core coding tools active in every conversation.
 */
export const CORE_TOOL_NAMES = new Set([
  "exec_command",
  "read_file",
  "write_file",
  "edit_file",
  "grep",
  "glob",
  "list_directory",
  "git_status",
  "git_diff",
  "git_commit",
  "create_agent",
  "list_agents",
  "delegate_to_agent",
  "discover_tools",
  "show_app_access",
]);

/**
 * Keyword-based category activation mappings for adaptive tool scoping.
 */
const TOOL_CATEGORY_PATTERNS: Array<{ pattern: RegExp; toolNames: string[] }> = [
  {
    pattern: /\b(slack|linear|github|oauth|connector|connect|integration)\b/i,
    toolNames: ["show_app_access", "list_connectors", "slack_post_message", "linear_create_issue", "github_app_action"],
  },
  {
    pattern: /\b(task|todo|milestone|backlog)\b/i,
    toolNames: ["create_agent_task", "list_agent_tasks", "update_agent_task", "delete_agent_task"],
  },
  {
    pattern: /\b(memory|memories|remember|recall|fact)\b/i,
    toolNames: ["recall_memories", "store_memory", "update_memory", "forget_memory", "import_memory"],
  },
  {
    pattern: /\b(vault|secret|credential|password|token|key|encrypt)\b/i,
    toolNames: [
      "vault_list_secrets",
      "vault_store_secret",
      "vault_delete_secret",
      "vault_list_credentials",
      "vault_store_credential",
      "vault_delete_credential",
    ],
  },
  {
    pattern: /\b(skill|recipe|skill\.md)\b/i,
    toolNames: ["list_skills", "add_skill", "mount_skill", "unmount_skill", "delete_skill"],
  },
  {
    pattern: /\b(routine|cron|schedule|recurring|interval|ticker)\b/i,
    toolNames: [
      "create_routine",
      "list_routines",
      "set_routine_enabled",
      "trigger_routine",
      "delete_routine",
      "get_routine_logs",
    ],
  },
  {
    pattern: /\b(room|round-table|deliberat|convene|discuss)\b/i,
    toolNames: [
      "create_room",
      "list_rooms",
      "set_room_members",
      "run_room_discussion",
      "delete_room",
    ],
  },
  {
    pattern: /\b(sentinel|watcher|self-heal|heal|watch)\b/i,
    toolNames: ["start_workspace_watcher", "list_workspace_watchers", "stop_workspace_watcher"],
  },
  {
    pattern: /\b(attachment|stage|upload)\b/i,
    toolNames: ["stage_attachment", "list_attachments", "delete_attachment"],
  },
  {
    pattern: /\b(template|export_template|import_template|gallery|persona_store|agent_store|marketplace)\b/i,
    toolNames: ["export_agent_template", "import_agent_template", "list_gallery_templates", "install_gallery_template"],
  },
  {
    pattern: /\b(ocr|screen|window|capture|vision)\b/i,
    toolNames: [
      "recognize_screen_text",
      "capture_window",
      "list_windows",
      "inspect_active_app",
      "show_notification",
    ],
  },
];

/**
 * Standard tool configurations per agent persona role for subagent tool scoping and token hygiene.
 */
export const DEFAULT_ROLE_TOOLS: Record<string, string[]> = {
  "code-reviewer": ["git_diff", "git_status", "read_file", "grep", "glob", "list_directory", "exec_command"],
  "reviewer": ["git_diff", "git_status", "read_file", "grep", "glob", "list_directory", "exec_command"],
  "security-auditor": ["read_file", "grep", "glob", "list_directory", "exec_command", "vault_list_secrets"],
  "security": ["read_file", "grep", "glob", "list_directory", "exec_command", "vault_list_secrets"],
  "refactoring-architect": ["read_file", "grep", "glob", "edit_file", "write_file", "list_directory", "exec_command", "git_status"],
  "architect": ["read_file", "grep", "glob", "edit_file", "write_file", "list_directory", "exec_command", "git_status"],
  "project-lead": ["linear_create_issue", "show_app_access", "create_agent_task", "list_agent_tasks", "update_agent_task"],
  "pm": ["linear_create_issue", "show_app_access", "create_agent_task", "list_agent_tasks", "update_agent_task"],
  "devops": ["exec_command", "read_file", "grep", "glob", "write_file", "edit_file", "list_directory"],
  "infrastructure": ["exec_command", "read_file", "grep", "glob", "write_file", "edit_file", "list_directory"],
  "qa": ["read_file", "grep", "glob", "list_directory", "exec_command", "git_status", "git_diff"],
  "tester": ["read_file", "grep", "glob", "list_directory", "exec_command", "git_status", "git_diff"],
  "notifier": ["slack_post_message", "show_app_access", "recall_memories"],
  "collaboration": ["slack_post_message", "show_app_access", "recall_memories"],
  "reverse-engineer": ["read_file", "grep", "glob", "list_directory", "exec_command", "discover_tools"],
  "maintainer": ["github_app_action", "show_app_access", "git_status", "git_diff", "git_commit"],
  "researcher": ["read_file", "grep", "glob", "list_directory", "exec_command", "discover_tools"],
  "engineer": ["read_file", "grep", "glob", "edit_file", "write_file", "list_directory", "exec_command", "git_status", "git_diff", "git_commit"],
  "developer": ["read_file", "grep", "glob", "edit_file", "write_file", "list_directory", "exec_command", "git_status", "git_diff", "git_commit"],
};

/**
 * Resolve default allowed tools for a specified agent role name.
 */
export function getRoleDefaultTools(role?: string): string[] | undefined {
  if (!role) return undefined;
  const normalized = role.toLowerCase().trim();
  if (DEFAULT_ROLE_TOOLS[normalized]) {
    return [...DEFAULT_ROLE_TOOLS[normalized]];
  }
  if (normalized.includes("reviewer") || normalized.includes("review")) {
    return [...DEFAULT_ROLE_TOOLS["reviewer"]];
  }
  if (normalized.includes("security")) {
    return [...DEFAULT_ROLE_TOOLS["security"]];
  }
  if (normalized.includes("architect")) {
    return [...DEFAULT_ROLE_TOOLS["architect"]];
  }
  if (normalized.includes("project") || normalized.includes("delivery") || normalized.includes("agile")) {
    return [...DEFAULT_ROLE_TOOLS["project-lead"]];
  }
  if (normalized.includes("infra") || normalized.includes("devops") || normalized.includes("operations")) {
    return [...DEFAULT_ROLE_TOOLS["infrastructure"]];
  }
  if (normalized.includes("notifier") || normalized.includes("collab")) {
    return [...DEFAULT_ROLE_TOOLS["notifier"]];
  }
  if (normalized.includes("reverse") || normalized.includes("archaeology")) {
    return [...DEFAULT_ROLE_TOOLS["reverse-engineer"]];
  }
  if (normalized.includes("maintainer") || normalized.includes("github")) {
    return [...DEFAULT_ROLE_TOOLS["maintainer"]];
  }
  if (normalized.includes("qa") || normalized.includes("test")) {
    return [...DEFAULT_ROLE_TOOLS["qa"]];
  }
  if (normalized.includes("engineer") || normalized.includes("developer") || normalized.includes("coder")) {
    return [...DEFAULT_ROLE_TOOLS["engineer"]];
  }
  if (normalized.includes("research")) {
    return [...DEFAULT_ROLE_TOOLS["researcher"]];
  }
  return undefined;
}

/**
 * Resolves allowedTools from an explicit allowedTools array or fallback role definition.
 */
export function resolveRoleAllowedTools(role?: string, allowedTools?: string[]): string[] | undefined {
  if (Array.isArray(allowedTools)) {
    return [...allowedTools];
  }
  if (role) {
    return getRoleDefaultTools(role);
  }
  return undefined;
}

export interface SelectActiveToolsOptions {
  query?: string;
  mode?: "core" | "auto" | "all";
  role?: string;
  allowedTools?: string[];
}

/**
 * Filter tool definitions adaptively to minimize prompt token overhead.
 * - 'core': only essential file/command tools (~11 tools vs 61 tools, ~83% token savings)
 * - 'auto': core tools + keyword-hinted categories + model-declared capabilities
 * - 'all': all registered tools
 *
 * When an allowedTools list or role is provided, tools are strictly filtered by that whitelist.
 *
 * The model-driven path is selectActiveToolsForModel(): it takes the
 * capabilities the model declared (from discover_tools, which lists every
 * tool with its capability hint) and includes those categories without
 * keyword guessing. Keyword patterns remain only as a legacy hint for
 * 'auto' callers that pass a query; they never gate discover_tools itself.
 */
export function selectActiveTools(
  tools: ToolDefinition[],
  queryOrOptions?: string | string[] | SelectActiveToolsOptions,
  modeOrOptions?: "core" | "auto" | "all" | { role?: string; allowedTools?: string[] } | string[],
  options?: { role?: string; allowedTools?: string[] } | string[]
): ToolDefinition[] {
  if (!tools || tools.length === 0) {
    return [];
  }

  let query: string | undefined;
  let mode: "core" | "auto" | "all" | undefined;
  let role: string | undefined;
  let allowedTools: string[] | undefined;

  if (queryOrOptions && typeof queryOrOptions === "object" && !Array.isArray(queryOrOptions)) {
    query = queryOrOptions.query;
    mode = queryOrOptions.mode;
    role = queryOrOptions.role;
    allowedTools = queryOrOptions.allowedTools;
  } else if (Array.isArray(queryOrOptions)) {
    allowedTools = queryOrOptions;
  } else {
    query = queryOrOptions;
    if (typeof modeOrOptions === "string") {
      mode = modeOrOptions;
    } else if (Array.isArray(modeOrOptions)) {
      allowedTools = modeOrOptions;
    } else if (modeOrOptions && typeof modeOrOptions === "object") {
      role = modeOrOptions.role;
      allowedTools = modeOrOptions.allowedTools;
    }

    if (Array.isArray(options)) {
      allowedTools = options;
    } else if (options && typeof options === "object") {
      role = options.role ?? role;
      allowedTools = options.allowedTools ?? allowedTools;
    }
  }

  const effectiveAllowed = resolveRoleAllowedTools(role, allowedTools);

  // If role/allowedTools were specified, default mode to 'all' of those tools unless explicitly specified
  const effectiveMode: "core" | "auto" | "all" = mode ?? (effectiveAllowed !== undefined ? "all" : "auto");

  let candidateTools = tools;
  if (effectiveAllowed !== undefined) {
    candidateTools = tools.filter((t) => effectiveAllowed.includes(t.function.name));
  }

  if (effectiveMode === "all" || candidateTools.length === 0) {
    return candidateTools;
  }

  if (effectiveMode === "core" || !query) {
    return candidateTools.filter((t) => CORE_TOOL_NAMES.has(t.function.name));
  }

  // Mode is 'auto': core + keyword-hinted tools (legacy, kept for back-compat)
  const activeToolNames = new Set(CORE_TOOL_NAMES);

  for (const { pattern, toolNames } of TOOL_CATEGORY_PATTERNS) {
    if (pattern.test(query)) {
      for (const name of toolNames) {
        activeToolNames.add(name);
      }
    }
  }

  return candidateTools.filter((t) => activeToolNames.has(t.function.name));
}

/**
 * Model-driven tool scoping. The model declares capabilities
 * (e.g. ["vault", "routines"]) after inspecting discover_tools output;
 * this returns CORE + those categories, and — critically — always
 * includes discover_tools itself so the model can re-discover within
 * the same turn instead of being trapped by a stale scope.
 */
export function selectActiveToolsForModel(
  tools: ToolDefinition[],
  capabilities: string[]
): ToolDefinition[] {
  if (!tools || tools.length === 0) return tools;
  const wanted = new Set(capabilities.map((c) => c.toLowerCase().trim()));
  return tools.filter((t) => {
    if (CORE_TOOL_NAMES.has(t.function.name)) return true;
    let hints = TOOL_CAPABILITY_HINTS[t.function.name];
    if (!hints && t.function.name.includes("__")) {
      const [server] = t.function.name.split("__");
      hints = ["mcp", server];
    }
    return (hints ?? []).some((h) => wanted.has(h));
  });
}

export interface RecommendScopeModeOptions {
  role?: string;
  allowedTools?: string[];
}

/**
 * Recommend a scope mode for a model without paying the full tool-schema
 * cost when it isn't needed. Cloud models with >= 100k context default
 * to 'all' (cheap); local/small models keep 'auto'/'core'.
 * Subagents with constrained allowedTools or focused roles default to 'all'.
 */
export function recommendToolScopeMode(
  modelName?: string,
  maxContextTokensOrOptions?: number | string | string[] | RecommendScopeModeOptions,
  options?: RecommendScopeModeOptions | string[] | string
): "core" | "auto" | "all" {
  let maxContextTokens: number | undefined;
  let role: string | undefined;
  let allowedTools: string[] | undefined;

  if (typeof maxContextTokensOrOptions === "number") {
    maxContextTokens = maxContextTokensOrOptions;
  } else if (typeof maxContextTokensOrOptions === "string") {
    role = maxContextTokensOrOptions;
  } else if (Array.isArray(maxContextTokensOrOptions)) {
    allowedTools = maxContextTokensOrOptions;
  } else if (maxContextTokensOrOptions && typeof maxContextTokensOrOptions === "object") {
    role = maxContextTokensOrOptions.role;
    allowedTools = maxContextTokensOrOptions.allowedTools;
  }

  if (typeof options === "string") {
    role = options;
  } else if (Array.isArray(options)) {
    allowedTools = options;
  } else if (options && typeof options === "object") {
    role = options.role ?? role;
    allowedTools = options.allowedTools ?? allowedTools;
  }

  const effectiveAllowed = resolveRoleAllowedTools(role, allowedTools);

  // If a subagent has an explicitly constrained tool list (<= 25 tools), recommend 'all'
  // so the subagent has access to all its intended tools without keyword suppression.
  if (effectiveAllowed !== undefined && effectiveAllowed.length <= 25) {
    return "all";
  }

  const tokens = maxContextTokens ?? getModelMaxContextTokens(modelName);
  return tokens >= 100000 ? "all" : "auto";
}

/**
 * Resolves the maximum context window size in tokens for a given model identifier.
 * Accurately maps common model families (Gemini, Claude, DeepSeek, GPT-4o, Qwen, Llama, Mistral).
 */
export function getModelMaxContextTokens(modelName?: string): number {
  if (!modelName) {
    return 128000;
  }
  const name = modelName.toLowerCase().trim();

  // 1. Google Gemini: 1,000,000 tokens
  if (
    name.includes("gemini-1.5") ||
    name.includes("gemini-2.0") ||
    name.includes("gemini-flash") ||
    name.includes("gemini-pro") ||
    name.includes("google/gemini")
  ) {
    return 1000000;
  }
  if (name.includes("gemini-1.0")) {
    return 32768;
  }

  // 2. Anthropic Claude: 200,000 tokens
  if (
    name.includes("claude-3") ||
    name.includes("claude-3-5") ||
    name.includes("claude-3-7") ||
    name.includes("claude-2.1") ||
    name.includes("anthropic/claude")
  ) {
    return 200000;
  }
  if (name.includes("claude-2") || name.includes("claude-instant")) {
    return 100000;
  }
  if (name.includes("claude")) {
    return 200000;
  }

  // 3. DeepSeek models: 128,000 tokens
  // e.g. deepseek/deepseek-v4.1-flash-1017, deepseek-chat, deepseek-coder, deepseek-r1
  if (name.includes("deepseek")) {
    return 128000;
  }

  // 4. OpenAI models
  // gpt-4o, gpt-4o-mini, o1, o1-mini, o1-preview, o3-mini, chatgpt-4o-latest
  if (
    name.includes("gpt-4o") ||
    name.includes("o1") ||
    name.includes("o3") ||
    name.includes("gpt-4-turbo") ||
    name.includes("gpt-4-1106") ||
    name.includes("gpt-4-0125")
  ) {
    return 128000;
  }
  if (name.includes("gpt-4-32k")) {
    return 32768;
  }
  if (name.includes("gpt-4")) {
    return 8192;
  }
  if (
    name.includes("gpt-3.5-turbo-16k") ||
    name.includes("gpt-3.5-turbo-0125") ||
    name.includes("gpt-3.5-turbo-1106")
  ) {
    return 16384;
  }
  if (name.includes("gpt-3.5")) {
    return 16384;
  }

  // 5. Qwen models
  // Qwen 2.5 series (qwen2.5-coder, qwen2.5:32b, etc.) -> 128,000
  if (name.includes("qwen2.5") || name.includes("qwen-2.5")) {
    return 128000;
  }
  // Qwen 1 / 2 / 3 8B, local Ollama models (e.g. qwen3:8b, qwen:8b, qwen2:7b) -> 32,768
  if (name.includes("qwen")) {
    return 32768;
  }

  // 6. Meta Llama models
  // Llama 3.1 / 3.2 / 3.3 -> 128,000
  if (
    name.includes("llama-3.1") ||
    name.includes("llama3.1") ||
    name.includes("llama-3.2") ||
    name.includes("llama3.2") ||
    name.includes("llama-3.3") ||
    name.includes("llama3.3")
  ) {
    return 128000;
  }
  // Llama 3 (8k)
  if (name.includes("llama-3") || name.includes("llama3")) {
    return 8192;
  }
  // Llama 2 (4k)
  if (name.includes("llama-2") || name.includes("llama2")) {
    return 4096;
  }

  // 7. Mistral / Codestral
  if (
    name.includes("mistral-large") ||
    name.includes("codestral") ||
    name.includes("mistral-small") ||
    name.includes("mistral-nemo") ||
    name.includes("open-mistral-nemo")
  ) {
    return 128000;
  }
  if (name.includes("mistral") || name.includes("mixtral")) {
    return 32768;
  }

  // 8. Cohere Command R / Command R+
  if (name.includes("command-r")) {
    return 128000;
  }

  // Fallback default: standard 128,000
  return 128000;
}
