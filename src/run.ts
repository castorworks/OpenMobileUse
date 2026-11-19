import type { Decide } from './chat.js';
import type { openDevice } from './doctor.js';
import { runAgent } from './agent.js';
import { roundTrip } from './navigation.js';
import { runScript, type readScript } from './script.js';
import { runTask, type Task } from './task.js';

export type Progress = (event: {
  kind: 'action' | 'step' | 'evidence';
  name: string;
  status?: string;
  phase?: string;
  bluetooth?: boolean;
}) => void;

export async function executeRound(
  device: Awaited<ReturnType<typeof openDevice>>,
  identity: string,
  plan: {
    script?: Awaited<ReturnType<typeof readScript>>;
    task?: Task;
    decide?: Decide;
    vision?: boolean;
  },
  signal: AbortSignal,
  progress?: Progress,
) {
  signal.throwIfAborted();
  if (plan.decide && plan.task)
    return runTask(device, identity, plan.task, plan.decide, !!plan.vision, signal, progress);
  if (plan.decide) return runAgent(device, plan.decide, undefined, signal, progress);
  if (plan.script?.kind === 'bluetooth') return roundTrip(device, plan.script.steps, signal, progress);
  if (plan.script?.kind === 'general')
    return runScript(device, identity, plan.script.steps, signal, progress);
  throw new Error('MISSING_TASK_OR_SCRIPT');
}
