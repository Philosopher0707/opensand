import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { MISSION_EVENT, nextMissionStatus, projectMissionStatus } from '../src/index.js';
import type { MissionStatus } from '../src/index.js';

describe('mission status projection', () => {
  it('maps every status-moving event kind', () => {
    const cases: Array<[string, MissionStatus, MissionStatus]> = [
      [MISSION_EVENT.STARTED, 'failed', 'running'],
      [MISSION_EVENT.NEEDS_YOU, 'running', 'needs-you'],
      [MISSION_EVENT.ANSWERED, 'needs-you', 'running'],
      [MISSION_EVENT.VERIFIED, 'running', 'verified'],
      [MISSION_EVENT.FAILED, 'running', 'failed'],
      [MISSION_EVENT.STOPPED, 'running', 'stopped'],
    ];
    for (const [kind, from, to] of cases) assert.strictEqual(nextMissionStatus(from, kind), to, kind);
  });

  it('leaves status alone for kinds that do not move it', () => {
    for (const kind of [MISSION_EVENT.NODE_STARTED, MISSION_EVENT.NODE_COMPLETED, MISSION_EVENT.CHECK_COMPLETED, MISSION_EVENT.REVIEW_COMPLETED, 'tool.call', 'whatever']) {
      assert.strictEqual(nextMissionStatus('needs-you', kind), 'needs-you', kind);
    }
  });

  it('folds a log: running by default, last status-moving event wins', () => {
    assert.strictEqual(projectMissionStatus([]), 'running');
    assert.strictEqual(projectMissionStatus([{ kind: 'mission.started' }, { kind: 'mission.needs-you' }, { kind: 'node.started' }]), 'needs-you');
    assert.strictEqual(projectMissionStatus([{ kind: 'mission.started' }, { kind: 'mission.needs-you' }, { kind: 'mission.answered' }, { kind: 'mission.verified' }]), 'verified');
  });
});
