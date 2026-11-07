import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ChatMessage, ToolCall } from "./types.js";
import { ToolExecutionResult } from "@opensand/local-exec-daemon";

export class TranscriptManager {
  private baseDir: string;
  private sessionId: string;
  private sessionDir: string;

  constructor(sessionId: string, customBaseDir?: string) {
    this.sessionId = sessionId;
    this.baseDir = customBaseDir ?? path.join(os.homedir(), ".opensand", "sessions");
    this.sessionDir = path.join(this.baseDir, this.sessionId);
  }

  get directory(): string {
    return this.sessionDir;
  }

  async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
  }

  /**
   * Append a structured event object to transcript.jsonl.
   */
  async appendJsonl(event: Record<string, any>): Promise<void> {
    await this.ensureDirectory();
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      ...event,
    }) + "\n";

    await fs.appendFile(path.join(this.sessionDir, "transcript.jsonl"), entry, { encoding: "utf-8", mode: 0o600 });
  }

  /**
   * Format message history into human-readable Grok Bot transcript parity format.
   */
  formatHumanReadable(messages: ChatMessage[]): string {
    const sections: string[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        continue;
      }

      if (msg.role === "user") {
        sections.push(`<user_query>\n${msg.content ?? ""}\n</user_query>`);
        continue;
      }

      if (msg.role === "assistant") {
        if (msg.content) {
          sections.push(`assistant:\n${msg.content}`);
        }
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            sections.push(`[Tool call]\nTool: ${tc.function.name}\nArguments: ${tc.function.arguments}`);
          }
        }
        continue;
      }

      if (msg.role === "tool") {
        sections.push(`[Tool result]\n${msg.content ?? ""}`);
        continue;
      }
    }

    return sections.join("\n\n") + "\n";
  }

  /**
   * Save messages array directly to messages.json in session directory
   */
  async saveMessages(messages: ChatMessage[]): Promise<void> {
    await this.ensureDirectory();
    await fs.writeFile(
      path.join(this.sessionDir, "messages.json"),
      JSON.stringify(messages, null, 2),
      { encoding: "utf-8", mode: 0o600 }
    );
  }

  /**
   * Load messages from disk (preferring messages.json, falling back to transcript.jsonl).
   */
  async loadHistory(): Promise<ChatMessage[]> {
    const messagesPath = path.join(this.sessionDir, "messages.json");
    try {
      const raw = await fs.readFile(messagesPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed as ChatMessage[];
      }
    } catch {
      // Fall through to transcript.jsonl
    }

    const jsonlPath = path.join(this.sessionDir, "transcript.jsonl");
    try {
      const raw = await fs.readFile(jsonlPath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      let messages: ChatMessage[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.role === "system") {
            if (entry.event === "rollback" && typeof entry.remainingMessages === "number") {
              messages = messages.slice(0, entry.remainingMessages);
            } else if (entry.event === "compacted" && entry.content) {
              messages = [
                { role: "system", content: entry.content },
                ...messages.filter((m) => m.role !== "system"),
              ];
            } else if (entry.content) {
              messages.push({ role: "system", content: entry.content });
            }
          } else if (entry.role === "user") {
            messages.push({
              role: "user",
              content: entry.content ?? null,
            });
          } else if (entry.role === "assistant") {
            messages.push({
              role: "assistant",
              content: entry.content ?? null,
              tool_calls: entry.tool_calls,
            });
          } else if (entry.role === "tool") {
            const content =
              entry.content ??
              (typeof entry.result === "string"
                ? entry.result
                : JSON.stringify(entry.result ?? ""));
            messages.push({
              role: "tool",
              tool_call_id: entry.tool_call_id,
              content,
            });
          }
        } catch {
          // Ignore invalid line
        }
      }
      return messages;
    } catch {
      return [];
    }
  }

  /**
   * Save formatted transcript.txt and messages.json to disk.
   */
  async writeHumanReadableTranscript(messages: ChatMessage[]): Promise<void> {
    await this.ensureDirectory();
    const formatted = this.formatHumanReadable(messages);
    await fs.writeFile(path.join(this.sessionDir, "transcript.txt"), formatted, { encoding: "utf-8", mode: 0o600 });
    await this.saveMessages(messages);
  }
}

export interface SessionSummary {
  sessionId: string;
  mtimeMs: number;
  title?: string;
  turns: number;
}

export interface RetentionPolicy {
  /** Keep the N most recent sessions (by mtime). Default 30. */
  maxSessions?: number;
  /** Remove sessions untouched for longer than this. Default 90 days. */
  maxAgeDays?: number;
  /** Keep sessions modified within this window regardless of count. Default 7 days. */
  keepRecentDays?: number;
}

export interface RetentionCandidate {
  sessionId: string;
  dir: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface RetentionResult {
  removed: RetentionCandidate[];
  kept: RetentionCandidate[];
  totalSizeBytes: number;
}

/**
 * Totally pure retention planner: given the session directory listing,
 * decide which directories to remove. Kept separate from I/O so it is
 * fully unit-testable without touching the filesystem.
 */
export function planRetention(
  candidates: RetentionCandidate[],
  policy: RetentionPolicy = {},
  nowMs: number = Date.now()
): { removed: RetentionCandidate[]; kept: RetentionCandidate[] } {
  const maxSessions = policy.maxSessions ?? 30;
  const maxAgeDays = policy.maxAgeDays ?? 90;
  const keepRecentDays = policy.keepRecentDays ?? 7;

  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const keepRecentMs = keepRecentDays * 24 * 60 * 60 * 1000;

  // Most recent first
  const sorted = [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs);

  const removed: RetentionCandidate[] = [];
  const kept: RetentionCandidate[] = [];

  sorted.forEach((c, idx) => {
    const tooOld = nowMs - c.mtimeMs > maxAgeMs;
    const tooMany = idx >= maxSessions;
    const withinKeepWindow = nowMs - c.mtimeMs <= keepRecentMs;

    if ((tooOld || tooMany) && !withinKeepWindow) {
      removed.push(c);
    } else {
      kept.push(c);
    }
  });

  return { removed, kept };
}

/** Scan the sessions directory and evaluate the retention policy. */
export async function evaluateRetention(
  sessionsBaseDir?: string,
  policy: RetentionPolicy = {},
  nowMs: number = Date.now()
): Promise<RetentionResult> {
  const baseDir = sessionsBaseDir ?? path.join(os.homedir(), ".opensand", "sessions");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(baseDir);
  } catch {
    return { removed: [], kept: [], totalSizeBytes: 0 };
  }

  const candidates: RetentionCandidate[] = [];
  for (const name of entries) {
    const dir = path.join(baseDir, name);
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) continue;
      candidates.push({ sessionId: name, dir, mtimeMs: stat.mtimeMs, sizeBytes: stat.size });
    } catch {
      // Ignore unreadable entries
    }
  }

  const { removed, kept } = planRetention(candidates, policy, nowMs);
  const totalSizeBytes = candidates.reduce((sum, c) => sum + c.sizeBytes, 0);
  return { removed, kept, totalSizeBytes };
}

export async function listSessions(sessionsBaseDir?: string): Promise<SessionSummary[]> {
  const baseDir = sessionsBaseDir ?? path.join(os.homedir(), ".opensand", "sessions");
  let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions: SessionSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const sessionDir = path.join(baseDir, entry.name);
      const jsonlPath = path.join(sessionDir, "transcript.jsonl");
      const messagesPath = path.join(sessionDir, "messages.json");

      let mtimeMs: number | undefined;
      let hasTranscript = false;

      try {
        const jsonlStat = await fs.stat(jsonlPath);
        mtimeMs = jsonlStat.mtimeMs;
        hasTranscript = true;
      } catch {
        // transcript.jsonl not present
      }

      let title: string | undefined;
      let turns = 0;

      try {
        const raw = await fs.readFile(messagesPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          hasTranscript = true;
          for (const msg of parsed) {
            if (msg && msg.role === "user") {
              turns++;
              if (title === undefined && typeof msg.content === "string") {
                title = msg.content.slice(0, 80);
              }
            }
          }
        }
      } catch (err: any) {
        if (err?.code !== "ENOENT") {
          // unreadable or corrupt messages.json
          continue;
        }
      }

      if (!hasTranscript) {
        continue;
      }

      if (mtimeMs === undefined) {
        const dirStat = await fs.stat(sessionDir);
        mtimeMs = dirStat.mtimeMs;
      }

      sessions.push({
        sessionId: entry.name,
        mtimeMs,
        title,
        turns,
      });
    } catch {
      continue;
    }
  }

  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sessions;
}


/**
 * Prune old sessions per policy. Returns what was removed.
 * Never removes a session modified within keepRecentDays (default 7).
 */
export async function pruneSessions(
  sessionsBaseDir?: string,
  policy: RetentionPolicy = {},
  nowMs: number = Date.now()
): Promise<RetentionResult> {
  const result = await evaluateRetention(sessionsBaseDir, policy, nowMs);
  for (const c of result.removed) {
    await fs.rm(c.dir, { recursive: true, force: true });
  }
  return result;
}
