import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
  GENESIS_PREV_HASH,
  SessionEvent,
  AppendEventInput,
  EventChainVerificationResult,
  EventChainIntegrityError,
  EventLogHeader,
} from "./event-log-types.js";
import { EventLogLock, EventLogLockOptions } from "./event-log-lock.js";

export * from "./event-log-types.js";
export * from "./event-log-lock.js";

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

export function computeLineHash(line: string): string {
  return `sha256:${crypto.createHash("sha256").update(line, "utf8").digest("hex")}`;
}

interface LogEntry {
  event: SessionEvent;
  line: string;
}

export interface ParsedEventLog {
  entries: LogEntry[];
  trailingFragmentBytes: number;
  chain: EventChainVerificationResult;
}

function parseRecord(line: string, lineNumber: number): SessionEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new EventChainIntegrityError(`Corrupt JSON at line ${lineNumber}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EventChainIntegrityError(`Non-object record at line ${lineNumber}`);
  }
  const event = parsed as SessionEvent;
  if (typeof event.seq !== "number" || typeof event.kind !== "string" || typeof event.prev !== "string") {
    throw new EventChainIntegrityError(`Invalid event record fields at line ${lineNumber}`);
  }
  return event;
}

function verifyEventLogChain(entries: LogEntry[]): EventChainVerificationResult {
  let expectedPrev = GENESIS_PREV_HASH;
  entries.forEach(({ event, line }, index) => {
    const expectedSeq = index + 1;
    if (event.seq !== expectedSeq) {
      throw new EventChainIntegrityError(
        `Broken sequence: expected record ${expectedSeq}, found seq ${event.seq}`,
        { seq: event.seq, parentSeq: event.seq - 1 }
      );
    }
    if (event.prev !== expectedPrev) {
      const message =
        index === 0
          ? `Broken hash chain at record 1: prev is not the genesis hash`
          : `Broken hash chain at record ${event.seq}: its prev does not match the hash of record ${event.seq - 1}`;
      throw new EventChainIntegrityError(message, {
        seq: event.seq,
        parentSeq: event.seq - 1,
        expectedHash: expectedPrev,
        actualHash: event.prev,
      });
    }
    expectedPrev = computeLineHash(line);
  });
  return {
    valid: true,
    totalEvents: entries.length,
    headHash: entries.length > 0 ? expectedPrev : undefined,
  };
}

export function parseEventLogContent(raw: string): ParsedEventLog {
  const lastNewline = raw.lastIndexOf("\n");
  const committed = raw.slice(0, lastNewline + 1);
  const trailingFragmentBytes = Buffer.byteLength(raw.slice(lastNewline + 1), "utf8");

  const lines = committed.split("\n");
  lines.pop();

  const entries = lines.map((line, index) => ({
    event: parseRecord(line, index + 1),
    line,
  }));
  return { entries, trailingFragmentBytes, chain: verifyEventLogChain(entries) };
}

export function resolveEventLogPath(logPathOrDir: string): string {
  return logPathOrDir.endsWith(".jsonl") ? logPathOrDir : path.join(logPathOrDir, "event-log.jsonl");
}

async function readRaw(logPath: string): Promise<string> {
  try {
    return await fs.readFile(logPath, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

export class EventLogReader {
  private readonly targetPath: string;

  constructor(logPathOrDir: string) {
    this.targetPath = resolveEventLogPath(logPathOrDir);
  }

  get path(): string {
    return this.targetPath;
  }

  async readWithRecovery(): Promise<{ events: SessionEvent[]; discardedTrailingBytes: number }> {
    const parsed = parseEventLogContent(await readRaw(this.targetPath));
    return {
      events: parsed.entries.map((entry) => entry.event),
      discardedTrailingBytes: parsed.trailingFragmentBytes,
    };
  }

  async readAll(): Promise<SessionEvent[]> {
    return (await this.readWithRecovery()).events;
  }

  async verifyChain(): Promise<EventChainVerificationResult> {
    return parseEventLogContent(await readRaw(this.targetPath)).chain;
  }

  async getHeader(): Promise<EventLogHeader | null> {
    const parsed = parseEventLogContent(await readRaw(this.targetPath));
    if (parsed.entries.length === 0) return null;
    const first = parsed.entries[0].event;
    const last = parsed.entries[parsed.entries.length - 1].event;
    return {
      sessionId: first.sessionId,
      firstSeq: first.seq,
      lastSeq: last.seq,
      totalEvents: parsed.entries.length,
      headHash: parsed.chain.headHash as string,
    };
  }
}

export class EventLogWriter {
  private readonly targetPath: string;
  private readonly dir: string;
  private readonly defaultSessionId: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(logPathOrDir: string, options?: { sessionId?: string }) {
    this.targetPath = resolveEventLogPath(logPathOrDir);
    this.dir = path.dirname(this.targetPath);
    this.defaultSessionId = options?.sessionId ?? path.basename(this.dir);
  }

  get path(): string {
    return this.targetPath;
  }

  async append(input: AppendEventInput, lockOptions?: EventLogLockOptions): Promise<SessionEvent> {
    const [event] = await this.appendBatch([input], lockOptions);
    return event;
  }

  async appendBatch(inputs: AppendEventInput[], lockOptions?: EventLogLockOptions): Promise<SessionEvent[]> {
    if (inputs.length === 0) return [];
    const run = this.writeQueue.then(() => this.appendUnderLock(inputs, lockOptions));
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private async appendUnderLock(
    inputs: AppendEventInput[],
    lockOptions?: EventLogLockOptions
  ): Promise<SessionEvent[]> {
    const lock = await EventLogLock.acquire(this.dir, lockOptions);
    try {
      const raw = await readRaw(this.targetPath);
      const { entries, trailingFragmentBytes } = parseEventLogContent(raw);
      if (trailingFragmentBytes > 0) {
        await this.truncateTo(Buffer.byteLength(raw, "utf8") - trailingFragmentBytes);
      }

      let seq = entries.length;
      let prev = entries.length > 0 ? computeLineHash(entries[entries.length - 1].line) : GENESIS_PREV_HASH;
      const appended: SessionEvent[] = [];
      let payload = "";

      for (const input of inputs) {
        const nextSeq = seq + 1;
        if (input.seq !== undefined && input.seq !== nextSeq) {
          throw new EventChainIntegrityError(
            `Cannot append event with seq ${input.seq}: expected ${nextSeq}`,
            { seq: input.seq }
          );
        }
        if (input.prev !== undefined && input.prev !== prev) {
          throw new EventChainIntegrityError(
            `Cannot append event with prev ${input.prev}: expected ${prev}`,
            { seq: nextSeq, expectedHash: prev, actualHash: input.prev }
          );
        }

        const event: SessionEvent = {
          seq: nextSeq,
          ts: input.ts ?? new Date().toISOString(),
          sessionId: input.sessionId ?? this.defaultSessionId,
          attempt: input.attempt ?? 1,
          node: input.node ?? "act",
          kind: input.kind,
          data: input.data ?? {},
          prev,
        };
        const line = canonicalJson(event);
        payload += `${line}\n`;
        appended.push(event);
        seq = nextSeq;
        prev = computeLineHash(line);
      }

      const existed = await fs.stat(this.targetPath).then(() => true, () => false);
      const fh = await fs.open(this.targetPath, "a");
      try {
        await fh.appendFile(payload, "utf8");
        await fh.sync();
      } finally {
        await fh.close();
      }
      if (!existed) {
        const dh = await fs.open(this.dir, "r");
        try {
          await dh.sync();
        } finally {
          await dh.close();
        }
      }
      return appended;
    } finally {
      await lock.release();
    }
  }

  private async truncateTo(bytes: number): Promise<void> {
    const fh = await fs.open(this.targetPath, "r+");
    try {
      await fh.truncate(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
  }
}
