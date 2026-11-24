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
) => Promise<void>;
function directory(t: Target) {
  const key = createHash('sha256')
    .update(t.platform + ':' + t.id)
    .digest('hex');
  return join(process.env.OMU_STATE_DIR || join(homedir(), '.openmobileuse'), key);
}
export function pending(t: Target) {
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
    return await work(async (kind, perform) => {
      const tmp = record + '.' + randomUUID();
      writeFileSync(tmp, JSON.stringify({ runId, seq: ++seq, kind, time: new Date().toISOString() }), {
        mode: 0o600,
        flush: true,
      });
      renameSync(tmp, record);
      try {
        await perform();
      } catch (e) {
        throw new Error('ACTION_OUTCOME_UNKNOWN: ' + (e as Error).message);
      }
      unlinkSync(record);
    });
  } finally {
    lock.close();
  }
}
