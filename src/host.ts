import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
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
}
export async function list(platform: Platform): Promise<Target[]> {
  if (platform === 'ios') {
    const devices = JSON.parse(await run('xcrun', ['xcdevice', 'list', '--timeout', '2'])) as {
      simulator: boolean;
      modelName: string;
      identifier: string;
      available: boolean;
    }[];
    return devices
      .filter((d) => !d.simulator && d.modelName?.startsWith('iPhone'))
      .map((d) => ({ platform, id: d.identifier, model: d.modelName, available: d.available }));
  }
  if (platform === 'harmony') {
    const lines = (await run(hdc, ['list', 'targets', '-v'])).split('\n');
    return lines
      .map((l) => l.trim().split(/\s+/))
      .filter((parts) => parts.length >= 3 && ['USB', 'TCP'].includes(parts[1]))
      .map(([id, , state]) => ({ platform, id, model: 'HarmonyOS', available: state === 'Connected' }));
  }
  return (await run(adb, ['devices', '-l']))
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((parts) => ['device', 'offline', 'unauthorized'].includes(parts[1]))
    .map(([id, state, ...info]) => ({
      platform,
      id,
      available: state === 'device',
      model: info.find((k) => k.startsWith('model:'))?.slice(6) || 'Android',
    }));
}
