#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentToolchain, list, type Platform } from './host.js';
import { openDevice, doctor, diagnose, connectionError } from './doctor.js';
import { parseTask } from './task.js';
import { compileScript, executeRound } from './run.js';
import { pending, withDevice } from './session.js';
import { saveCapture } from './inspect.js';
import { executeStep, parseStep, stepHelp } from './steps.js';
import { text as streamText } from 'node:stream/consumers';
import { bluetoothTask } from './agent.js';
import { chatClient, modelConfig } from './chat.js';
import { runConversation } from './conversation.js';
import { maxRecordingSteps, type RecordedStep } from './recording.js';

const platforms: Platform[] = ['harmony', 'ios', 'android'];
const json = (v: unknown) => console.log(JSON.stringify(v, null, 2));
const help = `${stepHelp}
omu devices --json
omu doctor --device <platform:id> --json
omu inspect --device <platform:id> --output <dir>
omu run --device <platform:id> --script examples/settings-bluetooth.json [--repeat 5] [--output <dir>] --json
omu chat --device <platform:id> --message <request> [--vision] [--model <id>] [--base-url <url>] [--api-key-env <name>] [--output <recording.json>] --json
omu agent --device <platform:id> --task <settings.bluetoothRoundTrip|task.json> [--vision] [--model <id>] [--base-url <url>] [--api-key-env <name>] [--repeat 5] [--output <dir>] --json`;
function commonArgs(args: string[]) {
  return parseArgs({
    args,
    options: {
      device: { type: 'string' },
      script: { type: 'string' },
      task: { type: 'string' },
      message: { type: 'string' },
      vision: { type: 'boolean' },
      model: { type: 'string' },
      'base-url': { type: 'string' },
      'api-key-env': { type: 'string' },
      repeat: { type: 'string' },
      output: { type: 'string' },
      json: { type: 'boolean' },
    },
  }).values;
}
async function main() {
  const command = process.argv[2];
  if (!command || command === '--help') {
    console.log(help);
    return;
  }
  const args = process.argv.slice(3);
  const single = ['tap', 'swipe', 'input', 'launch', 'back', 'waitFor'].includes(command)
    ? await parseStep(command, args, () => streamText(process.stdin))
    : undefined;
  const values: ReturnType<typeof commonArgs> = single ? { device: single.device } : commonArgs(args);
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
    (!single && !['doctor', 'inspect', 'run', 'agent', 'chat'].includes(command))
  )
    throw new Error(help);
  if (command === 'inspect' && !values.output) throw new Error('--output is required for inspect');
  if (command === 'run' && !values.script) throw new Error('--script is required');
  if (command === 'agent' && (!values.task || values.script))
    throw new Error('agent requires --task <registered ID or task.json>');
  const message = values.message?.trim();
  if (command === 'chat') {
    if (!message || message.length > 2000)
      throw new Error('chat requires --message (1–2000 characters)');
    if (values.task !== undefined || values.script !== undefined || values.repeat !== undefined)
      throw new Error('chat does not accept --task, --script or --repeat');
    if (values.output !== undefined) {
      if (!values.output.trim()) throw new Error('chat requires a recording file path for --output');
      const existing = await lstat(values.output).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (existing) throw new Error('Recording output already exists');
    }
  } else {
    if (values.message !== undefined) throw new Error('--message is only available for chat');
    if (values.vision && (command !== 'agent' || values.task === bluetoothTask))
      throw new Error('--vision requires a task with permitted visual controls');
  }
  const task =
    command === 'agent' && values.task !== bluetoothTask
      ? await parseTask(JSON.parse(await readFile(values.task!, 'utf8')), platform as Platform)
      : undefined;
  if (command === 'agent' && values.vision && !task?.actions.some((a) => a.visual))
    throw new Error('TASK_HAS_NO_VISUAL_ACTIONS');
  const config =
    command === 'agent' || command === 'chat'
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
  const cancel = () => cancellation.abort(new Error('CANCELLED'));
  const decide =
    config && chatClient(config, fetch, (id) => servedModels.add(id), cancellation.signal, command === 'chat');
  const script =
    command === 'run'
      ? await compileScript(JSON.parse(await readFile(values.script!, 'utf8')), platform as Platform)
      : undefined;
  const count = Number(values.repeat || 1);
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('--repeat must be 1..100');
  process.exitCode = 1;
  const runId = randomUUID();
  let targets;
  try {
    targets = await list(platform as Platform);
  } catch (e) {
    if (command !== 'doctor') throw e;
    json({
      platform,
      connected: false,
      controllable: false,
      unconfirmed: pending({ id, platform: platform as Platform, model: 'unknown', available: false }),
      probes: [{ stage: 'discovery', ok: false, error: diagnose(e) }],
    });
    return;
  }
  const target = targets.find((t) => t.id === id);
  if (command === 'doctor') {
    const device = target ?? { platform: platform as Platform, id, model: 'unknown', available: false };
    const report = await doctor(device, runId);
    json(report);
    process.exitCode = report.controllable ? 0 : 1;
    return;
  }
  if (!target?.available) {
    json({ runId, platform, status: 'failed', error: connectionError(target) });
    return;
  }
  if (command === 'chat' && message && decide) {
    const started = Date.now();
    const { signal } = cancellation;
    const steps: RecordedStep[] = [];
    const events: { name: string; status: string }[] = [];
    let cleanupError: string | undefined;
    let result: Awaited<ReturnType<typeof runConversation>>;
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
      result = await withDevice(target, runId, async (dispatch) => {
        signal.throwIfAborted();
        const device = await openDevice(target, (kind, perform) => {
          signal.throwIfAborted();
          return dispatch(kind, perform);
        });
        try {
          return await runConversation(
            device,
            values.device!,
            target.platform,
            [{ user: message }],
            decide,
            signal,
            async (step) => {
              steps.push(step);
            },
            (name, status) => events.push({ name, status }),
            () => steps.length < maxRecordingSteps,
            undefined,
            !!values.vision,
          );
        } finally {
          try {
            await device.close();
          } catch {
            cleanupError = 'DEVICE_SESSION_CLOSE_FAILED';
          }
        }
      });
    } catch (error) {
      result = {
        status: 'failed',
        reason: signal.aborted ? 'CANCELLED' : (error as Error).message,
        modelCalls: 0,
      };
    } finally {
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
    }
    let recordingFile: string | undefined;
    let recordingError: string | undefined;
    if (values.output && steps.length) {
      try {
        const recording = { schemaVersion: 2, platform: target.platform, steps };
        await writeFile(values.output, JSON.stringify(recording, null, 2) + '\n', {
          flag: 'wx',
          mode: 0o600,
          flush: true,
        });
        recordingFile = values.output;
      } catch (error) {
        recordingError = (error as NodeJS.ErrnoException).code || 'RECORDING_WRITE_FAILED';
      }
    }
    json({
      ...result,
      runId,
      platform,
      durationMs: Date.now() - started,
      modelId: config?.model,
      servedModels: [...servedModels],
      stepCount: steps.length,
      events,
      recordingFile,
      recordingError,
      cleanupError,
    });
    if (result.status === 'succeeded' && !recordingError) process.exitCode = 0;
    return;
  }
  if (single || command === 'inspect') {
    const started = Date.now();
    if (!single) await mkdir(values.output!, { recursive: true, mode: 0o700 });
    try {
      let cleanupError: string | undefined;
      const result = await withDevice(target, runId, async (dispatch) => {
        const driver = await openDevice(target, dispatch);
        try {
          return single
            ? await executeStep(driver, values.device!, single.step, single.observation)
            : await saveCapture(join(values.output!, runId), driver, values.device!);
        } finally {
          try {
            await driver.close();
          } catch {
            cleanupError = 'DEVICE_SESSION_CLOSE_FAILED';
          }
        }
      });
      json({ ...result, runId, platform, durationMs: Date.now() - started, cleanupError });
      process.exitCode = 0;
    } catch (e) {
      if (!single) throw e;
      const msg = (e as Error).message;
      json({
        runId,
        platform,
        action: single.step.kind,
        requestedApp: single.step.kind === 'launch' ? single.step.app : undefined,
        status: 'failed',
        error: /^[A-Z][A-Z_0-9]*(?=:|$)/.exec(msg)?.[0] || 'DEVICE_ERROR',
        detail: msg.startsWith('AMBIGUOUS_ELEMENT:') ? msg : undefined,
        durationMs: Date.now() - started,
      });
    }
    return;
  }
  const report = {
    runId,
    platform,
    model: target.model,
    task: config && (task?.id ?? bluetoothTask),
    modelId: config?.model,
    endpoint: config?.baseURL,
    servedModels: config ? ([] as string[]) : undefined,
    toolchain: undefined as Awaited<ReturnType<typeof agentToolchain>> | undefined,
    cleanupError: undefined as string | undefined,
    started: new Date().toISOString(),
    status: 'failed',
    rounds: [] as Awaited<ReturnType<typeof executeRound>>[],
    error: undefined as string | undefined,
  };
  if (config)
    console.error(
      'Agent → ' +
        config.baseURL +
        ' (' +
        config.model +
        (task
          ? '): task action names and checkpoints' + (values.vision ? ', requested control images' : '')
          : '): Settings navigation labels, Bluetooth state, and task checkpoints'),
    );
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    await withDevice(target, runId, async (dispatch) => {
      if (config) report.toolchain = await agentToolchain(target);
      const device = await openDevice(
        target,
        (kind, perform) => {
          cancellation.signal.throwIfAborted();
          return dispatch(kind, perform);
        },
        script?.mode ?? (task ? 'foreground' : 'settings'),
      );
      try {
        for (let i = 0; i < count; i++) {
          const round = await executeRound(
            device,
            values.device!,
            { script, task, decide, vision: !!values.vision },
            cancellation.signal,
          );
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
