/**
 * Tools that are safe to execute concurrently with other tools in the same
 * model turn. The coordinator preserves prehooks, policy checks, and
 * approvals in model order; it only parallelizes execution for this explicit
 * read-only set. A tool not listed here is intentionally a sequential
 * barrier, including exec_command, all mutating file/git/vault operations,
 * delegating/orchestrating tools, and any MCP/custom tool (unknown tools
 * default to sequential).
 */
const PARALLEL_SAFE_TOOLS = new Set<string>([
  // Local daemon: inspection and discovery
  "read_file",
  "list_directory",
  "list_agents",
  "list_agent_tasks",
  "discover_tools",

  // Native read-only bridges
  "read_recent_messages",
  "safari_inspect_active_tab",
  "list_windows",
  "recognize_screen_text",

  // Orchestrator: read-only views of agents/tasks/memory/skills/rooms/secrets.
  "list_room_members",
  "list_rooms",
  "list_skills",
  "list_attachments",
  "list_team_review_items",
  "list_workspaces",
  "list_workspace_watchers",
  "get_sentinel_diagnostic_logs",
  "list_routines",
  "vault_list_secrets",
  "vault_list_credentials",
  "recall_memories",
  "get_agent_tail",
  "show_app_access",
  "list_connectors",
  "list_gallery_templates",
]);


export function isParallelSafeTool(toolName: string): boolean {
  return PARALLEL_SAFE_TOOLS.has(toolName);
}
