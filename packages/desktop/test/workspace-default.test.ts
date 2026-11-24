import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DesktopIpcBridge } from '../src/ipc-bridge.js';
import { closeThenRemove } from './teardown.js';

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-workspace-default-'));
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
    await closeThenRemove([bridge], home);
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
    await closeThenRemove([bridge], home);
  }
});
