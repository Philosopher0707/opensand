import { createMissionHandlers, MissionRunnerManager } from '@opensand/engine';
import { listMissionSummaries } from './shell/mission-list-source.js';

export type RestoreFn = (missionId: string, snapshot: string) => Promise<unknown>;
export type PreviewRestoreFn = (missionId: string, snapshot: string) => Promise<unknown>;

function createRestoreContext(stateDir: string) {
  return {
    stateDir,
    version: 'desktop',
    pid: process.pid,
    startedAt: Date.now(),
    now: () => new Date(),
    connection: { write: async () => undefined, close: () => undefined },
    subscribe: () => undefined,
    requestShutdown: () => undefined,
    activeMissions: () => 0,
    publish: () => undefined,
  };
}

/**
 * The desktop's route to `mission.Missions.previewRestore`. Runs the engine's read-only preview
 * handler in-process to compute which files will be overwritten, recreated, or deleted before
 * any disk changes are made.
 */
export function createMissionPreviewRestore(stateDir: string): PreviewRestoreFn {
  let handler: ((params: Record<string, unknown>, context: any) => Promise<unknown>) | undefined;
  const context = createRestoreContext(stateDir);
  return async (missionId, snapshot) => {
    if (typeof missionId !== 'string' || missionId === '' || typeof snapshot !== 'string' || snapshot === '') {
      throw new Error('missionId and snapshot are required');
    }
    const summaries = await listMissionSummaries(stateDir);
    if (summaries.find((m) => m.missionId === missionId)?.status === 'running') {
      throw new Error(`Cannot restore: mission '${missionId}' is actively running`);
    }
    if (!handler) {
      const manager = new MissionRunnerManager(stateDir, undefined, () => undefined);
      handler = createMissionHandlers(manager)['mission.Missions.previewRestore'] as unknown as typeof handler;
    }
    return handler!({ missionId, snapshot }, context);
  };
}

/**
 * The desktop's route to `mission.Missions.restoreSnapshot`. It runs the engine's own handler, so
 * the folder-trust gate, mission-ref confinement, per-workspace lock, pre-restore safety copy and
 * the SNAPSHOT_RESTORED log event are the engine's, not a copy. The manager here never starts a
 * mission (no agent) and never publishes frames; it exists only to hold the restore logic.
 *
 * Missions run in the engine process, so this process cannot see its runners. A mission whose log
 * has not reached a terminal event is therefore treated as running and refused, with the message
 * the Restore dialog already classifies.
 */
export function createMissionRestore(stateDir: string): RestoreFn {
  let handler: ((params: Record<string, unknown>, context: any) => Promise<unknown>) | undefined;
  const context = createRestoreContext(stateDir);
  return async (missionId, snapshot) => {
    if (typeof missionId !== 'string' || missionId === '' || typeof snapshot !== 'string' || snapshot === '') {
      throw new Error('missionId and snapshot are required');
    }
    const summaries = await listMissionSummaries(stateDir);
    if (summaries.find((m) => m.missionId === missionId)?.status === 'running') {
      throw new Error(`Cannot restore: mission '${missionId}' is actively running`);
    }
    if (!handler) {
      const manager = new MissionRunnerManager(stateDir, undefined, () => undefined);
      handler = createMissionHandlers(manager)['mission.Missions.restoreSnapshot'] as unknown as typeof handler;
    }
    return handler!({ missionId, snapshot }, context);
  };
}
