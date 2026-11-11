import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runStateMigrations, readSchemaVersion } from '../src/state-migrations.js';
import { readEventLogSync, verifyEventLogChain, projectMessages } from '../src/event-log.js';
import { ChatMessage } from '../src/types.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-migrations-'));
}

test('fresh state is stamped with the current version and not backed up', () => {
  const dir = tempDir();
  const stateDir = path.join(dir, 'state');

  const result = runStateMigrations(stateDir);

  assert.equal(result.from, 0);
  assert.equal(result.to, 2);
  assert.equal(result.migrated, true);
  assert.equal(result.backupDir, null);
  assert.equal(readSchemaVersion(stateDir), 2);
});

test('existing state is backed up before a migration runs', () => {
  const dir = tempDir();
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'sessions.json'), '{"a":1}');
  fs.writeFileSync(path.join(stateDir, 'schema.json'), '{"version":1}');

  const order: string[] = [];
  const result = runStateMigrations(stateDir, {
    currentVersion: 2,
    migrations: [
      {
        to: 2,
        up: (d) => {
          order.push('ran');
          fs.writeFileSync(path.join(d, 'sessions.json'), '{"a":2}');
        },
      },
    ],
  });

  assert.deepEqual(order, ['ran']);
  assert.equal(result.from, 1);
  assert.equal(result.to, 2);
  assert.ok(result.backupDir);
  const backup = result.backupDir as string;
  assert.equal(fs.readFileSync(path.join(backup, 'sessions.json'), 'utf8'), '{"a":1}');
  assert.equal(fs.readFileSync(path.join(stateDir, 'sessions.json'), 'utf8'), '{"a":2}');
  assert.equal(readSchemaVersion(stateDir), 2);
});

test('an unstamped state directory with data is backed up before stamping', () => {
  const stateDir = path.join(tempDir(), 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'sessions.json'), '{"a":1}');

  const result = runStateMigrations(stateDir);

  assert.equal(result.from, 0);
  assert.ok(result.backupDir);
  assert.equal(
    fs.readFileSync(path.join(result.backupDir as string, 'sessions.json'), 'utf8'),
    '{"a":1}',
  );
});

test('a state directory already at the current version is left alone', () => {
  const stateDir = path.join(tempDir(), 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'schema.json'), '{"version":2}');

  const result = runStateMigrations(stateDir);

  assert.equal(result.migrated, false);
  assert.equal(result.backupDir, null);
  assert.equal(fs.existsSync(path.join(stateDir, '..', 'state-backups')), false);
});

test('a newer state is refused instead of downgraded', () => {
  const stateDir = path.join(tempDir(), 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'schema.json'), '{"version":99}');

  assert.throws(() => runStateMigrations(stateDir), /newer than this build supports/);
});

test('a corrupt schema file fails with a readable message', () => {
  const stateDir = path.join(tempDir(), 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'schema.json'), 'not json');

  assert.throws(() => runStateMigrations(stateDir), /Cannot read state schema/);
});

test('migrates v1 session directory with legacy messages.json + meta.json to v2; asserts valid event log and byte-identical projected messages', () => {
  const dir = tempDir();
  const stateDir = path.join(dir, 'state');
  const sessionsDir = path.join(stateDir, 'sessions');
  const session1Dir = path.join(sessionsDir, 'sess-legacy-1');
  fs.mkdirSync(session1Dir, { recursive: true });

  const originalMessages: ChatMessage[] = [
    { role: 'user', content: 'What is the speed of light?' },
    { role: 'assistant', content: 'The speed of light is approximately 299,792,458 m/s.' },
  ];
  const messagesJson = JSON.stringify(originalMessages, null, 2);
  fs.writeFileSync(path.join(session1Dir, 'messages.json'), messagesJson, 'utf8');

  const meta = {
    sessionId: 'sess-legacy-1',
    title: 'Speed of Light Query',
    model: 'claude-3-7-sonnet',
    createdAt: '2026-11-10T12:00:00.000Z',
  };
  fs.writeFileSync(path.join(session1Dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  fs.writeFileSync(path.join(stateDir, 'schema.json'), '{"version":1}');

  const result = runStateMigrations(stateDir);
  assert.equal(result.from, 1);
  assert.equal(result.to, 2);
  assert.equal(result.migrated, true);

  const eventLogPath = path.join(session1Dir, 'event-log.jsonl');
  assert.equal(fs.existsSync(eventLogPath), true);

  const events = readEventLogSync(eventLogPath);
  assert.ok(events.length >= 3);
  assert.equal(events[0].kind, 'session.created');
  assert.equal(events[0].data.title, 'Speed of Light Query');

  // Verify hash chain
  assert.equal(verifyEventLogChain(events), true);

  // Assert byte-identical projected messages
  const projected = projectMessages(events);
  assert.deepEqual(projected, originalMessages);
  assert.equal(JSON.stringify(projected, null, 2), messagesJson);
});
