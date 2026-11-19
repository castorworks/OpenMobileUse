#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentToolchain, list, type Platform } from './host.js';
import { Harmony } from './harmony.js';
import { parseScript, roundTrip } from './navigation.js';
import { pending, withDevice } from './session.js';
import { WebDriver } from './webdriver.js';
import { saveCapture } from './inspect.js';
import { bluetoothTask, runAgent } from './agent.js';
import { chatClient, modelConfig } from './chat.js';

const platforms: Platform[] = ['harmony', 'ios', 'android'];
const json = (v: unknown) => console.log(JSON.stringify(v, null, 2));
const help = `omu devices --json
omu doctor --device <platform:id> --json
omu inspect --device <platform:id> --output <dir>
omu run --device <platform:id> --script examples/settings-bluetooth.json [--repeat 5] [--output <dir>] --json
omu agent --device <platform:id> --task settings.bluetoothRoundTrip [--model <id>] [--base-url <url>] [--api-key-env <name>] [--repeat 5] [--output <dir>] --json`;
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
      task: { type: 'string' },
      model: { type: 'string' },
      'base-url': { type: 'string' },
      'api-key-env': { type: 'string' },
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
    !['doctor', 'inspect', 'run', 'agent'].includes(command)
  )
    throw new Error(help);
  if (command === 'inspect' && !values.output) throw new Error('--output is required for inspect');
  if (command === 'run' && !values.script) throw new Error('--script is required');
  if (command === 'agent' && (values.task !== bluetoothTask || values.script))
    throw new Error('agent requires --task ' + bluetoothTask);
  const config =
    command === 'agent'
      ? modelConfig({
          model: values.model,
          baseURL: values['base-url'],
          apiKeyEnv: values['api-key-env'],
        })
      : undefined;
  const servedModels = new Set<string>();
  // Device bridges are child processes. Only the HTTP client needs this credential.
  if (config?.keyEnv) delete process.env[config.keyEnv];
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  const decide = config && chatClient(config, fetch, (id) => servedModels.add(id), cancellation.signal);
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
    task: config && bluetoothTask,
    modelId: config?.model,
    endpoint: config?.baseURL,
    servedModels: config ? ([] as string[]) : undefined,
    toolchain: undefined as Awaited<ReturnType<typeof agentToolchain>> | undefined,
    cleanupError: undefined as string | undefined,
    started: new Date().toISOString(),
    status: 'failed',
    rounds: [] as Awaited<ReturnType<typeof roundTrip | typeof runAgent>>[],
    error: undefined as string | undefined,
  };
  if (config)
    console.error(
      'Agent → ' +
        config.baseURL +
        ' (' +
        config.model +
        '): Settings navigation labels, Bluetooth state, and task checkpoints',
    );
  if (decide) {
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
  }
  try {
    await withDevice(target, runId, async (dispatch) => {
      if (config) report.toolchain = await agentToolchain(target);
      const device =
        target.platform === 'harmony'
          ? new Harmony(id, dispatch)
          : await WebDriver.open(target.platform, id, dispatch);
      try {
        for (let i = 0; i < count; i++) {
          const round = decide
            ? await runAgent(device, decide, undefined, cancellation.signal)
            : await roundTrip(device, script);
          report.rounds.push(round);
          if ('reason' in round && round.status !== 'succeeded') {
            report.status = round.status;
            report.error = round.reason;
            break;
          }
          console.error(`${platform}: verified ${i + 1}/${count}`);
        }
      } finally {
        try {
          await device.close();
        } catch (e) {
          if (!config) throw e;
          report.cleanupError = 'DEVICE_SESSION_CLOSE_FAILED';
        }
      }
    });
    if (report.rounds.length === count && report.rounds.every((r) => r.status === 'succeeded')) {
      report.status = 'succeeded';
      process.exitCode = 0;
    }
  } catch (e) {
    report.error = (e as Error).message;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
  if (config) report.servedModels = [...servedModels];
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
