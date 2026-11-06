/**
 * Human-readable tool call / result summaries for the CLI.
 * Pure functions (no I/O) so they are unit-testable.
 */

/** Safely parse a tool-call arguments JSON string; returns {} on failure. */
export function parseToolArgs(raw: string): Record<string, any> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, any>;
    }
    return {};
  } catch {
    return {};
  }
}

function shortPath(p: string, max = 72): string {
  if (p.length <= max) return p;
  return `…/${p.split("/").filter(Boolean).slice(-2).join("/")}`;
}

function firstLine(s: string, max = 90): string {
  const line = s.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function compactJson(args: Record<string, any>, max = 80): string {
  try {
    const s = JSON.stringify(args);
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  } catch {
    return "";
  }
}

/** First "meaningful" string arg, in preference order. */
function pickArg(args: Record<string, any>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v: unknown = args[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

/**
 * One-line human summary of what a tool call is about to do.
 * e.g. `read packages/cli/src/cli-app.ts`, `run: git status`
 */
export function summarizeToolCall(name: string, args: Record<string, any>): string {
  switch (name) {
    case "exec_command": {
      const cmd = typeof args.command === "string" ? args.command : "";
      const cwd = typeof args.cwd === "string" && args.cwd ? ` (in ${shortPath(args.cwd, 40)})` : "";
      return `run: ${firstLine(cmd) || "(empty command)"}${cwd}`;
    }
    case "read_file": {
      const p = pickArg(args, ["path", "file_path", "filePath"]) ?? "(unknown file)";
      const range =
        args.start_line || args.end_line
          ? ` lines ${args.start_line ?? "?"}–${args.end_line ?? "?"}`
          : "";
      return `read ${shortPath(p)}${range}`;
    }
    case "write_file": {
      const p = pickArg(args, ["path", "file_path", "filePath"]) ?? "(unknown file)";
      const bytes =
        typeof args.content === "string" ? ` (${(args.content.length / 1024).toFixed(1)} KB)` : "";
      return `write ${shortPath(p)}${bytes}`;
    }
    case "list_directory": {
      const p = pickArg(args, ["path", "directory", "dir"]) ?? ".";
      return `list ${shortPath(p)}${args.recursive ? " (recursive)" : ""}`;
    }
    case "web_search": {
      const q = pickArg(args, ["query"]) ?? "";
      return `search web: "${firstLine(q, 70)}"`;
    }
    case "fetch_web_page": {
      const u = pickArg(args, ["url"]) ?? "";
      return `fetch ${shortPath(u, 80)}`;
    }
    case "git_status": {
      const d = pickArg(args, ["repo_dir", "repoDir", "path"]);
      return `git status${d ? ` in ${shortPath(d, 40)}` : ""}`;
    }
    case "git_diff_summary": {
      const d = pickArg(args, ["repo_dir", "repoDir"]);
      return `git diff${args.staged ? " (staged)" : ""}${d ? ` in ${shortPath(d, 40)}` : ""}`;
    }
    case "git_worktree_create": {
      const b = pickArg(args, ["branch_name", "branchName", "branch"]);
      return `git worktree create${b ? ` ${b}` : ""}`;
    }
    case "git_auto_commit": {
      const m = pickArg(args, ["message"]);
      return `git commit${m ? `: "${firstLine(m, 60)}"` : ""}`;
    }
    case "gh_pr_review": {
      const r = pickArg(args, ["pr_reference", "prReference", "ref"]);
      return `PR review${r ? ` ${r}` : ""}`;
    }
    case "create_agent": {
      return `create agent "${pickArg(args, ["name"]) ?? "?"}"`;
    }
    case "list_agents": return "list agents";
    case "delegate_to_agent": {
      const a = pickArg(args, ["agent_id_or_name", "agentIdOrName", "agent_id"]);
      return `delegate to ${a ?? "agent"}`;
    }
    case "create_room": return `create room "${pickArg(args, ["name"]) ?? "?"}"`;
    case "list_rooms": return "list rooms";
    case "run_room_discussion": return "run room discussion";
    case "read_recent_messages": return "read recent messages";
    case "draft_imessage": {
      const r = pickArg(args, ["recipient"]);
      return `draft message to ${r ?? "?"}`;
    }
    case "speak_text": return `speak: "${firstLine(pickArg(args, ["text"]) ?? "", 60)}"`;
    case "create_agent_task": return `create task "${pickArg(args, ["title"]) ?? "?"}"`;
    case "list_agent_tasks": return "list tasks";
    case "update_agent_task": return "update task";
    case "stage_attachment": return `stage ${shortPath(pickArg(args, ["file_path", "filePath"]) ?? "file")}`;
    case "list_attachments": return "list attachments";
    case "vault_store_secret":
    case "vault_store_credential": return `store secret ${pickArg(args, ["name", "title"]) ?? ""}`.trim();
    case "vault_list_secrets": return "list vault secrets";
    case "vault_list_credentials": return "list vault credentials";
    case "add_skill": return `add skill "${pickArg(args, ["name"]) ?? "?"}"`;
    case "list_skills": return "list skills";
    case "mount_skill": return `mount skill ${pickArg(args, ["skill_id_or_name", "skillIdOrName"]) ?? ""}`;
    case "discover_tools": return "discover tools";
    case "recall_memories": {
      const q = pickArg(args, ["query"]);
      return `recall memories${q ? `: "${firstLine(q, 50)}"` : ""}`;
    }
    case "list_windows": return "list windows";
    case "safari_inspect_active_tab": return "inspect active browser tab";
    case "recognize_screen_text": return `OCR ${shortPath(pickArg(args, ["image_path", "imagePath"]) ?? "screen")}`;
    default: {
      const primary = pickArg(args, [
        "path", "file_path", "url", "query", "command", "title", "name", "prompt",
      ]);
      if (primary) return `${name} — ${firstLine(primary, 70)}`;
      const j = compactJson(args, 80);
      return j && j !== "{}" ? `${name} ${j}` : name;
    }
  }
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function outputLines(output: unknown): string[] {
  if (output == null) return [];
  if (typeof output === "string") return output.split(/\r?\n/);
  if (typeof output === "number" || typeof output === "boolean") return [String(output)];
  if (Array.isArray(output)) {
    return output.map((x) => (typeof x === "string" ? x : safeStringify(x)));
  }
  if (typeof output === "object") {
    const o = output as Record<string, any>;
    const lines: string[] = [];
    if (typeof o.stdout === "string" && o.stdout.trim()) lines.push(...o.stdout.split(/\r?\n/));
    if (typeof o.stderr === "string" && o.stderr.trim()) lines.push(`stderr: ${o.stderr.split(/\r?\n/)[0]}`);
    if (typeof o.content === "string" && o.content) lines.push(...o.content.split(/\r?\n/));
    if (Array.isArray(o.entries)) {
      for (const e of o.entries.slice(0, 20)) {
        if (typeof e === "string") lines.push(e);
        else if (e && typeof e === "object" && typeof e.name === "string") lines.push(String(e.name));
      }
    }
    if (lines.length === 0) {
      const s = safeStringify(o);
      if (s && s.trim() && s !== '{}' && s !== '[]' && s !== '{"stdout":""}') lines.push(s);
    }
    return lines;
  }
  return [];
}

function safeStringify(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s ?? String(v);
  } catch {
    return String(v);
  }
}

/** Short one-line summary of a tool result's output (for the ✔ line). */
export function summarizeToolOutput(name: string, output: unknown): string {
  if (output == null) return "";
  if (name === "read_file" && typeof output === "object") {
    const o = output as Record<string, any>;
    const parts: string[] = [];
    if (typeof o.totalLines === "number") parts.push(`${o.totalLines} lines`);
    if (typeof o.bytes === "number") parts.push(`${o.bytes} bytes`);
    return parts.join(", ");
  }
  if (name === "write_file" && typeof output === "object") {
    const o = output as Record<string, any>;
    if (typeof o.bytesWritten === "number") return `${o.bytesWritten} bytes written`;
  }
  if (name === "exec_command" && typeof output === "object") {
    const o = output as Record<string, any>;
    const parts: string[] = [];
    if (typeof o.exitCode === "number") parts.push(`exit ${o.exitCode}`);
    if (typeof o.durationMs === "number") parts.push(formatDuration(o.durationMs));
    const out = typeof o.stdout === "string" ? o.stdout.trim() : "";
    if (out) {
      const n = out.split(/\r?\n/).length;
      parts.push(`${n} output line${n === 1 ? "" : "s"}`);
    }
    return parts.join(", ");
  }
  if (name === "list_directory" && typeof output === "object") {
    const o = output as Record<string, any>;
    if (Array.isArray(o.entries)) return `${o.entries.length} entries`;
  }
  const lines = outputLines(output).filter((l) => l.trim());
  if (lines.length === 0) return "";
  const first = firstLine(lines.join("\n"), 100);
  return lines.length > 1 ? `${first} (+${lines.length - 1} more)` : first;
}

/** Indented preview lines of a tool result (empty = nothing worth showing). */
export function previewToolOutput(
  name: string,
  output: unknown,
  maxLines = 3,
  maxCharsPerLine = 160
): string[] {
  void name;
  const lines = outputLines(output)
    .map((l) => l.replace(/\t/g, "  ").trimEnd())
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const shown = lines.slice(0, maxLines).map((l) =>
    l.length > maxCharsPerLine ? `${l.slice(0, maxCharsPerLine - 1)}…` : l
  );
  if (lines.length > maxLines) shown.push(`… (${lines.length - maxLines} more lines)`);
  return shown;
}

/** Full one-line result summary: `ok (1.2s) — 42 lines` / `error: msg`. */
export function summarizeToolResult(
  name: string,
  result: { status: string; output?: unknown; error?: { message?: string } },
  startedAtMs?: number
): string {
  const dur = startedAtMs != null ? formatDuration(Date.now() - startedAtMs) : "";
  const durPart = dur ? ` (${dur})` : "";
  if (result.status === "ok") {
    const s = summarizeToolOutput(name, result.output);
    return `ok${durPart}${s ? ` — ${s}` : ""}`;
  }
  if (result.status === "permission_pending") return `awaiting approval`;
  return `error${durPart}: ${result.error?.message ?? "unknown error"}`;
}
