import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";
import { ChatMessage } from "./types.js";

export const GENESIS_PREV_HASH = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

export type EventGraphNode = "plan" | "act" | "check" | "review" | "repair" | "user" | string;

export interface SessionEvent<T = any> {
  seq: number;
  ts: string;
  sessionId: string;
  attempt?: number;
  node?: EventGraphNode;
  kind: string;
  data: T;
  prev: string;
}

export class EventChainIntegrityError extends Error {
  public readonly seq?: number;
  public readonly expectedHash?: string;
  public readonly actualHash?: string;

  constructor(message: string, details?: { seq?: number; expectedHash?: string; actualHash?: string }) {
    super(message);
    this.name = "EventChainIntegrityError";
    this.seq = details?.seq;
    this.expectedHash = details?.expectedHash;
    this.actualHash = details?.actualHash;
  }
}

/**
 * Deterministic JSON stringifier with recursively sorted object keys.
 */
export function canonicalJson(obj: unknown): string {
  return JSON.stringify(obj, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  });
}

/**
 * Compute SHA-256 hash of a trimmed string, returning "sha256:<hex>".
 */
export function computeLineHash(line: string): string {
  const hash = crypto.createHash("sha256").update(line.trim()).digest("hex");
  return `sha256:${hash}`;
}

/**
 * Compute SHA-256 hash of a SessionEvent record's canonical line.
 */
export function computeRecordHash(event: SessionEvent): string {
  return computeLineHash(canonicalJson(event));
}

/**
 * Verifies seq continuity (1..N) and SHA-256 prev hash chaining.
 * Throws EventChainIntegrityError on any mismatch.
 */
export function verifyEventLogChain(events: SessionEvent[]): boolean {
  if (events.length === 0) return true;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const expectedSeq = i + 1;
    if (ev.seq !== expectedSeq) {
      throw new EventChainIntegrityError(
        `Broken sequence at index ${i}: expected seq ${expectedSeq}, got ${ev.seq}`,
        { seq: ev.seq }
      );
    }

    const expectedPrev = i === 0 ? GENESIS_PREV_HASH : computeRecordHash(events[i - 1]);
    if (ev.prev !== expectedPrev) {
      throw new EventChainIntegrityError(
        `Broken hash chain at seq ${ev.seq}: expected prev ${expectedPrev}, got ${ev.prev}`,
        { seq: ev.seq, expectedHash: expectedPrev, actualHash: ev.prev }
      );
    }
  }

  return true;
}

export interface ReadEventLogResult {
  events: SessionEvent[];
  discardedTrailingBytes?: number;
  hadTrailingCorruption?: boolean;
}

/**
 * Parses raw JSONL content of an event log.
 * Detects tampering or invalid JSON:
 * - Throws EventChainIntegrityError if any mid-file line is invalid JSON.
 * - Gracefully discards unparseable trailing line at EOF (e.g. from kill -9 mid-write).
 * - Validates cryptographic hash chain.
 */
export function parseEventLogContent(raw: string): ReadEventLogResult {
  if (!raw || raw.trim().length === 0) {
    return { events: [] };
  }

  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  let lastNonEmptyIndex = -1;
  for (let idx = lines.length - 1; idx >= 0; idx--) {
    if (lines[idx].trim().length > 0) {
      lastNonEmptyIndex = idx;
      break;
    }
  }

  if (lastNonEmptyIndex === -1) {
    return { events: [] };
  }

  const events: SessionEvent[] = [];
  let hadTrailingCorruption = false;
  let discardedTrailingBytes = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const isLastNonEmpty = i === lastNonEmptyIndex;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (isLastNonEmpty) {
        hadTrailingCorruption = true;
        discardedTrailingBytes = Buffer.byteLength(line, "utf8");
        break;
      } else {
        throw new EventChainIntegrityError(
          `Corrupt JSON at mid-file line ${i + 1}: ${line.slice(0, 80)}`
        );
      }
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      if (isLastNonEmpty) {
        hadTrailingCorruption = true;
        discardedTrailingBytes = Buffer.byteLength(line, "utf8");
        break;
      } else {
        throw new EventChainIntegrityError(
          `Non-object JSON record at mid-file line ${i + 1}: ${line.slice(0, 80)}`
        );
      }
    }

    const ev = parsed as SessionEvent;
    if (
      typeof ev.seq !== "number" ||
      typeof ev.kind !== "string" ||
      typeof ev.prev !== "string"
    ) {
      if (isLastNonEmpty) {
        hadTrailingCorruption = true;
        discardedTrailingBytes = Buffer.byteLength(line, "utf8");
        break;
      } else {
        throw new EventChainIntegrityError(
          `Invalid event record fields at line ${i + 1}: ${line.slice(0, 80)}`
        );
      }
    }

    events.push(ev);
  }

  verifyEventLogChain(events);

  return {
    events,
    discardedTrailingBytes,
    hadTrailingCorruption,
  };
}

export class EventLogReader {
  private readonly targetPath: string;

  constructor(logPathOrDir: string) {
    this.targetPath = logPathOrDir.endsWith(".jsonl")
      ? logPathOrDir
      : path.join(logPathOrDir, "event-log.jsonl");
  }

  get path(): string {
    return this.targetPath;
  }

  async readAll(): Promise<SessionEvent[]> {
    if (!fsSync.existsSync(this.targetPath)) return [];
    const content = await fs.readFile(this.targetPath, "utf8");
    return parseEventLogContent(content).events;
  }

  readAllSync(): SessionEvent[] {
    if (!fsSync.existsSync(this.targetPath)) return [];
    const content = fsSync.readFileSync(this.targetPath, "utf8");
    return parseEventLogContent(content).events;
  }

  async readWithRecovery(): Promise<ReadEventLogResult> {
    if (!fsSync.existsSync(this.targetPath)) return { events: [] };
    const content = await fs.readFile(this.targetPath, "utf8");
    return parseEventLogContent(content);
  }

  async getHead(): Promise<SessionEvent | null> {
    const events = await this.readAll();
    return events.length > 0 ? events[events.length - 1] : null;
  }

  async verify(): Promise<boolean> {
    const events = await this.readAll();
    return verifyEventLogChain(events);
  }
}

export async function readEventLog(logPathOrDir: string): Promise<SessionEvent[]> {
  const reader = new EventLogReader(logPathOrDir);
  return reader.readAll();
}

export function readEventLogSync(logPathOrDir: string): SessionEvent[] {
  const reader = new EventLogReader(logPathOrDir);
  return reader.readAllSync();
}

export interface AppendEventInput {
  seq?: number;
  ts?: string;
  sessionId?: string;
  attempt?: number;
  node?: EventGraphNode;
  kind: string;
  data?: any;
  prev?: string;
}

export function writeEventLogSync(
  logPathOrDir: string,
  events: AppendEventInput[]
): SessionEvent[] {
  const targetPath = logPathOrDir.endsWith(".jsonl")
    ? logPathOrDir
    : path.join(logPathOrDir, "event-log.jsonl");

  fsSync.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });

  const writtenEvents: SessionEvent[] = [];
  let prevHash = GENESIS_PREV_HASH;
  let seq = 1;

  const lines: string[] = [];

  for (const item of events) {
    const fullEvent: SessionEvent = {
      seq,
      ts: item.ts || new Date().toISOString(),
      sessionId: item.sessionId || path.basename(path.dirname(targetPath)),
      attempt: item.attempt ?? 1,
      node: item.node ?? "act",
      kind: item.kind,
      data: item.data ?? {},
      prev: prevHash,
    };

    const canonical = canonicalJson(fullEvent);
    lines.push(canonical);
    prevHash = computeLineHash(canonical);
    seq++;
    writtenEvents.push(fullEvent);
  }

  fsSync.writeFileSync(targetPath, lines.length > 0 ? lines.join("\n") + "\n" : "", {
    mode: 0o600,
  });

  return writtenEvents;
}

/**
 * Projects ChatMessage[] directly from SessionEvent[].
 */
export function projectMessages(events: SessionEvent[]): ChatMessage[] {
  let messages: ChatMessage[] = [];

  for (const ev of events) {
    const data = ev.data ?? {};

    if (ev.kind === "turn.rollback" || (data.role === "system" && data.event === "rollback")) {
      const remaining = typeof data.remainingMessages === "number" ? data.remainingMessages : undefined;
      if (remaining !== undefined) {
        messages = messages.slice(0, remaining);
      }
      continue;
    }

    if (ev.kind === "turn.compacted" || (data.role === "system" && data.event === "compacted")) {
      const summaryContent = data.content ?? data.compactedSummary;
      if (summaryContent) {
        messages = [
          { role: "system", content: summaryContent },
          ...messages.filter((m) => m.role !== "system"),
        ];
      }
      continue;
    }

    if (ev.kind === "turn.started" || ev.kind === "user.message" || data.role === "user") {
      messages.push({
        role: "user",
        content: data.content ?? null,
      });
      continue;
    }

    if (ev.kind === "model.completion" || ev.kind === "assistant.message" || data.role === "assistant") {
      const msg: ChatMessage = {
        role: "assistant",
        content: data.content ?? null,
      };
      if (data.tool_calls) {
        msg.tool_calls = data.tool_calls;
      }
      messages.push(msg);
      continue;
    }

    if (ev.kind === "tool.completed" || ev.kind === "tool.failed" || data.role === "tool") {
      const content =
        data.content !== undefined && data.content !== null
          ? data.content
          : (typeof data.result === "string"
            ? data.result
            : JSON.stringify(data.result ?? ""));
      messages.push({
        role: "tool",
        tool_call_id: data.tool_call_id ?? data.toolCallId,
        content,
      });
      continue;
    }

    if (ev.kind === "session.system" || data.role === "system") {
      if (data.content) {
        messages.push({
          role: "system",
          content: data.content,
        });
      }
      continue;
    }
  }

  return messages;
}

export class EventLogWriter {
  private readonly targetPath: string;
  private readonly lockPath: string;
  private readonly defaultSessionId: string;
  private writeQueue: Promise<any> = Promise.resolve();

  constructor(logPathOrDir: string, options?: { sessionId?: string }) {
    this.targetPath = logPathOrDir.endsWith(".jsonl")
      ? logPathOrDir
      : path.join(logPathOrDir, "event-log.jsonl");
    this.lockPath = `${this.targetPath}.lock`;
    this.defaultSessionId =
      options?.sessionId ?? path.basename(path.dirname(this.targetPath));
  }

  get path(): string {
    return this.targetPath;
  }

  private async acquireFileLock(): Promise<() => Promise<void>> {
    const lockDir = path.dirname(this.lockPath);
    await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });

    const maxWaitMs = 5000;
    const start = Date.now();

    while (true) {
      try {
        const handle = await fs.open(this.lockPath, "wx");
        const lockPayload = JSON.stringify({
          pid: process.pid,
          time: Date.now(),
          host: os.hostname(),
        });
        await handle.writeFile(lockPayload, "utf8");
        await handle.sync();
        await handle.close();

        return async () => {
          try {
            await fs.unlink(this.lockPath);
          } catch {
            // ignore cleanup errors
          }
        };
      } catch (err: any) {
        if (err.code === "EEXIST") {
          try {
            const raw = await fs.readFile(this.lockPath, "utf8");
            const info = JSON.parse(raw);
            let stale = false;
            if (typeof info?.pid === "number") {
              try {
                process.kill(info.pid, 0);
              } catch (e: any) {
                if (e.code === "ESRCH") {
                  stale = true;
                }
              }
            } else {
              stale = true;
            }

            if (stale || Date.now() - (info?.time ?? 0) > 30000) {
              await fs.unlink(this.lockPath).catch(() => {});
              continue;
            }
          } catch {
            await fs.unlink(this.lockPath).catch(() => {});
            continue;
          }

          if (Date.now() - start > maxWaitMs) {
            throw new Error(`Timeout acquiring lock on ${this.lockPath}`);
          }
          await new Promise((r) => setTimeout(r, 50));
        } else {
          throw err;
        }
      }
    }
  }

  async recoverTrailingCorruption(): Promise<number> {
    if (!fsSync.existsSync(this.targetPath)) return 0;
    const raw = await fs.readFile(this.targetPath, "utf8");
    const res = parseEventLogContent(raw);
    if (res.hadTrailingCorruption && res.discardedTrailingBytes && res.discardedTrailingBytes > 0) {
      const rawBytes = Buffer.from(raw, "utf8");
      const validBytes = rawBytes.length - res.discardedTrailingBytes;
      const fh = await fs.open(this.targetPath, "r+");
      await fh.truncate(validBytes);
      await fh.sync();
      await fh.close();
      return res.discardedTrailingBytes;
    }
    return 0;
  }

  async getHead(): Promise<SessionEvent | null> {
    const reader = new EventLogReader(this.targetPath);
    return reader.getHead();
  }

  async append(input: AppendEventInput): Promise<SessionEvent> {
    const result = await (this.writeQueue = this.writeQueue.then(async () => {
      const release = await this.acquireFileLock();
      try {
        await fs.mkdir(path.dirname(this.targetPath), { recursive: true, mode: 0o700 });

        await this.recoverTrailingCorruption();

        const head = await this.getHead();
        const nextSeq = head ? head.seq + 1 : 1;
        const expectedPrev = head ? computeRecordHash(head) : GENESIS_PREV_HASH;

        if (input.seq !== undefined && input.seq !== nextSeq) {
          throw new EventChainIntegrityError(
            `Cannot append event with seq ${input.seq}: expected ${nextSeq}`,
            { seq: input.seq }
          );
        }

        if (input.prev !== undefined && input.prev !== expectedPrev) {
          throw new EventChainIntegrityError(
            `Cannot append event with prev ${input.prev}: expected ${expectedPrev}`,
            { seq: nextSeq, expectedHash: expectedPrev, actualHash: input.prev }
          );
        }

        const fullEvent: SessionEvent = {
          seq: nextSeq,
          ts: input.ts || new Date().toISOString(),
          sessionId: input.sessionId || this.defaultSessionId,
          attempt: input.attempt ?? 1,
          node: input.node ?? "act",
          kind: input.kind,
          data: input.data ?? {},
          prev: expectedPrev,
        };

        const canonical = canonicalJson(fullEvent) + "\n";
        const fh = await fs.open(this.targetPath, "a+");
        try {
          await fh.appendFile(canonical, "utf8");
          await fh.sync();
        } finally {
          await fh.close();
        }

        return fullEvent;
      } finally {
        await release();
      }
    }));

    return result;
  }
}
