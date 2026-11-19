import { setTimeout as sleep } from 'node:timers/promises';
import type { Platform } from './host.js';
import type { Progress } from './run.js';
import { compileStep, object, reason } from './script.js';
import { executeTextTarget } from './screen-text.js';
import { executeImageTarget, isImageTarget, type ImageTarget } from './screen-image.js';
import {
  executeStep,
  guardObservation,
  isAppIdentifier,
  matchingControls,
  screenAvailable,
  uniqueSelector,
  type CommandStep,
  type Control,
  type Selector,
  type StepDevice,
  type View,
} from './steps.js';

type Reading = { checked?: boolean; value?: string; label?: string };
export type RecordedStep = {
  inApp: string;
  command: Record<string, unknown>;
  reading?: Reading;
  screen?: { width: number; height: number; rotation: number; anchors: Selector[] };
};
export const maxRecordingSteps = 512;

export function reading(node?: Control): Reading | undefined {
  if (!node || node.secret) return;
  const state: Reading = {};
  if (node.checked !== undefined) state.checked = node.checked;
  if (node.editable && node.value !== undefined) state.value = node.value;
  if (!node.editable && node.labels[0]) state.label = node.labels[0];
  return Object.keys(state).length ? state : undefined;
}

// Geometry-dependent gestures need the original orientation and recognizable page landmarks.
export function recordStep(view: View, command: Record<string, unknown>, node?: Control): RecordedStep {
  const item: RecordedStep = { inApp: view.app, command, reading: reading(node) };
  if (
    command.action === 'swipe' ||
    (command.action === 'tap' && 'x' in command) ||
    (command.action === 'back' && !node)
  ) {
    const anchors: Selector[] = [];
    for (const c of view.controls) {
      if (c.secret || c.editable || !c.labels.length) continue;
      const selector = uniqueSelector(view, c);
      if (selector) anchors.push(selector);
      if (anchors.length >= 3) break;
    }
    item.screen = { width: view.width, height: view.height, rotation: view.rotation, anchors };
  }
  return item;
}

export { screenAvailable };

type PlaybackStep = {
  source: RecordedStep;
  step?: CommandStep;
  selector?: Selector;
  screenText?: string;
  image?: ImageTarget;
};

export async function compileRecording(data: unknown, platform: Platform): Promise<PlaybackStep[]> {
  if (
    !object(data) ||
    data.schemaVersion !== 2 ||
    !Array.isArray(data.steps) ||
    !data.steps.length ||
    data.steps.length > maxRecordingSteps
  )
    throw Error('INVALID_RECORDING');
  if (data.platform !== platform) throw Error('RECORDING_PLATFORM_MISMATCH');
  const parsed: PlaybackStep[] = [];
  for (const item of data.steps) {
    if (!object(item) || !isAppIdentifier(item.inApp) || !object(item.command))
      throw Error('INVALID_RECORDING');
    const { command } = item;
    if (
      item.reading !== undefined &&
      (!object(item.reading) ||
        Object.keys(item.reading).some((k) => !['checked', 'value', 'label'].includes(k)) ||
        (item.reading.label !== undefined && typeof item.reading.label !== 'string') ||
        (item.reading.value !== undefined && typeof item.reading.value !== 'string') ||
        (item.reading.checked !== undefined && typeof item.reading.checked !== 'boolean'))
    )
      throw Error('INVALID_RECORDING');
    const source: RecordedStep = { inApp: item.inApp, command, reading: item.reading as Reading };
    if (item.screen !== undefined) {
      const g = item.screen;
      if (
        !object(g) ||
        !Number.isSafeInteger(g.width) ||
        !Number.isSafeInteger(g.height) ||
        !Number.isFinite(g.rotation) ||
        !Array.isArray(g.anchors) ||
        g.anchors.length > 3 ||
        !g.anchors.every(
          (a) =>
            object(a) &&
            (!!a.id || !!a.label) &&
            Object.entries(a).every(
              ([k, v]) => ['id', 'label', 'role'].includes(k) && typeof v === 'string',
            ),
        )
      )
        throw Error('INVALID_RECORDING');
      source.screen = g as RecordedStep['screen'];
    }
    if (command.action === 'tapScreenText' || command.action === 'checkScreenText') {
      if (
        Object.keys(command).length !== 2 ||
        typeof command.text !== 'string' ||
        !command.text.trim() ||
        command.text.length > 160 ||
        source.reading ||
        source.screen
      )
        throw Error('INVALID_RECORDING');
      parsed.push({ source, screenText: command.text });
      continue;
    }
    if (command.action === 'tapImage' || command.action === 'checkImage') {
      if (
        Object.keys(command).length !== 3 ||
        typeof command.label !== 'string' ||
        !command.label.trim() ||
        command.label.length > 100 ||
        !isImageTarget(command.anchor) ||
        source.reading ||
        source.screen
      )
        throw Error('INVALID_RECORDING');
      parsed.push({ source, image: command.anchor });
      continue;
    }
    if (command.action === 'pause' && Object.keys(command).length === 1 && !source.reading) {
      parsed.push({ source });
      continue;
    }
    if (command.action === 'check') {
      const { action, ...fields } = command;
      if (Object.keys(fields).length === 0 && !source.reading) parsed.push({ source });
      else {
        const { step } = await compileStep({ ...fields, action: 'waitFor' }, platform);
        if (step.kind !== 'waitFor' || step.state !== 'visible') throw Error('INVALID_RECORDING');
        parsed.push({ source, selector: step.selector });
      }
      continue;
    }
    const { step, observation } = await compileStep(command, platform);
    if (observation || !['tap', 'input', 'swipe', 'back', 'launch'].includes(step.kind))
      throw Error('INVALID_RECORDING');
    const selector = 'selector' in step ? step.selector : undefined;
    if (source.reading && !selector) throw Error('INVALID_RECORDING');
    parsed.push({ source, step, selector });
  }
  return parsed;
}

export async function replayRecording(
  device: StepDevice,
  identity: string,
  steps: PlaybackStep[],
  signal: AbortSignal,
  progress: Progress,
) {
  for (const [index, { source, step, selector, screenText, image }] of steps.entries()) {
    const name = String(source.command.action);
    try {
      const deadline = Date.now() + 8000;
      for (;;) {
        signal.throwIfAborted();
        const view = await device.snapshot();
        signal.throwIfAborted();
        screenAvailable(view);
        const hits = selector ? matchingControls(view, selector) : [];
        const node = hits[0];
        // A launch is independent of the starting app. Other operations must match the recording.
        const sameApp = step?.kind === 'launch' || source.inApp === view.app;
        const g = source.screen;
        const samePage =
          !g ||
          (view.width === g.width &&
            view.height === g.height &&
            view.rotation === g.rotation &&
            g.anchors.every((a) => matchingControls(view, a).length === 1));
        if (
          sameApp &&
          samePage &&
          (!selector ||
            (hits.length === 1 &&
              (!step || node.enabled) &&
              (source.reading?.label === undefined || node.labels.includes(source.reading.label)) &&
              (source.reading?.checked === undefined || node.checked === source.reading.checked) &&
              (source.reading?.value === undefined || node.value === source.reading.value)))
        ) {
          try {
            if (image) {
              await executeImageTarget(device, identity, view, image, name === 'tapImage', signal);
            } else if (screenText) {
              await executeTextTarget(
                device,
                identity,
                view,
                screenText,
                name === 'tapScreenText' ? 'tap' : 'check',
                signal,
              );
            } else if (step) {
              const validate = guardObservation(identity, view, step, (fresh) => {
                screenAvailable(fresh);
                if (g?.anchors.some((a) => matchingControls(fresh, a).length !== 1))
                  throw Error('STALE_OBSERVATION');
              });
              await executeStep(device, identity, step, validate, signal);
            } else if (name === 'pause') await sleep(650, undefined, { signal });
            break;
          } catch (e) {
            if (
              ![
                'STALE_OBSERVATION',
                'SCREEN_TEXT_NOT_UNIQUE_OR_MISSING',
                'VISUAL_TARGET_UNCLEAR',
              ].includes(reason(e))
            )
              throw e;
          }
        }
        if (Date.now() >= deadline) throw Error('RECORDING_STATE_MISMATCH');
        await sleep(250, undefined, { signal });
      }
      progress({ kind: 'step', name, status: 'succeeded' });
    } catch (e) {
      const code =
        reason(e) === 'ACTION_OUTCOME_UNKNOWN' ? reason(e) : signal.aborted ? 'CANCELLED' : reason(e);
      progress({ kind: 'step', name, status: code });
      return { status: 'failed', failedStep: index + 1, reason: code };
    }
  }
  return { status: 'succeeded' };
}
