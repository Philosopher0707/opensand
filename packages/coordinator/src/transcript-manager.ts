import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  EventLogWriter,
  EventLogReader,
  parseEventLogContent,
  EventChainIntegrityError,
  SessionEvent,
  AppendEventInput,
} from "@opensand/shared";
import {
  ChatMessage,
  ToolCall,
  SessionRecoveryReport,
  SessionRecoveryWarning,
  SessionMetadata,
} from "./types.js";
import { ToolExecutionResult } from "@opensand/local-exec-daemon";
import {
  projectMessages,
  projectMetadata,
  projectHumanReadable,
  projectTranscriptJsonl,
} from "./event-projections.js";

/**
 * Write to temp file (.tmp) and atomic rename (fs.rename), preventing partial/zero-byte files on interruption.
 */
export async function writeAtomic(targetPath: string, content: string): Promise<void> {
  const targetDir = path.dirname(targetPath);
  await fs.mkdir(targetDir, { recursive: true, mode: 0o700 });
  const tmpPath = `${targetPath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
  await fs.rename(tmpPath, targetPath);
}

/**
 * Enforce tool-turn invariants: ensure every assistant message with tool_calls
 * has matching tool role responses. Prune or stub unfulfilled tool calls to prevent
 * LLM client API validation failure on resume.
 */
export function reconcileTurnInvariants(
  messages: ChatMessage[],
  options?: { strategy?: "stub" | "prune" }
): { messages: ChatMessage[]; warnings: SessionRecoveryWarning[] } {
  const warnings: SessionRecoveryWarning[] = [];
  const result: ChatMessage[] = [];
  const strategy = options?.strategy ?? "stub";

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    result.push(msg);

    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      // Find all immediate tool messages that follow this assistant message
      const toolResponses: ChatMessage[] = [];
      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool") {
        toolResponses.push(messages[j]);
        j++;
      }

      const respondedIds = new Set(toolResponses.map((t) => t.tool_call_id).filter(Boolean));
      const orphanedCalls = msg.tool_calls.filter((tc) => !respondedIds.has(tc.id));

      if (orphanedCalls.length > 0) {
        if (strategy === "prune") {
          const fulfilled = msg.tool_calls.filter((tc) => respondedIds.has(tc.id));
          if (fulfilled.length > 0) {
            msg.tool_calls = fulfilled;
          } else {
            msg.tool_calls = undefined;
            if (!msg.content) {
              msg.content = "[Interrupted tool call]";
            }
          }
          warnings.push({
            type: "orphaned_tool_calls_reconciled",
            rawSnippet: orphanedCalls.map((tc) => `${tc.id}:${tc.function?.name ?? ""}`).join(", "),
            remedy: `Pruned ${orphanedCalls.length} orphaned tool call(s) without matching tool responses`,
          });
        } else {
          // Default: Stub missing tool responses
          const stubMessages: ChatMessage[] = orphanedCalls.map((tc) => ({
            role: "tool",
            tool_call_id: tc.id,
            content: `[Execution interrupted: tool ${tc.function?.name ?? tc.id} did not complete]`,
          }));

          for (const resp of toolResponses) {
            result.push(resp);
          }
          for (const stub of stubMessages) {
            result.push(stub);
          }
          i = j - 1; // Advance outer loop past tool responses

          warnings.push({
            type: "orphaned_tool_calls_reconciled",
            rawSnippet: orphanedCalls.map((tc) => `${tc.id}:${tc.function?.name ?? ""}`).join(", "),
            remedy: `Reconciled ${orphanedCalls.length} orphaned tool call(s) with stubbed tool responses`,
          });
          continue;
        }
      }
    }
  }

  return { messages: result, warnings };
}

export class TranscriptManager {
  private baseDir: string;
  private sessionId: string;
  private sessionDir: string;
  private eventWriter: EventLogWriter;
  private eventReader: EventLogReader;

  constructor(sessionId: string, customBaseDir?: string) {
    this.sessionId = sessionId;
    this.baseDir = customBaseDir ?? path.join(os.homedir(), ".opensand", "sessions");
    this.sessionDir = path.join(this.baseDir, this.sessionId);
    const logPath = path.join(this.sessionDir, "event-log.jsonl");
    this.eventWriter = new EventLogWriter(logPath, { sessionId: this.sessionId });
    this.eventReader = new EventLogReader(logPath);
  }

  get directory(): string {
    return this.sessionDir;
  }

  get writer(): EventLogWriter {
    return this.eventWriter;
  }

  get reader(): EventLogReader {
    return this.eventReader;
  }

  async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
  }

  /**
   * Write to temp file (.tmp) and atomic rename (fs.rename), preventing partial/zero-byte files on interruption.
   */
  async writeAtomic(filename: string, content: string): Promise<void> {
    await this.ensureDirectory();
    const targetPath = path.isAbsolute(filename) ? filename : path.join(this.sessionDir, filename);
    await writeAtomic(targetPath, content);
  }

  /**
   * Append an event directly to event-log.jsonl.
   */
  async appendEvent(event: AppendEventInput): Promise<SessionEvent> {
    await this.ensureDirectory();
    return this.eventWriter.append(event);
  }

  /**
   * Append a structured event object to the hash-chained event log (and transcript.jsonl).
   */
  async appendJsonl(event: Record<string, any>): Promise<void> {
    await this.ensureDirectory();

    let kind = event.kind;
    let node = event.node;
    if (!kind) {
      if (event.role === "user") {
        kind = "turn.started";
        node = "user";
      } else if (event.role === "assistant") {
        kind = "model.completion";
        node = "act";
      } else if (event.role === "tool") {
        kind = "tool.completed";
        node = "act";
      } else if (event.role === "system") {
        if (event.event === "rollback") {
          kind = "turn.rollback";
          node = "repair";
        } else if (event.event === "compacted") {
          kind = "turn.compacted";
          node = "plan";
        } else {
          kind = "session.system";
          node = "plan";
        }
      } else {
        kind = "session.event";
        node = "act";
      }
    }

    await this.eventWriter.append({
      kind,
      node,
      sessionId: this.sessionId,
      data: event,
    });

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
   * Save messages array directly to messages.json in session directory using atomic write.
   */
  async saveMessages(messages: ChatMessage[]): Promise<void> {
    await this.ensureDirectory();
    await this.writeAtomic("messages.json", JSON.stringify(messages, null, 2));

    const currentEvents = await this.eventReader.readAll();
    const projected = projectMessages(currentEvents);
    if (JSON.stringify(projected) !== JSON.stringify(messages)) {
      const logPath = path.join(this.sessionDir, "event-log.jsonl");
      await fs.rm(logPath, { force: true });
      const tempWriter = new EventLogWriter(logPath, { sessionId: this.sessionId });
      for (const msg of messages) {
        if (msg.role === "user") {
          await tempWriter.append({ kind: "turn.started", node: "user", data: msg, sessionId: this.sessionId });
        } else if (msg.role === "assistant") {
          await tempWriter.append({ kind: "model.completion", node: "act", data: msg, sessionId: this.sessionId });
        } else if (msg.role === "tool") {
          await tempWriter.append({ kind: "tool.completed", node: "act", data: msg, sessionId: this.sessionId });
        } else if (msg.role === "system") {
          await tempWriter.append({ kind: "session.system", node: "plan", data: msg, sessionId: this.sessionId });
        }
      }
    }
  }

  /**
   * Save session metadata to metadata.json in session directory using atomic write.
   */
  async saveMetadata(metadata: SessionMetadata): Promise<void> {
    await this.ensureDirectory();
    await this.writeAtomic("metadata.json", JSON.stringify(metadata, null, 2));
  }

  /**
   * Load session metadata: queries event log projection first, falls back to metadata.json.
   */
  async loadMetadata(): Promise<SessionMetadata | undefined> {
    const eventLogPath = path.join(this.sessionDir, "event-log.jsonl");
    if (fsSync.existsSync(eventLogPath)) {
      try {
        const raw = await fs.readFile(eventLogPath, "utf-8");
        const res = parseEventLogContent(raw);
        if (res.events.length > 0) {
          return projectMetadata(res.events);
        }
      } catch {
        // Fall back
      }
    }

    const metaPath = path.join(this.sessionDir, "metadata.json");
    try {
      const raw = await fs.readFile(metaPath, "utf-8");
      return JSON.parse(raw) as SessionMetadata;
    } catch {
      return undefined;
    }
  }

  /**
   * Regenerates projection files (messages.json, metadata.json, transcript.txt, transcript.jsonl)
   * on demand from the hash-chained event log.
   */
  async regenerateProjections(): Promise<void> {
    const events = await this.eventReader.readAll();
    if (events.length === 0) return;

    const messages = projectMessages(events);
    const meta = projectMetadata(events);
    const humanTxt = projectHumanReadable(events);
    const jsonlTxt = projectTranscriptJsonl(events);

    await this.writeAtomic("messages.json", JSON.stringify(messages, null, 2));
    await this.writeAtomic("metadata.json", JSON.stringify(meta, null, 2));
    await this.writeAtomic("transcript.txt", humanTxt);
    if (jsonlTxt) {
      await this.writeAtomic("transcript.jsonl", jsonlTxt);
    }
  }

  /**
   * Load history with full recovery and integrity reporting:
   * - Reads event log as single source of truth when present.
   * - Discards unparseable trailing line if process was killed mid-write.
   * - Validates hash chain integrity and throws EventChainIntegrityError on tampering.
   * - Falls back to legacy messages.json / transcript.jsonl if event-log.jsonl is not present.
   * - Enforces tool-turn invariants (reconcileTurnInvariants).
   */
  async loadHistoryDetailed(options?: {
    ignoreMessagesJson?: boolean;
    strategy?: "stub" | "prune";
  }): Promise<{ messages: ChatMessage[]; report: SessionRecoveryReport }> {
    const report: SessionRecoveryReport = {
      recoveredMessages: 0,
      discardedEntries: 0,
      warnings: [],
    };

    const eventLogPath = path.join(this.sessionDir, "event-log.jsonl");
    if (fsSync.existsSync(eventLogPath)) {
      try {
        const raw = await fs.readFile(eventLogPath, "utf-8");
        const readResult = parseEventLogContent(raw);

        if (readResult.hadTrailingCorruption && readResult.discardedTrailingBytes) {
          report.discardedEntries++;
          report.warnings.push({
            type: "truncated_tail_discarded",
            lineNumber: readResult.events.length + 1,
            rawSnippet: "[trailing uncommitted partial bytes]",
            remedy: "Discarded incomplete trailing line at EOF",
          });
        }

        const messages = projectMessages(readResult.events, { strategy: options?.strategy });
        report.recoveredMessages = messages.length;
        return { messages, report };
      } catch (err: any) {
        if (err instanceof EventChainIntegrityError) {
          throw err;
        }
        // Fall through to legacy if unparseable
      }
    }

    let messages: ChatMessage[] = [];
    let loadedFromMessagesJson = false;

    if (!options?.ignoreMessagesJson) {
      const messagesPath = path.join(this.sessionDir, "messages.json");
      try {
        const raw = await fs.readFile(messagesPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          messages = parsed as ChatMessage[];
          loadedFromMessagesJson = true;
        }
      } catch {
        // Fall through to transcript.jsonl
      }
    }

    if (!loadedFromMessagesJson) {
      const jsonlPath = path.join(this.sessionDir, "transcript.jsonl");
      try {
        const raw = await fs.readFile(jsonlPath, "utf-8");
        const rawLines = raw.split("\n");
        if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
          rawLines.pop();
        }

        let lastNonEmptyIndex = -1;
        for (let idx = rawLines.length - 1; idx >= 0; idx--) {
          if (rawLines[idx].trim().length > 0) {
            lastNonEmptyIndex = idx;
            break;
          }
        }

        for (let i = 0; i < rawLines.length; i++) {
          const line = rawLines[i];
          if (!line.trim()) continue;

          const isLastLine = i === lastNonEmptyIndex;

          try {
            const entry = JSON.parse(line);
            if (!entry || typeof entry !== "object") {
              report.discardedEntries++;
              report.warnings.push({
                type: "corrupt_line_skipped",
                lineNumber: i + 1,
                rawSnippet: line.slice(0, 100),
                remedy: `Skipped non-object entry at line ${i + 1}`,
              });
              continue;
            }

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
            } else {
              report.discardedEntries++;
              report.warnings.push({
                type: "corrupt_line_skipped",
                lineNumber: i + 1,
                rawSnippet: line.slice(0, 100),
                remedy: `Skipped unrecognized entry role at line ${i + 1}`,
              });
            }
          } catch {
            report.discardedEntries++;
            if (isLastLine) {
              report.warnings.push({
                type: "truncated_tail_discarded",
                lineNumber: i + 1,
                rawSnippet: line.slice(0, 100),
                remedy: `Discarded incomplete trailing line at line ${i + 1}`,
              });
            } else {
              report.warnings.push({
                type: "corrupt_line_skipped",
                lineNumber: i + 1,
                rawSnippet: line.slice(0, 100),
                remedy: `Skipped corrupt JSON at line ${i + 1}`,
              });
            }
          }
        }
      } catch {
        // transcript.jsonl absent or unreadable
      }
    }

    // Reconcile tool-turn invariants
    const reconciled = reconcileTurnInvariants(messages, { strategy: options?.strategy });
    messages = reconciled.messages;
    report.warnings.push(...reconciled.warnings);
    report.recoveredMessages = messages.length;

    return { messages, report };
  }

  /**
   * Backwards-compatible wrapper returning messages from loadHistoryDetailed().
   */
  async loadHistory(): Promise<ChatMessage[]> {
    const { messages } = await this.loadHistoryDetailed();
    return messages;
  }

  /**
   * Save formatted transcript.txt and messages.json to disk using atomic writes.
   */
  async writeHumanReadableTranscript(messages: ChatMessage[]): Promise<void> {
    await this.ensureDirectory();
    const formatted = this.formatHumanReadable(messages);
    await this.writeAtomic("transcript.txt", formatted);
    await this.saveMessages(messages);
  }
}

export async function loadSessionMetadata(
  sessionId: string,
  customBaseDir?: string
): Promise<SessionMetadata | undefined> {
  const manager = new TranscriptManager(sessionId, customBaseDir);
  return manager.loadMetadata();
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
 * Pure retention planner: given the session directory listing,
 * decide which directories to remove.
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
      const eventLogPath = path.join(sessionDir, "event-log.jsonl");
      const jsonlPath = path.join(sessionDir, "transcript.jsonl");
      const messagesPath = path.join(sessionDir, "messages.json");

      let mtimeMs: number | undefined;
      let hasTranscript = false;
      let title: string | undefined;
      let turns = 0;

      // Check event-log.jsonl first (event log is single truth)
      if (fsSync.existsSync(eventLogPath)) {
        try {
          const logStat = await fs.stat(eventLogPath);
          mtimeMs = logStat.mtimeMs;
          hasTranscript = true;

          const raw = await fs.readFile(eventLogPath, "utf-8");
          const parseResult = parseEventLogContent(raw);
          const meta = projectMetadata(parseResult.events);
          title = meta.title;
          turns = meta.turnCount ?? 0;
        } catch {
          // fall through
        }
      }

      if (!hasTranscript) {
        try {
          const jsonlStat = await fs.stat(jsonlPath);
          mtimeMs = jsonlStat.mtimeMs;
          hasTranscript = true;
        } catch {
          // transcript.jsonl not present
        }

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
        } catch {
          // Corrupt/unreadable messages.json
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
