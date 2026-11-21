import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { appiumEndpoint } from '../dist/webdriver.js';

const project = fileURLToPath(new URL('../', import.meta.url));

async function status(base) {
  let res;
  try {
    res = await fetch(base.href.replace(/\/$/, '') + '/status', {
      redirect: 'manual',
      signal: AbortSignal.timeout(1000),
    });
  } catch (e) {
    const errors = e.cause?.errors || [e.cause];
    if (errors.length && errors.every((cause) => cause?.code === 'ECONNREFUSED')) return 'absent';
    throw Error('APPIUM_UNREACHABLE');
  }
  const value = (await res.json().catch(() => null))?.value;
  if (!res.ok || typeof value?.ready !== 'boolean' || typeof value?.build?.version !== 'string')
    throw Error('APPIUM_ENDPOINT_CONFLICT');
  return value.ready ? 'ready' : 'waiting';
}

async function launch(base, environment) {
  const entry = join(project, 'node_modules', 'appium', 'index.js');
  if (!existsSync(entry)) throw Error('APPIUM_NOT_INSTALLED');
  const env = { ...environment };
  const pathKey =
    Object.keys(env).find((k) => process.platform === 'win32' && k.toUpperCase() === 'PATH') || 'PATH';
  const sdk = env.ANDROID_SDK_ROOT || join(homedir(), 'Library', 'Android', 'sdk');
  const jdk = '/Applications/Android Studio.app/Contents/jbr/Contents/Home';
  if (!env.ANDROID_HOME && existsSync(sdk)) env.ANDROID_HOME = sdk;
  if (!env.JAVA_HOME && existsSync(jdk)) env.JAVA_HOME = jdk;
  // Keep Appium's writable driver manifest outside a packaged application.
  const node = process.execPath;
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  if (process.resourcesPath && project.startsWith(process.resourcesPath + '/')) {
    const lock = await readFile(join(project, 'package-lock.json'));
    const key = createHash('sha256').update(project).update(lock).digest('hex').slice(0, 16);
    const home = join(env.OMU_STATE_DIR || join(homedir(), '.openmobileuse'), 'drivers', key);
    const modules = join(home, 'node_modules');
    await mkdir(modules, { recursive: true });
    for (const name of ['appium-xcuitest-driver', 'appium-uiautomator2-driver']) {
      await symlink(join(project, 'node_modules', name), join(modules, name)).catch((e) => {
        if (e.code !== 'EEXIST') throw e;
      });
    }
    env.APPIUM_HOME = home;
    env.OMU_NODE_BINARY = node;
    env[pathKey] = join(project, 'bin') + delimiter + env[pathKey];
  }
  env[pathKey] = [
    env.JAVA_HOME && join(env.JAVA_HOME, 'bin'),
    env.ANDROID_HOME && join(env.ANDROID_HOME, 'platform-tools'),
    dirname(node),
    env[pathKey],
  ]
    .filter(Boolean)
    .join(delimiter);
  const host = base.hostname === '[::1]' ? '::1' : base.hostname;
  const args = [
    entry,
    '--address',
    host,
    '--port',
    base.port || '80',
    '--base-path',
    base.pathname,
    '--log-level',
    'warn',
  ];
  const child = spawn(node, args, {
    cwd: project, env, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
  });
  // 'close' also follows a spawn error (e.g. a Node binary removed since installation).
  child.on('error', (error) => console.error('Appium launch:', error.message));
  const closed = new Promise((resolve) => child.once('close', resolve));
  return { child, closed };
}

async function stop(owned) {
  if (!owned || !owned.child.pid || owned.child.exitCode !== null || owned.child.signalCode) return;
  owned.child.kill('SIGTERM');
  const timer = setTimeout(() => owned.child.kill('SIGKILL'), 3000);
  try {
    await owned.closed;
  } finally {
    clearTimeout(timer);
  }
}

function appiumEnvironment() {
  const env = { ...process.env };
  return { env, key: JSON.stringify([env.ANDROID_HOME, env.ANDROID_SDK_ROOT, env.JAVA_HOME]) };
}

export class LocalAppium {
  clients = new Set();
  constructor(endpoint) {
    this.endpoint = endpoint;
  }
  async withEnvironment(work) {
    let environment = appiumEnvironment();
    while (this.clients.size && environment.key !== this.environment.key) {
      await Promise.race(this.clients);
      environment = appiumEnvironment();
    }
    if (this.closing) throw Error('CANCELLED');
    if (!this.clients.size) this.environment = environment;
    const { promise, resolve } = Promise.withResolvers();
    this.clients.add(promise);
    try {
      return await work();
    } finally {
      this.clients.delete(promise);
      resolve();
    }
  }
  ensureReady() {
    if (this.closing) return Promise.reject(Error('CANCELLED'));
    // Separate device locks may request the same service at the same time.
    this.starting ??= this.connect().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  async connect() {
    const base = appiumEndpoint(this.endpoint);
    const { env, key } = this.environment || appiumEnvironment();
    // A running service only sees the environment it inherited. Wait for other
    // workbench sessions before replacing an owned service with new SDK paths.
    if (this.owned && this.owned.key !== key) await stop(this.owned);
    const deadline = Date.now() + 15000;
    let spawned;
    try {
      do {
        const state = await status(base);
        if (this.closing) throw Error('CANCELLED');
        if (state === 'ready') return;
        if (spawned && this.owned !== spawned) throw Error('APPIUM_START_FAILED');
        if (state === 'absent' && !this.owned) {
          if (base.protocol === 'https:') throw Error('APPIUM_HTTPS_UNAVAILABLE');
          spawned = this.owned = { ...(await launch(base, env)), key };
          spawned.closed.then(() => {
            if (this.owned === spawned) this.owned = undefined;
          });
        }
        await wait(200);
      } while (Date.now() < deadline);
      throw Error('APPIUM_START_TIMEOUT');
    } catch (e) {
      await stop(spawned);
      throw e;
    }
  }
  async close() {
    this.closing = true;
    await this.starting?.catch(() => {});
    await stop(this.owned);
  }
}
