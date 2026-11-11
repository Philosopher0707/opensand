import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  ChatMessage,
  ToolCall,
  SessionRecoveryReport,
  SessionRecoveryWarning,
  SessionMetadata,
} from "./types.js";
import { ToolExecutionResult } from "@opensand/local-exec-daemon";
import {
  EventChainIntegrityError,
  EventLogReader,
  EventLogWriter,
  SessionEvent,
} from "@opensand/shared";
import {
  EVENT,
  formatHumanReadable,
  projectMessages,
  projectTranscriptJsonl,
  projectTranscriptText,
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
  private eventLog?: EventLogWriter;

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
   * Write to temp file (.tmp) and atomic rename (fs.rename), preventing partial/zero-byte files on interruption.
   */
  async writeAtomic(filename: string, content: string): Promise<void> {
    await this.ensureDirectory();
    const targetPath = path.isAbsolute(filename) ? filename : path.join(this.sessionDir, filename);
    await writeAtomic(targetPath, content);
  }

  private get log(): EventLogWriter {
    this.eventLog ??= new EventLogWriter(this.sessionDir, { sessionId: this.sessionId });
    return this.eventLog;
  }

  private async readEvents(): Promise<SessionEvent[]> {
    return (await new EventLogReader(this.sessionDir).readWithRecovery()).events;
  }

  /**
   * Append one session event to event-log.jsonl, the sole persistent record of the session.
   */
  async recordEvent(kind: string, data: Record<string, unknown>): Promise<SessionEvent> {
    return this.log.append({ kind, data });
  }

  /**
   * Record how a fresh or migrated session starts. A session with no log gets its
   * current messages as a snapshot; a resumed one records only a changed system prompt.
   */
  async recordBaseline(messages: ChatMessage[], meta: { model: string }): Promise<void> {
    const events = await this.readEvents();
    if (events.length === 0) {
      await this.log.appendBatch([
        { kind: EVENT.sessionCreated, data: { model: meta.model } },
        { kind: EVENT.snapshot, data: { messages } },
      ]);
      return;
    }

    const projected = projectMessages(events);
    if (projected[0]?.role !== "system" || projected[0].content !== messages[0]?.content) {
      await this.recordEvent(EVENT.system, { content: messages[0]?.content ?? "" });
    }
  }

  /**
   * Format message history into human-readable Grok Bot transcript parity format.
   */
  formatHumanReadable(messages: ChatMessage[]): string {
    return formatHumanReadable(messages);
  }

  /**
   * Save session metadata to metadata.json in session directory using atomic write.
   */
  async saveMetadata(metadata: SessionMetadata): Promise<void> {
    await this.ensureDirectory();
    await this.writeAtomic("metadata.json", JSON.stringify(metadata, null, 2));
  }

  /**
   * Load session metadata from metadata.json in session directory.
   */
  async loadMetadata(): Promise<SessionMetadata | undefined> {
    const metaPath = path.join(this.sessionDir, "metadata.json");
    try {
      const raw = await fs.readFile(metaPath, "utf-8");
      return JSON.parse(raw) as SessionMetadata;
    } catch {
      return undefined;
    }
  }

  private async loadFromEventLog(report: SessionRecoveryReport): Promise<ChatMessage[] | null> {
    try {
      const { events, discardedTrailingBytes } = await new EventLogReader(this.sessionDir).readWithRecovery();
      if (discardedTrailingBytes > 0) {
        report.discardedEntries++;
        report.warnings.push({
          type: "truncated_tail_discarded",
          lineNumber: events.length + 1,
          remedy: `Discarded ${discardedTrailingBytes} bytes of an unfinished event at the end of the event log`,
        });
      }
      return events.length > 0 ? projectMessages(events) : null;
    } catch (err) {
      if (!(err instanceof EventChainIntegrityError)) throw err;
      report.warnings.push({
        type: "corrupt_line_skipped",
        lineNumber: err.seq,
        remedy: `Event log failed verification (${err.message}); loaded legacy files instead`,
      });
      return null;
    }
  }

  /**
   * Load history with full recovery and integrity reporting:
   * - Discard unparseable trailing line if process was killed mid-write.
   * - Skip corrupt mid-file lines and record line-indexed warnings.
   * - Enforce tool-turn invariants (reconcileTurnInvariants).
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

    let messages: ChatMessage[] = [];
    let loaded = false;

    const fromLog = await this.loadFromEventLog(report);
    if (fromLog) {
      messages = fromLog;
      loaded = true;
    }

    if (!loaded && !options?.ignoreMessagesJson) {
      const messagesPath = path.join(this.sessionDir, "messages.json");
      try {
        const raw = await fs.readFile(messagesPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          messages = parsed as ChatMessage[];
          loaded = true;
        }
      } catch {
        // Fall through to transcript.jsonl
      }
    }

    if (!loaded) {
      const jsonlPath = path.join(this.sessionDir, "transcript.jsonl");
      try {
        const raw = await fs.readFile(jsonlPath, "utf-8");
        const rawLines = raw.split("\n");
        // Pop trailing empty line produced by final \n
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
   * Regenerate messages.json, transcript.txt and transcript.jsonl from event-log.jsonl.
   */
  async writeProjections(): Promise<void> {
    await this.ensureDirectory();
    const events = await this.readEvents();
    await this.writeAtomic("messages.json", JSON.stringify(projectMessages(events), null, 2));
    await this.writeAtomic("transcript.txt", projectTranscriptText(events));
    await this.writeAtomic("transcript.jsonl", projectTranscriptJsonl(events));
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
      } catch {
        // Corrupt/unreadable messages.json: loadHistory falls back to transcript.jsonl,
        // so keep listing the session (with no title) instead of hiding it.
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
