import { executeStep, parseStep, type CommandStep, type StepDevice } from './steps.js';
import { parseScript } from './navigation.js';
import type { Platform } from './host.js';

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function reason(error: unknown) {
  return /^[A-Z][A-Z_0-9]*(?=:|$)/.exec((error as Error)?.message)?.[0] || 'DEVICE_ERROR';
}
const numbers: Record<string, string> = {
  x: 'x',
  y: 'y',
  fromX: 'from-x',
  fromY: 'from-y',
  toX: 'to-x',
  toY: 'to-y',
  durationMs: 'duration-ms',
  timeoutMs: 'timeout-ms',
};
const strings = ['app', 'id', 'label', 'role', 'text', 'state', 'module', 'ability', 'observation'];
export async function compileStep(raw: unknown, platform: Platform) {
  if (!object(raw) || typeof raw.action !== 'string') throw new Error('INVALID_STEP');
  const kind = raw.action === 'launchApp' ? 'launch' : raw.action;
  if (!['launch', 'tap', 'swipe', 'input', 'waitFor', 'back'].includes(kind))
    throw new Error('UNKNOWN_STEP');
  const args = ['--device', platform + ':script'];
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'action') continue;
    if (key === 'replace' && typeof value === 'boolean' && kind === 'input') {
      if (value) args.push('--replace');
    } else if (Object.hasOwn(numbers, key) && typeof value === 'number' && Number.isFinite(value)) {
      args.push('--' + numbers[key] + '=' + value);
    } else if (strings.includes(key) && typeof value === 'string') {
      args.push('--' + key + '=' + value);
    } else throw new Error('INVALID_STEP_ARGUMENT');
  }
  return parseStep(kind, args, async () => {
    throw new Error('INVALID_STEP_ARGUMENT');
  });
}
type Compiled = { index?: number; step: CommandStep; observation?: string };
export async function readScript(raw: unknown, platform: Platform) {
  if (
    !object(raw) ||
    raw.schemaVersion !== 1 ||
    !Array.isArray(raw.steps) ||
    !raw.steps.length ||
    raw.steps.length > 64 ||
    Object.keys(raw).some((k) => !['schemaVersion', 'steps', 'targets'].includes(k))
  )
    throw new Error('INVALID_SCRIPT');
  if (raw.targets !== undefined && !object(raw.targets)) throw new Error('INVALID_SCRIPT_TARGETS');
  if (
    !raw.targets &&
    raw.steps.some(
      (s) =>
        object(s) && (s.action === 'route' || (s.action === 'waitFor' && typeof s.target === 'string')),
    )
  ) {
    return { kind: 'bluetooth' as const, steps: parseScript(raw) };
  }
  const steps: Compiled[] = [];
  for (const [i, rawStep] of raw.steps.entries()) {
    try {
      if (!object(rawStep)) throw new Error('INVALID_STEP');
      const { target, platforms, ...action } = rawStep;
      if (platforms !== undefined) {
        if (
          !Array.isArray(platforms) ||
          !platforms.length ||
          !platforms.every((p) => ['ios', 'harmony', 'android'].includes(p))
        )
          throw new Error('INVALID_STEP_PLATFORMS');
        if (!platforms.includes(platform)) continue;
      }
      if (target !== undefined) {
        if (typeof target !== 'string' || !object(raw.targets) || !Object.hasOwn(raw.targets, target))
          throw new Error('UNKNOWN_TARGET');
        const variants = raw.targets[target];
        const loc = object(variants) ? variants[platform] : undefined;
        if (
          !object(loc) ||
          Object.keys(loc).some((k) => !['id', 'label', 'role'].includes(k) || Object.hasOwn(action, k))
        )
          throw new Error('INVALID_TARGET');
        Object.assign(action, loc);
      }
      steps.push({ ...(await compileStep(action, platform)), index: i + 1 });
    } catch (e) {
      throw new Error('INVALID_SCRIPT_STEP: ' + (i + 1) + ' ' + reason(e));
    }
  }
  if (!steps.length) throw new Error('EMPTY_PLATFORM_SCRIPT');
  return { kind: 'general' as const, steps };
}
export async function runScript(
  device: StepDevice,
  identity: string,
  commands: Compiled[],
  signal: AbortSignal,
) {
  const steps: { index: number; action: string; status: string; durationMs: number; error?: string }[] =
    [];
  for (const [i, command] of commands.entries()) {
    const started = performance.now();
    const item = {
      index: command.index ?? i + 1,
      action: command.step.kind,
      status: 'succeeded',
      durationMs: 0,
    };
    try {
      await executeStep(device, identity, command.step, command.observation, signal);
    } catch (e) {
      const error =
        reason(e) === 'ACTION_OUTCOME_UNKNOWN'
          ? 'ACTION_OUTCOME_UNKNOWN'
          : signal.aborted
            ? 'CANCELLED'
            : reason(e);
      steps.push({
        ...item,
        durationMs: Math.round(performance.now() - started),
        status: 'failed',
        error,
      });
      return { status: 'failed', reason: error, failedStep: item.index, steps };
    }
    steps.push({ ...item, durationMs: Math.round(performance.now() - started) });
  }
  return { status: 'succeeded', steps };
}
