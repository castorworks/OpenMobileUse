import { DOMParser } from '@xmldom/xmldom';
import { adb, run } from './host.js';
import type { Device, Move, Screen } from './navigation.js';
import type { Dispatch } from './session.js';

type Family = 'android' | 'ios';
type Locator = { using: string; value: string };
type View = Screen & { forward?: Locator; back?: Locator };
const iosSettings = 'com.apple.Preferences';
const androidSettings = 'com.android.settings';
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
      const bars = match('NavigationBar', title);
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

async function request<T>(url: string, method: string, data?: unknown, timeout = 20000): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(timeout),
  });
  const { value } = (await res.json()) as { value: T & { message?: string; error?: string } };
  if (!res.ok || value?.error)
    throw new Error(
      `Appium: ${(value?.message || value?.error || res.status).toString().split('\n')[0]}`,
    );
  return value;
}
export class WebDriver implements Device {
  private constructor(
    readonly platform: Family,
    readonly id: string,
    private url: string,
    private dispatch: Dispatch,
  ) {}
  static async open(platform: Family, id: string, dispatch: Dispatch) {
    const base = new URL(process.env.OMU_APPIUM_URL || 'http://127.0.0.1:4723');
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) ||
      !['http:', 'https:'].includes(base.protocol) ||
      base.username ||
      base.password
    )
      throw new Error('Use a loopback Appium endpoint');
    const caps: Record<string, unknown> = {
      platformName: platform === 'ios' ? 'iOS' : 'Android',
      'appium:automationName': platform === 'ios' ? 'XCUITest' : 'UiAutomator2',
      'appium:udid': id,
      'appium:noReset': true,
      'appium:newCommandTimeout': 90,
    };
    if (platform === 'ios') {
      caps['appium:bundleId'] = iosSettings;
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
  private async settingsActive() {
    const active =
      this.platform === 'ios'
        ? (await this.mobile<{ bundleId: string }>('activeAppInfo')).bundleId
        : await this.mobile<string>('getCurrentPackage');
    return active === (this.platform === 'ios' ? iosSettings : androidSettings);
  }
  async observe(): Promise<View> {
    if (!(await this.settingsActive())) return other;
    return classifyXml(this.platform, await request<string>(this.url + '/source', 'GET'));
  }
  async capture() {
    if (!(await this.settingsActive())) throw new Error('Settings is not in the foreground');
    const layout = await request<string>(this.url + '/source', 'GET');
    const screen = classifyXml(this.platform, layout);
    if (screen.page === 'other') throw new Error('Inspect requires a recognized Settings page');
    const image = Buffer.from(await request<string>(this.url + '/screenshot', 'GET'), 'base64');
    if ((await this.observe()).page !== screen.page) throw new Error('STALE_OBSERVATION');
    return { image, layout, screen };
  }
  async move(action: Move, from: Screen, entryKey?: string) {
    if (action === 'openSettings') {
      await this.dispatch(action, async () => {
        if (this.platform === 'ios') await this.mobile('activateApp', { bundleId: iosSettings });
        else
          await run(adb, [
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
    const hits = await request<Record<string, string>[]>(this.url + '/elements', 'POST', locator);
    if (hits.length !== 1 || !hits[0][elementKey]) throw new Error('AMBIGUOUS_OR_MISSING_ELEMENT');
    await this.dispatch(action, () =>
      request(this.url + '/element/' + encodeURIComponent(hits[0][elementKey]) + '/click', 'POST', {}),
    );
  }
  async close() {
    await request(this.url, 'DELETE');
  }
}
