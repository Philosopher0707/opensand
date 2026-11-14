import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventLogReader } from '@opensand/shared';
import type { RawTimelineEvent } from './mission-timeline-model.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TAIL_MAX = 400;

/** Fields the timeline shows. Receipts, change sets and workspace paths never cross IPC. */
const SCALAR_FIELDS = ['node', 'attempt', 'title', 'claim', 'passed', 'exitCode', 'durationMs', 'accept', 'note', 'reason', 'question', 'folder', 'level', 'tool', 'name'] as const;

function trim(v: string): string {
  return v.length > TAIL_MAX ? v.slice(0, TAIL_MAX) + '…' : v;
}

function pickData(data: unknown): Record<string, unknown> {
  const src = (data ?? {}) as Record<string, any>;
  const out: Record<string, unknown> = {};
  for (const k of SCALAR_FIELDS) {
    const v = src[k];
    if (typeof v === 'string') out[k] = trim(v);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  if (typeof src.outputTail === 'string') out.outputTail = trim(src.outputTail);
  if (typeof src.error?.message === 'string') out.error = trim(src.error.message);
  return out;
}

/**
 * Read-only event list for one mission under `<baseDir>/missions/<id>`. Rejects ids that
 * are not a plain name, so the renderer cannot point it at another directory.
 */
export async function readMissionTimeline(baseDir: string, missionId: unknown): Promise<RawTimelineEvent[]> {
  if (typeof missionId !== 'string' || !SAFE_ID.test(missionId)) throw new Error('Invalid mission id');
  const dir = path.join(baseDir, 'missions', missionId);
  if (!fs.existsSync(dir)) return [];
  const { events } = await new EventLogReader(dir).readWithRecovery();
  return events.map((ev) => ({ seq: ev.seq, ts: ev.ts, kind: ev.kind, data: pickData(ev.data) }));
}
