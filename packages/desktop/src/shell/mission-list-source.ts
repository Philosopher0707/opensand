import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventLogReader } from '@opensand/shared';
import type { MissionSummary } from './mission-list-model.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Read-only summary of every mission log under `<baseDir>/missions`. Mirrors the
 * title/status/updatedAt part of the engine's projectMission; unreadable logs are skipped.
 */
export async function listMissionSummaries(baseDir: string): Promise<MissionSummary[]> {
  const dir = path.join(baseDir, 'missions');
  if (!fs.existsSync(dir)) return [];
  const out: MissionSummary[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory() || !SAFE_ID.test(ent.name)) continue;
    try {
      const { events } = await new EventLogReader(path.join(dir, ent.name)).readWithRecovery();
      if (events.length === 0) continue;
      let title = '';
      let status = 'running';
      for (const ev of events) {
        const data = (ev.data ?? {}) as Record<string, any>;
        if (ev.kind === 'mission.started') {
          title = typeof data.title === 'string' ? data.title : title;
          status = 'running';
        } else if (ev.kind === 'mission.needs-you') status = 'needs-you';
        else if (ev.kind === 'mission.answered') status = 'running';
        else if (ev.kind === 'mission.verified') status = 'verified';
        else if (ev.kind === 'mission.failed') status = 'failed';
        else if (ev.kind === 'mission.stopped') status = 'stopped';
      }
      out.push({ missionId: ent.name, title, status, updatedAt: events[events.length - 1].ts });
    } catch {
      // A corrupt or locked log must not hide the other missions.
    }
  }
  return out;
}
