import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DesktopIpcBridge } from '../src/ipc-bridge.js';

// The headline bug: "always allow" wrote grants.json AND standing-allowlist.json, but revoke only
// shrank grants.json, so the daemon (which read the legacy file) kept running the command.
test('revoking an "always allow" grant stops the daemon running that command', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-bridge-revoke-'));
  const bridge = new DesktopIpcBridge({ baseDir: tmpDir });
  try {
    const resPromise = bridge.requestUserApproval('exec_command', { command: 'echo revoke-me' });
    const [approvalId] = Array.from(((bridge as any).activeApprovals as Map<string, any>).keys());
    const epoch = (bridge as any).activeApprovals.get(approvalId)?.request.epoch;
    assert.strictEqual((await bridge.approveTool(approvalId, { action: 'always_allow', epoch })).success, true);
    assert.strictEqual(await resPromise, true);

    const daemon = (bridge as any).daemon;
    const before = await daemon.executeTool('exec_command', { command: 'echo revoke-me' });
    assert.strictEqual(before.status, 'ok', 'the standing grant must work before the revoke');

    const grants = await (bridge as any).grantsStore.read();
    const grant = grants.grants.find((g: any) => g.tool === 'exec_command' && g.scope === 'echo *');
    assert.ok(grant, 'always_allow wrote a grant');
    assert.strictEqual((await bridge.revokeGrant(grant.id)).revoked, true);

    const after = await daemon.executeTool('exec_command', { command: 'echo revoke-me' });
    assert.strictEqual(after.status, 'permission_pending');
  } finally {
    await bridge.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});
