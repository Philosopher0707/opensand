import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventLogReader } from '@opensand/shared';
import { buildReceiptView, type ReceiptView } from './mission-receipt-model.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Read-only receipt for one mission under `<baseDir>/missions/<id>`, reduced to display
 * fields in the main process. Null when the mission has no receipt yet. Rejects ids that are
 * not a plain name, so the renderer cannot point it at another directory.
 */
export async function readMissionReceipt(baseDir: string, missionId: unknown): Promise<ReceiptView | null> {
  if (typeof missionId !== 'string' || !SAFE_ID.test(missionId)) throw new Error('Invalid mission id');
  const dir = path.join(baseDir, 'missions', missionId);
  if (!fs.existsSync(dir)) return null;
  const { events } = await new EventLogReader(dir).readWithRecovery();
  return buildReceiptView(events as any);
}
