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
