import { DOMParser, type Element as XmlElement } from '@xmldom/xmldom';
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
  const androidNodes = new Map<XmlElement, Control>();
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
    const control: Control = {
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
    };
    result.push(control);
    if (!ios) androidNodes.set(n, control);
  }
  if (platform === 'android') attachAndroidCards(androidNodes);
  return result;
}

function isCardRoot(el: XmlElement) {
  const role = el.getAttribute('class') || '';
  const id = el.getAttribute('resource-id') || '';
  return /CardView$/.test(role) ||
    /(?:RecyclerView|ListView|GridView|ViewPager2?)$/.test(el.parentElement?.getAttribute('class') || '') ||
    (/(?:Layout|ViewGroup)$/.test(role) && /(?:^|\/)(?:row|card|list_item|item_container)$/.test(id));
}

function xmlNodeTest(el: XmlElement) {
  const role = el.getAttribute('class'), id = el.getAttribute('resource-id');
  if (!role) return '*';
  return `*[@class=${xpathLiteral(role)}${id ? ' and @resource-id=' + xpathLiteral(id) : ''}]`;
}

// An anchor lives on a specific branch of the row. A title from a nested carousel belongs to its own card.
function markerPath(row: XmlElement, marker: XmlElement, label: string) {
  const path: string[] = [];
  for (let el = marker; el !== row; el = el.parentElement!) path.unshift(xmlNodeTest(el));
  const attr = ['text', 'content-desc', 'hint'].find(key => marker.getAttribute(key) === label)!;
  return `${path.join('/') || 'self::*'}[@${attr}=${xpathLiteral(label)} and not(@displayed='false')]`;
}

function attachAndroidCards(nodes: Map<XmlElement, Control>) {
  const groups = new Map<string, XmlElement[]>();
  for (const [el, c] of nodes) {
    if (!c.id || c.editable || c.secret) continue;
    const key = JSON.stringify([c.id, c.role]);
    const group = groups.get(key);
    if (group) group.push(el);
    else groups.set(key, [el]);
  }
  const labelCache = new Map<XmlElement, Map<string, XmlElement>>();
  function cardLabels(row: XmlElement) {
    const cached = labelCache.get(row);
    if (cached) return cached;
    const titles = new Map<string, XmlElement>();
    const text = new Map<string, XmlElement>();
    function visit(el: XmlElement) {
      if ((el !== row && isCardRoot(el)) || el.getAttribute('displayed') === 'false') return;
      const c = nodes.get(el);
      if (c?.editable || c?.secret) return;
      if (c) {
        const named = /title|caption|author|name/i.test(c.id);
        const labels = named || el === row ? c.labels :
          c.role.endsWith('TextView') ? [el.getAttribute('text')] : [];
        const markers = named ? titles : text;
        for (const label of labels)
          if (label && /\p{L}/u.test(label) && !markers.has(label)) markers.set(label, el);
      }
      for (let child = el.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1) visit(child as XmlElement);
      }
    }
    visit(row);
    for (const [label, el] of text) if (!titles.has(label)) titles.set(label, el);
    labelCache.set(row, titles);
    return titles;
  }
  for (const peers of groups.values()) {
    const counts = new Map<XmlElement, number>();
    if (peers.length > 1) {
      for (const el of peers) {
        for (let p: XmlElement | null = el; p; p = p.parentElement) counts.set(p, (counts.get(p) ?? 0) + 1);
      }
    }
    const rows = peers.map((el) => {
      let fallback: { row: XmlElement; depth: number } | undefined;
      let depth = 0;
      for (let p: XmlElement | null = el; p?.parentElement; p = p.parentElement, depth++) {
        const parent = p.parentElement;
        if (isCardRoot(p)) return { row: p, depth };
        // Some apps expose ordinary layout wrappers for each repeated list item.
        if (p !== el && counts.get(p) === 1 && (counts.get(parent) ?? 0) > 1) fallback = { row: p, depth };
      }
      return fallback;
    });
    const owners = new Set(rows.flatMap((r) => r ? [r.row] : []));
    const frequency = new Map<string, number>();
    if (owners.size > 1) {
      for (const row of owners) {
        for (const label of cardLabels(row).keys()) frequency.set(label, (frequency.get(label) ?? 0) + 1);
      }
    }
    rows.forEach((item, i) => {
      if (!item) return;
      const { row, depth } = item;
      const owner = nodes.get(row);
      if (!owner || owner.secret || owner.editable) return;
      for (const [label, marker] of cardLabels(row)) {
        if ((frequency.get(label) ?? 1) > 1) continue;
        const axis = depth ? `ancestor::*[${depth}]/self::` : 'self::';
        const parent = row.parentElement ? `[parent::${xmlNodeTest(row.parentElement)}]` : '';
        const ancestor = axis + xmlNodeTest(row) + parent + `[${markerPath(row, marker, label)}]`;
        nodes.get(peers[i])!.card = { label, ancestor, bounds: owner.bounds };
        break;
      }
    });
  }
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
export function nodeXPath(platform: 'android' | 'ios', app: string, n: Control, label?: string, exactBounds = true) {
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
    : { package: app, class: n.role };
  if (!ios && exactBounds) attrs.bounds = `[${b.x},${b.y}][${b.x + b.width},${b.y + b.height}]`;
  if (n.id) attrs[ios ? 'name' : 'resource-id'] = n.id;
  if (ios && n.labels[0]) attrs.label = n.labels[0];
  const conditions = Object.entries(attrs).map(([k, v]) => '@' + k + '=' + xpathLiteral(v));
  if (!ios && !exactBounds) conditions.push("not(@displayed='false')", "not(@enabled='false')");
  if (!ios && label) {
    const literal = xpathLiteral(label);
    conditions.push(`(@text=${literal} or @content-desc=${literal} or @hint=${literal})`);
  }
  return '//*[' + conditions.join(' and ') + ']';
}
