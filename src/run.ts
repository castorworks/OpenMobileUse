import type { Decide } from './chat.js';
import { runAgent } from './agent.js';
import { roundTrip, type Device } from './navigation.js';
import { compileRecording, replayRecording } from './recording.js';
import { object, readScript, runScript } from './script.js';
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

export async function compileScript(raw: unknown, platform: Platform) {
  if (object(raw) && raw.schemaVersion === 2) {
    return {
      kind: 'recording' as const,
      steps: await compileRecording(raw, platform),
      mode: 'foreground' as const,
    };
  }
  const script = await readScript(raw, platform);
  const mode = script.kind === 'bluetooth' ? 'settings' : 'foreground';
  return { ...script, mode } as const;
}

export async function executeRound(
  device: StepDevice & Device,
  identity: string,
  plan: {
    script?: Awaited<ReturnType<typeof compileScript>>;
    task?: Task;
    decide?: Decide;
    vision?: boolean;
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
    return runScript(device, identity, plan.script.steps, signal, progress);
  if (plan.script?.kind === 'recording')
    return replayRecording(device, identity, plan.script.steps, signal, progress);
  throw new Error('MISSING_TASK_OR_SCRIPT');
}
