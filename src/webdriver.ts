import { bluetoothDefinition } from './bluetooth-task.js';
import { DOMParser } from '@xmldom/xmldom';
import { adbPath, run } from './host.js';
import { nodeXPath, xmlControls } from './native-layout.js';
import { isTransientObservation, reason } from './observation.js';
import {
  isAppIdentifier,
  inputValue,
  pointInView,
  type Control,
  type LaunchStep,
  type Step,
  type View as StepView,
} from './steps.js';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Device, Move, Screen } from './navigation.js';
import type { Dispatch } from './session.js';

type Family = 'android' | 'ios';
type Locator = { using: string; value: string };
type View = Screen & { forward?: Locator; back?: Locator };
const { ios: iosSettings, android: androidSettings } = bluetoothDefinition.apps;
const elementKey = 'element-6066-11e4-a52e-4f735466cecf';
const other: View = { page: 'other' };
function androidTitle(label: string): Locator {
  return {
    using: '-android uiautomator',
    value: `new UiSelector().packageName("com.android.settings").resourceId("android:id/title").text(${JSON.stringify(label)})`,
  };
}
const navigationLabels = new Set([
  '已连接的设备',
  'Connected devices',
  '连接偏好设置',
  'Connection preferences',
  '蓝牙',
  'Bluetooth',
  '网络和互联网',
  '网络和 Internet',
  'Network & internet',
  '显示',
  'Display',
  '配对新设备',
  'Pair new device',
  '投射',
  'Cast',
  'NFC',
  '打印',
  'Printing',
]);

export function classifyXml(platform: Family, source: string): View {
  const document = new DOMParser().parseFromString(source, 'application/xml');
  const nodes = Array.from(document.getElementsByTagName('*'));
  const geometry = (node: (typeof nodes)[number]) =>
    ['x', 'y', 'width', 'height', 'bounds'].map((k) => node.getAttribute(k) || '').join(',');
  if (platform === 'ios') {
    const visible = nodes.filter((n) => n.getAttribute('visible') === 'true');
    if (
      visible.some((n) =>
        ['XCUIElementTypeAlert', 'XCUIElementTypeSheet'].includes(n.getAttribute('type') || ''),
      )
    )
      return other;
    const match = (type: string, name: string) =>
      visible.filter(
        (n) => n.getAttribute('type') === 'XCUIElementType' + type && n.getAttribute('name') === name,
      );
    if (
      match('Button', 'com.apple.settings.bluetooth').length === 1 &&
      match('Button', 'com.apple.settings.wifi').length === 1
    ) {
      const rows = visible.filter(
        (n) =>
          n.getAttribute('type') === 'XCUIElementTypeButton' &&
          ['com.apple.settings.wifi', 'com.apple.settings.bluetooth'].includes(
            n.getAttribute('name') || '',
          ),
      );
      return {
        page: 'home',
        marker: 'com.apple.settings.bluetooth',
        entries: rows.map((n) => {
          const key = n.getAttribute('name')!;
          const allowed = key === 'com.apple.settings.bluetooth';
          // The full accessibility label can contain the current SSID or accessory name.
          const title = Array.from(n.getElementsByTagName('XCUIElementTypeStaticText'))
            .map((text) => text.getAttribute('label'))
            .find((text) => ['蓝牙', 'Bluetooth', 'Wi-Fi', '无线局域网', 'WLAN'].includes(text || ''));
          return { key, allowed, label: title || (allowed ? 'Bluetooth' : 'Wi-Fi') };
        }),
        layoutKey: rows.map(geometry).join('/'),
        forward: { using: 'accessibility id', value: 'com.apple.settings.bluetooth' },
      };
    }
    const toggles = match('Switch', 'BLUETOOTH');
    const value = toggles[0]?.getAttribute('value');
    if (
      toggles.length === 1 &&
      (value === '0' || value === '1') &&
      match('Button', 'BackButton').length === 1
    )
      return {
        page: 'bluetooth',
        bluetooth: value === '1',
        marker: 'BLUETOOTH',
        layoutKey: geometry(match('Button', 'BackButton')[0]) + '/' + geometry(toggles[0]),
        back: { using: 'accessibility id', value: 'BackButton' },
      };
    // iOS 18 exposes localized names for the switch and the parent-page back button.
    for (const [title, parent] of [
      ['Bluetooth', 'Settings'],
      ['蓝牙', '设置'],
    ]) {
      const bars = [...match('NavigationBar', 'Bluetooth'), ...match('NavigationBar', '蓝牙')];
      const switches = match('Switch', title);
      const buttons = match('Button', parent);
      const state = switches[0]?.getAttribute('value');
      if (
        bars.length === 1 &&
        buttons.length === 1 &&
        switches.length === 1 &&
        bars[0].contains(buttons[0]) &&
        (state === '0' || state === '1')
      ) {
        return {
          page: 'bluetooth',
          bluetooth: state === '1',
          marker: title + ' navigation bar + switch',
          layoutKey: geometry(buttons[0]) + '/' + geometry(switches[0]),
          back: {
            using: '-ios predicate string',
            value: `type == "XCUIElementTypeButton" AND name == "${parent}" AND visible == 1`,
          },
        };
      }
    }
    return other;
  }
  const owned = nodes.filter((n) => n.getAttribute('package') === androidSettings);
  if (
    nodes.some(
      (n) =>
        n.getAttribute('resource-id') === 'android:id/alertTitle' ||
        n.getAttribute('package') === 'com.android.permissioncontroller',
    )
  )
    return other;
  const id = (value: string) => owned.filter((n) => n.getAttribute('resource-id') === value);
  const switchLabel = id(androidSettings + ':id/switch_text');
  const toggle = id('android:id/switch_widget').filter(
    (n) => n.getAttribute('class') === 'android.widget.Switch' && n.getAttribute('checkable') === 'true',
  );
  const checked = toggle[0]?.getAttribute('checked');
  if (
    switchLabel.length === 1 &&
    ['启用蓝牙', '使用蓝牙', 'Use Bluetooth'].includes(switchLabel[0].getAttribute('text') || '') &&
    toggle.length === 1 &&
    (checked === 'true' || checked === 'false')
  )
    return {
      page: 'bluetooth',
      marker: 'switch_text:bluetooth + switch_widget',
      layoutKey: geometry(toggle[0]),
      bluetooth: checked === 'true',
    };
  const routes = [
    { page: 'home', labels: ['已连接的设备', 'Connected devices'] },
    { page: 'connected', labels: ['连接偏好设置', 'Connection preferences'] },
    { page: 'preferences', labels: ['蓝牙', 'Bluetooth'] },
  ] as const;
  for (const route of routes) {
    if (route.page === 'home' && id(androidSettings + ':id/homepage_title').length !== 1) continue;
    const entries = id('android:id/title').filter((n) =>
      route.labels.some((l) => l === n.getAttribute('text')),
    );
    if (entries.length === 1) {
      const label = entries[0].getAttribute('text')!;
      const titles = id('android:id/title');
      const rows = titles.filter((n) => {
        const text = n.getAttribute('text') || '';
        return (
          navigationLabels.has(text) &&
          titles.filter((other) => other.getAttribute('text') === text).length === 1
        );
      });
      return {
        page: route.page,
        marker: 'android:id/title:' + label,
        entries: rows.map((n) => {
          const key = n.getAttribute('text')!;
          return { key, label: key, allowed: route.labels.some((l) => l === key) };
        }),
        layoutKey: rows.map(geometry).join('/'),
        forward: androidTitle(label),
      };
    }
  }
  return other;
}

class AppiumError extends Error {
  constructor(readonly code: string | undefined, detail: string) {
    super('Appium: ' + detail);
  }
}
function lostElement(error: unknown) {
  return (
    error instanceof AppiumError &&
    (error.code === 'stale element reference' || error.code === 'no such element')
  );
}
// Only observational requests may expose a stale target as safe to re-observe.
async function observed<T>(response: Promise<T>): Promise<T> {
  try {
    return await response;
  } catch (error) {
    if (lostElement(error)) throw new Error('STALE_OBSERVATION');
    if (error instanceof AppiumError && error.code === 'no such window')
      throw new Error('FOREGROUND_APP_UNAVAILABLE');
    throw error;
  }
}
async function request<T>(url: string, method: string, data?: unknown, timeout = 20000): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(timeout),
  });
  const { value } = (await res.json()) as { value: T & { message?: string; error?: string } };
  if (!res.ok || value?.error)
    throw new AppiumError(
      value?.error,
      (value?.message || value?.error || res.status).toString().split('\n')[0],
    );
  return value;
}
export function appiumEndpoint(value = process.env.OMU_APPIUM_URL || 'http://127.0.0.1:4723') {
  let base: URL;
  try {
    base = new URL(value);
  } catch {
    throw new Error('APPIUM_INVALID_URL');
  }
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) ||
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.port === '0'
  )
    throw new Error('APPIUM_INVALID_URL');
  return base;
}
export class WebDriver implements Device {
  private readonly adb = adbPath();

  private constructor(
    readonly platform: Family,
    readonly id: string,
    private url: string,
    private dispatch: Dispatch,
  ) {}
  static async open(
    platform: Family,
    id: string,
    dispatch: Dispatch,
    mode: 'settings' | 'foreground' = 'settings',
  ) {
    const base = appiumEndpoint();
    const caps: Record<string, unknown> = {
      platformName: platform === 'ios' ? 'iOS' : 'Android',
      'appium:automationName': platform === 'ios' ? 'XCUITest' : 'UiAutomator2',
      'appium:udid': id,
      'appium:noReset': true,
      'appium:newCommandTimeout': 90,
    };
    if (mode === 'foreground') caps['appium:autoLaunch'] = false;
    if (platform === 'ios') {
      if (mode === 'settings') caps['appium:bundleId'] = iosSettings;
      caps['appium:shouldTerminateApp'] = false;
      if (process.env.OMU_IOS_XCCONFIG) caps['appium:xcodeConfigFile'] = process.env.OMU_IOS_XCCONFIG;
      else if (process.env.OMU_IOS_TEAM_ID) {
        caps['appium:xcodeOrgId'] = process.env.OMU_IOS_TEAM_ID;
        caps['appium:xcodeSigningId'] = 'Apple Development';
      }
      caps['appium:updatedWDABundleId'] =
        process.env.OMU_WDA_BUNDLE_ID || 'com.castorworks.openmobileuse.wda';
      if (process.env.OMU_WDA_PORT) caps['appium:wdaLocalPort'] = Number(process.env.OMU_WDA_PORT);
    }
    const sessions = base.href.replace(/\/$/, '') + '/session';
    const { sessionId } = await request<{ sessionId: string }>(
      sessions,
      'POST',
      { capabilities: { alwaysMatch: caps, firstMatch: [{}] } },
      240000,
    );
    return new WebDriver(platform, id, sessions + '/' + sessionId, dispatch);
  }
  private mobile<T>(name: string, args: object = {}) {
    return request<T>(this.url + '/execute/sync', 'POST', { script: 'mobile: ' + name, args: [args] });
  }
  async foregroundApp() {
    const app =
      this.platform === 'ios'
        ? (await observed(this.mobile<{ bundleId?: string } | null>('activeAppInfo')))?.bundleId
        : await observed(this.mobile<string>('getCurrentPackage'));
    if (!app) throw new Error('FOREGROUND_APP_UNAVAILABLE');
    return app;
  }
  private async settingsActive() {
    return (await this.foregroundApp()) === (this.platform === 'ios' ? iosSettings : androidSettings);
  }
  async launch(step: LaunchStep) {
    if (!isAppIdentifier(step.app)) throw new Error('INVALID_APP_ID');
    if (this.platform === 'ios') {
      const app = step.app === 'settings' ? iosSettings : step.app;
      if (!(await this.mobile<boolean>('isAppInstalled', { bundleId: app })))
        throw new Error('APP_NOT_INSTALLED');
      // WDA launches a stopped app and activates an already running one.
      await this.dispatch('launch', () => this.mobile('launchApp', { bundleId: app }));
      return app;
    }
    const shell = (...args: string[]) => run(this.adb, ['-s', this.id, 'shell', ...args]);
    const settings = step.app === 'settings';
    const intent = settings
      ? ['-a', 'android.settings.SETTINGS']
      : ['-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-p', step.app];
    const resolved = await shell(
      'cmd',
      'package',
      'resolve-activity',
      '--brief',
      '--user',
      'current',
      ...intent,
    );
    const component = resolved.split(/\r?\n/).at(-1) ?? '';
    const [app, activity] = component.split('/');
    if (!isAppIdentifier(app) || !activity || (settings ? app === 'android' : app !== step.app)) {
      if (!settings) {
        const packages = await shell('pm', 'list', 'packages', '--user', 'current', step.app);
        if (!packages.split(/\r?\n/).includes('package:' + step.app))
          throw new Error('APP_NOT_INSTALLED');
      }
      throw new Error('APP_NOT_LAUNCHABLE');
    }
    let rejected = false;
    await this.dispatch('launch', async () => {
      const response = await shell(
        'am',
        'start',
        '-W',
        '--user',
        'current',
        ...intent,
        ...(settings ? ['-p', app] : ['-n', component]),
      );
      rejected = /^Error:/m.test(response);
      if (!rejected && !/^Status:\s*ok\s*$/m.test(response)) throw new Error('LAUNCH_REPLY_UNAVAILABLE');
    });
    if (rejected) throw new Error('APP_LAUNCH_REJECTED');
    return app;
  }
  async observe(): Promise<View> {
    if (!(await this.settingsActive())) return other;
    return classifyXml(this.platform, await observed(request<string>(this.url + '/source', 'GET')));
  }
  async snapshot(): Promise<StepView> {
    return observed(this.readSnapshot());
  }
  private async readSnapshot(): Promise<StepView> {
    const app = await this.foregroundApp();
    const rotation = async () => (await request<{ z: number }>(this.url + '/rotation', 'GET')).z;
    const angle = await rotation();
    const { width, height } = await request<{ width: number; height: number }>(
      this.url + '/window/rect',
      'GET',
    );
    if (
      !Number.isInteger(width) ||
      width <= 0 ||
      !Number.isInteger(height) ||
      height <= 0 ||
      !Number.isFinite(angle)
    )
      throw new Error('DISPLAY_GEOMETRY_UNAVAILABLE');
    const layout = await request<string>(this.url + '/source', 'GET');
    if (app !== (await this.foregroundApp()) || angle !== (await rotation()))
      throw new Error('STALE_OBSERVATION');
    const controls = xmlControls(this.platform, layout, app, width, height);
    if (
      this.platform === 'ios' &&
      controls.some((n) => n.editable) &&
      !controls.some((n) => n.editable && n.focused)
    ) {
      // WDA omits keyboard focus from iOS XML. Resolve its active element against the same tree.
      let active: Record<string, string> | null = null;
      try {
        active = await request(this.url + '/element/active', 'GET');
      } catch (e) {
        const noActiveElement =
          e instanceof AppiumError &&
          (e.code === 'no such element' ||
            ((!e.code || e.code === 'unknown error') &&
              /no such element|could not be located|unable to find/i.test(e.message)));
        if (!noActiveElement) throw e;
      }
      if (active?.[elementKey]) {
        const base = this.url + '/element/' + encodeURIComponent(active[elementKey]);
        const rect = await request<Control['bounds']>(base + '/rect', 'GET');
        const hits = controls.filter(
          (n) =>
            n.editable &&
            n.bounds.x === rect.x &&
            n.bounds.y === rect.y &&
            n.bounds.width === rect.width &&
            n.bounds.height === rect.height,
        );
        if (hits.length === 1) hits[0].focused = true;
      }
    }
    const window = this.platform === 'android' ? await this.mobile<string>('getCurrentActivity') : app;
    return {
      app,
      window,
      width,
      height,
      rotation: angle,
      controls,
      layout,
      screen:
        app === (this.platform === 'ios' ? iosSettings : androidSettings)
          ? classifyXml(this.platform, layout)
          : other,
    };
  }
  async screenshot() {
    return Buffer.from(await observed(request<string>(this.url + '/screenshot', 'GET')), 'base64');
  }
  private async touch(step: Extract<Step, { kind: 'swipe' } | { point: unknown }>, view: StepView) {
    const swipe = step.kind === 'swipe';
    const a = pointInView(view, swipe ? step.from : step.point);
    const actions: object[] = [
      { type: 'pointerMove', duration: 0, origin: 'viewport', ...a },
      { type: 'pointerDown', button: 0 },
    ];
    if (swipe)
      actions.push({
        type: 'pointerMove',
        duration: step.duration,
        origin: 'viewport',
        ...pointInView(view, step.to),
      });
    else actions.push({ type: 'pause', duration: 70 });
    actions.push({ type: 'pointerUp', button: 0 });
    await this.dispatch(step.kind, () =>
      request(this.url + '/actions', 'POST', {
        actions: [{ type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' }, actions }],
      }),
    );
  }
  private async elementURL(locator: Locator) {
    const hits = await observed(
      request<Record<string, string>[]>(this.url + '/elements', 'POST', locator),
    );
    if (hits.length !== 1 || !hits[0][elementKey]) throw new Error('AMBIGUOUS_OR_MISSING_ELEMENT');
    return this.url + '/element/' + encodeURIComponent(hits[0][elementKey]);
  }
  async back() {
    if (this.platform !== 'android') throw new Error('NAVIGATION_BUTTON_REQUIRED');
    await this.dispatch('back', () => request(this.url + '/back', 'POST', {}));
  }
  async perform(step: Step, view: StepView, node?: Control, signal?: AbortSignal) {
    if (step.kind === 'swipe' || 'point' in step) {
      await this.touch(step, view);
      return;
    }
    const field = node!;
    const url = await this.elementURL({
      using: 'xpath',
      value: nodeXPath(this.platform, view.app, field, step.selector.label),
    });
    signal?.throwIfAborted();
    if (step.kind === 'tap') {
      await this.dispatch('tap', () => request(url + '/click', 'POST', {}));
      return;
    }
    const expected = inputValue(field.value ?? '', step);
    const readValue = async () => {
      const raw =
        (await request<string | null>(
          url + '/attribute/' + (this.platform === 'ios' ? 'value' : 'text'),
          'GET',
        )) ?? '';
      if (this.platform === 'ios')
        return raw === (await request(url + '/attribute/placeholderValue', 'GET')) ? '' : raw;
      return raw && (await request(url + '/attribute/showing-hint', 'GET')) === 'true' ? '' : raw;
    };
    const checkField = async () => {
      if ((await this.foregroundApp()) !== view.app || (await observed(readValue())) !== field.value)
        throw new Error('STALE_OBSERVATION');
      signal?.throwIfAborted();
    };
    await checkField();
    if (this.platform === 'android' && !field.focused) {
      await this.dispatch('tap', () => request(url + '/click', 'POST', {}));
      await checkField();
    }
    await this.dispatch('input', async () => {
      try {
        if (this.platform === 'android') {
          await this.mobile('replaceElementValue', {
            elementId: url.slice(url.lastIndexOf('/') + 1),
            text: expected,
          });
        } else {
          if (field.value || step.replace) await request(url + '/clear', 'POST', {});
          if (expected)
            await request(url + '/value', 'POST', { text: expected, value: Array.from(expected) });
        }
      } catch {
        throw new Error('TEXT_DRIVER_ERROR');
      }
    });
    const sameId = (n: Control) => n.id === field.id && n.role === field.role;
    let referenceLost = false;
    const verified = async () => {
      if ((await this.foregroundApp()) !== view.app) return false;
      if (!referenceLost) {
        try {
          return (await readValue()) === expected;
        } catch (error) {
          if (!lostElement(error)) throw error;
          referenceLost = true;
        }
      }
      // A refreshed accessibility tree may assign a new element handle. Reconcile from
      // the tree only when the original field can still be identified unambiguously.
      if (!field.id || view.controls.filter(sameId).length !== 1) return false;
      const fresh = await this.snapshot();
      if (fresh.app !== view.app || fresh.window !== view.window) return false;
      const hits = fresh.controls.filter(sameId);
      if (hits.length !== 1) return false;
      const current = hits[0];
      return (
        current.editable &&
        !current.secret &&
        current.value === expected &&
        nodeXPath(this.platform, fresh.app, current) === nodeXPath(this.platform, view.app, field)
      );
    };
    for (let i = 0; i < 3; i++) {
      signal?.throwIfAborted();
      try {
        if (await observed(verified())) return;
      } catch (error) {
        if (!isTransientObservation(reason(error))) throw error;
      }
      if (i < 2) await sleep(120, undefined, { signal });
    }
    throw new Error('INPUT_NOT_VERIFIED');
  }
  async move(action: Move, from: Screen, entryKey?: string) {
    if (action === 'openSettings') {
      await this.dispatch(action, async () => {
        if (this.platform === 'ios') await this.mobile('activateApp', { bundleId: iosSettings });
        else
          await run(this.adb, [
            '-s',
            this.id,
            'shell',
            'am',
            'start',
            '-W',
            '-a',
            'android.settings.SETTINGS',
          ]);
      });
      return;
    }
    const now = await this.observe();
    if (now.page !== from.page || now.marker !== from.marker || now.layoutKey !== from.layoutKey)
      throw new Error('STALE_OBSERVATION');
    if (
      action === 'back' &&
      this.platform === 'android' &&
      ['connected', 'bluetooth', 'preferences'].includes(now.page)
    ) {
      await this.dispatch(action, () => request(this.url + '/back', 'POST', {}));
      return;
    }
    let locator = action === 'forward' ? now.forward : now.back;
    if (action === 'tap') {
      const entry = now.entries?.find((e) => e.key === entryKey && e.allowed);
      if (!entry) throw new Error('TARGET_OUT_OF_SCOPE');
      locator =
        this.platform === 'ios'
          ? { using: 'accessibility id', value: entry.key }
          : androidTitle(entry.key);
    }
    if (!locator) throw new Error('Unsupported Settings navigation target');
    const url = await this.elementURL(locator);
    await this.dispatch(action, () => request(url + '/click', 'POST', {}));
  }
  async close() {
    await request(this.url, 'DELETE');
  }
}
