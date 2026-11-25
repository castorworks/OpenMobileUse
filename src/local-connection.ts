import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

type LocalConnection = { url: string; instanceId: string };
export const localConnectionFile = 'connection.json';
export const localInstanceHeader = 'X-OMU-Instance';
const descriptorLimit = 4096;

export function apiStateDirectory(environment = process.env) {
  const shared = environment.OMU_STATE_DIR ?? join(homedir(), '.openmobileuse');
  return resolve(environment.OMU_API_STATE_DIR ?? join(shared, 'api'));
}

async function readDescriptor(path: string) {
  const pathInfo = await lstat(path);
  if (!pathInfo.isFile()) return;
  const flags = process.platform === 'win32' ? constants.O_RDONLY :
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const file = await open(path, flags);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > descriptorLimit ||
        (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))) return;
    const buffer = Buffer.alloc(descriptorLimit + 1);
    const { bytesRead } = await file.read(buffer);
    if (bytesRead <= descriptorLimit)
      return JSON.parse(buffer.toString('utf8', 0, bytesRead)) as Partial<LocalConnection> | null;
  } finally {
    await file.close();
  }
}

export async function discoverLocalConnection(directory = apiStateDirectory(), options: {
  fetch?: typeof fetch;
  signal?: AbortSignal;
} = {}): Promise<LocalConnection | undefined> {
  try {
    options.signal?.throwIfAborted();
    const descriptor = await readDescriptor(join(directory, localConnectionFile));
    if (!descriptor) return;
    const { url, instanceId } = descriptor;
    if (typeof url !== 'string' || typeof instanceId !== 'string' ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(instanceId)) return;
    const address = new URL(url);
    if (url !== 'http://' + address.hostname + ':' + (address.port || '80') || address.protocol !== 'http:' ||
        !['127.0.0.1', '[::1]'].includes(address.hostname)) return;
    const timeout = AbortSignal.timeout(800);
    const response = await (options.fetch ?? globalThis.fetch)(new URL('/healthz', address), {
      redirect: 'error',
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
    if (response.ok && response.headers.get(localInstanceHeader) === instanceId &&
        (await response.json())?.status === 'ok') return { url, instanceId };
    if (!response.bodyUsed) await response.body?.cancel();
  } catch {
    options.signal?.throwIfAborted();
  }
}
