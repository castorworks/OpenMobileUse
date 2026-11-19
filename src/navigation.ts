import { setTimeout as sleep } from 'node:timers/promises';

export type Page = 'home' | 'connected' | 'preferences' | 'bluetooth' | 'other';
export interface Screen {
  page: Page;
  bluetooth?: boolean;
  marker?: string;
}
export type Move = 'openSettings' | 'forward' | 'back';
export interface Device {
  observe(): Promise<Screen>;
  move(action: Move, from: Screen): Promise<void>;
  close(): Promise<void>;
}

type Step =
  | { action: 'launchApp'; app: 'settings' }
  | { action: 'route'; name: 'settings.toBluetooth' | 'bluetooth.toSettingsHome' }
  | {
      action: 'waitFor';
      target: 'bluetooth.pageMarker' | 'settings.homeMarker';
      state: 'visible';
      timeoutMs: number;
    };
export function parseScript(raw: unknown): Step[] {
  const script = raw as { schemaVersion?: number; steps?: Record<string, unknown>[] } | null;
  if (
    script?.schemaVersion !== 1 ||
    !Array.isArray(script.steps) ||
    !script.steps.length ||
    script.steps.length > 64
  )
    throw new Error('Invalid Bluetooth navigation script');
  return script.steps.map((s, i) => {
    const only = (...keys: string[]) => Object.keys(s).every((k) => keys.includes(k));
    if (s?.action === 'launchApp' && s.app === 'settings' && only('action', 'app'))
      return { action: s.action, app: s.app };
    if (
      s?.action === 'route' &&
      (s.name === 'settings.toBluetooth' || s.name === 'bluetooth.toSettingsHome') &&
      only('action', 'name')
    )
      return { action: s.action, name: s.name };
    if (
      s?.action === 'waitFor' &&
      s.state === 'visible' &&
      (s.target === 'bluetooth.pageMarker' || s.target === 'settings.homeMarker') &&
      only('action', 'target', 'state', 'timeoutMs')
    ) {
      const ms = s.timeoutMs ?? 5000;
      if (typeof ms === 'number' && Number.isInteger(ms) && ms > 0 && ms <= 60000)
        return { action: s.action, target: s.target, state: s.state, timeoutMs: ms };
    }
    throw new Error(`Unsupported step at index ${i}`);
  });
}

async function wait(device: Device, match: (s: Screen) => boolean, timeout: number, expected: string) {
  const end = Date.now() + timeout;
  let screen: Screen;
  do {
    screen = await device.observe();
    if (match(screen)) return screen;
    if (Date.now() < end) await sleep(200);
  } while (Date.now() < end);
  throw new Error(`PAGE_NOT_OBSERVED: expected ${expected}, saw ${screen.page}`);
}

export async function roundTrip(device: Device, script: Step[]) {
  const evidence: { seq: number; phase: string; page: Page; marker: string; bluetooth?: boolean }[] = [];
  const record = (phase: string, s: Screen) => {
    if (!s.marker) throw new Error('Page marker missing');
    evidence.push({
      seq: evidence.length + 1,
      phase,
      page: s.page,
      marker: s.marker,
      bluetooth: s.bluetooth,
    });
  };
  async function route(dest: 'home' | 'bluetooth', timeout: number) {
    let s = await device.observe();
    const seen = new Set<Page>();
    while (s.page !== dest) {
      if (s.page === 'other' || seen.has(s.page))
        throw new Error(`UNSUPPORTED_ROUTE: ${s.page} to ${dest}`);
      const previous = s.page;
      seen.add(previous);
      await device.move(dest === 'home' ? 'back' : 'forward', s);
      s = await wait(device, (x) => x.page !== previous && x.page !== 'other', timeout, dest);
    }
    return s;
  }
  const readBluetooth = (s: Screen) => {
    if (s.page !== 'bluetooth' || typeof s.bluetooth !== 'boolean')
      throw new Error('BLUETOOTH_STATE_UNREADABLE');
    return s.bluetooth;
  };
  await device.move('openSettings', { page: 'other' });
  await wait(device, (s) => s.page !== 'other', 5000, 'Settings');
  await route('home', 5000);
  const pre = await route('bluetooth', 5000);
  const initial = readBluetooth(pre);
  record('preflight', pre);
  await route('home', 5000);
  const milestones = ['home', 'bluetooth', 'home'];
  let reached = 0;
  for (const step of script) {
    if (step.action === 'launchApp') await device.move('openSettings', { page: 'other' });
    if (step.action === 'route')
      await route(step.name === 'settings.toBluetooth' ? 'bluetooth' : 'home', 5000);
    if (step.action === 'waitFor') {
      const page = step.target === 'bluetooth.pageMarker' ? 'bluetooth' : 'home';
      const s = await wait(device, (o) => o.page === page, step.timeoutMs, page);
      record('execution', s);
      if (page === 'bluetooth' && readBluetooth(s) !== initial)
        throw new Error('BLUETOOTH_STATE_CHANGED');
      if (page === milestones[reached]) reached++;
    }
  }
  if (reached !== milestones.length || (await device.observe()).page !== 'home')
    throw new Error('MISSING_EXECUTION_EVIDENCE');
  const post = await route('bluetooth', 5000);
  const final = readBluetooth(post);
  record('verification', post);
  record('verification', await route('home', 5000));
  if (final !== initial) throw new Error('BLUETOOTH_STATE_CHANGED');
  return { status: 'succeeded', initial, final, evidence };
}
