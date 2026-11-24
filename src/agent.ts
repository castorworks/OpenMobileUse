import type { Progress } from './run.js';
import { tool, decode } from './agent-tools.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { messagesFor, remember, type Decide, type History, type Tool } from './chat.js';
import {
  prepareBluetooth,
  readBluetooth,
  route,
  waitForPage,
  type Device,
  type Screen,
} from './navigation.js';
import { isTargetUnavailable, isTransientObservation, reason } from './observation.js';

import { bluetoothDefinition } from './bluetooth-task.js';
export { bluetoothTask } from './bluetooth-task.js';
const { goal: instruction, checks } = bluetoothDefinition;
type Check = (typeof checks)[number];
type Phase = 'preflight' | 'execution' | 'verification';
type Evidence = {
  observationId: string;
  phase: Phase;
  page: Screen['page'];
  marker: string;
  bluetooth?: boolean;
  navigationEntries?: Node[];
};
type Action = { observationId: string; tool: string; outcome: string; target?: string; after?: string };
type Node = { id: string; label: string };
function visibleRows(screen: Screen): Node[] {
  return (screen.entries || []).map((row, i) => ({ id: 'n' + (i + 1), label: row.label }));
}
function availableTools(id: string, nodes: Node[], canBack: boolean): Tool[] {
  return [
    ...(nodes.length
      ? [
          tool(id, 'tap', 'Tap one task-relevant navigation entry from this observation.', {
            nodeId: nodes.map((n) => n.id),
          }),
        ]
      : []),
    ...(canBack ? [tool(id, 'back', 'Use the current Settings back control.')] : []),
    tool(id, 'wait', 'Wait briefly and observe again.'),
    tool(id, 'finish', 'Ask the host to verify completion.'),
    tool(id, 'request_help', 'Stop for human review.'),
  ].filter((t) => bluetoothDefinition.actions.includes(t.function.name));
}
function sameView(a: Screen, b: Screen) {
  return (
    a.page === b.page &&
    a.marker === b.marker &&
    JSON.stringify(a.entries) === JSON.stringify(b.entries) &&
    a.layoutKey === b.layoutKey &&
    a.bluetooth === b.bluetooth
  );
}
export async function runAgent(
  device: Device,
  decide: Decide,
  limits = bluetoothDefinition.limits,
  signal?: AbortSignal,
  progress?: Progress,
) {
  const started = Date.now(),
    deadline = started + limits.ms;
  const evidence: Evidence[] = [],
    actions: Action[] = [],
    history: History = [];
  const satisfied: Partial<Record<Check, string>> = {};
  const missing = () => checks.filter((c) => !satisfied[c]);
  let decisions = 0,
    modelCalls = 0,
    seq = 0,
    initial: boolean | undefined,
    final: boolean | undefined;
  const result = (status: 'succeeded' | 'needs_review' | 'failed', reason?: string) => ({
    status,
    reason,
    decisions,
    modelCalls,
    durationMs: Date.now() - started,
    initial,
    final,
    satisfied,
    missing: missing(),
    evidence,
    actions,
  });
  function record(phase: Phase, s: Screen) {
    if (s.page === 'other' || !s.marker) throw new Error('UNRECOGNIZED_SETTINGS_PAGE');
    const id = 'o' + ++seq;
    progress?.({ kind: 'evidence', name: s.page, phase, bluetooth: s.bluetooth });
    evidence.push({
      observationId: id,
      phase,
      page: s.page,
      marker: s.marker,
      bluetooth: s.bluetooth,
      navigationEntries: phase === 'execution' && s.entries ? visibleRows(s) : undefined,
    });
    return id;
  }
  function checkTime() {
    if (signal?.aborted) throw new Error('CANCELLED');
    if (Date.now() >= deadline) throw new Error('TIME_BUDGET');
  }
  // Also guard setup and verification moves after a slow device read or model response.
  const bounded: Device = {
    observe: async () => {
      checkTime();
      const observed = await device.observe();
      checkTime();
      return observed;
    },
    move: (action, from, key) => {
      checkTime();
      return device.move(action, from, key);
    },
    close: () => device.close(),
  };
  const observeSettings = () =>
    waitForPage(bounded, (s) => s.page !== 'other' && !!s.marker, 1800, 'Settings');
  try {
    const pre = await prepareBluetooth(bounded);
    initial = readBluetooth(pre);
    satisfied.baseline = record('preflight', pre);
    let screen = await waitForPage(bounded, (s) => s.page === 'home', 1800, 'home');
    let id = record('execution', screen),
      lastStall = '';
    while (decisions < limits.turns) {
      checkTime();
      const nodes = visibleRows(screen);
      const tools = availableTools(id, nodes, screen.page !== 'home');
      const observation = {
        observationId: id,
        app: 'Settings',
        page: screen.page,
        navigationEntries: nodes,
        bluetooth: screen.bluetooth,
        verified: Object.keys(satisfied),
        remaining: missing(),
      };
      const reply = await decide(
        messagesFor(instruction, history, observation, tools),
        tools,
        deadline,
        () => {
          modelCalls++;
        },
      );
      decisions++;
      checkTime();
      const call = reply.tool_calls[0];
      let rejected =
        reply.tool_calls.length !== 1
          ? 'ONE_ACTION_PER_OBSERVATION'
          : decode(tools, call.function.name, call.function.arguments);
      let entry;
      if (!rejected && call.function.name === 'tap') {
        const nodeId = JSON.parse(call.function.arguments).nodeId;
        entry = screen.entries?.[nodes.findIndex((n) => n.id === nodeId)];
        if (!entry?.allowed) rejected = 'TARGET_OUT_OF_SCOPE';
      }
      const name = rejected ? 'rejected' : call.function.name;
      const action: Action = { observationId: id, tool: name, outcome: rejected || 'observed' };
      actions.push(action);
      const fresh = await observeSettings();
      let next = fresh;
      if (!sameView(screen, fresh)) action.outcome = 'STALE_OBSERVATION';
      else if (!rejected) {
        if (name === 'request_help') return result('needs_review', 'MODEL_REQUESTED_HELP');
        if (name === 'finish') action.outcome = 'MISSING_CHECKPOINTS';
        if (name === 'wait') await sleep(200);
        if (name === 'tap' || name === 'back') {
          action.target = name === 'tap' ? entry!.label : 'back';
          try {
            await bounded.move(name, fresh, entry?.key);
            action.outcome = 'dispatched';
          } catch (err) {
            const code = reason(err);
            if (!isTransientObservation(code) && !isTargetUnavailable(code)) throw err;
            action.outcome = code;
          }
          next =
            action.outcome === 'dispatched'
              ? await waitForPage(
                  bounded,
                  (s) => s.page !== 'other' && s.page !== fresh.page && !!s.marker,
                  5000,
                  'navigation away from ' + fresh.page,
                )
              : await observeSettings();
        } else next = await observeSettings();
      }
      progress?.({ kind: 'action', name, status: action.outcome });
      const nextId = record('execution', next);
      action.after = nextId;
      if (next.page === 'bluetooth' && readBluetooth(next) !== initial)
        throw new Error('BLUETOOTH_STATE_CHANGED');
      if (action.outcome === 'dispatched') {
        if (name === 'tap' && screen.page !== 'bluetooth' && next.page === 'bluetooth')
          satisfied.arrived ??= nextId;
        if (satisfied.arrived && name === 'back' && screen.page !== 'home' && next.page === 'home')
          satisfied.returned = nextId;
      }
      if (satisfied.returned) {
        const post = await route(bounded, 'bluetooth', 5000);
        final = readBluetooth(post);
        const finalId = record('verification', post);
        const home = await route(bounded, 'home', 5000);
        satisfied.finalHome = record('verification', home);
        if (final !== initial) throw new Error('BLUETOOTH_STATE_CHANGED');
        satisfied.statePreserved = finalId;
        checkTime();
        return result('succeeded');
      }
      const stall = sameView(screen, next)
        ? JSON.stringify([name, action.target, action.outcome, next.page, missing()])
        : '';
      if (stall && stall === lastStall) return result('needs_review', 'NO_PROGRESS');
      lastStall = stall;
      remember(
        history,
        observation,
        reply,
        reply.tool_calls.map(() =>
          JSON.stringify({
            outcome: action.outcome,
            observationId: nextId,
            page: next.page,
            remaining: missing(),
          }),
        ),
      );
      screen = next;
      id = nextId;
    }
    return result('failed', 'DECISION_BUDGET');
  } catch (err) {
    const code = reason(err);
    const last = actions.at(-1);
    if (last && !last.after && last.outcome !== 'dispatched') last.outcome = code;
    return result(
      [
        'UNRECOGNIZED_SETTINGS_PAGE',
        'UNSUPPORTED_ROUTE',
        'PAGE_NOT_OBSERVED',
        'BLUETOOTH_STATE_UNREADABLE',
      ].includes(code) || isTargetUnavailable(code) || isTransientObservation(code)
        ? 'needs_review'
        : 'failed',
      code,
    );
  }
}
