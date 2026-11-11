import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  EventLogWriter,
  EventLogReader,
  verifyEventLogChain,
  EventChainIntegrityError,
  GENESIS_PREV_HASH,
  computeRecordHash,
  canonicalJson,
} from '../src/event-log.js';

function tempDir(): string {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), 'opensand-event-log-'));
}

test('EventLogWriter appends events with valid sequence numbers and SHA-256 hash chaining', async () => {
  const dir = tempDir();
  try {
    const logPath = path.join(dir, 'event-log.jsonl');
    const writer = new EventLogWriter(logPath, { sessionId: 'sess-1' });

    const ev1 = await writer.append({
      kind: 'session.created',
      data: { title: 'First Session' },
    });
    assert.equal(ev1.seq, 1);
    assert.equal(ev1.prev, GENESIS_PREV_HASH);
    assert.equal(ev1.sessionId, 'sess-1');

    const ev2 = await writer.append({
      kind: 'turn.started',
      data: { role: 'user', content: 'Hello' },
    });
    assert.equal(ev2.seq, 2);
    assert.equal(ev2.prev, computeRecordHash(ev1));

    const ev3 = await writer.append({
      kind: 'model.completion',
      data: { role: 'assistant', content: 'World' },
    });
    assert.equal(ev3.seq, 3);
    assert.equal(ev3.prev, computeRecordHash(ev2));

    const reader = new EventLogReader(logPath);
    const readEvents = await reader.readAll();
    assert.equal(readEvents.length, 3);
    assert.deepEqual(readEvents, [ev1, ev2, ev3]);

    const isValid = await reader.verify();
    assert.equal(isValid, true);
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

test('Tamper test: modifying one byte in record 2 of a 5-record log causes verifyEventLogChain to throw EventChainIntegrityError', async () => {
  const dir = tempDir();
  try {
    const logPath = path.join(dir, 'event-log.jsonl');
    const writer = new EventLogWriter(logPath, { sessionId: 'sess-tamper' });

    for (let i = 1; i <= 5; i++) {
      await writer.append({
        kind: `event.${i}`,
        data: { step: i, status: 'ok' },
      });
    }

    const reader = new EventLogReader(logPath);
    const events = await reader.readAll();
    assert.equal(events.length, 5);
    assert.equal(verifyEventLogChain(events), true);

    // Tamper with record 2 (index 1) in memory
    const tamperedEvents = JSON.parse(JSON.stringify(events));
    tamperedEvents[1].data.status = 'corrupted';

    assert.throws(
      () => verifyEventLogChain(tamperedEvents),
      (err: any) => {
        assert.ok(err instanceof EventChainIntegrityError);
        assert.match(err.message, /Broken hash chain/);
        return true;
      }
    );

    // Tamper with record 2 directly in file
    const rawContent = await fs.readFile(logPath, 'utf8');
    const lines = rawContent.trim().split('\n');
    assert.equal(lines.length, 5);

    // Modify a character in line 2
    const tamperedLine2 = lines[1].replace('"status":"ok"', '"status":"bad"');
    assert.notEqual(tamperedLine2, lines[1]);
    lines[1] = tamperedLine2;
    await fs.writeFile(logPath, lines.join('\n') + '\n', 'utf8');

    // Reader must reject the tampered file
    await assert.rejects(
      async () => await reader.readAll(),
      (err: any) => {
        assert.ok(err instanceof EventChainIntegrityError);
        assert.match(err.message, /Broken hash chain/);
        return true;
      }
    );
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

test('Crash simulation test (kill -9): unparseable trailing partial line at EOF is recovered without losing or repeating committed events', async () => {
  const dir = tempDir();
  try {
    const logPath = path.join(dir, 'event-log.jsonl');
    const writer = new EventLogWriter(logPath, { sessionId: 'sess-crash' });

    const committed: any[] = [];
    for (let i = 1; i <= 3; i++) {
      const ev = await writer.append({
        kind: `turn.${i}`,
        data: { messageIndex: i },
      });
      committed.push(ev);
    }

    // Simulate kill -9 crash mid-write on record 4: half-written JSON line without newline or closing brace
    const partialLine = '{"seq":4,"ts":"2026-11-11T18:30:00.000Z","sessionId":"sess-crash","attempt":1,"node":"act","kind":"tool.co';
    await fs.appendFile(logPath, partialLine, 'utf8');

    // Reader recovers all 3 committed events without error, discarding trailing unparseable partial write
    const reader = new EventLogReader(logPath);
    const recoveredWithMeta = await reader.readWithRecovery();
    assert.equal(recoveredWithMeta.hadTrailingCorruption, true);
    assert.ok(recoveredWithMeta.discardedTrailingBytes! > 0);
    assert.equal(recoveredWithMeta.events.length, 3);
    assert.deepEqual(recoveredWithMeta.events, committed);

    const recoveredEvents = await reader.readAll();
    assert.equal(recoveredEvents.length, 3);
    assert.deepEqual(recoveredEvents, committed);

    // Now append next event (record 4) after crash recovery:
    // Writer should truncate partial trailing line and append record 4 cleanly
    const ev4 = await writer.append({
      kind: 'tool.completed',
      data: { tool: 'exec_command', exit: 0 },
    });

    assert.equal(ev4.seq, 4);
    assert.equal(ev4.prev, computeRecordHash(committed[2]));

    const allEvents = await reader.readAll();
    assert.equal(allEvents.length, 4);
    assert.equal(await reader.verify(), true);
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

test('canonicalJson ensures consistent key ordering for hash calculation', () => {
  const objA = { b: 2, a: 1, c: { y: 20, x: 10 } };
  const objB = { a: 1, c: { x: 10, y: 20 }, b: 2 };

  assert.equal(canonicalJson(objA), canonicalJson(objB));
  assert.equal(canonicalJson(objA), '{"a":1,"b":2,"c":{"x":10,"y":20}}');
});
