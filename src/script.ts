import type { Progress } from './run.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { isTargetUnavailable, isTransientObservation, reason } from './observation.js';
import {
  executeStep,
  guardObservation,
  matchingControls,
  parseStep,
  screenAvailable,
  type CommandStep,
  type Control,
  type StepDevice,
  type View,
} from './steps.js';
import { parseScript } from './navigation.js';
import type { Platform } from './host.js';

export { reason };
export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

async function executeScriptStep(
  device: StepDevice,
  identity: string,
  command: Compiled,
  signal: AbortSignal,
) {
  const { step, observation } = command;
  const selector = 'selector' in step && step.selector;
  if (observation || step.kind === 'waitFor' || !selector || !(selector.id || selector.label))
    return executeStep(device, identity, step, observation, signal);

  let samePage: ((view: View) => void) | undefined;
  let original: Control | undefined;
  const validate = (view: View) => {
    if (samePage) samePage(view);
    else samePage = guardObservation(identity, view, { kind: 'check' }, screenAvailable);
    const hits = matchingControls(view, selector);
    if (hits.length !== 1) return;
    const [target] = hits;
    if (
      original &&
      (target.id !== original.id ||
        target.role !== original.role ||
        target.checked !== original.checked ||
        (original.labels[0] && !target.labels.includes(original.labels[0])) ||
        (step.kind === 'input' && target.value !== original.value))
    )
      throw Error('STALE_OBSERVATION');
    original ??= target;
  };
  for (let attempt = 1; ; attempt++) {
    try {
      return await executeStep(device, identity, step, validate, signal);
    } catch (error) {
      const code = reason(error);
      if (!samePage || attempt === 3 || (!isTargetUnavailable(code) && !isTransientObservation(code)))
        throw error;
      await sleep(200, undefined, { signal });
    }
  }
}

export async function runScript(
  device: StepDevice,
  identity: string,
  commands: Compiled[],
  signal: AbortSignal,
  progress?: Progress,
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
      await executeScriptStep(device, identity, command, signal);
    } catch (e) {
      const error =
        reason(e) === 'ACTION_OUTCOME_UNKNOWN'
          ? 'ACTION_OUTCOME_UNKNOWN'
          : signal.aborted
            ? 'CANCELLED'
            : reason(e);
      progress?.({ kind: 'step', name: item.action, status: error });
      steps.push({
        ...item,
        durationMs: Math.round(performance.now() - started),
        status: 'failed',
        error,
      });
      return { status: 'failed', reason: error, failedStep: item.index, steps };
    }
    progress?.({ kind: 'step', name: item.action, status: 'succeeded' });
    steps.push({ ...item, durationMs: Math.round(performance.now() - started) });
  }
  return { status: 'succeeded', steps };
}
