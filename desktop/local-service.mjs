import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, open } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { apiStateDirectory, discoverLocalConnection } from '../dist/local-connection.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const defaultEntry = join(project, 'dist', 'cli.js');
const exec = promisify(execFile);
const connecting = new Map();
function removeEnvironmentValues(env, names) {
  const normalize = (key) => process.platform === 'win32' ? key.toUpperCase() : key;
  const removed = new Set([...names].filter((key) => typeof key === 'string').map(normalize));
  for (const key of Object.keys(env)) if (removed.has(normalize(key))) delete env[key];
}

function nodeEnvironment(environment) {
  const env = { ...environment };
  removeEnvironmentValues(env, ['OMU_API_TOKEN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']);
  env.ELECTRON_RUN_AS_NODE = '1';
  if (env.OMU_STATE_DIR !== undefined) env.OMU_STATE_DIR = resolve(env.OMU_STATE_DIR);
  return env;
}

function authEnvironment() {
  const env = nodeEnvironment(process.env);
  const secretKeys = new Set(['DEEPSEEK_API_KEY', 'OMU_MODEL_PROFILES', process.env.OMU_MODEL_KEY_ENV]);
  try {
    const profiles = JSON.parse(process.env.OMU_MODEL_PROFILES ?? '[]');
    if (Array.isArray(profiles)) for (const profile of profiles) secretKeys.add(profile?.apiKeyEnv);
  } catch { /* Omit the raw model configuration below. */ }
  removeEnvironmentValues(env, secretKeys);
  return env;
}

async function daemonEnvironment(preferences, options, signal) {
  const serviceEnvironment = options.serviceEnvironment ??
    (await import('./service-environment.mjs')).serviceEnvironment;
  signal.throwIfAborted();
  const env = nodeEnvironment(await serviceEnvironment(options.secure ?? preferences.secure));
  const bin = join(project, 'bin');
  const shim = await lstat(join(bin, 'node')).catch(() => null);
  if (shim?.isFile()) {
    const key = Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
    env[key] = [bin, env[key]].filter(Boolean).join(delimiter);
    env.OMU_NODE_BINARY = options.node ?? process.execPath;
  }
  return env;
}

async function startLocalDaemon(directory, preferences, options, fetch, signal) {
  const environment = await daemonEnvironment(preferences, options, signal);
  const existing = await discoverLocalConnection(directory, { fetch, signal });
  if (existing) return existing;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const log = await open(join(directory, 'desktop-service.log'), 'a', 0o600);
  let failed = false;
  try {
    signal.throwIfAborted();
    const child = (options.spawn ?? spawn)(options.node ?? process.execPath, [
      options.entry ?? defaultEntry, 'serve', '--host', '127.0.0.1', '--port', '0', '--state-dir', directory,
    ], {
      cwd: project,
      env: environment,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', log.fd, log.fd],
    });
    child.once('error', () => { failed = true; });
    child.once('exit', () => { failed = true; });
    child.unref();
  } catch {
    signal.throwIfAborted();
    throw Error('LOCAL_SERVICE_START_FAILED');
  } finally {
    await log.close();
  }
  const clock = Date.now() + (options.timeoutMs ?? 25_000);
  for (;;) {
    const connection = await discoverLocalConnection(directory, { fetch, signal });
    if (connection) return connection;
    const remaining = clock - Date.now();
    if (remaining <= 0) throw Error(failed ? 'LOCAL_SERVICE_START_FAILED' : 'LOCAL_SERVICE_START_TIMEOUT');
    await sleep(Math.min(150, remaining), undefined, { signal });
  }
}

async function acceptsToken(connection, token, fetch, signal) {
  if (typeof token !== 'string' || !token || /[^!-~]/.test(token)) return false;
  try {
    const response = await fetch(new URL('/api/capabilities', connection.url), {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
    });
    await response.body?.cancel().catch(() => {});
    return response.ok;
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

async function bootstrap(directory, preferences, options, signal) {
  const fetch = options.fetch ?? globalThis.fetch;
  const connection = await discoverLocalConnection(directory, { fetch, signal }) ??
    await startLocalDaemon(directory, preferences, options, fetch, signal);
  const previous = preferences.clientConfig();
  if (previous.stateDirectory === directory &&
      await acceptsToken(connection, previous.token, fetch, signal)) {
    return { baseURL: connection.url, token: previous.token, stateDirectory: directory };
  }
  signal.throwIfAborted();
  let issued;
  try {
    const { stdout } = await (options.execFile ?? exec)(options.node ?? process.execPath, [
      options.entry ?? defaultEntry, 'auth', 'token', 'create', '--subject', 'desktop-local', '--state-dir', directory,
    ], {
      cwd: project,
      env: authEnvironment(),
      signal,
      timeout: 12_000,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 65_536,
    });
    issued = JSON.parse(stdout);
  } catch {
    signal.throwIfAborted();
    throw Error('LOCAL_SERVICE_AUTH_FAILED');
  }
  // A replacement listening on the old port must pass the local instance check
  // before any generated token is sent.
  const current = await discoverLocalConnection(directory, { fetch, signal });
  if (!current || !await acceptsToken(current, issued?.token, fetch, signal))
    throw Error('LOCAL_SERVICE_AUTH_FAILED');
  return { baseURL: current.url, token: issued.token, stateDirectory: directory };
}

async function waitForConnection(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  let cancel;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
    })]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

export async function ensureLocalService(preferences, options = {}) {
  options.signal?.throwIfAborted();
  const directory = options.stateDir === undefined ? apiStateDirectory() : resolve(options.stateDir);
  let entry = connecting.get(directory);
  if (!entry || entry.controller.signal.aborted) {
    const controller = new AbortController();
    entry = { controller, users: 0 };
    const owned = entry;
    entry.promise = bootstrap(directory, preferences, options, controller.signal).finally(() => {
      if (connecting.get(directory) === owned) connecting.delete(directory);
    });
    connecting.set(directory, entry);
  }
  entry.users++;
  try {
    return await waitForConnection(entry.promise, options.signal);
  } finally {
    if (--entry.users === 0) entry.controller.abort(Error('CANCELLED'));
  }
}
