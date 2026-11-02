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
        const parsed = JSON.parse(msg.content);
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
 * Core coding tools active in every conversation.
 */
export const CORE_TOOL_NAMES = new Set([
  "exec_command",
  "read_file",
  "write_file",
  "edit_file",
  "list_directory",
  "git_status",
  "git_diff",
  "git_commit",
  "create_agent",
  "list_agents",
  "delegate_to_agent",
]);

/**
 * Keyword-based category activation mappings for adaptive tool scoping.
 */
const TOOL_CATEGORY_PATTERNS: Array<{ pattern: RegExp; toolNames: string[] }> = [
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
    pattern: /\b(template|export_template|import_template)\b/i,
    toolNames: ["export_agent_template", "import_agent_template"],
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
 * Filter tool definitions adaptively to minimize prompt token overhead.
 * - 'core': only essential file/command tools (~11 tools vs 61 tools, ~83% token savings)
 * - 'auto': core tools + any tools dynamically relevant to the query/context
 * - 'all': all registered tools
 */
export function selectActiveTools(
  tools: ToolDefinition[],
  query?: string,
  mode: "core" | "auto" | "all" = "auto"
): ToolDefinition[] {
  if (mode === "all" || !tools || tools.length === 0) {
    return tools;
  }

  if (mode === "core" || !query) {
    return tools.filter((t) => CORE_TOOL_NAMES.has(t.function.name));
  }

  // Mode is 'auto': start with core tools
  const activeToolNames = new Set(CORE_TOOL_NAMES);

  for (const { pattern, toolNames } of TOOL_CATEGORY_PATTERNS) {
    if (pattern.test(query)) {
      for (const name of toolNames) {
        activeToolNames.add(name);
      }
    }
  }

  return tools.filter((t) => activeToolNames.has(t.function.name));
}
