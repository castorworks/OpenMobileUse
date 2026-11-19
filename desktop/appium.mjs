import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

function launch(base) {
  const entry = join(project, 'node_modules', 'appium', 'index.js');
  if (!existsSync(entry)) throw Error('APPIUM_NOT_INSTALLED');
  const env = { ...process.env };
  const sdk = env.ANDROID_SDK_ROOT || join(homedir(), 'Library', 'Android', 'sdk');
  const jdk = '/Applications/Android Studio.app/Contents/jbr/Contents/Home';
  if (!env.ANDROID_HOME && existsSync(sdk)) env.ANDROID_HOME = sdk;
  if (!env.JAVA_HOME && existsSync(jdk)) env.JAVA_HOME = jdk;
  const node = env.npm_node_execpath || (process.versions.electron ? 'node' : process.execPath);
  const host = base.hostname === '[::1]' ? '::1' : base.hostname;
  const args = [
    entry, '--address', host, '--port', base.port || '80',
    '--base-path', base.pathname, '--log-level', 'warn',
  ];
  const child = spawn(node, args, { cwd: project, env, stdio: ['ignore', 'inherit', 'inherit'] });
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

export class LocalAppium {
  constructor(endpoint) {
    this.endpoint = endpoint;
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
          spawned = this.owned = launch(base);
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
