#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { list, type Platform } from './host.js';
import { Harmony } from './harmony.js';
import { parseScript, roundTrip } from './navigation.js';
import { pending, withDevice } from './session.js';
import { WebDriver } from './webdriver.js';
import { saveCapture } from './inspect.js';

const platforms: Platform[] = ['harmony', 'ios', 'android'];
const json = (v: unknown) => console.log(JSON.stringify(v, null, 2));
const help = `omu devices --json
omu doctor --device <platform:id> --json
omu inspect --device <platform:id> --output <dir>
omu run --device <platform:id> --script examples/settings-bluetooth.json [--repeat 5] [--output <dir>] --json`;
async function main() {
  const command = process.argv[2];
  if (!command || command === '--help') {
    console.log(help);
    return;
  }
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      device: { type: 'string' },
      script: { type: 'string' },
      repeat: { type: 'string' },
      output: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  if (command === 'devices') {
    const result = await Promise.allSettled(platforms.map(list));
    json({
      devices: result.flatMap((r) =>
        r.status === 'fulfilled' ? r.value.map((d) => ({ ...d, id: d.platform + ':' + d.id })) : [],
      ),
      unavailable: platforms.filter((_, i) => result[i].status === 'rejected'),
    });
    return;
  }
  const [platform, ...rest] = (values.device || '').split(':');
  const id = rest.join(':');
  if (
    !platforms.includes(platform as Platform) ||
    !id ||
    !['doctor', 'inspect', 'run'].includes(command)
  )
    throw new Error(help);
  if (command === 'inspect' && !values.output) throw new Error('--output is required for inspect');
  if (command === 'run' && !values.script) throw new Error('--script is required');
  const script =
    command === 'run' ? parseScript(JSON.parse(await readFile(values.script!, 'utf8'))) : [];
  const count = Number(values.repeat || 1);
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('--repeat must be 1..100');
  process.exitCode = 1;
  const target = (await list(platform as Platform)).find((t) => t.id === id);
  if (command === 'doctor') {
    const device = target ?? { platform: platform as Platform, id, model: 'unknown', available: false };
    json({ platform, model: device.model, connected: device.available, unconfirmed: pending(device) });
    process.exitCode = device.available ? 0 : 1;
    return;
  }
  if (!target?.available) throw new Error('DEVICE_UNAVAILABLE');
  const runId = randomUUID();
  if (command === 'inspect') {
    await mkdir(values.output!, { recursive: true, mode: 0o700 });
    const capture = await withDevice(target, runId, async (dispatch) => {
      const device =
        target.platform === 'harmony'
          ? new Harmony(id, dispatch)
          : await WebDriver.open(target.platform, id, dispatch);
      try {
        return await saveCapture(join(values.output!, runId), await device.capture());
      } finally {
        await device.close();
      }
    });
    json(capture);
    process.exitCode = 0;
    return;
  }
  const report = {
    runId,
    platform,
    model: target.model,
    started: new Date().toISOString(),
    status: 'failed',
    rounds: [] as Awaited<ReturnType<typeof roundTrip>>[],
    error: undefined as string | undefined,
  };
  try {
    await withDevice(target, runId, async (dispatch) => {
      const device =
        target.platform === 'harmony'
          ? new Harmony(id, dispatch)
          : await WebDriver.open(target.platform, id, dispatch);
      try {
        for (let i = 0; i < count; i++) {
          report.rounds.push(await roundTrip(device, script));
          console.error(`${platform}: verified ${i + 1}/${count}`);
        }
      } finally {
        await device.close();
      }
    });
    report.status = 'succeeded';
    process.exitCode = 0;
  } catch (e) {
    report.error = (e as Error).message;
  }
  json(report);
  if (values.output) {
    await mkdir(values.output, { recursive: true, mode: 0o700 });
    await writeFile(join(values.output, runId + '.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = process.exitCode || 2;
});
