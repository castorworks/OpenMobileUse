import { randomUUID } from 'node:crypto';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { compileScript } from '../dist/run.js';
import { readScriptEnvelope } from '../dist/script.js';
import { overview, stateRoot, writeJSON } from './library.mjs';

const platforms = ['android', 'ios', 'harmony'];
const builtins = new Map([
  ['settings-bluetooth', '蓝牙导航'],
  ['settings-search', '设置搜索'],
]);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const dir = () => join(stateRoot(), 'scripts');
const overrides = () => join(dir(), 'recordings');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
async function entries(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}
function scriptName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100)
    throw Error('INVALID_SCRIPT_NAME');
  return value.trim();
}
function reference(id) {
  const parts = typeof id === 'string' ? id.split(':') : [];
  if (parts[0] === 'builtin' && parts.length === 2 && builtins.has(parts[1])) return parts;
  if (parts[0] === 'import' && parts.length === 2 && uuid.test(parts[1])) return parts;
  if (parts[0] === 'record' && parts.length === 3 && hash.test(parts[1]) && uuid.test(parts[2]))
    return parts;
  throw Error('UNKNOWN_SCRIPT');
}
export async function recordOptions(device, chatId) {
  try {
    return await json(join(overrides(), device + '-' + chatId + '.json'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}
export async function scriptEntry(id, includeHidden = false) {
  const [source, key, chatId] = reference(id);
  if (source === 'builtin') {
    const script = await json(new URL('../examples/' + key + '.json', import.meta.url));
    return { id, source, title: builtins.get(key), platforms, stepCount: script.steps.length, script };
  }
  if (source === 'import') {
    const saved = await json(join(dir(), key + '.json'));
    readScriptEnvelope(saved.script);
    return { ...saved, id, source };
  }
  const options = await recordOptions(key, chatId);
  if (options.hidden && !includeHidden) throw Error('UNKNOWN_SCRIPT');
  const chat = await json(join(stateRoot(), 'conversations', key, chatId + '.json'));
  const { platform } = readScriptEnvelope(chat.script, true);
  if (!platform) throw Error('INVALID_SCRIPT');
  const info = overview(chat);
  return {
    id,
    source,
    title: options.title || info.title,
    updated: info.updated,
    stepCount: info.stepCount,
    partial: info.status !== 'succeeded',
    platforms: [platform],
    script: chat.script,
    hidden: !!options.hidden,
  };
}

export async function listScripts() {
  const ids = [...builtins.keys()].map((key) => 'builtin:' + key);
  for (const file of await entries(dir())) {
    if (file.isFile() && file.name.endsWith('.json') && uuid.test(file.name.slice(0, -5)))
      ids.push('import:' + file.name.slice(0, -5));
  }
  const root = join(stateRoot(), 'conversations');
  for (const group of await entries(root)) {
    if (!group.isDirectory() || !hash.test(group.name)) continue;
    for (const file of await entries(join(root, group.name))) {
      if (file.isFile() && file.name.endsWith('.json') && uuid.test(file.name.slice(0, -5)))
        ids.push('record:' + group.name + ':' + file.name.slice(0, -5));
    }
  }
  const rows = [];
  for (const id of ids) {
    try {
      const { script, hidden, ...summary } = await scriptEntry(id, true);
      if (!hidden && summary.stepCount) rows.push(summary);
    } catch (e) {
      if (e.code !== 'ENOENT' && !['INVALID_SCRIPT', 'INVALID_SCRIPT_TARGETS'].includes(e.message)) throw e;
    }
  }
  return rows.sort(
    (a, b) =>
      (b.updated || '').localeCompare(a.updated || '') || a.title.localeCompare(b.title, 'zh-CN'),
  );
}

export async function importScript(title, text) {
  title = scriptName(title);
  if (typeof text !== 'string' || Buffer.byteLength(text) > 8 * 1024 * 1024) throw Error('INVALID_FILE');
  const script = JSON.parse(text);
  const { platform } = readScriptEnvelope(script);
  const candidates = platform ? [platform] : platforms;
  const checks = await Promise.allSettled(candidates.map((platform) => compileScript(script, platform)));
  const supported = candidates.filter((_, i) => checks[i].status === 'fulfilled');
  if (!supported.length) throw checks[0].reason;
  const key = randomUUID();
  await writeJSON(dir(), key + '.json', {
    title,
    script,
    platforms: supported,
    stepCount: script.steps.length,
    updated: new Date().toISOString(),
  });
  return 'import:' + key;
}

export async function renameScript(id, value) {
  const title = scriptName(value);
  const [source, key, chatId] = reference(id);
  if (source === 'builtin') throw Error('BUILTIN_SCRIPT');
  const { script, platforms, stepCount } = await scriptEntry(id);
  if (source === 'record') return writeJSON(overrides(), key + '-' + chatId + '.json', { title });
  return writeJSON(dir(), key + '.json', {
    title,
    script,
    platforms,
    stepCount,
    updated: new Date().toISOString(),
  });
}
export async function removeScript(id) {
  const [source, key, chatId] = reference(id);
  if (source === 'builtin') throw Error('BUILTIN_SCRIPT');
  if (source === 'import') return unlink(join(dir(), key + '.json'));
  const opts = await recordOptions(key, chatId);
  return writeJSON(overrides(), key + '-' + chatId + '.json', { ...opts, hidden: true });
}
export async function restoreRecording(id) {
  const [source, key, chatId] = reference(id);
  if (source !== 'record') throw Error('UNKNOWN_SCRIPT');
  const opts = await recordOptions(key, chatId);
  if (opts.hidden)
    await writeJSON(overrides(), key + '-' + chatId + '.json', { ...opts, hidden: false });
}
