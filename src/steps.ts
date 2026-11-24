import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Platform } from './host.js';
import { isTransientObservation, readObservation, reason } from './observation.js';

export type Point = { x: number; y: number };
export type Bounds = { x: number; y: number; width: number; height: number };
export type AndroidCard = { label: string; ancestor: string; bounds: Bounds };
export interface Control {
  id: string;
  labels: string[];
  role: string;
  bounds: Bounds;
  card?: AndroidCard;
  enabled: boolean;
  clickable?: boolean;
  focused: boolean;
  editable: boolean;
  secret: boolean;
  navigation?: boolean;
  checked?: boolean;
  value?: string;
}
export interface View {
  app: string;
  window: string;
  windowIdentity?: string;
  width: number;
  height: number;
  rotation: number;
  controls: Control[];
  layout: unknown;
}
export type Selector = {
  id?: string; label?: string; role?: string;
  within?: string; cardX?: number; cardY?: number;
};

export function isScreenContainer(view: View, node: Control) {
  if (/^(?:XCUIElementType)?(?:Application|Window)$/.test(node.role)) return true;
  const container = /^(?:XCUIElementTypeOther|.*(?:Layout|SurfaceView|TextureView)|Canvas|Stack)$/.test(
    node.role,
  );
  return container && node.bounds.width >= view.width * 0.9 && node.bounds.height >= view.height * 0.9;
}

export function screenAvailable(view: View) {
  if (view.controls.some((c) => c.secret || /Alert|Dialog|Sheet/.test(c.role)))
    throw Error('SENSITIVE_OR_BLOCKED_SCREEN');
}

export type LaunchStep = { kind: 'launch'; app: string; ability?: string; module?: string };
// These identifiers may become arguments to the device shell.
export function isAppIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/.test(value);
}
export type BackStep = { kind: 'back'; selector?: Selector };
export type WaitStep = {
  kind: 'waitFor';
  selector: Selector;
  state: 'visible' | 'hidden';
  timeoutMs: number;
};
export type CommandStep = Step | BackStep | WaitStep | LaunchStep | { kind: 'goHome' };
export type Step =
  | { kind: 'tap'; selector: Selector }
  | { kind: 'tap'; point: Point }
  | { kind: 'swipe'; from: Point; to: Point; duration: number }
  | { kind: 'input'; selector: Selector; text: string; replace: boolean };
export interface StepDevice {
  snapshot(): Promise<View>;
  screenshot(): Promise<Buffer>;
  perform(step: Step, view: View, node?: Control, signal?: AbortSignal): Promise<void>;
  back(): Promise<void>;
  goHome?(): Promise<string>;
  launch(step: LaunchStep, guard?: (targetApp: string) => void): Promise<string>;
  foregroundApp(): Promise<string>;
}
export const stepHelp = `omu tap --device <platform:id> (--id <id> | --label <label>) [--role <role>]
omu tap --device <platform:id> --x <0..1> --y <0..1>
omu swipe --device <platform:id> --from-x <x> --from-y <y> --to-x <x> --to-y <y> [--duration-ms 400]
omu input --device <platform:id> [--id <id> | --label <label>] [--role <role>] (--text <text> | --stdin) [--replace]
omu launch --device <platform:id> --app <settings|package-or-bundle-id> [--ability <name>] [--module <name>]
omu back --device <platform:id> [--id <navigation-control> | --label <name>] [--role <role>]
omu waitFor --device <platform:id> (--id <id> | --label <name>) [--role <role>] [--state visible|hidden] [--timeout-ms 5000]
For repeated Android ids, tap and waitFor accept --id <id> --role <role> --within <card label> [--card-x <0..1> --card-y <0..1>].
--ability and --module are Harmony-only. All commands accept [--observation <observationId>] [--json].`;
const stepArgumentTypes = {
  id: 'string',
  label: 'string',
  role: 'string',
  within: 'string',
  cardX: 'number',
  cardY: 'number',
  app: 'string',
  ability: 'string',
  module: 'string',
  text: 'string',
  state: 'string',
  observation: 'string',
  replace: 'boolean',
  x: 'number',
  y: 'number',
  fromX: 'number',
  fromY: 'number',
  toX: 'number',
  toY: 'number',
  durationMs: 'number',
  timeoutMs: 'number',
} as const;
type ArgumentTypes = { string: string; boolean: boolean; number: number };
type StepArgument = keyof typeof stepArgumentTypes;
type StepArguments = {
  [K in StepArgument]?: ArgumentTypes[(typeof stepArgumentTypes)[K]];
};
const stepArguments: Record<CommandStep['kind'], readonly StepArgument[]> = {
  tap: ['id', 'label', 'role', 'x', 'y', 'within', 'cardX', 'cardY'],
  input: ['id', 'label', 'role', 'text', 'replace'],
  swipe: ['fromX', 'fromY', 'toX', 'toY', 'durationMs'],
  waitFor: ['id', 'label', 'role', 'state', 'timeoutMs', 'within', 'cardX', 'cardY'],
  back: ['id', 'label', 'role'],
  goHome: [],
  launch: ['app', 'ability', 'module'],
};
type StepKind = CommandStep['kind'];

function isStepKind(kind: string): kind is StepKind {
  return Object.hasOwn(stepArguments, kind);
}

function checkStepArguments(kind: StepKind, options: Record<string, unknown>) {
  const allowed: readonly string[] = stepArguments[kind];
  if (Object.keys(options).some((key) => key !== 'observation' && !allowed.includes(key)))
    throw new Error('OPTION_NOT_SUPPORTED_FOR_STEP');
}

export function compileCommandStep(action: string, options: Record<string, unknown>, platform: Platform) {
  const kind = action === 'launchApp' ? 'launch' : action;
  if (!isStepKind(kind)) throw new Error('UNKNOWN_STEP');
  for (const [key, value] of Object.entries(options)) {
    if (
      !Object.hasOwn(stepArgumentTypes, key) ||
      typeof value !== stepArgumentTypes[key as StepArgument] ||
      (typeof value === 'number' && !Number.isFinite(value)) ||
      (key === 'replace' && kind !== 'input')
    )
      throw new Error('INVALID_STEP_ARGUMENT');
  }
  checkStepArguments(kind, options);
  return validateStep(kind, options, platform);
}

function validateStep(
  kind: StepKind,
  v: StepArguments,
  platform: string | undefined,
): { step: CommandStep; observation?: string } {
  const observation = v.observation;
  if (observation !== undefined && !/^[a-f0-9]{64}$/.test(observation))
    throw new Error('INVALID_DEVICE_OR_OBSERVATION');
  if (kind === 'goHome') {
    if (platform !== 'android') throw Error('HOME_UNAVAILABLE');
    return { step: { kind }, observation };
  }
  if (kind === 'launch') {
    if (!v.app || !isAppIdentifier(v.app)) throw new Error('INVALID_APP_ID');
    for (const name of [v.ability, v.module]) {
      if (name !== undefined && (platform !== 'harmony' || !isAppIdentifier(name)))
        throw new Error('INVALID_HARMONY_ENTRY');
    }
    const step: LaunchStep = { kind, app: v.app, ability: v.ability, module: v.module };
    return { step, observation };
  }
  const selector: Selector = { id: v.id, label: v.label, role: v.role };
  if ([v.id, v.label, v.role].includes('') || (v.id !== undefined && v.label !== undefined))
    throw new Error('INVALID_SELECTOR');
  function coordinate(value: number | undefined) {
    if (value === undefined || !Number.isFinite(value) || value < 0 || value > 1)
      throw new Error('COORDINATE_OUT_OF_RANGE');
    return value;
  }
  if (v.within !== undefined || v.cardX !== undefined || v.cardY !== undefined) {
    if (platform !== 'android' || !v.within?.trim() || !v.id || !v.role ||
      (v.cardX === undefined) !== (v.cardY === undefined)) throw Error('INVALID_SELECTOR');
    selector.within = v.within;
    if (v.cardX !== undefined) {
      selector.cardX = coordinate(v.cardX);
      selector.cardY = coordinate(v.cardY);
    }
  }
  let step: CommandStep;
  if (kind === 'back') {
    const specified = !!(selector.id || selector.label);
    if (platform === 'ios' ? !specified : specified || selector.role)
      throw new Error('BACK_REQUIRES_IOS_NAVIGATION_SELECTOR_ONLY');
    step = { kind, selector: specified ? selector : undefined };
    return { step, observation };
  }
  if (kind === 'waitFor') {
    const state = v.state ?? 'visible',
      timeoutMs = v.timeoutMs ?? 5000;
    if (
      (!selector.id && !selector.label) ||
      (state !== 'visible' && state !== 'hidden') ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 60000
    )
      throw new Error('INVALID_WAIT');
    step = { kind, selector, state, timeoutMs };
    return { step, observation };
  }
  if (kind === 'swipe') {
    const from = { x: coordinate(v.fromX), y: coordinate(v.fromY) },
      to = { x: coordinate(v.toX), y: coordinate(v.toY) };
    const duration = v.durationMs ?? 400;
    if (
      !Number.isInteger(duration) ||
      duration < 1 ||
      duration > 10000 ||
      (from.x === to.x && from.y === to.y)
    )
      throw new Error('INVALID_SWIPE');
    step = { kind, from, to, duration };
  } else if (kind === 'tap') {
    if (v.x !== undefined || v.y !== undefined) {
      if (v.id || v.label || v.role) throw new Error('MIXED_TAP_TARGET');
      step = { kind, point: { x: coordinate(v.x), y: coordinate(v.y) } };
    } else {
      if (!v.id && !v.label) throw new Error('MISSING_TAP_TARGET');
      step = { kind, selector };
    }
  } else if (kind === 'input') {
    if (v.text === undefined) throw new Error('SPECIFY_TEXT_OR_STDIN');
    const text = v.text;
    if (text.includes('\0') || (!text && !v.replace)) throw new Error('INVALID_INPUT_TEXT');
    step = { kind, selector, text, replace: !!v.replace };
  } else throw new Error(stepHelp);
  return { step, observation };
}

const cliArgumentNames: Partial<Record<string, StepArgument>> = {
  'from-x': 'fromX',
  'from-y': 'fromY',
  'to-x': 'toX',
  'to-y': 'toY',
  'duration-ms': 'durationMs',
  'timeout-ms': 'timeoutMs',
  'card-x': 'cardX',
  'card-y': 'cardY',
};

export async function parseStep(kind: string, args: string[], stdin: () => Promise<string>) {
  const str = { type: 'string' } as const,
    flag = { type: 'boolean' } as const;
  const {
    values: { device, stdin: useStdin, json: _json, ...values },
  } = parseArgs({
    args,
    options: {
      device: str,
      observation: str,
      json: flag,
      id: str,
      label: str,
      role: str,
      within: str,
      'card-x': str,
      'card-y': str,
      x: str,
      y: str,
      'from-x': str,
      'from-y': str,
      'to-x': str,
      'to-y': str,
      'duration-ms': str,
      text: str,
      stdin: flag,
      replace: flag,
      app: str,
      ability: str,
      module: str,
      state: str,
      'timeout-ms': str,
    },
  });
  if (!isStepKind(kind)) throw new Error(stepHelp);
  if (useStdin !== undefined && kind !== 'input') throw new Error('OPTION_NOT_SUPPORTED_FOR_STEP');
  const options = Object.fromEntries(
    Object.entries(values).map(([name, value]) => {
      const key = cliArgumentNames[name] ?? name;
      const type = stepArgumentTypes[key as StepArgument];
      if (type === 'number' && typeof value === 'string')
        return [key, value.trim() ? Number(value) : NaN];
      return [key, value];
    }),
  );
  checkStepArguments(kind, options);
  if (!device) throw new Error('INVALID_DEVICE_OR_OBSERVATION');
  if (useStdin) {
    if (values.text !== undefined) throw new Error('SPECIFY_TEXT_OR_STDIN');
    options.text = await stdin();
  }
  const prefix = device.indexOf(':');
  const platform = prefix === -1 ? undefined : device.slice(0, prefix);
  return { ...validateStep(kind, options, platform), device };
}
type ObservationScope =
  | CommandStep
  | { kind: 'check'; selector?: Selector }
  | { kind: 'visualTap'; point: Point };

function isPassiveScreenText(view: View, node: Control) {
  return /^(?:Text|TextView|StaticText)$/.test(controlType(node)) &&
    node.clickable === false && !node.editable && !node.focused &&
    node.bounds.width >= 0.9 * view.width && node.bounds.height >= 0.9 * view.height;
}

function controlType(node: Control) {
  return node.role.slice(node.role.lastIndexOf('.') + 1).replace(/^XCUIElementType/, '');
}

export function isIconControl(node: Control) {
  return node.clickable === true && node.enabled && !node.editable && !node.secret &&
    /^(?:Button|Icon|Image|ImageButton|ImageView)$/.test(controlType(node));
}

function visualTapControls(view: View, hits: Control[]) {
  const button = hits.at(-1);
  if (
    !button || !isIconControl(button) ||
    button.bounds.width > view.width / 4 || button.bounds.height > view.height / 4
  ) return hits;
  // A video can expose its changing playback time in a screen-sized accessibility label
  // behind the toolbar. Keep the entire hit stack, including its order and geometry.
  return hits.map((node) => isPassiveScreenText(view, node) ? { ...node, labels: [] } : node);
}

export function containsPoint(r: Bounds, p: Point) {
  return r.x <= p.x && p.x < r.x + r.width && r.y <= p.y && p.y < r.y + r.height;
}

function controlState({ bounds, card, ...state }: Control) {
  return state;
}

function observedControl(node: Control) {
  if (!node.card) return node;
  const { card, ...control } = node;
  return control;
}

function controlsInGestureRegion(view: View, a: Point, b: Point) {
  return view.controls.filter(
    ({ bounds: r }) =>
      r.x <= Math.max(a.x, b.x) &&
      r.x + r.width > Math.min(a.x, b.x) &&
      r.y <= Math.max(a.y, b.y) &&
      r.y + r.height > Math.min(a.y, b.y),
  );
}

function relevantControls(view: View, scope?: ObservationScope) {
  if (!scope) return view.controls.map(observedControl);
  if (scope.kind === 'launch' || scope.kind === 'goHome' || (scope.kind === 'check' && !scope.selector))
    return [];
  if (scope.kind === 'back' && !scope.selector)
    return view.controls.map((node) => {
      const state = controlState(node);
      if (!isPassiveScreenText(view, node)) return state;
      // The elapsed time can tick while checking a system Back. Keep the total
      // duration, captions and other controls as evidence of the current page.
      const [label = '', ...rest] = state.labels;
      const time = /^(?:\d{1,2}:)?\d{1,2}:[0-5]\d(\s*\/\s*(?:\d{1,2}:)?\d{1,2}:[0-5]\d)?$/.exec(label);
      return time ? { ...state, labels: [{ duration: time[1] ?? '' }, ...rest] } : state;
    });
  if ('selector' in scope && scope.selector && (scope.selector.id || scope.selector.label)) {
    // Resolve the same unique control in the new tree. The driver uses its current bounds.
    const hits = matchingControls(view, scope.selector);
    const states = hits.map(n => n.card ? { ...controlState(n), within: n.card.label } : controlState(n));
    if (hits.length !== 1 || scope.kind === 'check' || scope.kind === 'waitFor') return states;
    const center = visibleCenter(view, hits[0].bounds);
    const atTarget = view.controls.filter((n) => containsPoint(n.bounds, center));
    return [states, atTarget.map((c) => [c.role, c.id])];
  }
  if (
    scope.kind === 'swipe' || scope.kind === 'visualTap' ||
    (scope.kind === 'tap' && 'point' in scope)
  ) {
    const a = pointInView(view, scope.kind === 'swipe' ? scope.from : scope.point);
    const b = scope.kind === 'swipe' ? pointInView(view, scope.to) : a;
    const hits = controlsInGestureRegion(view, a, b).map(observedControl);
    return scope.kind === 'visualTap' ? visualTapControls(view, hits) : hits;
  }
  return view.controls.map(observedControl);
}

function observationHash(device: string, view: View, controls: unknown) {
  return createHash('sha256')
    .update(JSON.stringify([
      device, view.app, view.window, view.width, view.height, view.rotation, controls,
    ]))
    .digest('hex');
}

export function observationId(device: string, view: View, scope?: ObservationScope) {
  return observationHash(device, view, relevantControls(view, scope));
}

export function swipeObservation(identity: string, view: View, step?: Extract<Step, { kind: 'swipe' }>) {
  const from = step && pointInView(view, step.from);
  const to = step && pointInView(view, step.to);
  const region = from && to ? controlsInGestureRegion(view, from, to) : view.controls;
  const edges: number[] = [];
  const controls = region.map((node) => {
    const { bounds } = node;
    const state = controlState(node);
    edges.push(bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height);
    return from && to ? [state, containsPoint(bounds, from), containsPoint(bounds, to)] : state;
  });
  const tolerance = identity.startsWith('android:')
    ? Math.max(2, Math.round(Math.min(view.width, view.height) * 0.005))
    : 0;
  return { state: observationHash(identity, view, controls), edges, tolerance };
}

export function sameSwipeObservation(
  a: ReturnType<typeof swipeObservation>,
  b: ReturnType<typeof swipeObservation>,
) {
  return a.state === b.state && a.edges.every((edge, i) => Math.abs(edge - b.edges[i]) <= a.tolerance);
}

export function guardObservation(
  identity: string,
  before: View,
  scope: ObservationScope,
  check?: (view: View) => void,
) {
  if (scope.kind === 'swipe') {
    const beforeSwipe = swipeObservation(identity, before, scope);
    return (current: View) => {
      check?.(current);
      // Allow slight player animation only while both endpoints keep the same control stack.
      if (!sameSwipeObservation(beforeSwipe, swipeObservation(identity, current, scope)))
        throw Error('STALE_OBSERVATION');
    };
  }
  const expected = observationId(identity, before, scope);
  return (current: View) => {
    check?.(current);
    if (observationId(identity, current, scope) !== expected) throw Error('STALE_OBSERVATION');
  };
}
function inSelectedCard(node: Control, selector: Selector) {
  if (!selector.within) return true;
  if (node.card?.label !== selector.within) return false;
  const { cardX, cardY } = selector;
  if (cardX === undefined && cardY === undefined) return true;
  return cardX !== undefined && cardY !== undefined &&
    containsPoint(node.bounds, cardPoint(node.card.bounds, cardX, cardY));
}

export function matchingControls(view: View, selector: Selector) {
  return view.controls.filter(
    (n) =>
      (!selector.id || n.id === selector.id) &&
      (!selector.label || n.labels.includes(selector.label)) &&
      (!selector.role || n.role === selector.role) &&
      inSelectedCard(n, selector),
  );
}
export function cardPoint(bounds: Bounds, x: number, y: number): Point {
  return { x: bounds.x + x * bounds.width, y: bounds.y + y * bounds.height };
}
export function uniqueSelector(view: View, node: Control, allowCard = true) {
  const candidates: Selector[] = [];
  if (node.id) candidates.push({ id: node.id, role: node.role });
  const card = allowCard && node.card;
  if (node.id && card) candidates.push({ id: node.id, role: node.role, within: card.label });
  for (const label of node.labels) candidates.push({ label, role: node.role });
  const unique = candidates.find((s) => matchingControls(view, s).length === 1);
  if (unique || !card || !node.id) return unique;
  const center = visibleCenter(view, node.bounds);
  if (!containsPoint(card.bounds, center)) return;
  const relative: Selector = {
    id: node.id, role: node.role, within: card.label,
    cardX: (center.x - card.bounds.x) / card.bounds.width,
    cardY: (center.y - card.bounds.y) / card.bounds.height,
  };
  if (matchingControls(view, relative).length === 1) return relative;
}

export function resolveControl(view: View, selector: Selector, input: boolean) {
  const focusedOnly = input && !selector.id && !selector.label;
  const hits = matchingControls(view, selector).filter(
    (n) => !focusedOnly || (n.focused && (n.editable || n.secret)),
  );
  if (!hits.length) throw new Error(focusedOnly ? 'NO_FOCUSED_FIELD' : 'ELEMENT_NOT_FOUND');
  if (hits.length !== 1)
    throw new Error(
      'AMBIGUOUS_ELEMENT: ' +
        hits.length +
        ' matches (' +
        [...new Set(hits.map((n) => n.role))].slice(0, 5).join(', ') +
        ')',
    );
  const n = hits[0];
  if (!n.enabled) throw new Error('ELEMENT_DISABLED');
  if (input && (n.secret || !n.editable)) throw new Error('ORDINARY_EDITABLE_FIELD_REQUIRED');
  return n;
}
export function pointInView(view: View, p: Point): Point {
  return { x: Math.round(p.x * (view.width - 1)), y: Math.round(p.y * (view.height - 1)) };
}
export function visibleCenter(view: View, b: Bounds): Point {
  const l = Math.max(0, b.x),
    t = Math.max(0, b.y),
    r = Math.min(view.width, b.x + b.width),
    bottom = Math.min(view.height, b.y + b.height);
  if (r <= l || bottom <= t) throw new Error('ELEMENT_OUTSIDE_SCREEN');
  return { x: Math.floor((l + r) / 2), y: Math.floor((t + bottom) / 2) };
}
export function inputValue(before: string, step: Extract<Step, { kind: 'input' }>) {
  return step.replace ? step.text : before + step.text;
}
export function hasWrittenValue(
  before: View,
  after: View,
  field: Control,
  selectorLabel: string | undefined,
  expected: string,
) {
  if (
    after.app !== before.app ||
    after.rotation !== before.rotation ||
    after.width !== before.width ||
    after.height !== before.height ||
    (after.window !== before.window &&
      (!before.windowIdentity || after.windowIdentity !== before.windowIdentity))
  )
    return false;

  const peers = (v: View) => v.controls.filter((n) => n.editable && n.role === field.role);
  const previous = peers(before);
  const current = peers(after);
  // Harmony can change the accessibilityId on every dump. An id-less search box can
  // also replace its placeholder label with the query while suggestions echo the query below it.
  const { x, y, width, height } = field.bounds;
  let matches = (n: Control) =>
    n.bounds.x === x && n.bounds.y === y && n.bounds.width === width && n.bounds.height === height;
  if (field.id) matches = (n) => n.id === field.id;
  else if (!current.some(matches) && selectorLabel && selectorLabel !== field.value)
    matches = (n) => n.labels.includes(selectorLabel);
  if (previous.filter(matches).length !== 1) return false;
  const hits = current.filter(matches);
  if (hits.length !== 1) return false;
  const [target] = hits;
  if (target.secret || target.id !== field.id || target.value !== expected) return false;
  if (field.id) return true;
  if (target.labels.some((label) => label !== expected && !field.labels.includes(label))) return false;
  return target.focused || (previous.length === 1 && current.length === 1);
}

export class AppNotForeground extends Error {
  constructor(readonly targetApp: string) {
    super('APP_NOT_FOREGROUND');
  }
}

export async function verifyForeground(
  read: () => Promise<string>,
  target: string,
  timeoutMs = 10000,
  signal?: AbortSignal,
) {
  const deadline = performance.now() + timeoutMs;
  let matched = false;
  do {
    signal?.throwIfAborted();
    let app: string | undefined;
    try {
      app = await read();
    } catch (error) {
      if (!isTransientObservation(reason(error))) throw error;
    }
    signal?.throwIfAborted();
    if (app === target && matched) return app;
    matched = app === target;
    if (performance.now() >= deadline) break;
    await sleep(Math.min(250, Math.max(0, deadline - performance.now())), undefined, { signal });
  } while (performance.now() <= deadline);
  throw new AppNotForeground(target);
}

export async function executeStep(
  device: StepDevice,
  identity: string,
  step: CommandStep,
  expected?: string | ((view: View) => void),
  signal?: AbortSignal,
  guard?: ((view: View) => void) | { launch: (targetApp: string) => void },
) {
  signal?.throwIfAborted();
  function validate(view: View) {
    const id = observationId(identity, view);
    if (typeof expected === 'function') expected(view);
    else if (expected && expected !== id) throw new Error('STALE_OBSERVATION');
    return id;
  }
  if (step.kind === 'launch' || step.kind === 'goHome') {
    const id = expected ? validate(await readObservation(() => device.snapshot(), signal)) : undefined;
    signal?.throwIfAborted();
    const targetApp = step.kind === 'launch'
      ? await device.launch(step, typeof guard === 'object' ? guard.launch : undefined)
      : await device.goHome?.();
    if (!targetApp) throw new Error('HOME_UNAVAILABLE');
    const foregroundApp = await verifyForeground(() => device.foregroundApp(), targetApp, 10000, signal);
    return {
      action: step.kind,
      status: 'succeeded',
      ...(step.kind === 'launch' ? { requestedApp: step.app } : {}),
      targetApp,
      foregroundApp,
      foregroundVerified: true,
      observationId: id,
    };
  }
  if (step.kind === 'waitFor') {
    const end = Date.now() + step.timeoutMs;
    let first = true;
    let lastIssue = 'WAIT_TIMEOUT';
    for (;;) {
      signal?.throwIfAborted();
      let current: View | undefined;
      try {
        current = await device.snapshot();
      } catch (error) {
        if (!isTransientObservation(reason(error))) throw error;
        lastIssue = reason(error);
      }
      signal?.throwIfAborted();
      if (current) {
        if (typeof guard === 'function') guard(current);
        const token = first ? validate(current) : observationId(identity, current);
        first = false;
        const hits = matchingControls(current, step.selector);
        lastIssue = hits.length > 1 ? 'AMBIGUOUS_ELEMENT' : 'WAIT_TIMEOUT';
        if (hits.length === (step.state === 'visible' ? 1 : 0))
          return { action: step.kind, status: 'succeeded', observationId: token };
      }
      if (Date.now() >= end) throw new Error(lastIssue);
      await sleep(Math.min(200, end - Date.now()), undefined, { signal });
    }
  }
  const view = await readObservation(() => device.snapshot(), signal);
  const id = validate(view);
  signal?.throwIfAborted();
  if (step.kind === 'back') {
    if (step.selector) {
      const node = resolveControl(view, step.selector, false);
      if (!node.navigation) throw new Error('NAVIGATION_BUTTON_REQUIRED');
      await device.perform({ kind: 'tap', selector: step.selector }, view, node, signal);
    } else await device.back();
    return { action: step.kind, status: 'succeeded', observationId: id };
  }
  const node =
    'selector' in step ? resolveControl(view, step.selector, step.kind === 'input') : undefined;
  if (node) visibleCenter(view, node.bounds);
  await device.perform(step, view, node, signal);
  return {
    action: step.kind,
    status: 'succeeded',
    observationId: id,
    inputVerified: step.kind === 'input' ? true : undefined,
  };
}
