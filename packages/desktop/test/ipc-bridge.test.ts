import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DesktopIpcBridge } from '../src/ipc-bridge.js';
import { StateManager } from '@opensand/local-exec-daemon';

test('DesktopIpcBridge - manages settings and persistent config', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-bridge-test-'));

  try {
    const bridge = new DesktopIpcBridge({
      baseDir: tmpDir,
      defaultSettings: { model: 'test-model', autoApprove: false },
    });

    const initial = bridge.getSettings();
    assert.strictEqual(initial.model, 'test-model');
    assert.strictEqual(initial.autoApprove, false);

    // Update settings
    const updated = bridge.updateSettings({ model: 'gpt-4o', autoApprove: true });
    assert.strictEqual(updated.model, 'gpt-4o');
    assert.strictEqual(updated.autoApprove, true);

    // Verify written to config.json
    const raw = fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.model, 'gpt-4o');
    assert.strictEqual(parsed.autoApprove, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DesktopIpcBridge - handles approval resolutions and standing allowlist', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-bridge-appr-'));

  try {
    const bridge = new DesktopIpcBridge({ baseDir: tmpDir });

    let eventEmitted = false;
    bridge.on('event', (evt) => {
      if (evt.type === 'approval_required') {
        eventEmitted = true;
      }
    });

    // Directly simulate approval tool dispatch
    const resPromise = bridge.requestUserApproval('exec_command', { command: 'git status' });
    assert.strictEqual(eventEmitted, true);

    const activeMap = (bridge as any).activeApprovals as Map<string, any>;
    const [approvalId] = Array.from(activeMap.keys());
    assert.ok(approvalId);

    // Test always_allow adds to standing allowlist
    const approveRes = await bridge.approveTool(approvalId, { action: 'always_allow' });
    assert.strictEqual(approveRes.success, true);

    const resolvedVal = await resPromise;
    assert.strictEqual(resolvedVal, true);

    // Check allowlist file
    const stateManager = new StateManager(path.join(tmpDir, 'state'));
    const gates = await stateManager.readPermissionGates();
    assert.ok(gates.standingAllowlist.includes('git'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DesktopIpcBridge - handles rejection', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-bridge-reject-'));

  try {
    const bridge = new DesktopIpcBridge({ baseDir: tmpDir });

    const resPromise = bridge.requestUserApproval('exec_command', { command: 'rm -f test' });
    const activeMap = (bridge as any).activeApprovals as Map<string, any>;
    const [approvalId] = Array.from(activeMap.keys());

    const approveRes = await bridge.approveTool(approvalId, { action: 'reject' });
    assert.strictEqual(approveRes.success, true);

    const resolvedVal = await resPromise;
    assert.strictEqual(resolvedVal, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DesktopIpcBridge - lists and loads session transcripts', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-bridge-sess-'));

  try {
    const sessDir = path.join(tmpDir, 'sessions', 'test-session-1');
    fs.mkdirSync(sessDir, { recursive: true });

    const jsonl = [
      JSON.stringify({ role: 'user', content: 'What is 2+2?' }),
      JSON.stringify({ role: 'assistant', content: '4' }),
    ].join('\n');
    fs.writeFileSync(path.join(sessDir, 'transcript.jsonl'), jsonl, 'utf8');
    fs.writeFileSync(path.join(sessDir, 'transcript.txt'), '<user_query>\nWhat is 2+2?\n</user_query>\nassistant:\n4\n', 'utf8');

    const bridge = new DesktopIpcBridge({ baseDir: tmpDir });
    const sessions = await bridge.getSessions();
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].id, 'test-session-1');
    assert.strictEqual(sessions[0].messageCount, 2);

    const loaded = await bridge.loadSession('test-session-1');
    assert.strictEqual(loaded.events.length, 2);
    assert.ok(loaded.transcript.includes('<user_query>'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
