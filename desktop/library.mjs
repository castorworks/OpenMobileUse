import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const stateRoot = () => process.env.OMU_STATE_DIR || join(homedir(), '.openmobileuse');
export function deviceDir(identity, category) {
  return join(stateRoot(), category, createHash('sha256').update(identity).digest('hex'));
}
export async function writeJSON(dir, name, value) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, name);
  const tmp = file + '.' + randomUUID() + '.tmp';
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600, flush: true });
  await rename(tmp, file);
}
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
export function saveConversation(identity, chat) {
  return writeJSON(deviceDir(identity, 'conversations'), chat.id + '.json', chat);
}
export async function loadConversation(identity, id) {
  if (typeof id !== 'string' || !uuid.test(id)) throw Error('UNKNOWN_CONVERSATION');
  return JSON.parse(await readFile(join(deviceDir(identity, 'conversations'), id + '.json'), 'utf8'));
}
export function overview(chat) {
  return {
    id: chat.id,
    title: chat.turns[0]?.user.slice(0, 64),
    updated: chat.updated,
    stepCount: chat.script.steps.length,
    status: chat.turns.at(-1)?.status,
  };
}
export async function conversations(identity) {
  const dir = deviceDir(identity, 'conversations');
  const files = await readdir(dir).catch((e) => {
    if (e.code === 'ENOENT') return [];
    throw e;
  });
  const chats = [];
  for (const f of files) {
    if (f.endsWith('.json') && uuid.test(f.slice(0, -5)))
      chats.push(overview(await loadConversation(identity, f.slice(0, -5))));
  }
  return chats.sort((a, b) => b.updated.localeCompare(a.updated));
}
