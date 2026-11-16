import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventLogWriter } from '@opensand/shared';
import { createMissionRestore } from '../src/mission-restore.js';
import { makeGitWorkspace, runScriptedMission, trustFolderIn, git } from './engine-mission-fixture.js';

const SPEC = [
  { writes: { 'file.txt': 'step1\n', 'extra.txt': 'made by step 1\n' }, review: { accept: false, note: 'again' } },
  { writes: { 'file.txt': 'step2\n' }, review: { accept: true, note: 'ok' } },
];

async function realMission() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-restore-home-')));
  const stateDir = path.join(home, '.opensand');
  const ws = makeGitWorkspace({ 'file.txt': 'initial\n' });
  trustFolderIn(stateDir, ws);
  const m = await runScriptedMission(stateDir, ws, SPEC);
  return { home, stateDir, ws, ...m, done: () => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(ws, { recursive: true, force: true }); } };
}

test('restore wiring: a real finished mission restores to a step on disk and Undo brings the files back', async () => {
  const r = await realMission();
  try {
    assert.ok(r.snapshots.length >= 2, `expected >=2 snapshots, got ${r.snapshots.length}`);
    assert.strictEqual(fs.readFileSync(path.join(r.ws, 'file.txt'), 'utf8'), 'step2\n');
    assert.ok(fs.existsSync(path.join(r.ws, 'extra.txt')));
    assert.strictEqual(fs.readFileSync(path.join(r.ws, 'file.txt'), 'utf8'), 'step2\n');

    const restore = createMissionRestore(r.stateDir);
    const res: any = await restore(r.missionId, r.snapshots[0]);
    assert.strictEqual(res.success, true);
    assert.strictEqual(fs.readFileSync(path.join(r.ws, 'file.txt'), 'utf8'), 'initial\n', 'file.txt rolled back to its state before the mission');
    assert.strictEqual(fs.existsSync(path.join(r.ws, 'extra.txt')), false, 'file the mission created is deleted');

    const undo: any = await restore(r.missionId, res.preRestoreSnapshot);
    assert.strictEqual(undo.success, true);
    assert.strictEqual(fs.readFileSync(path.join(r.ws, 'file.txt'), 'utf8'), 'step2\n', 'Undo restores step 2');
    assert.strictEqual(fs.readFileSync(path.join(r.ws, 'extra.txt'), 'utf8'), 'made by step 1\n', 'Undo brings back the deleted file');
    assert.match(git(['status', '--porcelain'], r.ws), /file\.txt/);
  } finally { r.done(); }
});

test('restore wiring: an untrusted folder is refused by the engine gate and nothing changes', async () => {
  const r = await realMission();
  try {
    fs.rmSync(path.join(r.stateDir, 'folder-trust.json'));
    const before = fs.readFileSync(path.join(r.ws, 'file.txt'), 'utf8');
    await assert.rejects(createMissionRestore(r.stateDir)(r.missionId, r.snapshots[1]), /untrusted/i);
    assert.strictEqual(fs.readFileSync(path.join(r.ws, 'file.txt'), 'utf8'), before);
  } finally { r.done(); }
});

test('restore wiring: a snapshot ref of another mission is refused', async () => {
  const r = await realMission();
  try {
    const other = r.snapshots[1].replace(r.missionId, 'm-other');
    await assert.rejects(createMissionRestore(r.stateDir)(r.missionId, other), /does not belong/i);
    assert.strictEqual(fs.readFileSync(path.join(r.ws, 'file.txt'), 'utf8'), 'step2\n');
  } finally { r.done(); }
});

test('restore wiring: a mission whose log has not ended is "actively running" and nothing changes', async () => {
  const r = await realMission();
  try {
    const w = new EventLogWriter(path.join(r.stateDir, 'missions', 'm-live'), { sessionId: 'm-live' });
    await w.append({ kind: 'mission.started' as any, data: { title: 'still going', workspaceRoot: r.ws } });
    await assert.rejects(createMissionRestore(r.stateDir)('m-live', 'refs/opensand/missions/m-live/s-1'), /actively running/);
    assert.strictEqual(fs.readFileSync(path.join(r.ws, 'file.txt'), 'utf8'), 'step2\n');
  } finally { r.done(); }
});

test('restore wiring: empty ids are rejected before any engine call', async () => {
  const restore = createMissionRestore(path.join(os.tmpdir(), 'opensand-no-such-state'));
  await assert.rejects(restore('', 'refs/x'), /required/);
  await assert.rejects(restore('m-1', ''), /required/);
});
