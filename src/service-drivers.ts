import { spawn, fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { mkdir, readFile, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { agentToolchain, adbPath, hdcToolchain, list, readAndroidSettings, run, type Platform, type Target } from './host.js';
import { Harmony } from './harmony.js';
import type { Device } from './navigation.js';
import type { Dispatch } from './session.js';
import type { StepDevice, View } from './steps.js';
import type { CommentVideo } from './comment-panel.js';
import { appiumEndpoint, WebDriver } from './webdriver.js';

export const servicePlatforms: readonly Platform[] = ['android', 'harmony', 'ios'];
export type ConnectedTarget = Target & { hardwareKey?: string };
export type ServiceDevice = StepDevice & Device & { commentOrigin?: CommentVideo; settingsScreen?(view: View): { page: string; marker?: string } };
export type DriverStatus = { platform: Platform; available: boolean; code?: string };
export type OwnedDriverSession = { endpoint: string; sessionId: string; ports: number[] };
export type DriverSession = { device: ServiceDevice; owned?: OwnedDriverSession; close(): Promise<void> };

export interface ServiceDrivers {
  discover(platform: Platform): Promise<ConnectedTarget[]>;
  status(platform: Platform): Promise<DriverStatus>;
  open(
    target: Target, dispatch: Dispatch, mode: 'settings' | 'foreground', signal: AbortSignal, newCommandTimeoutSeconds?: number,
  ): Promise<DriverSession>;
  toolchain?(target: Target, signal?: AbortSignal): Promise<Record<string, string>>;
  recover?(owned: OwnedDriverSession): Promise<void>;
  close(): Promise<void>;
}

export type NativeDriverOptions = {
  appiumMode?: 'external' | 'managed';
  appiumUrl?: string;
  secretKeys?: string[];
};

const require = createRequire(import.meta.url);
const entrypoint = fileURLToPath(import.meta.url);
const superviseFlag = '--omu-supervise-appium';
const windows = process.platform === 'win32';
const mac = process.platform === 'darwin';
const executable = (name: string) => windows ? name + '.exe' : name;

function directories(root: string) {
  try { return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map(({ name }) => join(root, name)); }
  catch { return []; }
}

function pathExecutable(name: string, path: string) {
  return path.split(delimiter).filter(Boolean)
    .map((directory) => join(directory.replace(/^"(.*)"$/, '$1'), executable(name)))
    .find(existsSync);
}

function inferAndroidEnvironment(env: NodeJS.ProcessEnv, path: string) {
  const state = env.OMU_STATE_DIR || join(homedir(), '.openmobileuse');
  const managed = join(state, 'android');
  const settings = readAndroidSettings(managed);
  if (typeof settings.sdk === 'string' && existsSync(join(settings.sdk, 'platform-tools', executable('adb'))))
    env.ANDROID_HOME = env.ANDROID_SDK_ROOT = settings.sdk;
  if (!env.ANDROID_HOME && !env.ANDROID_SDK_ROOT) {
    const configured = adbPath();
    const adb = isAbsolute(configured) ? configured : pathExecutable('adb', path);
    const directory = adb && dirname(adb);
    if (directory && basename(directory).toLowerCase() === 'platform-tools')
      env.ANDROID_HOME = dirname(directory);
  }
  env.ANDROID_HOME ??= env.ANDROID_SDK_ROOT;
  const managedJava = mac ? join(managed, 'jdk', 'Contents', 'Home') : join(managed, 'jdk');
  if (env.JAVA_HOME && env.JAVA_HOME === settings.incompatibleJava &&
      existsSync(join(managedJava, 'bin', executable('jarsigner')))) env.JAVA_HOME = managedJava;
  if (env.JAVA_HOME) return;
  const java = pathExecutable('java', path);
  let fromPath: string | undefined;
  if (java) {
    try { fromPath = dirname(dirname(realpathSync(java))); }
    catch { fromPath = dirname(dirname(java)); }
  }
  const home = (path: string) => mac ? join(path, 'Contents', 'Home') : path;
  const candidates = windows
    ? [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']]
        .filter((path): path is string => !!path)
        .flatMap((path) => [
          join(path, 'Android', 'Android Studio', 'jbr'),
          ...['Java', 'Eclipse Adoptium', 'Microsoft'].flatMap((vendor) => directories(join(path, vendor))),
        ])
    : mac
      ? [
          ...['/Applications', join(homedir(), 'Applications')].map((path) =>
            home(join(path, 'Android Studio.app', 'Contents', 'jbr'))),
          ...['/Library/Java/JavaVirtualMachines', join(homedir(), 'Library', 'Java', 'JavaVirtualMachines')]
            .flatMap(directories).map(home),
        ]
      : [];
  const javaHome = [env.JDK_HOME, fromPath, ...candidates, managedJava]
    .find((path) => !!path && path !== '/usr' &&
      existsSync(join(path, 'bin', executable('java'))) &&
      existsSync(join(path, 'bin', executable('jarsigner'))));
  if (javaHome) env.JAVA_HOME = javaHome;
}

async function bundledAppiumHome(entry: string, env: NodeJS.ProcessEnv) {
  if (!env.OMU_NODE_BINARY || env.APPIUM_HOME) return;
  const project = dirname(dirname(dirname(entry)));
  if (!existsSync(join(project, 'bin', 'node'))) return;
  const lock = await readFile(join(project, 'package-lock.json'));
  const key = createHash('sha256').update(project).update(lock).digest('hex').slice(0, 16);
  const home = join(env.OMU_STATE_DIR || join(homedir(), '.openmobileuse'), 'drivers', key);
  const modules = join(home, 'node_modules');
  await mkdir(modules, { recursive: true, mode: 0o700 });
  for (const name of ['appium-xcuitest-driver', 'appium-uiautomator2-driver']) {
    await symlink(join(project, 'node_modules', name), join(modules, name), 'dir').catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
  }
  env.APPIUM_HOME = home;
}

function stopChild(child: ChildProcess | undefined) {
  if (!child?.pid || child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

// The watchdog owns the one child it created. It receives IPC EOF if the service crashes.
if (process.argv[2] === superviseFlag && process.send) {
  const [, , , entry, port] = process.argv;
  const child = spawn(process.execPath, [
    entry, '--address', '127.0.0.1', '--port', port, '--base-path', '/', '--log-level', 'warn',
  ], {
    cwd: dirname(dirname(dirname(entry))),
    env: process.env,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.once('error', () => process.exit(1));
  child.once('exit', (code) => process.exit(code ?? 0));
  process.once('disconnect', () => { void stopChild(child); });
}

function openPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(Error('PORT_UNAVAILABLE'));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function appiumStatus(endpoint: string) {
  const base = appiumEndpoint(endpoint);
  const response = await fetch(base.href.replace(/\/$/, '') + '/status', {
    redirect: 'error', signal: AbortSignal.timeout(1200),
  });
  const reply: { value?: { ready?: boolean; build?: { version?: string } } } = await response.json();
  if (!response.ok || reply.value?.ready !== true || typeof reply.value.build?.version !== 'string')
    throw Error('APPIUM_UNREACHABLE');
  return reply.value.build.version;
}

function validSerial(value: string) {
  return /^[a-z0-9][a-z0-9._-]{4,95}$/i.test(value) &&
    !['unknown', '0123456789abcdef', '1234567890', '0000000000'].includes(value.toLowerCase());
}

async function identify(target: Target): Promise<ConnectedTarget> {
  if (target.platform === 'ios') return { ...target, hardwareKey: target.id };
  if (!target.available || target.connection === 'emulator') return target;
  const serial = target.platform === 'android'
    ? await run(adbPath(), ['-s', target.id, 'shell', 'getprop', 'ro.serialno'], 2000).catch(() => '')
    : await run(hdcToolchain().executable, ['-t', target.id, 'shell', 'param', 'get', 'const.product.serial'], 2000).catch(() => '');
  return validSerial(serial) ? { ...target, hardwareKey: serial } : target;
}

export class NativeServiceDrivers implements ServiceDrivers {
  private readonly mode: 'external' | 'managed';
  private readonly external: string;
  private readonly environment: NodeJS.ProcessEnv;
  private managed?: { endpoint: string; child: ChildProcess };
  private startup?: Promise<string>;
  private readonly reserved = new Set<number>();
  private closing = false;

  constructor(options: NativeDriverOptions = {}) {
    this.mode = options.appiumMode ?? 'external';
    this.external = this.mode === 'external' ? appiumEndpoint(options.appiumUrl).href : '';
    this.environment = { ...process.env };
    for (const key of options.secretKeys ?? []) delete this.environment[key];
    delete this.environment.NODE_OPTIONS;
  }

  private async launchEnvironment(entry: string) {
    const env = { ...this.environment };
    const key = Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
    inferAndroidEnvironment(env, env[key] ?? '');
    const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
    env[key] = [
      env.JAVA_HOME && join(env.JAVA_HOME, 'bin'),
      sdk && join(sdk, 'platform-tools'),
      dirname(process.execPath),
      env[key],
    ].filter(Boolean).join(delimiter);
    await bundledAppiumHome(entry, env);
    return env;
  }

  async discover(platform: Platform) {
    return Promise.all((await list(platform)).map(identify));
  }

  async status(platform: Platform): Promise<DriverStatus> {
    try {
      if (platform === 'ios') {
        if (process.platform !== 'darwin') return { platform, available: false, code: 'HOST_PLATFORM_UNSUPPORTED' };
        await run('xcrun', ['--find', 'xcodebuild'], 1500);
      } else if (platform === 'harmony') {
        if (!hdcToolchain().available) return { platform, available: false, code: 'TOOL_NOT_FOUND' };
      } else {
        await run(adbPath(), ['version'], 1500);
      }
      if (platform !== 'harmony') {
        if (this.mode === 'external') await appiumStatus(this.external);
        else require.resolve('appium/index.js');
      }
      return { platform, available: true };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { platform, available: false, code: code === 'ENOENT' ? 'TOOL_NOT_FOUND' :
        code === 'MODULE_NOT_FOUND' ? 'APPIUM_NOT_INSTALLED' :
        platform === 'harmony' ? 'DRIVER_UNAVAILABLE' : 'APPIUM_UNREACHABLE' };
    }
  }

  private async endpoint() {
    if (this.closing) throw Error('CANCELLED');
    if (this.mode === 'external') {
      try { await appiumStatus(this.external); }
      catch { throw Error('APPIUM_UNREACHABLE'); }
      return this.external;
    }
    if (this.managed && this.managed.child.exitCode === null && !this.managed.child.signalCode)
      return this.startup ?? this.managed.endpoint;
    this.startup ??= this.launch().finally(() => { this.startup = undefined; });
    return this.startup;
  }

  private waitForEndpoint(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const ready = this.endpoint();
    if (!signal) return ready;
    // Cancelling one queued device must not terminate the shared Appium startup.
    return new Promise<string>((resolve, reject) => {
      const cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      void ready.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    });
  }

  private async launch() {
    let entry: string;
    try { entry = require.resolve('appium/index.js'); }
    catch { throw Error('APPIUM_NOT_INSTALLED'); }
    const env = await this.launchEnvironment(entry);
    const port = await openPort();
    const endpoint = 'http://127.0.0.1:' + port;
    if (this.closing) throw Error('CANCELLED');
    const child = fork(entrypoint, [superviseFlag, entry, String(port)], {
      env,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: [],
    });
    let startupError = false;
    child.once('error', () => { startupError = true; });
    this.managed = { endpoint, child };
    try {
      const deadline = Date.now() + 5 * 60_000;
      do {
        if (this.closing) throw Error('CANCELLED');
        if (startupError || child.exitCode !== null || child.signalCode) throw Error('APPIUM_START_FAILED');
        if (await appiumStatus(endpoint).catch(() => null)) return endpoint;
        await sleep(200);
      } while (Date.now() < deadline);
      throw Error('APPIUM_START_TIMEOUT');
    } catch (error) {
      await this.stopManaged();
      throw error;
    }
  }

  private async reservePort() {
    for (;;) {
      const port = await openPort();
      if (!this.reserved.has(port)) {
        this.reserved.add(port);
        return port;
      }
    }
  }

  async open(target: Target, dispatch: Dispatch, mode: 'settings' | 'foreground', signal: AbortSignal, newCommandTimeoutSeconds?: number) {
    signal.throwIfAborted();
    if (target.platform === 'harmony') {
      const device = new Harmony(target.id, dispatch);
      return { device, close: () => device.close() };
    }
    const endpoint = await this.waitForEndpoint(signal);
    signal.throwIfAborted();
    const ports: number[] = [];
    let opening = false;
    const release = () => { for (const port of ports) this.reserved.delete(port); };
    try {
      ports.push(await this.reservePort());
      signal.throwIfAborted();
      opening = true;
      const device = await WebDriver.open(target.platform, target.id, dispatch, mode, {
        endpoint,
        newCommandTimeoutSeconds,
        waitForIdleTimeoutMs: target.platform === 'android' ? 1000 : undefined,
        systemPort: target.platform === 'android' ? ports[0] : undefined,
        wdaLocalPort: target.platform === 'ios' ? ports[0] : undefined,
        disableAutoLaunch: true,
      });
      const owned = { endpoint, sessionId: device.sessionId, ports };
      return {
        device,
        owned,
        close: async () => {
          await WebDriver.closeSession(endpoint, device.sessionId);
          release();
        },
      };
    } catch (error) {
      // An incomplete create response can leave an unknown session using these ports.
      if (!opening || (!(error instanceof DOMException) && (error as Error).message.startsWith('Appium:')))
        release();
      throw error;
    }
  }

  async toolchain(target: Target, signal?: AbortSignal): Promise<Record<string, string>> {
    if (target.platform === 'harmony') {
      const { driver, version, bridge } = await agentToolchain(target);
      return { driver, version, bridge: bridge ?? '' };
    }
    const endpoint = await this.waitForEndpoint(signal);
    const version = await appiumStatus(endpoint);
    return { driver: target.platform === 'ios' ? 'XCUITest' : 'UiAutomator2', appium: version, source: this.mode };
  }

  async recover(owned: OwnedDriverSession) {
    // A managed watchdog has already stopped its own Appium on IPC EOF.
    if (this.mode === 'managed' && owned.endpoint !== this.managed?.endpoint) {
      const alive = await appiumStatus(owned.endpoint).then(() => true, () => false);
      if (!alive) return;
    }
    await WebDriver.closeSession(owned.endpoint, owned.sessionId);
    for (const port of owned.ports) this.reserved.delete(port);
  }

  private async stopManaged() {
    const child = this.managed?.child;
    this.managed = undefined;
    if (!child || child.exitCode !== null || child.signalCode) return;
    if (!child.connected) return stopChild(child);
    const finished = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.disconnect();
    const timeout = new AbortController();
    try {
      await Promise.race([finished, sleep(5000, undefined, { signal: timeout.signal })]);
    } finally {
      timeout.abort();
    }
    await stopChild(child);
  }

  async close() {
    this.closing = true;
    await this.startup?.catch(() => {});
    await this.stopManaged();
  }
}
