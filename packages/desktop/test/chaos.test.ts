import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { classifyError } from '@opensand/coordinator';
import { createWorkspaceSnapshot, revertWorkspaceSnapshot } from '@opensand/shared';
import { runStateMigrations } from '@opensand/shared';
import { DesktopIpcBridge } from '../src/ipc-bridge.js';

test('Chaos Suite: 20 automated resilience scenarios', async (t) => {
  // 1. Dead Ollama endpoint
  await t.test('1. Dead Ollama endpoint produces classified error', () => {
    const err = classifyError(new Error('connect ECONNREFUSED 127.0.0.1:11434'));
    assert.strictEqual(err.code, 'OLLAMA_UNREACHABLE');
    assert.strictEqual(err.isUserFixable, true);
  });

  // 2. 401 Unauthorized API key
  await t.test('2. 401 Unauthorized produces classified error', () => {
    const err = classifyError(new Error('401 Unauthorized: invalid api key'));
    assert.strictEqual(err.code, 'AUTH_INVALID_KEY');
    assert.ok(err.nextAction.includes('Settings'));
  });

  // 3. 429 Rate limit exceeded
  await t.test('3. 429 Rate limit produces classified error', () => {
    const err = classifyError(new Error('rate limit reached (429)'));
    assert.strictEqual(err.code, 'RATE_LIMIT_EXCEEDED');
  });

  // 4. 503 Provider unavailable
  await t.test('4. 503 Provider unavailable produces classified error', () => {
    const err = classifyError({ status: 503, message: 'model overloaded' });
    assert.strictEqual(err.code, 'PROVIDER_UNAVAILABLE');
    assert.strictEqual(err.isUserFixable, false);
  });

  // 5. Tool approval denied
  await t.test('5. Tool approval denied produces classified error', () => {
    const err = classifyError(new Error('approval rejected by user policy'));
    assert.strictEqual(err.code, 'TOOL_APPROVAL_DENIED');
  });

  // 6. Command timeout
  await t.test('6. Command timeout produces classified error', () => {
    const err = classifyError(new Error('timed out after 60000ms'));
    assert.strictEqual(err.code, 'EXECUTION_TIMEOUT');
  });

  // 7. File not found
  await t.test('7. File not found produces classified error', () => {
    const err = classifyError(new Error('ENOENT: no such file or directory'));
    assert.strictEqual(err.code, 'FILE_NOT_FOUND');
  });

  // 8. OS permission denied
  await t.test('8. OS permission denied produces classified error', () => {
    const err = classifyError(new Error('EACCES: permission denied'));
    assert.strictEqual(err.code, 'FS_PERMISSION_DENIED');
  });

  // 9. Disk full
  await t.test('9. Disk full produces classified error', () => {
    const err = classifyError(new Error('ENOSPC: no space left on device'));
    assert.strictEqual(err.code, 'DISK_FULL');
  });

  // 10. Context length exceeded
  await t.test('10. Context length exceeded produces classified error', () => {
    const err = classifyError(new Error('maximum context length is 8192 tokens'));
    assert.strictEqual(err.code, 'CONTEXT_LENGTH_EXCEEDED');
  });

  // 11. State downgrade refused
  await t.test('11. State downgrade refused produces classified error', () => {
    const err = classifyError(new Error('state version downgrade refused'));
    assert.strictEqual(err.code, 'STATE_DOWNGRADE_REFUSED');
  });

  // 12. Network offline
  await t.test('12. Network offline produces classified error', () => {
    const err = classifyError(new Error('getaddrinfo ENOTFOUND api.openai.com'));
    assert.strictEqual(err.code, 'NETWORK_OFFLINE');
  });

  // 13. Invalid sessionId format rejected
  await t.test('13. Invalid sessionId format rejected with error', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-chaos-'));
    try {
      const bridge = new DesktopIpcBridge({ baseDir: tmpDir });
      await assert.rejects(async () => {
        await bridge.loadSession('../malicious');
      }, /Invalid sessionId/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 14. Rename non-existent session returns false safely
  await t.test('14. Rename non-existent session returns false safely', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-chaos-'));
    try {
      const bridge = new DesktopIpcBridge({ baseDir: tmpDir });
      const ok = await bridge.renameSession('non-existent-session', 'Title');
      assert.strictEqual(ok, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 15. Export non-existent session throws expected error
  await t.test('15. Export non-existent session throws expected error', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-chaos-'));
    try {
      const bridge = new DesktopIpcBridge({ baseDir: tmpDir });
      await assert.rejects(async () => {
        await bridge.exportSession('non-existent-session', 'json');
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 16. Corrupt session transcript JSONL handled gracefully
  await t.test('16. Corrupt session transcript JSONL handled gracefully', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-chaos-'));
    try {
      const bridge = new DesktopIpcBridge({ baseDir: tmpDir });
      const sessDir = path.join(tmpDir, 'sessions', 'corrupt-sess');
      fs.mkdirSync(sessDir, { recursive: true });
      fs.writeFileSync(path.join(sessDir, 'transcript.jsonl'), 'NOT_VALID_JSON\n{"role":"user","content":"ok"}\n');
      const loaded = await bridge.loadSession('corrupt-sess');
      assert.strictEqual(loaded.events.length, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 17. Path traversal attempt in session delete rejected
  await t.test('17. Path traversal attempt in session delete rejected', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-chaos-'));
    try {
      const bridge = new DesktopIpcBridge({ baseDir: tmpDir });
      await assert.rejects(async () => {
        await bridge.deleteSession('../../etc');
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 18. Downgrade migration attempt refused safely
  await t.test('18. Downgrade migration attempt refused safely', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-chaos-'));
    try {
      const stateDir = path.join(tmpDir, 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'schema.json'), JSON.stringify({ version: 9999 }));
      assert.throws(() => {
        runStateMigrations(stateDir);
      }, /Refusing/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 19. Workspace snapshot revert of non-existent turnId throws clear error
  await t.test('19. Workspace snapshot revert of non-existent turnId throws clear error', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-chaos-'));
    try {
      assert.throws(() => {
        revertWorkspaceSnapshot(tmpDir, 'non-existent-turn');
      }, /Snapshot manifest not found/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 20. Workspace snapshot restores deleted file and removes untracked
  await t.test('20. Workspace snapshot restores deleted file and removes untracked file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-chaos-ws-'));
    try {
      const testFile = path.join(tmpDir, 'important.txt');
      fs.writeFileSync(testFile, 'critical code', 'utf8');

      createWorkspaceSnapshot(tmpDir, 'turn-safe');

      fs.unlinkSync(testFile);
      const rogueFile = path.join(tmpDir, 'rogue.sh');
      fs.writeFileSync(rogueFile, 'rm -rf /', 'utf8');

      const res = revertWorkspaceSnapshot(tmpDir, 'turn-safe');
      assert.strictEqual(fs.readFileSync(testFile, 'utf8'), 'critical code');
      assert.strictEqual(fs.existsSync(rogueFile), false);
      assert.deepStrictEqual(res.restored, ['important.txt']);
      assert.deepStrictEqual(res.deleted, ['rogue.sh']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
