import { DOMParser } from '@xmldom/xmldom';
import type { Bounds, Control, View } from './steps.js';
export type HarmonyNode = { attributes: Record<string, string>; children?: HarmonyNode[] };
export function bounds(s: string | null | undefined): Bounds | undefined {
  const m = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(s || '');
  if (!m) return;
  const [x, y, r, b] = m.slice(1).map(Number);
  return { x, y, width: r - x, height: b - y };
}
const labels = (...xs: (string | null | undefined)[]) => [
  ...new Set(xs.filter((s): s is string => !!s)),
];
function onScreen(b: Bounds | undefined, w: number, h: number): b is Bounds {
  return (
    !!b &&
    [b.x, b.y, b.width, b.height].every(Number.isFinite) &&
    b.width > 0 &&
    b.height > 0 &&
    b.x < w &&
    b.y < h &&
    b.x + b.width > 0 &&
    b.y + b.height > 0
  );
}
export function focusedHarmonyWindow(root: HarmonyNode) {
  const windows: HarmonyNode[] = [];
  function findWin(n: HarmonyNode) {
    if (n.attributes.bundleName) {
      if (n.attributes.focused === 'true') windows.push(n);
      return;
    }
    n.children?.forEach(findWin);
  }
  findWin(root);
  return windows.length === 1 ? windows[0] : undefined;
}
export function harmonyView(root: HarmonyNode, rotation: number): View {
  const screen = bounds(root.attributes.bounds);
  if (!screen || screen.x !== 0 || screen.y !== 0 || screen.width <= 0 || screen.height <= 0)
    throw new Error('DISPLAY_GEOMETRY_UNAVAILABLE');
  const { width, height } = screen;
  const win = focusedHarmonyWindow(root);
  if (!win) throw new Error('FOREGROUND_WINDOW_AMBIGUOUS');
  const controls: Control[] = [];
  function collect(n: HarmonyNode, searchFocused = false) {
    const a = n.attributes,
      b = bounds(a.bounds);
    if (a.visible === 'false') return;
    if (onScreen(b, width, height) && a.type) {
      const editable = ['TextInput', 'TextArea', 'SearchField', 'RichEditor'].includes(a.type);
      const secret =
        a.password === 'true' ||
        a.type.toLowerCase().includes('password') ||
        /^(password|newpassword|numberpassword)$/i.test(a.inputType || '');
      controls.push({
        id: a.id || '',
        labels: labels(a.text, a.description, a.hint),
        role: a.type,
        bounds: b,
        enabled: a.enabled !== 'false',
        focused: a.focused === 'true' || (searchFocused && a.type === 'SearchField'),
        editable,
        secret,
        checked: a.checkable === 'true' || a.type === 'Toggle' ? a.checked === 'true' : undefined,
        value: editable && !secret ? a.text : undefined,
      });
    }
    n.children?.forEach((c) =>
      collect(c, searchFocused || (a.type === 'Search' && a.focused === 'true')),
    );
  }
  collect(win);
  return {
    app: win.attributes.bundleName,
    window: [
      win.attributes.hostWindowId,
      win.attributes.abilityName,
      win.attributes.pagePath,
      win.attributes.bounds,
    ].join('/'),
    width,
    height,
    rotation,
    controls,
    layout: root,
    screen: { page: 'other' },
  };
}
export function xmlControls(
  platform: 'android' | 'ios',
  source: string,
  app: string,
  width: number,
  height: number,
): Control[] {
  const doc = new DOMParser().parseFromString(source, 'application/xml');
  const result: Control[] = [];
  for (const n of Array.from(doc.getElementsByTagName('*'))) {
    const a = (k: string) => n.getAttribute(k) ?? '';
    const ios = platform === 'ios';
    if (ios ? a('visible') !== 'true' : a('package') !== app || a('displayed') === 'false') continue;
    const b = ios
      ? { x: Number(a('x')), y: Number(a('y')), width: Number(a('width')), height: Number(a('height')) }
      : bounds(a('bounds'));
    if (!onScreen(b, width, height)) continue;
    const role = a(ios ? 'type' : 'class'),
      secret = a('password') === 'true' || role === 'XCUIElementTypeSecureTextField';
    const editable = ios
      ? ['XCUIElementTypeTextField', 'XCUIElementTypeTextView', 'XCUIElementTypeSearchField'].includes(
          role,
        )
      : role === 'android.widget.EditText' || a('editable') === 'true';
    const value = ios ? a('value') : a('text');
    let navigation = false;
    if (ios && role === 'XCUIElementTypeButton') {
      navigation = [a('name'), a('label')].some((s) =>
        ['BackButton', 'Back', '返回', 'Cancel', '取消'].includes(s),
      );
      for (
        let ancestor = n.parentNode;
        !navigation && ancestor?.nodeType === 1;
        ancestor = ancestor.parentNode
      ) {
        navigation = (ancestor as typeof n).getAttribute('type') === 'XCUIElementTypeNavigationBar';
      }
    }
    result.push({
      navigation: navigation || undefined,
      checked: ios
        ? role === 'XCUIElementTypeSwitch'
          ? value === '1'
          : undefined
        : a('checkable') === 'true'
          ? a('checked') === 'true'
          : undefined,
      id: a(ios ? 'name' : 'resource-id'),
      labels: ios ? labels(a('label')) : labels(a('text'), a('content-desc'), a('hint')),
      role,
      bounds: b,
      enabled: a('enabled') !== 'false',
      focused: a('focused') === 'true',
      editable,
      secret,
      value:
        editable && !secret
          ? (ios && value === a('placeholderValue')) || (!ios && a('showing-hint') === 'true')
            ? ''
            : value
          : undefined,
    });
  }
  return result;
}
export function xpathLiteral(s: string) {
  if (!s.includes("'")) return "'" + s + "'";
  if (!s.includes('"')) return '"' + s + '"';
  return (
    'concat(' +
    s
      .split("'")
      .map((part) => "'" + part + "'")
      .join(', "\'", ') +
    ')'
  );
}
export function nodeXPath(platform: 'android' | 'ios', app: string, n: Control, label?: string) {
  const b = n.bounds,
    ios = platform === 'ios';
  const attrs: Record<string, string> = ios
    ? {
        type: n.role,
        x: String(b.x),
        y: String(b.y),
        width: String(b.width),
        height: String(b.height),
        visible: 'true',
      }
    : { package: app, class: n.role, bounds: `[${b.x},${b.y}][${b.x + b.width},${b.y + b.height}]` };
  if (n.id) attrs[ios ? 'name' : 'resource-id'] = n.id;
  if (ios && n.labels[0]) attrs.label = n.labels[0];
  const conditions = Object.entries(attrs).map(([k, v]) => '@' + k + '=' + xpathLiteral(v));
  if (!ios && label) {
    const literal = xpathLiteral(label);
    conditions.push(`(@text=${literal} or @content-desc=${literal} or @hint=${literal})`);
  }
  return '//*[' + conditions.join(' and ') + ']';
}
