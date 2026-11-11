import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DesktopIpcBridge } from '../src/ipc-bridge.js';

test('DesktopIpcBridge - session rename, export, and search', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-session-test-'));

  try {
    const bridge = new DesktopIpcBridge({ baseDir: tmpDir });
    const sessionsDir = path.join(tmpDir, 'sessions');
    const sess1Dir = path.join(sessionsDir, 'sess-1');
    const sess2Dir = path.join(sessionsDir, 'sess-2');
    fs.mkdirSync(sess1Dir, { recursive: true });
    fs.mkdirSync(sess2Dir, { recursive: true });

    // Populate sess-1
    fs.writeFileSync(path.join(sess1Dir, 'transcript.jsonl'), JSON.stringify({ role: 'user', content: 'Hello world query' }) + '\n' + JSON.stringify({ role: 'assistant', content: 'Hello! How can I help you today?' }) + '\n');
    fs.writeFileSync(path.join(sess1Dir, 'messages.json'), JSON.stringify([
      { role: 'user', content: 'Hello world query' },
      { role: 'assistant', content: 'Hello! How can I help you today?' }
    ]));

    // Populate sess-2
    fs.writeFileSync(path.join(sess2Dir, 'transcript.jsonl'), JSON.stringify({ role: 'user', content: 'Fix compiler bug' }) + '\n');
    fs.writeFileSync(path.join(sess2Dir, 'messages.json'), JSON.stringify([
      { role: 'user', content: 'Fix compiler bug' },
      { role: 'assistant', content: 'Looking into the compiler bug now.' }
    ]));

    // 1. Initial list
    let sessions = await bridge.getSessions();
    assert.strictEqual(sessions.length, 2);

    // 2. Search
    const searchRes = await bridge.searchSessions('compiler');
    assert.strictEqual(searchRes.length, 1);
    assert.strictEqual(searchRes[0].id, 'sess-2');

    // 3. Rename
    const renameOk = await bridge.renameSession('sess-1', 'Renamed Greeting Session');
    assert.strictEqual(renameOk, true);

    const updatedSessions = await bridge.getSessions();
    const renamed = updatedSessions.find(s => s.id === 'sess-1');
    assert.strictEqual(renamed?.title, 'Renamed Greeting Session');

    // Search by new title
    const searchRenamed = await bridge.searchSessions('Greeting');
    assert.strictEqual(searchRenamed.length, 1);
    assert.strictEqual(searchRenamed[0].id, 'sess-1');

    // 4. Export JSON
    const exportedJson = await bridge.exportSession('sess-1', 'json');
    const parsed = JSON.parse(exportedJson);
    assert.strictEqual(parsed.sessionId, 'sess-1');
    assert.strictEqual(parsed.title, 'Renamed Greeting Session');
    assert.strictEqual(parsed.events.length, 2);

    // 5. Export Markdown
    const exportedMd = await bridge.exportSession('sess-1', 'md');
    assert.ok(exportedMd.includes('# Session: Renamed Greeting Session'));
    assert.ok(exportedMd.includes('### User'));
    assert.ok(exportedMd.includes('Hello world query'));
    assert.ok(exportedMd.includes('### Assistant'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

import { writeEventLogSync, readEventLogSync, verifyEventLogChain } from '@opensand/shared';

test('DesktopIpcBridge - event-log.jsonl source of truth for list, load, rename, and export', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-event-session-test-'));

  try {
    const bridge = new DesktopIpcBridge({ baseDir: tmpDir });
    const sessionsDir = path.join(tmpDir, 'sessions');
    const sessDir = path.join(sessionsDir, 'sess-v2');
    fs.mkdirSync(sessDir, { recursive: true });

    writeEventLogSync(path.join(sessDir, 'event-log.jsonl'), [
      {
        kind: 'session.created',
        node: 'plan',
        sessionId: 'sess-v2',
        data: { title: 'Event Log Session' },
      },
      {
        kind: 'turn.started',
        node: 'user',
        sessionId: 'sess-v2',
        data: { role: 'user', content: 'What is the speed of sound?' },
      },
      {
        kind: 'model.completion',
        node: 'act',
        sessionId: 'sess-v2',
        data: { role: 'assistant', content: 'The speed of sound in air is ~343 m/s.' },
      },
    ]);

    // 1. List
    const sessions = await bridge.getSessions();
    const found = sessions.find((s) => s.id === 'sess-v2');
    assert.ok(found);
    assert.strictEqual(found.title, 'Event Log Session');
    assert.strictEqual(found.messageCount, 2);

    // 2. Load
    const loaded = await bridge.loadSession('sess-v2');
    assert.ok(loaded);
    assert.strictEqual(loaded.events.length, 3);
    assert.ok(loaded.transcript.includes('What is the speed of sound?'));
    assert.ok(loaded.transcript.includes('343 m/s'));

    // 3. Rename
    const renameOk = await bridge.renameSession('sess-v2', 'Renamed Event Log Session');
    assert.strictEqual(renameOk, true);

    const logPath = path.join(sessDir, 'event-log.jsonl');
    const updatedEvents = readEventLogSync(logPath);
    assert.strictEqual(updatedEvents.length, 4);
    assert.strictEqual(updatedEvents[3].kind, 'session.renamed');
    assert.strictEqual(updatedEvents[3].data.title, 'Renamed Event Log Session');
    assert.strictEqual(verifyEventLogChain(updatedEvents), true);

    const updatedList = await bridge.getSessions();
    const updatedFound = updatedList.find((s) => s.id === 'sess-v2');
    assert.strictEqual(updatedFound?.title, 'Renamed Event Log Session');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
