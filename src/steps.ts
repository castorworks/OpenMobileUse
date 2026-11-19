import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import type { Screen } from './navigation.js';

export type Point = { x: number; y: number };
export type Bounds = { x: number; y: number; width: number; height: number };
export interface Control {
  id: string;
  labels: string[];
  role: string;
  bounds: Bounds;
  enabled: boolean;
  focused: boolean;
  editable: boolean;
  secret: boolean;
  value?: string;
}
export interface View {
  app: string;
  window: string;
  width: number;
  height: number;
  rotation: number;
  controls: Control[];
  layout: unknown;
  screen: Screen;
}
export type Selector = { id?: string; label?: string; role?: string };
export type Step =
  | { kind: 'tap'; selector: Selector }
  | { kind: 'tap'; point: Point }
  | { kind: 'swipe'; from: Point; to: Point; duration: number }
  | { kind: 'input'; selector: Selector; text: string; replace: boolean };
export interface StepDevice {
  snapshot(): Promise<View>;
  screenshot(): Promise<Buffer>;
  perform(step: Step, view: View, node?: Control): Promise<void>;
}
export const stepHelp = `omu tap --device <platform:id> (--id <id> | --label <label>) [--role <role>]
omu tap --device <platform:id> --x <0..1> --y <0..1>
omu swipe --device <platform:id> --from-x <x> --from-y <y> --to-x <x> --to-y <y> [--duration-ms 400]
omu input --device <platform:id> [--id <id> | --label <label>] [--role <role>] (--text <text> | --stdin) [--replace]
All three commands accept [--observation <observationId>] [--json].`;
export async function parseStep(kind: string, args: string[], stdin: () => Promise<string>) {
  const str = { type: 'string' } as const,
    flag = { type: 'boolean' } as const;
  const { values: v } = parseArgs({
    args,
    options: {
      device: str,
      observation: str,
      json: flag,
      id: str,
      label: str,
      role: str,
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
    },
  });
  const allowed = [
    'device',
    'observation',
    'json',
    ...(kind === 'tap'
      ? ['id', 'label', 'role', 'x', 'y']
      : kind === 'input'
        ? ['id', 'label', 'role', 'text', 'stdin', 'replace']
        : ['from-x', 'from-y', 'to-x', 'to-y', 'duration-ms']),
  ];
  if (Object.keys(v).some((k) => !allowed.includes(k))) throw new Error('OPTION_NOT_SUPPORTED_FOR_STEP');
  const device = v.device,
    observation = v.observation;
  if (!device || (observation !== undefined && !/^[a-f0-9]{64}$/.test(observation)))
    throw new Error('INVALID_DEVICE_OR_OBSERVATION');
  const selector: Selector = { id: v.id, label: v.label, role: v.role };
  if ([v.id, v.label, v.role].includes('') || (v.id !== undefined && v.label !== undefined))
    throw new Error('INVALID_SELECTOR');
  function coordinate(raw: string | undefined) {
    if (!raw?.trim() || !Number.isFinite(Number(raw)) || Number(raw) < 0 || Number(raw) > 1)
      throw new Error('COORDINATE_OUT_OF_RANGE');
    return Number(raw);
  }
  let step: Step;
  if (kind === 'swipe') {
    const from = { x: coordinate(v['from-x']), y: coordinate(v['from-y']) },
      to = { x: coordinate(v['to-x']), y: coordinate(v['to-y']) };
    const duration = Number(v['duration-ms'] ?? 400);
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
    if ((v.text !== undefined) === Boolean(v.stdin)) throw new Error('SPECIFY_TEXT_OR_STDIN');
    const text = v.stdin ? await stdin() : v.text!;
    if (text.includes('\0') || (!text && !v.replace)) throw new Error('INVALID_INPUT_TEXT');
    step = { kind, selector, text, replace: !!v.replace };
  } else throw new Error(stepHelp);
  return { step, device, observation };
}
export function observationId(device: string, view: View) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        device,
        view.app,
        view.window,
        view.width,
        view.height,
        view.rotation,
        view.controls,
      ]),
    )
    .digest('hex');
}
export function resolveControl(view: View, selector: Selector, input: boolean) {
  const focusedOnly = input && !selector.id && !selector.label;
  const hits = view.controls.filter(
    (n) =>
      (!selector.id || n.id === selector.id) &&
      (!selector.label || n.labels.includes(selector.label)) &&
      (!selector.role || selector.role === n.role) &&
      (!focusedOnly || (n.focused && (n.editable || n.secret))),
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
export async function executeStep(device: StepDevice, identity: string, step: Step, expected?: string) {
  const view = await device.snapshot();
  const id = observationId(identity, view);
  if (expected && expected !== id) throw new Error('STALE_OBSERVATION');
  const node =
    'selector' in step ? resolveControl(view, step.selector, step.kind === 'input') : undefined;
  if (node) visibleCenter(view, node.bounds);
  await device.perform(step, view, node);
  return {
    action: step.kind,
    status: 'succeeded',
    observationId: id,
    inputVerified: step.kind === 'input' ? true : undefined,
  };
}
