import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  EventLogWriter,
  EventLogReader,
  EventLogLock,
  EventLogLockTimeoutError,
  EventChainIntegrityError,
  GENESIS_PREV_HASH,
  canonicalJson,
} from "../src/event-log.js";

function tempDir(): string {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), "opensand-event-log-"));
}

test("clean append of 100 sequential events passes verifyChain", async () => {
  const dir = tempDir();
  try {
    const logPath = path.join(dir, "event-log.jsonl");
    const writer = new EventLogWriter(logPath, { sessionId: "sess-100" });

    const created = [];
    for (let i = 1; i <= 100; i++) {
      created.push(await writer.append({ kind: `event.${i}`, data: { step: i } }));
    }

    assert.equal(created[0].seq, 1);
    assert.equal(created[0].prev, GENESIS_PREV_HASH);
    assert.equal(created[99].seq, 100);

    const reader = new EventLogReader(logPath);
    assert.deepEqual(await reader.readAll(), created);

    const verification = await reader.verifyChain();
    assert.equal(verification.valid, true);
    assert.equal(verification.totalEvents, 100);

    const header = await reader.getHeader();
    assert.equal(header?.firstSeq, 1);
    assert.equal(header?.lastSeq, 100);
    assert.equal(header?.totalEvents, 100);
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

test("flipping one byte in record 5 of 10 fails verifyChain citing records 5 and 6", async () => {
  const dir = tempDir();
  try {
    const logPath = path.join(dir, "event-log.jsonl");
    const writer = new EventLogWriter(logPath, { sessionId: "sess-tamper" });
    for (let i = 1; i <= 10; i++) {
      await writer.append({ kind: `event.${i}`, data: { step: i, status: "original" } });
    }

    const reader = new EventLogReader(logPath);
    assert.equal((await reader.verifyChain()).valid, true);

    const lines = (await fs.readFile(logPath, "utf8")).split("\n");
    lines[4] = lines[4].replace(`"original"`, `"corrupted"`);
    await fs.writeFile(logPath, lines.join("\n"), "utf8");

    await assert.rejects(
      () => reader.verifyChain(),
      (err: any) => {
        assert.ok(err instanceof EventChainIntegrityError);
        assert.equal(err.seq, 6);
        assert.equal(err.parentSeq, 5);
        assert.match(err.message, /record 6/);
        assert.match(err.message, /record 5/);
        return true;
      }
    );
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

test("SIGKILL mid-append loses no acknowledged event and repeats none", async () => {
  const dir = tempDir();
  const logPath = path.join(dir, "event-log.jsonl");
  const moduleUrl = new URL("../src/event-log.js", import.meta.url).href;
  const childScript = `
    import { EventLogWriter } from ${JSON.stringify(moduleUrl)};
    const writer = new EventLogWriter(process.env.EVENT_LOG_PATH, { sessionId: "sess-sigkill" });
    for (let i = 1; ; i++) {
      const ev = await writer.append({ kind: "event.append", data: { index: i } });
      process.stdout.write("ACK " + ev.seq + "\\n");
    }
  `;

  const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
    env: { ...process.env, EVENT_LOG_PATH: logPath },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const acked: number[] = [];
  let buffered = "";
  let onFirstAck: () => void = () => {};
  const firstAck = new Promise<void>((resolve) => (onFirstAck = resolve));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      const match = /^ACK (\d+)$/.exec(line);
      if (match) {
        acked.push(Number(match[1]));
        onFirstAck();
      }
    }
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));

  try {
    await Promise.race([
      firstAck,
      closed.then(() => {
        throw new Error("child exited before acknowledging any append");
      }),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 41)));
    child.kill("SIGKILL");
    await closed;

    const lastAcked = acked[acked.length - 1];
    const reader = new EventLogReader(logPath);
    const events = await reader.readAll();

    assert.ok(events.length >= lastAcked, `lost acknowledged events: acked ${lastAcked}, recovered ${events.length}`);
    events.forEach((ev, i) => {
      assert.equal(ev.seq, i + 1, `sequence gap or repeat at index ${i}`);
      assert.equal(ev.data.index, i + 1, `event data repeated or lost at index ${i}`);
    });

    const verification = await reader.verifyChain();
    assert.equal(verification.valid, true);
    assert.equal(verification.totalEvents, events.length);

    const next = await new EventLogWriter(logPath, { sessionId: "sess-sigkill" }).append({
      kind: "event.post_recovery",
      data: { postRecovery: true },
    });
    assert.equal(next.seq, events.length + 1);
    assert.equal(next.prev, verification.headHash);
    assert.equal((await reader.verifyChain()).totalEvents, events.length + 1);
  } finally {
    child.kill("SIGKILL");
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

test("unterminated trailing fragment is discarded and the next append continues the chain", async () => {
  const dir = tempDir();
  try {
    const logPath = path.join(dir, "event-log.jsonl");
    const writer = new EventLogWriter(logPath, { sessionId: "sess-crash" });
    const committed = [];
    for (let i = 1; i <= 3; i++) {
      committed.push(await writer.append({ kind: `turn.${i}`, data: { messageIndex: i } }));
    }

    await fs.appendFile(logPath, `{"seq":4,"ts":"2026-11-11T18:30:00.000Z","kind":"tool.co`, "utf8");

    const reader = new EventLogReader(logPath);
    const recovered = await reader.readWithRecovery();
    assert.deepEqual(recovered.events, committed);
    assert.ok(recovered.discardedTrailingBytes > 0);

    const headBefore = (await reader.verifyChain()).headHash;
    const ev4 = await writer.append({ kind: "tool.completed", data: { exit: 0 } });
    assert.equal(ev4.seq, 4);
    assert.equal(ev4.prev, headBefore);
    assert.equal((await reader.readAll()).length, 4);
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

test("two writers in one process interleave without a seq gap or a fork", async () => {
  const dir = tempDir();
  try {
    const logPath = path.join(dir, "event-log.jsonl");
    const a = new EventLogWriter(logPath, { sessionId: "a" });
    const b = new EventLogWriter(logPath, { sessionId: "b" });
    const jobs = [];
    for (let i = 0; i < 25; i++) {
      jobs.push(a.append({ kind: "a.step", data: { i } }));
      jobs.push(b.append({ kind: "b.step", data: { i } }));
    }
    await Promise.all(jobs);

    const reader = new EventLogReader(logPath);
    const events = await reader.readAll();
    assert.equal(events.length, 50);
    assert.equal((await reader.verifyChain()).valid, true);
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

test("a rejected append does not block later appends", async () => {
  const dir = tempDir();
  try {
    const writer = new EventLogWriter(path.join(dir, "event-log.jsonl"));
    await assert.rejects(
      () => writer.append({ kind: "bad", prev: "sha256:deadbeef" }),
      EventChainIntegrityError
    );
    const ev = await writer.append({ kind: "good" });
    assert.equal(ev.seq, 1);
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

test("lock from a dead pid on this host is reclaimed; a live owner blocks acquisition", async () => {
  const dir = tempDir();
  try {
    const lockPath = path.join(dir, "event-log.lock");
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: 99999999, startedAt: Date.now() - 5000, hostname: os.hostname() }),
      "utf8"
    );
    const reclaimed = await EventLogLock.acquire(dir, { timeoutMs: 1000 });
    await reclaimed.release();
    assert.equal(fsSync.existsSync(lockPath), false);

    const held = await EventLogLock.acquire(dir, { timeoutMs: 1000 });
    await assert.rejects(
      () => EventLogLock.acquire(dir, { timeoutMs: 200, pollIntervalMs: 10 }),
      EventLogLockTimeoutError
    );
    await held.release();
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

test("canonicalJson sorts object keys recursively", () => {
  assert.equal(
    canonicalJson({ b: 2, a: 1, c: { y: 20, x: 10 } }),
    `{"a":1,"b":2,"c":{"x":10,"y":20}}`
  );
});

test("append benchmark: 5k appends proves O(1) tail read with last 100 mean < 3x first 100 mean", { timeout: 60_000 }, async () => {
  const dir = tempDir();
  try {
    const logPath = path.join(dir, "event-log.jsonl");
    const writer = new EventLogWriter(logPath, { sessionId: "sess-bench" });

    const firstDurations: number[] = [];
    const lastDurations: number[] = [];

    const total = 5000;
    for (let i = 1; i <= total; i++) {
      const start = performance.now();
      await writer.append({ kind: "bench.event", data: { i } });
      const duration = performance.now() - start;

      if (i <= 100) {
        firstDurations.push(duration);
      } else if (i > total - 100) {
        lastDurations.push(duration);
      }
    }

    const meanFirst = firstDurations.reduce((a, b) => a + b, 0) / firstDurations.length;
    const meanLast = lastDurations.reduce((a, b) => a + b, 0) / lastDurations.length;

    assert.ok(
      meanLast < 3 * meanFirst,
      `expected last 100 mean (${meanLast.toFixed(3)}ms) to be < 3x first 100 mean (${meanFirst.toFixed(3)}ms)`
    );

    const reader = new EventLogReader(logPath);
    const verification = await reader.verifyChain();
    assert.equal(verification.valid, true);
    assert.equal(verification.totalEvents, total);
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

test("a torn tail longer than 64 KiB (one huge unterminated line) is still truncated and chain continues", async () => {
  const dir = tempDir();
  try {
    const logPath = path.join(dir, "event-log.jsonl");
    const writer = new EventLogWriter(logPath, { sessionId: "sess-huge-tail" });
    const committed = [];
    for (let i = 1; i <= 3; i++) {
      committed.push(await writer.append({ kind: `event.${i}`, data: { step: i } }));
    }

    const reader = new EventLogReader(logPath);
    const headBefore = (await reader.verifyChain()).headHash;

    // Append a huge unterminated fragment > 64 KiB (75 KiB) with NO trailing newline
    const hugeTornFragment = `{"seq":4,"ts":"2026-11-12T00:00:00.000Z","kind":"huge.torn","data":"${"x".repeat(75 * 1024)}`;
    await fs.appendFile(logPath, hugeTornFragment, "utf8");

    // EventLogReader with recovery should discard the trailing bytes
    const recovered = await reader.readWithRecovery();
    assert.deepEqual(recovered.events, committed);
    assert.ok(recovered.discardedTrailingBytes > 64 * 1024);

    // EventLogWriter.append should seek from end, double chunk size past 64 KiB to find event 3,
    // truncate the torn tail, and continue the chain
    const ev4 = await writer.append({ kind: "event.recovered", data: { step: 4 } });
    assert.equal(ev4.seq, 4);
    assert.equal(ev4.prev, headBefore);

    const allEvents = await reader.readAll();
    assert.equal(allEvents.length, 4);
    assert.equal(allEvents[3].kind, "event.recovered");

    const verification = await reader.verifyChain();
    assert.equal(verification.valid, true);
    assert.equal(verification.totalEvents, 4);
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

test("two processes appending alternately: no seq gap, and verifyChain passes", { timeout: 30_000 }, async () => {
  const dir = tempDir();
  const logPath = path.join(dir, "event-log.jsonl");
  const moduleUrl = new URL("../src/event-log.js", import.meta.url).href;

  const childScript = `
    import { EventLogWriter } from ${JSON.stringify(moduleUrl)};
    import * as readline from "node:readline";

    const writer = new EventLogWriter(process.env.EVENT_LOG_PATH, { sessionId: process.env.SESSION_ID });
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

    for await (const line of rl) {
      if (line.startsWith("GO ")) {
        const round = Number(line.slice(3));
        const ev = await writer.append({ kind: "proc.event", data: { round } });
        process.stdout.write("ACK " + ev.seq + "\\n");
      } else if (line === "EXIT") {
        process.exit(0);
      }
    }
  `;

  const spawnWorker = (sessionId: string) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
      env: { ...process.env, EVENT_LOG_PATH: logPath, SESSION_ID: sessionId },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = "";
    const waiters: Array<(seq: number) => void> = [];

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const match = /^ACK (\d+)$/.exec(line);
        if (match) {
          const waiter = waiters.shift();
          if (waiter) waiter(Number(match[1]));
        }
      }
    });

    const step = (round: number): Promise<number> => {
      return new Promise<number>((resolve) => {
        waiters.push(resolve);
        child.stdin.write(`GO ${round}\n`);
      });
    };

    const stop = async () => {
      child.stdin.write("EXIT\n");
      child.stdin.end();
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    };

    return { child, step, stop };
  };

  const procA = spawnWorker("proc-a");
  const procB = spawnWorker("proc-b");

  try {
    const rounds = 20; // 20 each = 40 alternating events total
    for (let r = 1; r <= rounds; r++) {
      const seqA = await procA.step(r);
      assert.equal(seqA, (r - 1) * 2 + 1);

      const seqB = await procB.step(r);
      assert.equal(seqB, r * 2);
    }

    await procA.stop();
    await procB.stop();

    const reader = new EventLogReader(logPath);
    const events = await reader.readAll();
    assert.equal(events.length, rounds * 2);

    for (let i = 0; i < events.length; i++) {
      assert.equal(events[i].seq, i + 1, `seq gap at index ${i}`);
      const expectedSession = i % 2 === 0 ? "proc-a" : "proc-b";
      assert.equal(events[i].sessionId, expectedSession);
    }

    const verification = await reader.verifyChain();
    assert.equal(verification.valid, true);
    assert.equal(verification.totalEvents, rounds * 2);
  } finally {
    procA.child.kill("SIGKILL");
    procB.child.kill("SIGKILL");
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});
