import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DesktopIpcBridge } from '../src/ipc-bridge.js';

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-workspace-default-'));
}

async function closeAndRemove(bridge: DesktopIpcBridge | undefined, home: string): Promise<void> {
  await bridge?.close();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
}

// Finder/Dock launches an Electron app with cwd "/"; "/" must never become the workspace,
// otherwise the first turn waits on a folder.trust question for the whole filesystem.
test('workspace - cwd "/" defaults to the home folder', async () => {
  const home = tmpHome();
  const previousCwd = process.cwd();
  let bridge: DesktopIpcBridge | undefined;
  try {
    process.chdir('/');
    bridge = new DesktopIpcBridge({ baseDir: path.join(home, '.opensand') });
    assert.strictEqual(bridge.workspaceDir, os.homedir());
  } finally {
    process.chdir(previousCwd);
    await closeAndRemove(bridge, home);
  }
});

test('workspace - an explicit workspaceDir still wins over the default', async () => {
  const home = tmpHome();
  const project = path.join(home, 'project');
  fs.mkdirSync(project);
  let bridge: DesktopIpcBridge | undefined;
  try {
    bridge = new DesktopIpcBridge({ baseDir: path.join(home, '.opensand'), workspaceDir: project });
    assert.strictEqual(bridge.workspaceDir, project);
  } finally {
    await closeAndRemove(bridge, home);
  }
});
