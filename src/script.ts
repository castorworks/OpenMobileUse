import { setTimeout as sleep } from 'node:timers/promises';
import { isTargetUnavailable, isTransientObservation, reason } from './observation.js';
import {
  compileCommandStep,
  executeStep,
  guardObservation,
  isAppIdentifier,
  matchingControls,
  screenAvailable,
  type Control,
  type StepDevice,
  type View,
} from './steps.js';
import type { Platform } from './host.js';

export { reason };
export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export async function compileStep(raw: unknown, platform: Platform) {
  if (!object(raw) || typeof raw.action !== 'string') throw new Error('INVALID_STEP');
  const { action, ...options } = raw;
  return compileCommandStep(action, options, platform);
}
export const maxScriptSteps = 1000;
export function isScriptPlatform(value: unknown): value is Platform {
  return value === 'android' || value === 'ios' || value === 'harmony';
}

function flattenRecordedStep(item: unknown) {
  if (!object(item) || !isAppIdentifier(item.inApp) || !object(item.command) ||
    Object.keys(item).some(key => !['inApp', 'command', 'reading', 'screen'].includes(key)))
    throw Error('INVALID_SCRIPT');
  const { command, ...guards } = item;
  if (typeof command.action !== 'string' || ['route', 'waitFor'].includes(command.action) ||
    ['inApp', 'reading', 'screen', 'command', 'target', 'platforms', 'observation'].some(key => Object.hasOwn(command, key)))
    throw Error('INVALID_SCRIPT');
  return { ...command, ...guards };
}

export function readScriptEnvelope(raw: unknown, allowEmpty = false) {
  if (
    !object(raw) ||
    !Array.isArray(raw.steps) ||
    (!allowEmpty && !raw.steps.length) ||
    raw.steps.length > maxScriptSteps ||
    (raw.platform !== undefined && !isScriptPlatform(raw.platform))
  )
    throw new Error('INVALID_SCRIPT');
  if (raw.schemaVersion === 2) {
    if (!isScriptPlatform(raw.platform) || Object.keys(raw).some(key => !['schemaVersion', 'platform', 'steps'].includes(key)))
      throw Error('INVALID_SCRIPT');
    return { platform: raw.platform, steps: raw.steps.map(flattenRecordedStep) };
  }
  if (Object.keys(raw).some(key => !['platform', 'targets', 'steps'].includes(key)) ||
    raw.steps.some(step => object(step) && Object.hasOwn(step, 'command'))) throw Error('INVALID_SCRIPT');
  if (raw.targets !== undefined && !object(raw.targets)) throw Error('INVALID_SCRIPT_TARGETS');
  return {
    ...(raw.platform === undefined ? {} : { platform: raw.platform }),
    ...(raw.targets === undefined ? {} : { targets: raw.targets }),
    steps: raw.steps as unknown[],
  };
}

export function resolveScriptTarget(
  command: Record<string, unknown>,
  target: unknown,
  targets: Record<string, unknown> | undefined,
  platform: Platform,
) {
  if (target === undefined) return command;
  if (typeof target !== 'string' || !targets || !Object.hasOwn(targets, target))
    throw new Error('UNKNOWN_TARGET');
  const variants = targets[target];
  const selector = object(variants) ? variants[platform] : undefined;
  if (
    !object(selector) ||
    Object.keys(selector).some(
      (key) => !['id', 'label', 'role', 'within', 'cardX', 'cardY'].includes(key) || Object.hasOwn(command, key),
    )
  )
    throw new Error('INVALID_TARGET');
  return { ...command, ...selector };
}

export async function executeScriptStep(
  device: StepDevice,
  identity: string,
  command: Awaited<ReturnType<typeof compileStep>>,
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
