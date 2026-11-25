#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { text as streamText } from 'node:stream/consumers';
import { parseArgs } from 'node:util';
import {
  ApiClient,
  ApiError,
  isTransientApiError,
  terminalRunStatus,
  type Artifact,
  type Run,
  type RunEvent,
  type RunRequest,
} from './api-client.js';
import { discoverLocalConnection } from './local-connection.js';
import { readStepArguments, stepHelp } from './steps.js';

const stepCommands = ['tap', 'swipe', 'input', 'launch', 'back', 'waitFor'];
const bluetoothTask = 'settings.bluetoothRoundTrip';
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const json = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const serveHelp = 'omu serve [--host <address>] [--port <port>] [--state-dir <dir>] [--appium-mode <external|managed>] [--appium-url <url>] [--tls-cert <path> --tls-key <path>]';
const help = `Environment: OMU_API_URL (default local service discovery or http://127.0.0.1:18765) and OMU_API_TOKEN
${serveHelp}
omu auth token create --subject <id> [--permissions <csv>] [--devices <csv>] [--state-dir <dir>]
omu auth token revoke <tokenId> [--state-dir <dir>]
${stepHelp.replaceAll('<platform:id>', '<deviceId>')}
Coordinate taps and swipes require --observation from inspect.
omu devices --json
omu doctor --device <deviceId> --json
omu inspect --device <deviceId> --output <dir> [--include-layout]
omu run --device <deviceId> --script <file> [--repeat 5] [--output <dir>] --json
omu chat --device <deviceId> --message <request> [--vision] [--model-profile <id>] [--output <recording.json>] --json
omu agent --device <deviceId> --task <registered ID or task.json> [--vision] [--model-profile <id>] [--repeat 5] [--output <dir>] --json`;

type Device = {
  id: string;
  platform: string;
  name: string;
  state: string;
  errorCode?: string;
};

function commonArgs(args: string[]) {
  return parseArgs({
    args,
    options: {
      device: { type: 'string' },
      script: { type: 'string' },
      task: { type: 'string' },
      message: { type: 'string' },
      vision: { type: 'boolean' },
      'model-profile': { type: 'string' },
      model: { type: 'string' },
      'base-url': { type: 'string' },
      'api-key-env': { type: 'string' },
      repeat: { type: 'string' },
      output: { type: 'string' },
      'include-layout': { type: 'boolean' },
      json: { type: 'boolean' },
    },
  }).values;
}

async function deviceList(api: ApiClient) {
  const devices: Device[] = [];
  let cursor: string | undefined;
  do {
    const query: string = cursor === undefined ? 'refresh=true' : 'cursor=' + encodeURIComponent(cursor);
    const page: { items: Device[]; nextCursor?: string } = await api.json('/api/devices?' + query);
    devices.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  const { drivers } = await api.json<{ drivers: { platform: string; available: boolean }[] }>('/api/capabilities');
  return {
    devices: devices.map((device) => ({
      ...device,
      model: device.name,
      available: device.state === 'available',
    })),
    unavailable: drivers.filter((driver) => !driver.available).map((driver) => driver.platform),
  };
}

async function runAndWait(api: ApiClient, request: RunRequest) {
  let runId: string | undefined;
  let interrupted = false;
  let cancelError: string | undefined;
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    interrupted = true;
    const id = runId;
    if (id && !cancellation) {
      const requestCancel = () => api.cancelRun(id);
      cancellation = requestCancel().catch((error) => {
        if (isTransientApiError(error)) return requestCancel();
        throw error;
      }).then(() => {}, (error) => {
        cancelError = error instanceof ApiError ? error.code : 'CANCEL_REQUEST_FAILED';
      });
    }
  };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const idempotencyKey = randomUUID();
    const submit = () => api.submitRun(request, { idempotencyKey });
    const accepted = await submit().catch((error) => {
      if (isTransientApiError(error)) return submit();
      throw error;
    });
    runId = accepted.id;
    if (interrupted && !terminalRunStatus(accepted.status)) cancel();
    const run = await api.waitRun(runId);
    await cancellation;
    return { run, cancelError };
  } catch (error) {
    if (runId && error instanceof ApiError) Object.assign(error, { runId });
    throw error;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

async function artifactBytes(api: ApiClient, artifact: Artifact) {
  const response = await api.request(artifact.url, { headers: { Accept: artifact.mediaType } });
  return Buffer.from(await response.arrayBuffer());
}

async function saveCapture(api: ApiClient, run: Run, output: string, report: object) {
  const screenshot = run.artifacts.find((artifact) => artifact.kind === 'screenshot');
  if (!screenshot || !uuid.test(run.id)) throw new ApiError('API_INVALID_RESPONSE', 200);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const directory = join(output, run.id);
  const staging = await mkdtemp(join(output, '.capture-'));
  try {
    await writeFile(join(staging, 'screen.png'), await artifactBytes(api, screenshot), { mode: 0o600 });
    const layout = run.artifacts.find((artifact) => artifact.kind === 'layout');
    if (layout) {
      const name = layout.mediaType === 'application/xml' ? 'layout.xml' : 'layout.json';
      await writeFile(join(staging, name), await artifactBytes(api, layout), { mode: 0o600 });
    }
    await writeFile(join(staging, 'controls.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    await rename(staging, directory);
    return directory;
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
}

async function progressEvents(api: ApiClient, runId: string) {
  const events: { name: unknown; status: unknown }[] = [];
  let after = 0;
  do {
    const page: { items: RunEvent[]; nextAfter?: number } =
      await api.json('/api/runs/' + encodeURIComponent(runId) + '/events?limit=200&after=' + after);
    for (const event of page.items) {
      if (event.type === 'run.progress') events.push({ name: event.data.name, status: event.data.status });
    }
    if (!page.nextAfter || page.nextAfter <= after) return events;
    after = page.nextAfter;
  } while (true);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') {
    console.log(help);
    return;
  }
  if (command === 'serve' && args.length === 1 && args[0] === '--help') {
    console.log(serveHelp);
    return;
  }
  if (command === 'serve' || command === 'auth') {
    const { serveFromArgs, authFromArgs } = await import('./http.js');
    await (command === 'serve' ? serveFromArgs(args) : authFromArgs(args));
    return;
  }
  const baseURL = process.env.OMU_API_URL ?? (await discoverLocalConnection())?.url;
  const api = new ApiClient({ baseURL, token: process.env.OMU_API_TOKEN ?? '' });
  const single = stepCommands.includes(command)
    ? await readStepArguments(command, args, () => streamText(process.stdin))
    : undefined;
  const values = single ? { device: single.device } : commonArgs(args);
  if (command === 'devices') {
    json(await deviceList(api));
    return;
  }
  const deviceId = values.device;
  if (!deviceId || !uuid.test(deviceId)) throw Error('--device must be an ID from omu devices');
  const output = 'output' in values ? values.output : undefined;
  if (output !== undefined && !output.trim()) throw Error('--output requires a path');
  if (values['base-url'] !== undefined || values['api-key-env'] !== undefined)
    throw Error('Configure model endpoints and credentials on the host, then select --model-profile');
  if (values['model-profile'] !== undefined && values.model !== undefined)
    throw Error('Specify only --model-profile');
  const modelProfile = values['model-profile'] ?? values.model;
  if (modelProfile !== undefined && !modelProfile.trim()) throw Error('--model-profile requires a profile ID');
  if (command !== 'chat' && command !== 'agent' && (values.vision || modelProfile !== undefined))
    throw Error('--vision and --model-profile require chat or agent');
  if (command !== 'chat' && values.message !== undefined) throw Error('--message requires chat');
  if (command !== 'inspect' && values['include-layout']) throw Error('--include-layout requires inspect');
  if (values.repeat !== undefined && command !== 'run' && command !== 'agent')
    throw Error('--repeat requires run or agent');
  const repeat = values.repeat === undefined ? undefined : Number(values.repeat);
  if (repeat !== undefined && (!Number.isInteger(repeat) || repeat < 1 || repeat > 100))
    throw Error('--repeat must be 1..100');

  let request: RunRequest;
  if (single) {
    const { observation, ...args } = single.options;
    if (Object.values(args).some((value) => typeof value === 'number' && !Number.isFinite(value)))
      throw Error('INVALID_STEP_ARGUMENT');
    const observationId = typeof observation === 'string' ? observation : undefined;
    if (observationId !== undefined && (!observationId || observationId.length > 200))
      throw Error('INVALID_DEVICE_OR_OBSERVATION');
    if ((command === 'swipe' || 'x' in args || 'y' in args) && !observationId)
      throw Error('Coordinate steps require --observation from inspect');
    request = { deviceId, kind: 'step', input: { step: { action: command, ...args }, observationId } };
  } else if (command === 'doctor') {
    request = { deviceId, kind: 'diagnose', input: {} };
  } else if (command === 'inspect') {
    if (!output) throw Error('--output is required for inspect');
    request = { deviceId, kind: 'capture', input: { includeLayout: !!values['include-layout'] } };
  } else if (command === 'run') {
    if (!values.script) throw Error('--script is required for run');
    const script = JSON.parse(await readFile(values.script, 'utf8'));
    request = { deviceId, kind: 'script', input: { script, repeat } };
  } else if (command === 'chat') {
    const message = values.message?.trim();
    if (!message || message.length > 2000) throw Error('chat requires --message (1–2000 characters)');
    if (values.task !== undefined || values.script !== undefined)
      throw Error('chat does not accept --task or --script');
    if (output) {
      const existing = await lstat(output).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (existing) throw Error('Recording output already exists');
    }
    request = { deviceId, kind: 'chat', input: { message, modelProfile, useImages: !!values.vision } };
  } else if (command === 'agent') {
    const task = values.task;
    if (!task || values.script) throw Error('agent requires --task <registered ID or task.json>');
    if (task === bluetoothTask && values.vision) throw Error('Bluetooth Agent does not accept --vision');
    const taskInput = /^[A-Za-z][A-Za-z0-9_.-]{0,80}$/.test(task) && !task.endsWith('.json')
      ? { taskId: task }
      : { task: JSON.parse(await readFile(task, 'utf8')) };
    request = { deviceId, kind: 'agent', input: { ...taskInput, modelProfile, useImages: !!values.vision, repeat } };
  } else {
    throw Error(help);
  }

  const { run, cancelError } = await runAndWait(api, request);
  const { kind, ...result }: Record<string, unknown> = run.result ?? {};
  const report = {
    ...result,
    runId: run.id,
    deviceId,
    status: run.status,
    started: run.startedAt,
    durationMs: run.startedAt && run.finishedAt
      ? Date.parse(run.finishedAt) - Date.parse(run.startedAt)
      : undefined,
    reason: run.reason,
    error: run.reason,
    cleanupError: run.cleanupError,
    cancelError,
  };
  let succeeded = run.status === 'succeeded';
  if (command === 'doctor') succeeded = succeeded && run.result?.controllable === true;
  if (command === 'chat') {
    const recording = run.artifacts.find((artifact) => artifact.kind === 'recording');
    let recordingFile: string | undefined;
    let recordingError: string | undefined;
    if (output && recording) {
      try {
        await writeFile(output, await artifactBytes(api, recording), { flag: 'wx', mode: 0o600, flush: true });
        recordingFile = output;
      } catch (error) {
        recordingError = (error as NodeJS.ErrnoException).code || 'RECORDING_WRITE_FAILED';
      }
    }
    let events: Awaited<ReturnType<typeof progressEvents>> = [];
    let eventsError: string | undefined;
    try {
      events = await progressEvents(api, run.id);
    } catch (error) {
      eventsError = error instanceof ApiError ? error.code : 'API_INVALID_RESPONSE';
    }
    json({ ...report, stepCount: result.confirmedStepCount, events, eventsError, recordingFile, recordingError });
    succeeded &&= !recordingError;
  } else if (command === 'inspect' && succeeded) {
    const metadata = { ...report, controlsChangedDuringCapture: result.stable === false };
    try {
      const directory = await saveCapture(api, run, output!, metadata);
      json({ directory, ...metadata });
    } catch (error) {
      const artifactError = (error as NodeJS.ErrnoException).code || 'ARTIFACT_WRITE_FAILED';
      json({ ...metadata, artifactError });
      succeeded = false;
    }
  } else {
    json(report);
    if (output && (command === 'run' || command === 'agent')) {
      if (!uuid.test(run.id)) throw new ApiError('API_INVALID_RESPONSE', 200);
      await mkdir(output, { recursive: true, mode: 0o700 });
      await writeFile(join(output, run.id + '.json'), JSON.stringify(report, null, 2) + '\n', {
        flag: 'wx', mode: 0o600,
      });
    }
  }
  process.exitCode = succeeded ? 0 : 1;
}

main().catch((error) => {
  if (error instanceof ApiError) {
    json({ status: 'failed', error: error.code, detail: error.detail, runId: 'runId' in error ? error.runId : undefined });
    process.exitCode = [400, 413, 415, 422].includes(error.status) ||
      ['API_INVALID_URL', 'API_TOKEN_REQUIRED', 'API_TOKEN_INVALID'].includes(error.code) ? 2 : 1;
  } else {
    console.error(error.message);
    process.exitCode = 2;
  }
});
