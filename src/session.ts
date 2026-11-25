import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Target } from './host.js';
import type { Move } from './navigation.js';

export type Dispatch = (
  kind: Move | 'swipe' | 'input' | 'launch' | 'goHome',
  perform: () => Promise<unknown>,
  verify?: () => Promise<boolean>,
) => Promise<void>;

// The driver explicitly refused the action before applying it.
export class ActionRejected extends Error {}

function directory(t: Target) {
  const key = createHash('sha256')
    .update(t.platform + ':' + t.id)
    .digest('hex');
  return join(process.env.OMU_STATE_DIR || join(homedir(), '.openmobileuse'), key);
}
export type PendingDispatch = {
  runId: string;
  seq: number;
  kind: Parameters<Dispatch>[0];
  time: string;
};
export function pending(t: Target): PendingDispatch[] {
  const dir = directory(t);
  try {
    return readdirSync(dir)
      .filter((f) => /^pending-[a-f0-9-]+\.json$/.test(f))
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
// The caller holds this device's lock and has already checked a fresh observation.
export function acknowledgePending(t: Target, runId: string, seq: number) {
  if (!/^[a-f0-9-]+$/.test(runId)) throw Error('UNKNOWN_PENDING_ACTION');
  const file = join(directory(t), `pending-${runId}.json`);
  const entry: PendingDispatch = JSON.parse(readFileSync(file, 'utf8'));
  if (entry.runId !== runId || entry.seq !== seq) throw Error('UNKNOWN_PENDING_ACTION');
  unlinkSync(file);
}
export async function withDevice<T>(t: Target, runId: string, work: (dispatch: Dispatch) => Promise<T>) {
  const dir = directory(t);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // SQLite releases this process-scoped lock even after SIGKILL. Each device has its own database.
  const lock = new DatabaseSync(join(dir, 'device.lock.sqlite'));
  const record = join(dir, `pending-${runId}.json`);
  let seq = 0;
  try {
    try {
      lock.exec('BEGIN IMMEDIATE');
    } catch (error) {
      if ((error as { errcode?: number }).errcode === 5) throw new Error('DEVICE_BUSY');
      throw error;
    }
    return await work(async (kind, perform, verify) => {
      const tmp = record + '.' + randomUUID();
      writeFileSync(tmp, JSON.stringify({ runId, seq: ++seq, kind, time: new Date().toISOString() }), {
        mode: 0o600,
        flush: true,
      });
      renameSync(tmp, record);
      try {
        await perform();
      } catch (error) {
        if (error instanceof ActionRejected) {
          unlinkSync(record);
          throw error;
        }
        // Verify the original action while still holding the device lock.
        let confirmed = false;
        try { confirmed = (await verify?.()) === true; } catch {}
        if (!confirmed) throw new Error('ACTION_OUTCOME_UNKNOWN: ' + (error as Error).message, { cause: error });
      }
      unlinkSync(record);
    });
  } finally {
    lock.close();
  }
}
