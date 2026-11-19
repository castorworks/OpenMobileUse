import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const exec = promisify(execFile);
export const hdc =
  process.env.HDC_PATH ||
  '/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc';
const sdkAdb = join(
  process.env.ANDROID_HOME || join(homedir(), 'Library/Android/sdk'),
  'platform-tools/adb',
);
export const adb = process.env.ADB_PATH || (existsSync(sdkAdb) ? sdkAdb : 'adb');
export async function run(bin: string, args: string[], timeout = 12000): Promise<string> {
  // execFile avoids interpolation on the host; callers supply only fixed arguments to remote shells.
  const { stdout } = await exec(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' });
  return stdout.trim();
}
export type Platform = 'harmony' | 'ios' | 'android';
export interface Target {
  platform: Platform;
  id: string;
  model: string;
  available: boolean;
  connection?: string;
  state?: string;
  issue?: string;
}
export async function agentToolchain(target: Target) {
  if (target.platform === 'harmony') {
    const [bridge, version] = await Promise.all([
      run(hdc, ['-v']),
      run(hdc, ['-t', target.id, 'shell', 'uitest', '--version']),
    ]);
    return { driver: 'UITest', version, bridge };
  }
  const require = createRequire(import.meta.url);
  const pkg = target.platform === 'ios' ? 'appium-xcuitest-driver' : 'appium-uiautomator2-driver';
  return {
    driver: pkg,
    version: require(pkg + '/package.json').version as string,
    appium: require('appium/package.json').version as string,
    source: 'local installation',
  };
}
export async function list(platform: Platform): Promise<Target[]> {
  if (platform === 'ios') {
    const devices = JSON.parse(await run('xcrun', ['xcdevice', 'list', '--timeout', '2'])) as {
      interface?: string;
      error?: { description?: string };
      simulator: boolean;
      modelName: string;
      identifier: string;
      available: boolean;
    }[];
    return devices
      .filter((d) => !d.simulator && d.modelName?.startsWith('iPhone'))
      .map((d) => ({
        platform,
        id: d.identifier,
        model: d.modelName,
        available: d.available,
        connection: d.interface,
        state: d.available ? 'device' : 'unavailable',
        issue: d.error?.description,
      }));
  }
  if (platform === 'harmony') {
    const lines = (await run(hdc, ['list', 'targets', '-v'])).split('\n');
    const targets = lines
      .map((l) => l.trim().split(/\s+/))
      .filter((parts) => parts.length >= 3 && ['USB', 'TCP'].includes(parts[1]))
      .map(([id, connection, state]) => ({
        platform,
        id,
        connection,
        state,
        model: 'HarmonyOS',
        available: state === 'Connected',
      }));
    return Promise.all(
      targets.map(async (t) => {
        if (!t.available) return t;
        try {
          const model = await run(
            hdc,
            ['-t', t.id, 'shell', 'param', 'get', 'const.product.model'],
            2000,
          );
          if (/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u.test(model)) return { ...t, model };
        } catch {
          /* Discovery is still useful when model metadata is unavailable. */
        }
        return t;
      }),
    );
  }
  return (await run(adb, ['devices', '-l']))
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((parts) => ['device', 'offline', 'unauthorized'].includes(parts[1]))
    .map(([id, state, ...info]) => ({
      platform,
      id,
      available: state === 'device',
      state,
      connection: id.startsWith('emulator-')
        ? 'emulator'
        : info.some((s) => s.startsWith('usb:'))
          ? 'usb'
          : id.includes(':')
            ? 'network'
            : 'unknown',
      model: info.find((k) => k.startsWith('model:'))?.slice(6) || 'Android',
    }));
}
