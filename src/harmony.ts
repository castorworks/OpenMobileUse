import { bluetoothDefinition } from './bluetooth-task.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hdc, run } from './host.js';
import { isTransientObservation, reason } from './observation.js';
import { focusedHarmonyWindow, harmonyView } from './native-layout.js';
import {
  isAppIdentifier,
  inputValue,
  pointInView,
  visibleCenter,
  type Control,
  type LaunchStep,
  type Step,
  type View,
} from './steps.js';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Device, Move, Screen } from './navigation.js';
import type { Dispatch } from './session.js';
const bundle = bluetoothDefinition.apps.harmony;
const bluetoothTitle = 'bluetooth_entry.title';
const bluetoothToggle = 'Setting.Fusion.BluetoothSwitchGroup.BluetoothSwitchItem.result';
type Attr = Record<string, string>;
type Node = { attributes: Attr; children: Node[] };
interface HapModule {
  moduleName: string;
  mainElementName?: string;
  mainAbility?: string;
  abilityInfos?: { name: string }[];
}
export function harmonyEntry(output: string, app: string, step: LaunchStep) {
  if (output.startsWith('error: failed to get information')) throw new Error('APP_NOT_INSTALLED');
  const start = output.indexOf('{');
  if (start < 0) throw new Error('BUNDLE_INFO_UNAVAILABLE');
  const info = JSON.parse(output.slice(start)) as {
    name: string;
    entryModuleName?: string;
    hapModuleInfos: HapModule[];
  };
  if (info.name !== app || !Array.isArray(info.hapModuleInfos))
    throw new Error('BUNDLE_INFO_UNAVAILABLE');
  const moduleName = step.module ?? (step.ability ? undefined : info.entryModuleName);
  const entries: { module: string; ability: string }[] = [];
  for (const mod of info.hapModuleInfos) {
    if (moduleName && mod.moduleName !== moduleName) continue;
    const main = mod.mainElementName || mod.mainAbility;
    const name = step.ability ?? main;
    if (!name) continue;
    // Stage bundles can qualify mainElementName while abilityInfos lists the short name.
    const matches = (mod.abilityInfos ?? []).filter(
      (a) => a.name === name || app + '.' + a.name === name,
    );
    const names = matches.length ? matches.map((a) => a.name) : main === name ? [name] : [];
    for (const ability of names) {
      if (!isAppIdentifier(mod.moduleName) || !isAppIdentifier(ability))
        throw new Error('INVALID_HARMONY_ENTRY');
      entries.push({ module: mod.moduleName, ability });
    }
  }
  if (!entries.length) throw new Error('APP_NOT_LAUNCHABLE');
  if (entries.length !== 1) throw new Error('AMBIGUOUS_APP_ENTRY');
  return entries[0];
}
function settingsNodes(node: Node, inherited = '', result: Attr[] = []): Attr[] {
  const owner = node.attributes.bundleName
    ? node.attributes.focused === 'true'
      ? node.attributes.bundleName
      : ''
    : inherited;
  if (owner === bundle) result.push(node.attributes);
  for (const child of node.children || []) settingsNodes(child, owner, result);
  return result;
}
export function classifyHarmony(attrs: Attr[]): Screen {
  if (attrs.some((n) => ['AlertDialog', 'Dialog', 'Sheet'].includes(n.type))) return { page: 'other' };
  const switches = attrs.filter(
    (n) => n.id === bluetoothToggle && n.type === 'Toggle' && n.checkable === 'true',
  );
  if (switches.length === 1 && ['true', 'false'].includes(switches[0].checked))
    return {
      page: 'bluetooth',
      marker: bluetoothToggle,
      bluetooth: switches[0].checked === 'true',
      layoutKey: switches[0].bounds,
    };
  const titles = attrs.filter((n) => n.id === bluetoothTitle);
  if (attrs.filter((n) => n.id === 'wifi_entry.title').length === 1 && titles.length === 1) {
    const rows = attrs.filter((n) => n.id === bluetoothTitle || n.id === 'wifi_entry.title');
    return {
      page: 'home',
      marker: bluetoothTitle,
      entries: rows.map((n) => ({
        key: n.id,
        label: ['星闪和蓝牙', '蓝牙', 'Bluetooth', 'WLAN', '无线局域网', 'Wi-Fi'].includes(n.text)
          ? n.text
          : n.id,
        allowed: n.id === bluetoothTitle,
      })),
      layoutKey: rows.map((n) => n.bounds).join('/'),
    };
  }
  return { page: 'other' };
}
export class Harmony implements Device {
  constructor(
    readonly id: string,
    private dispatch: Dispatch,
  ) {}
  private async shell(...args: string[]) {
    return run(hdc, ['-t', this.id, 'shell', ...args]);
  }
  private async layout(): Promise<Node> {
    const path = '/data/local/tmp/omu-' + randomUUID() + '.json';
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const out = await this.shell('uitest', 'dumpLayout', '-p', path);
        if (out.includes(path)) return JSON.parse(await this.shell('cat', path));
        if (attempt === 0) await sleep(120);
      }
      throw new Error('HDC_LAYOUT_UNAVAILABLE');
    } finally {
      await this.shell('rm', '-f', path);
    }
  }
  private async nodes() {
    return settingsNodes(await this.layout());
  }
  async observe() {
    return classifyHarmony(await this.nodes());
  }
  async foregroundApp() {
    return focusedHarmonyWindow(await this.layout())?.attributes.bundleName ?? '';
  }
  async launch(step: LaunchStep) {
    if (!isAppIdentifier(step.app)) throw new Error('INVALID_APP_ID');
    const app = step.app === 'settings' ? bundle : step.app;
    const entry = harmonyEntry(await this.shell('bm', 'dump', '-n', app), app, step);
    let rejected = false;
    await this.dispatch('launch', async () => {
      const response = await this.shell(
        'aa',
        'start',
        '-b',
        app,
        '-m',
        entry.module,
        '-a',
        entry.ability,
      );
      rejected = /^error:|^failed to start ability/im.test(response);
      if (!rejected && !response.includes('start ability successfully'))
        throw new Error('LAUNCH_REPLY_UNAVAILABLE');
    });
    if (rejected) throw new Error('APP_LAUNCH_REJECTED');
    return app;
  }
  async snapshot() {
    const layout = await this.layout();
    const display = await this.shell('hidumper', '-s', 'DisplayManagerService', '-a', '-a');
    const match = /^\s*ScreenRotation:\s*(0|1|2|3|90|180|270)\s*$/m.exec(display);
    if (!match) throw new Error('DISPLAY_ROTATION_UNAVAILABLE');
    const raw = Number(match[1]);
    const view = harmonyView(layout, raw <= 3 ? raw * 90 : raw);
    view.screen = classifyHarmony(settingsNodes(layout));
    return view;
  }
  async screenshot() {
    const path = '/data/local/tmp/omu-' + randomUUID() + '.png';
    const dir = await mkdtemp(join(tmpdir(), 'omu-capture-'));
    try {
      const out = await this.shell('uitest', 'screenCap', '-p', path);
      if (!out.includes(path)) throw new Error('SCREENSHOT_UNAVAILABLE');
      const local = join(dir, 'screen.png');
      await run(hdc, ['-t', this.id, 'file', 'recv', path, local]);
      return await readFile(local);
    } finally {
      try {
        await this.shell('rm', '-f', path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }
  private async inject(...args: string[]) {
    if (!(await this.shell('uitest', 'uiInput', ...args)).includes('No Error'))
      throw new Error('HDC_INPUT_FAILED');
  }
  async back() {
    await this.dispatch('back', () => this.inject('keyEvent', 'Back'));
  }
  async perform(step: Step, view: View, node?: Control, signal?: AbortSignal) {
    if (step.kind === 'swipe') {
      const a = pointInView(view, step.from),
        b = pointInView(view, step.to);
      const speed = Math.min(
        40000,
        Math.max(200, Math.round((1000 * Math.hypot(b.x - a.x, b.y - a.y)) / step.duration)),
      );
      await this.dispatch('swipe', () =>
        this.inject('swipe', String(a.x), String(a.y), String(b.x), String(b.y), String(speed)),
      );
      return;
    }
    const at = 'point' in step ? pointInView(view, step.point) : visibleCenter(view, node!.bounds);
    const tap = () => this.inject('click', String(at.x), String(at.y));
    if (step.kind === 'tap') {
      await this.dispatch('tap', tap);
      return;
    }
    const field = node!;
    const checkValue = async (expected: string | undefined) => {
      let current: View;
      try {
        current = await this.snapshot();
      } catch (e) {
        const code = reason(e);
        if (code === 'FOREGROUND_WINDOW_AMBIGUOUS') return 'INPUT_FOCUS_UNCONFIRMED';
        if (isTransientObservation(code)) return code;
        throw e;
      }
      if (current.app !== view.app || current.window !== view.window) return 'INPUT_TARGET_CHANGED';
      const hits = current.controls.filter(
        (n) =>
          n.editable && !n.secret && n.role === field.role && (field.id ? n.id === field.id : n.focused),
      );
      if (hits.length !== 1 || !hits[0].enabled || !hits[0].focused) return 'INPUT_FOCUS_UNCONFIRMED';
      const label = step.selector.label;
      if (!field.id && label && label !== field.value && !hits[0].labels.includes(label))
        return 'INPUT_TARGET_CHANGED';
      if (hits[0].value !== expected) return 'INPUT_TARGET_CHANGED';
    };
    const confirmValue = async (value: string | undefined, failure?: string) => {
      for (let attempt = 1; ; attempt++) {
        signal?.throwIfAborted();
        const issue = await checkValue(value);
        signal?.throwIfAborted();
        if (!issue) return;
        if (attempt === 3) throw new Error(failure ?? issue);
        await sleep(120, undefined, { signal });
      }
    };
    // Journal the focus tap independently. A rejected precondition has not edited the field.
    if (!field.focused) await this.dispatch('tap', tap);
    await confirmValue(field.value);
    await this.dispatch('input', async () => {
      if (!step.replace && field.value) await this.inject('keyEvent', '2072', '2082'); // Ctrl+End
      if (step.replace && field.value) {
        await this.inject('keyEvent', '2072', '2017'); // Ctrl+A
        await this.inject('keyEvent', '2055'); // Backspace
        await confirmValue('', 'FIELD_NOT_CLEARED');
      }
      if (step.text) {
        try {
          // hdc re-quotes separate argv items. Pass ONE remote command with one POSIX-quoted literal.
          const literal = "'" + step.text.replaceAll("'", "'\\''") + "'";
          const out = await this.shell('uitest uiInput text ' + literal);
          if (!out.includes('No Error')) throw new Error();
        } catch {
          throw new Error('TEXT_DRIVER_ERROR');
        }
      }
    });
    await confirmValue(inputValue(field.value ?? '', step), 'INPUT_NOT_VERIFIED');
  }
  async move(action: Move, from: Screen, entryKey?: string) {
    if (action === 'openSettings') {
      await this.dispatch(action, async () => {
        const out = await this.shell('aa', 'start', '-b', bundle, '-a', bundle + '.MainAbility');
        if (!out.includes('successfully')) throw new Error('HDC failed to open Settings');
      });
      return;
    }
    const attrs = await this.nodes();
    const current = classifyHarmony(attrs);
    if (current.page !== from.page || current.layoutKey !== from.layoutKey)
      throw new Error('STALE_OBSERVATION');
    let args: string[];
    if (action === 'back' && from.page === 'bluetooth') {
      args = ['keyEvent', 'Back'];
    } else if ((action === 'forward' || action === 'tap') && from.page === 'home') {
      const key = action === 'forward' ? bluetoothTitle : entryKey;
      if (!current.entries?.some((e) => e.allowed && e.key === key))
        throw new Error('TARGET_OUT_OF_SCOPE');
      const title = attrs.find((n) => n.id === key)!;
      const box = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(title.bounds);
      if (!box || +box[3] <= +box[1] || +box[4] <= +box[2])
        throw new Error('ELEMENT_OUTSIDE_SCREEN');
      const [left, top, right, bottom] = box.slice(1).map(Number);
      args = ['click', String(Math.floor((left + right) / 2)), String(Math.floor((top + bottom) / 2))];
    } else throw new Error('Unsupported Harmony navigation action');
    await this.dispatch(action, async () => {
      if (!(await this.shell('uitest', 'uiInput', ...args)).includes('No Error'))
        throw new Error('HDC navigation failed');
    });
  }
  async close() {}
}
