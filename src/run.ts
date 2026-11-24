import type { Decide } from './chat.js';
import { runAgent } from './agent.js';
import { compileBluetoothStep, isBluetoothMarker, roundTrip, type Device } from './navigation.js';
import { compileGuardedStep, executeGuardedStep, isGuardedAction } from './recording.js';
import {
  compileStep,
  executeScriptStep,
  isScriptPlatform,
  object,
  readScriptEnvelope,
  reason,
  resolveScriptTarget,
} from './script.js';
import type { ScreenTextRecognizer } from './screen-text.js';
import type { StepDevice } from './steps.js';
import { runTask, type Task } from './task.js';
import type { Platform } from './host.js';

export type Progress = (event: {
  kind: 'action' | 'step' | 'evidence';
  name: string;
  status?: string;
  phase?: string;
  bluetooth?: boolean;
}) => void;

type ScriptStep = { index: number; action: string } & (
  | { kind: 'plain'; command: Awaited<ReturnType<typeof compileStep>> }
  | { kind: 'guarded'; command: Awaited<ReturnType<typeof compileGuardedStep>> }
);

function invalidStep(index: number, error: unknown) {
  return new Error('INVALID_SCRIPT_STEP: ' + index + ' ' + reason(error));
}

export async function compileScript(raw: unknown, platform: Platform) {
  const source = readScriptEnvelope(raw);
  if (source.platform !== undefined && source.platform !== platform)
    throw Error('SCRIPT_PLATFORM_MISMATCH');
  const selected = source.steps.flatMap((step, position) => {
    const index = position + 1;
    try {
      if (!object(step)) throw Error('INVALID_STEP');
      const { target, platforms, inApp, reading, screen, ...command } = step;
      if (platforms !== undefined) {
        if (!Array.isArray(platforms) || !platforms.length || !platforms.every(isScriptPlatform))
          throw Error('INVALID_STEP_PLATFORMS');
        if (!platforms.includes(platform)) return [];
      }
      const guards = inApp !== undefined || reading !== undefined || screen !== undefined
        ? { inApp, reading, screen }
        : undefined;
      return [{ index, command, target, guards }];
    } catch (error) {
      throw invalidStep(index, error);
    }
  });
  if (!selected.length) throw Error('EMPTY_PLATFORM_SCRIPT');
  const bluetooth = selected.some(
    ({ command, target }) =>
      command.action === 'route' ||
      (command.action === 'waitFor' &&
        isBluetoothMarker(target) &&
        !Object.hasOwn(source.targets ?? {}, target)),
  );
  if (bluetooth) {
    const steps = selected.map(({ index, command, target, guards }) => {
      try {
        if (guards) throw Error('INVALID_BLUETOOTH_STEP');
        return compileBluetoothStep(target === undefined ? command : { ...command, target }, index);
      } catch (error) {
        throw invalidStep(index, error);
      }
    });
    return { kind: 'bluetooth', mode: 'settings', steps } as const;
  }

  const steps: ScriptStep[] = [];
  for (const { index, command, target, guards } of selected) {
    try {
      const action = resolveScriptTarget(command, target, source.targets, platform);
      if (guards || isGuardedAction(action.action)) {
        const guarded = await compileGuardedStep(action, platform, guards);
        steps.push({ index, kind: 'guarded', action: guarded.step?.kind ?? guarded.action, command: guarded });
      } else {
        const plain = await compileStep(action, platform);
        steps.push({ index, kind: 'plain', action: plain.step.kind, command: plain });
      }
    } catch (error) {
      throw invalidStep(index, error);
    }
  }
  return { kind: 'general', mode: 'foreground', steps } as const;
}

async function runScript(
  device: StepDevice,
  identity: string,
  commands: ScriptStep[],
  signal: AbortSignal,
  progress: Progress,
  recognizeText?: ScreenTextRecognizer,
) {
  const steps: { index: number; action: string; status: string; durationMs: number; error?: string }[] = [];
  for (const step of commands) {
    const { index, action } = step;
    const started = performance.now();
    try {
      if (step.kind === 'guarded')
        await executeGuardedStep(device, identity, step.command, signal, recognizeText);
      else await executeScriptStep(device, identity, step.command, signal);
    } catch (error) {
      const code = reason(error);
      const failure = signal.aborted && code !== 'ACTION_OUTCOME_UNKNOWN' ? 'CANCELLED' : code;
      progress({ kind: 'step', name: action, status: failure });
      steps.push({
        index,
        action,
        status: 'failed',
        durationMs: Math.round(performance.now() - started),
        error: failure,
      });
      return { status: 'failed', reason: failure, failedStep: index, steps };
    }
    progress({ kind: 'step', name: action, status: 'succeeded' });
    steps.push({ index, action, status: 'succeeded', durationMs: Math.round(performance.now() - started) });
  }
  return { status: 'succeeded', steps };
}

export async function executeRound(
  device: StepDevice & Device,
  identity: string,
  plan: {
    script?: Awaited<ReturnType<typeof compileScript>>;
    task?: Task;
    decide?: Decide;
    vision?: boolean;
    recognizeText?: ScreenTextRecognizer;
  },
  signal: AbortSignal,
  progress: Progress = () => {},
) {
  signal.throwIfAborted();
  if (plan.decide && plan.task)
    return runTask(device, identity, plan.task, plan.decide, !!plan.vision, signal, progress);
  if (plan.decide) return runAgent(device, plan.decide, undefined, signal, progress);
  if (plan.script?.kind === 'bluetooth') return roundTrip(device, plan.script.steps, signal, progress);
  if (plan.script?.kind === 'general')
    return runScript(device, identity, plan.script.steps, signal, progress, plan.recognizeText);
  throw new Error('MISSING_TASK_OR_SCRIPT');
}
