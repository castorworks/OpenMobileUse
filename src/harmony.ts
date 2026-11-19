import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hdc, run } from './host.js';
import type { Device, Move, Screen } from './navigation.js';
import type { Dispatch } from './session.js';
const bundle = 'com.huawei.hmos.settings';
const bluetoothTitle = 'bluetooth_entry.title';
const bluetoothToggle = 'Setting.Fusion.BluetoothSwitchGroup.BluetoothSwitchItem.result';
type Attr = Record<string, string>;
type Node = { attributes: Attr; children: Node[] };
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
  const switches = attrs.filter(
    (n) => n.id === bluetoothToggle && n.type === 'Toggle' && n.checkable === 'true',
  );
  if (switches.length === 1 && ['true', 'false'].includes(switches[0].checked))
    return { page: 'bluetooth', marker: bluetoothToggle, bluetooth: switches[0].checked === 'true' };
  if (
    attrs.some((n) => n.id === 'wifi_entry.title') &&
    attrs.filter((n) => n.id === bluetoothTitle).length === 1
  )
    return { page: 'home', marker: bluetoothTitle };
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
      const out = await this.shell('uitest', 'dumpLayout', '-p', path);
      if (!out.includes(path)) throw new Error('HDC layout capture failed');
      return JSON.parse(await this.shell('cat', path));
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
  async capture() {
    const layout = await this.layout();
    const screen = classifyHarmony(settingsNodes(layout));
    if (screen.page === 'other') throw new Error('Inspect requires a recognized Settings page');
    const path = '/data/local/tmp/omu-' + randomUUID() + '.png';
    const dir = await mkdtemp(join(tmpdir(), 'omu-capture-'));
    try {
      const out = await this.shell('uitest', 'screenCap', '-p', path);
      if (!out.includes(path)) throw new Error('HDC screen capture failed');
      const local = join(dir, 'screen.png');
      await run(hdc, ['-t', this.id, 'file', 'recv', path, local]);
      const image = await readFile(local);
      if ((await this.observe()).page !== screen.page) throw new Error('STALE_OBSERVATION');
      return { image, layout, screen };
    } finally {
      try {
        await this.shell('rm', '-f', path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }
  async move(action: Move, from: Screen) {
    if (action === 'openSettings') {
      await this.dispatch(action, async () => {
        const out = await this.shell('aa', 'start', '-b', bundle, '-a', bundle + '.MainAbility');
        if (!out.includes('successfully')) throw new Error('HDC failed to open Settings');
      });
      return;
    }
    const attrs = await this.nodes();
    if (classifyHarmony(attrs).page !== from.page) throw new Error('STALE_OBSERVATION');
    let args: string[];
    if (action === 'back' && from.page === 'bluetooth') {
      args = ['keyEvent', 'Back'];
    } else if (action === 'forward' && from.page === 'home') {
      const title = attrs.find((n) => n.id === bluetoothTitle)!;
      const box = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(title.bounds);
      if (!box || +box[3] <= +box[1] || +box[4] <= +box[2])
        throw new Error('Navigation entry has no visible bounds');
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
