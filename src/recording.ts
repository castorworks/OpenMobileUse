import { setTimeout as sleep } from 'node:timers/promises';
import type { Platform } from './host.js';
import { compileStep, object, reason } from './script.js';
import { executeTextTarget, type ScreenTextRecognizer } from './screen-text.js';
import { executeImageTarget, isImageTarget, type ImageTarget } from './screen-image.js';
import { pauseVideoCenter } from './video-player.js';
import { executeVerifiedSearch, type SearchRequest } from './verified-search.js';
import { isTargetUnavailable, isTransientObservation } from './observation.js';
import {
  executeStep,
  guardObservation,
  isAppIdentifier,
  matchingControls,
  observationId,
  screenAvailable,
  uniqueSelector,
  type CommandStep,
  type Control,
  type Selector,
  type StepDevice,
  type View,
} from './steps.js';

type Reading = { checked?: boolean; value?: string; label?: string };
type RecordingAction = Record<string, unknown> & { action: string };
export type RecordedStep = RecordingAction & {
  inApp: string;
  reading?: Reading;
  screen?: { width: number; height: number; rotation: number; anchors: Selector[] };
};
function reading(node?: Control): Reading | undefined {
  if (!node || node.secret) return;
  const state: Reading = {};
  if (node.checked !== undefined) state.checked = node.checked;
  if (node.editable && node.value !== undefined) state.value = node.value;
  if (!node.editable && node.labels[0]) state.label = node.labels[0];
  return Object.keys(state).length ? state : undefined;
}

// Geometry-dependent gestures need the original orientation and recognizable page landmarks.
export function recordStep(view: View, command: RecordingAction, node?: Control): RecordedStep {
  const item: RecordedStep = { ...command, inApp: view.app };
  const observed = reading(node);
  if (observed) item.reading = observed;
  if (
    command.action === 'swipe' ||
    (command.action === 'tap' && 'x' in command) ||
    (command.action === 'back' && !node)
  ) {
    const anchors: Selector[] = [];
    for (const c of view.controls) {
      if (c.secret || c.editable || !c.labels.length) continue;
      const selector = uniqueSelector(view, c, false);
      if (selector) anchors.push(selector);
      if (anchors.length >= 3) break;
    }
    item.screen = { width: view.width, height: view.height, rotation: view.rotation, anchors };
  }
  return item;
}

type StepGuards = { inApp?: unknown; reading?: unknown; screen?: unknown };
type GuardedStep = {
  action: string;
  inApp?: string;
  reading?: Reading;
  screen?: RecordedStep['screen'];
  step?: CommandStep;
  selector?: Selector;
  observation?: string;
  screenText?: string;
  image?: ImageTarget;
  videoItem?: string;
  search?: SearchRequest;
};

export function isGuardedAction(action: unknown) {
  return ['check', 'pause', 'tapScreenText', 'checkScreenText', 'tapImage', 'checkImage', 'pauseVideoCenter', 'verifiedSearch'].some(
    (name) => name === action,
  );
}

function compileGuards(guards: StepGuards) {
  const { inApp, reading, screen } = guards;
  if (inApp !== undefined && !isAppIdentifier(inApp)) throw Error('INVALID_STEP_GUARD');
  if (
    reading !== undefined &&
    (!object(reading) ||
      Object.keys(reading).some((key) => !['checked', 'value', 'label'].includes(key)) ||
      (reading.label !== undefined && typeof reading.label !== 'string') ||
      (reading.value !== undefined && typeof reading.value !== 'string') ||
      (reading.checked !== undefined && typeof reading.checked !== 'boolean'))
  )
    throw Error('INVALID_STEP_GUARD');
  if (
    screen !== undefined &&
    (!object(screen) ||
      Object.keys(screen).some((key) => !['width', 'height', 'rotation', 'anchors'].includes(key)) ||
      typeof screen.width !== 'number' ||
      !Number.isSafeInteger(screen.width) ||
      screen.width <= 0 ||
      typeof screen.height !== 'number' ||
      !Number.isSafeInteger(screen.height) ||
      screen.height <= 0 ||
      !Number.isFinite(screen.rotation) ||
      !Array.isArray(screen.anchors) ||
      screen.anchors.length > 3 ||
      !screen.anchors.every(
        (anchor) =>
          object(anchor) &&
          (!!anchor.id || !!anchor.label) &&
          Object.entries(anchor).every(
            ([key, value]) => ['id', 'label', 'role'].includes(key) && typeof value === 'string',
          ),
      ))
  )
    throw Error('INVALID_STEP_GUARD');
  return {
    inApp,
    reading: reading as Reading | undefined,
    screen: screen as RecordedStep['screen'],
  };
}

export async function compileGuardedStep(
  command: Record<string, unknown>,
  platform: Platform,
  guards: StepGuards = {},
): Promise<GuardedStep> {
  const { action, ...fields } = command;
  if (typeof action !== 'string') throw Error('INVALID_STEP');
  const source = { action, ...compileGuards(guards) };
  const only = (...keys: string[]) => Object.keys(fields).every((key) => keys.includes(key));
  if (action === 'verifiedSearch') {
    if (!only('query', 'firstResult') || typeof fields.query !== 'string' || !fields.query.trim() ||
      fields.query.length > 200 || typeof fields.firstResult !== 'boolean' || source.reading || source.screen)
      throw Error('INVALID_STEP');
    return { ...source, search: { query: fields.query, firstResult: fields.firstResult } };
  }
  if (action === 'pauseVideoCenter') {
    if (platform !== 'android' || !only('item') || typeof fields.item !== 'string' ||
      !/^[a-f0-9]{64}$/.test(fields.item) || source.reading || source.screen) throw Error('INVALID_STEP');
    return { ...source, videoItem: fields.item };
  }
  if (action === 'tapScreenText' || action === 'checkScreenText') {
    if (
      !only('text') ||
      typeof fields.text !== 'string' ||
      !fields.text.trim() ||
      fields.text.length > 160 ||
      source.reading ||
      source.screen
    )
      throw Error('INVALID_STEP');
    return { ...source, screenText: fields.text };
  }
  if (action === 'tapImage' || action === 'checkImage') {
    if (
      !only('label', 'anchor') ||
      typeof fields.label !== 'string' ||
      !fields.label.trim() ||
      fields.label.length > 100 ||
      !isImageTarget(fields.anchor) ||
      source.reading ||
      source.screen
    )
      throw Error('INVALID_STEP');
    return { ...source, image: fields.anchor };
  }
  if (action === 'pause') {
    if (!only() || source.reading) throw Error('INVALID_STEP');
    return source;
  }
  if (action === 'check') {
    if (!only('id', 'label', 'role', 'within', 'cardX', 'cardY')) throw Error('INVALID_STEP');
    if (!Object.keys(fields).length && !source.reading) return source;
    const { step } = await compileStep({ ...fields, action: 'waitFor' }, platform);
    if (step.kind !== 'waitFor') throw Error('INVALID_STEP');
    return { ...source, selector: step.selector };
  }

  const { step, observation } = await compileStep(command, platform);
  const target = 'selector' in step ? step.selector : undefined;
  const selector = target?.id || target?.label ? target : undefined;
  if (source.reading && (!selector || (step.kind === 'waitFor' && step.state === 'hidden')))
    throw Error('INVALID_STEP_GUARD');
  return { ...source, step, selector, observation };
}

export async function executeGuardedStep(
  device: StepDevice,
  identity: string,
  source: GuardedStep,
  signal: AbortSignal,
  recognizeText?: ScreenTextRecognizer,
) {
  const { action, step, screenText, image, videoItem, search, selector, inApp, reading, screen } = source;
  const matches = (view: View) => {
    // Launch and Android Home are independent of the starting app.
    if (step?.kind !== 'launch' && step?.kind !== 'goHome' && inApp !== undefined && inApp !== view.app) return false;
    if (
      screen &&
      (view.width !== screen.width ||
        view.height !== screen.height ||
        view.rotation !== screen.rotation ||
        screen.anchors.some((anchor) => matchingControls(view, anchor).length !== 1))
    )
      return false;
    if (!selector) return true;
    const hits = matchingControls(view, selector);
    if (step?.kind === 'waitFor' && step.state === 'hidden') return hits.length === 0;
    if (hits.length !== 1) return false;
    const [node] = hits;
    return (
      (!step || step.kind === 'waitFor' || node.enabled) &&
      (reading?.label === undefined || node.labels.includes(reading.label)) &&
      (reading?.checked === undefined || node.checked === reading.checked) &&
      (reading?.value === undefined || node.value === reading.value)
    );
  };

  const deadline = Date.now() + (step?.kind === 'waitFor' ? step.timeoutMs : 8000);
  let observation = source.observation;
  for (;;) {
    signal.throwIfAborted();
    let view: View | undefined;
    try {
      view = await device.snapshot();
    } catch (error) {
      if (!isTransientObservation(reason(error)) || Date.now() >= deadline) throw error;
    }
    signal.throwIfAborted();
    if (view) {
      screenAvailable(view);
      if (observation && observationId(identity, view) !== observation) throw Error('STALE_OBSERVATION');
      if (step?.kind === 'waitFor') observation = undefined;
      if (matches(view)) {
        try {
          if (search) {
            const verified = await executeVerifiedSearch(device, identity, view, search, signal);
            if ('reason' in verified) throw Error(verified.reason);
          } else if (videoItem) {
            await pauseVideoCenter(device, identity, view, videoItem, signal);
          } else if (image) {
            await executeImageTarget(device, identity, view, image, action === 'tapImage', signal);
          } else if (screenText) {
            await executeTextTarget(
              device,
              identity,
              view,
              screenText,
              action === 'tapScreenText' ? 'tap' : 'check',
              signal,
              recognizeText,
            );
          } else if (step && step.kind !== 'waitFor') {
            const validate = guardObservation(identity, view, step, (fresh) => {
              screenAvailable(fresh);
              if (!matches(fresh) || (observation && observationId(identity, fresh) !== observation))
                throw Error('STALE_OBSERVATION');
            });
            await executeStep(device, identity, step, validate, signal);
          } else if (action === 'pause') {
            await sleep(650, undefined, { signal });
          }
          return;
        } catch (error) {
          const code = reason(error);
          if (!isTargetUnavailable(code) && !isTransientObservation(code)) throw error;
        }
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Error('RECORDING_STATE_MISMATCH');
    await sleep(Math.min(250, remaining), undefined, { signal });
  }
}
