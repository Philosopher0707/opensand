import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runStateMigrations, readSchemaVersion } from '../src/state-migrations.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-migrations-'));
}

test('fresh state is stamped with the current version and not backed up', () => {
  const dir = tempDir();
  const stateDir = path.join(dir, 'state');

  const result = runStateMigrations(stateDir);

  assert.equal(result.from, 0);
  assert.equal(result.to, 1);
  assert.equal(result.migrated, true);
  assert.equal(result.backupDir, null);
  assert.equal(readSchemaVersion(stateDir), 1);
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
  fs.writeFileSync(path.join(stateDir, 'schema.json'), '{"version":1}');

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
