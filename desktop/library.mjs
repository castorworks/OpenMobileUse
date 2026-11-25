import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const stateRoot = () => process.env.OMU_STATE_DIR || join(homedir(), '.openmobileuse');
export async function writeJSON(dir, name, value) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, name);
  const tmp = file + '.' + randomUUID() + '.tmp';
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600, flush: true });
  await rename(tmp, file);
}
