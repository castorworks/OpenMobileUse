import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { stateRoot } from './library.mjs';
import { ensureAndroid, emulatorImage } from './android-sdk.mjs';

function execute(bin, args, env, signal, timeout, input = '') {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { env, signal, timeout, maxBuffer: 2_000_000 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.trim()),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// The workbench owns this AVD directory and only stops the process it started.
export class DesktopEmulator {
  controller = new AbortController();
  constructor(confirm, report) {
    this.confirm = confirm;
    this.report = report;
  }
  ensure(withEmulator = false) {
    // Serialize installs, then recheck any additional components requested by a second caller.
    const done = (this.installing || Promise.resolve())
      .catch(() => {})
      .then(() => ensureAndroid(withEmulator, this.confirm, this.controller.signal, this.report));
    this.installing = done;
    return done;
  }
  start() {
    this.starting ??= this.prepare().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  async prepare() {
    const { sdk, bin } = await this.ensure(true);
    this.report('正在启动 Android 模拟器…');
    const env = { ...process.env, ANDROID_AVD_HOME: join(stateRoot(), 'avd') };
    const run = (bin, args, timeout, input) =>
      execute(bin, args, env, this.controller.signal, timeout, input);
    const emulator = join(sdk, 'emulator/emulator');
    const adb = join(sdk, 'platform-tools/adb');
    const image = emulatorImage();
    await mkdir(env.ANDROID_AVD_HOME, { recursive: true });
    const name = 'OpenMobileUse_API35';
    if (!existsSync(join(env.ANDROID_AVD_HOME, name + '.ini'))) {
      await run(
        join(bin, 'avdmanager'),
        ['create', 'avd', '-n', name, '-k', image],
        60000,
        'no\n',
      ).catch(() => {
        throw Error('AVD_CREATE_FAILED');
      });
    }
    if (this.closed) throw Error('CANCELLED');
    if (!this.child) {
      const child = spawn(emulator, ['-avd', name, '-no-boot-anim', '-no-snapshot'], {
        env,
        stdio: 'ignore',
      });
      this.child = child;
      child.on('error', () => {});
      child.once('close', () => {
        if (this.child === child) this.child = null;
      });
    }
    const deadline = Date.now() + 150000;
    do {
      if (!this.child || this.closed) throw Error(this.closed ? 'CANCELLED' : 'EMULATOR_START_FAILED');
      const list = await run(adb, ['devices'], 5000).catch(() => '');
      for (const [, id] of list.matchAll(/^(emulator-\d+)\s+device$/gm)) {
        const avd = await run(adb, ['-s', id, 'emu', 'avd', 'name'], 4000).catch(() => '');
        if (
          avd.split('\n')[0].trim() === name &&
          (await run(adb, ['-s', id, 'shell', 'getprop', 'sys.boot_completed'], 4000).catch(
            () => '',
          )) === '1'
        )
          return;
      }
      await wait(1000);
    } while (Date.now() < deadline);
    throw Error('EMULATOR_BOOT_TIMEOUT');
  }
  close() {
    this.closed = true;
    this.controller.abort();
    this.child?.kill('SIGTERM');
  }
}
