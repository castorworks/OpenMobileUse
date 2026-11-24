import type { Progress } from './run.js';
import { isTargetUnavailable, isTransientObservation, reason } from './observation.js';
import { setTimeout as sleep } from 'node:timers/promises';

export type Page = 'home' | 'connected' | 'preferences' | 'bluetooth' | 'other';
export interface Screen {
  page: Page;
  bluetooth?: boolean;
  marker?: string;
  entries?: { key: string; label: string; allowed: boolean }[];
  layoutKey?: string;
}
export type Move = 'openSettings' | 'forward' | 'back' | 'tap';
export interface Device {
  observe(): Promise<Screen>;
  move(action: Move, from: Screen, entryKey?: string): Promise<void>;
  close(): Promise<void>;
}

type BluetoothMarker = 'bluetooth.pageMarker' | 'settings.homeMarker';
type Step = { index: number } & (
  | { action: 'launchApp'; app: 'settings' }
  | { action: 'route'; name: 'settings.toBluetooth' | 'bluetooth.toSettingsHome' }
  | {
      action: 'waitFor';
      target: BluetoothMarker;
      timeoutMs: number;
    }
);

export function isBluetoothMarker(value: unknown): value is BluetoothMarker {
  return value === 'bluetooth.pageMarker' || value === 'settings.homeMarker';
}

export function compileBluetoothStep(step: Record<string, unknown>, index: number): Step {
  const only = (...keys: string[]) => Object.keys(step).every((key) => keys.includes(key));
  if (step.action === 'launchApp' && step.app === 'settings' && only('action', 'app'))
    return { index, action: step.action, app: step.app };
  if (
    step.action === 'route' &&
    (step.name === 'settings.toBluetooth' || step.name === 'bluetooth.toSettingsHome') &&
    only('action', 'name')
  )
    return { index, action: step.action, name: step.name };
  if (
    step.action === 'waitFor' &&
    step.state === 'visible' &&
    isBluetoothMarker(step.target) &&
    only('action', 'target', 'state', 'timeoutMs')
  ) {
    const timeoutMs = step.timeoutMs ?? 5000;
    if (typeof timeoutMs === 'number' && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000)
      return { index, action: step.action, target: step.target, timeoutMs };
  }
  throw new Error('INVALID_BLUETOOTH_STEP');
}

export async function waitForPage(
  device: Device,
  match: (s: Screen) => boolean,
  timeout: number,
  expected: string,
) {
  const end = Date.now() + timeout;
  let lastPage: Page | undefined;
  for (;;) {
    try {
      const screen = await device.observe();
      if (match(screen)) return screen;
      lastPage = screen.page;
    } catch (e) {
      const code = reason(e);
      if (!isTransientObservation(code) || Date.now() >= end) throw e;
    }
    const remaining = end - Date.now();
    if (remaining <= 0)
      throw new Error(`PAGE_NOT_OBSERVED: expected ${expected}, saw ${lastPage ?? 'unknown'}`);
    await sleep(Math.min(200, remaining));
  }
}

export async function route(device: Device, dest: 'home' | 'bluetooth', timeout: number) {
  const settings = () => waitForPage(device, (s) => s.page !== 'other', timeout, 'Settings');
  let s = await settings();
  const seen = new Set<Page>();
  let rejections = 0;
  while (s.page !== dest) {
    if (seen.has(s.page)) throw new Error(`UNSUPPORTED_ROUTE: ${s.page} to ${dest}`);
    const previous = s.page;
    try {
      await device.move(dest === 'home' ? 'back' : 'forward', s);
    } catch (e) {
      const code = reason(e);
      rejections++;
      if (rejections >= 3 || (!isTransientObservation(code) && !isTargetUnavailable(code))) throw e;
      await sleep(200);
      s = await settings();
      continue;
    }
    rejections = 0;
    seen.add(previous);
    s = await waitForPage(device, (x) => x.page !== previous && x.page !== 'other', timeout, dest);
  }
  return s;
}
export function readBluetooth(s: Screen) {
  if (s.page !== 'bluetooth' || typeof s.bluetooth !== 'boolean')
    throw new Error('BLUETOOTH_STATE_UNREADABLE');
  return s.bluetooth;
}

export async function prepareBluetooth(device: Device) {
  await device.move('openSettings', { page: 'other' });
  await route(device, 'home', 5000);
  const baseline = await route(device, 'bluetooth', 5000);
  readBluetooth(baseline);
  await route(device, 'home', 5000);
  return baseline;
}

export async function roundTrip(
  source: Device,
  script: Step[],
  signal?: AbortSignal,
  progress?: Progress,
) {
  const device: Device = {
    observe: async () => {
      signal?.throwIfAborted();
      const screen = await source.observe();
      signal?.throwIfAborted();
      return screen;
    },
    move: (...args) => {
      signal?.throwIfAborted();
      return source.move(...args);
    },
    close: () => source.close(),
  };
  const evidence: { seq: number; phase: string; page: Page; marker: string; bluetooth?: boolean }[] = [];
  const record = (phase: string, s: Screen) => {
    if (!s.marker) throw new Error('Page marker missing');
    progress?.({ kind: 'evidence', name: s.page, phase, bluetooth: s.bluetooth });
    evidence.push({
      seq: evidence.length + 1,
      phase,
      page: s.page,
      marker: s.marker,
      bluetooth: s.bluetooth,
    });
  };
  const pre = await prepareBluetooth(device);
  const initial = readBluetooth(pre);
  record('preflight', pre);
  const milestones = ['home', 'bluetooth', 'home'];
  let reached = 0;
  const steps: { index: number; action: string; status: string; durationMs: number; error?: string }[] =
    [];
  for (const step of script) {
    const started = performance.now();
    const item = { index: step.index, action: step.action, status: 'succeeded', durationMs: 0 };
    try {
      if (step.action === 'launchApp') await device.move('openSettings', { page: 'other' });
      if (step.action === 'route')
        await route(device, step.name === 'settings.toBluetooth' ? 'bluetooth' : 'home', 5000);
      if (step.action === 'waitFor') {
        const page = step.target === 'bluetooth.pageMarker' ? 'bluetooth' : 'home';
        const s = await waitForPage(device, (o) => o.page === page, step.timeoutMs, page);
        record('execution', s);
        if (page === 'bluetooth' && readBluetooth(s) !== initial)
          throw new Error('BLUETOOTH_STATE_CHANGED');
        if (page === milestones[reached]) reached++;
      }
    } catch (error) {
      const code = (error as Error).message.split(':')[0];
      progress?.({ kind: 'step', name: step.action, status: code });
      steps.push({
        ...item,
        status: 'failed',
        error: code,
        durationMs: Math.round(performance.now() - started),
      });
      return { status: 'failed', reason: code, failedStep: step.index, steps, evidence };
    }
    progress?.({ kind: 'step', name: step.action, status: 'succeeded' });
    steps.push({ ...item, durationMs: Math.round(performance.now() - started) });
  }
  if (reached !== milestones.length) throw new Error('MISSING_EXECUTION_EVIDENCE');
  await waitForPage(device, (s) => s.page === 'home', 5000, 'home');
  const post = await route(device, 'bluetooth', 5000);
  const final = readBluetooth(post);
  record('verification', post);
  record('verification', await route(device, 'home', 5000));
  if (final !== initial) throw new Error('BLUETOOTH_STATE_CHANGED');
  return { status: 'succeeded', initial, final, evidence, steps };
}
