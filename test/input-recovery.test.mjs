import assert from 'node:assert/strict';
import test from 'node:test';
import { compileScript, executeRound } from '../dist/run.js';
import { parseTask, runTask } from '../dist/task.js';

const app = 'example.search';
const identity = 'harmony:test';

function page(id = 'query', value = '', foregroundApp = app) {
  return {
    app: foregroundApp,
    window: 'main',
    width: 200,
    height: 400,
    rotation: 0,
    controls: [
      {
        id,
        role: 'TextInput',
        labels: [],
        enabled: true,
        editable: true,
        focused: true,
        secret: false,
        value,
        bounds: { x: 0, y: 0, width: 100, height: 30 },
      },
    ],
  };
}

const command = (id) => ({ action: 'input', id, text: 'hello' });

async function playback(device) {
  const script = await compileScript(
    {
      platform: 'harmony',
      steps: [{ ...command('query'), inApp: app, reading: { value: '' } }],
    },
    'harmony',
  );
  return executeRound(device, identity, { script }, new AbortController().signal);
}

test('recorded input waits for the recorded app and original field value after focus changes', async () => {
  let attempts = 0;
  const wrongApp = page('query', '', 'example.other');
  const wrongValue = page('query', 'somebody else typed');
  const changed = [wrongApp, wrongApp, wrongValue, wrongValue];
  const result = await playback({
    snapshot: async () => (attempts && changed.length ? changed.shift() : page()),
    async perform(step, view, node) {
      assert.equal(view.app, app);
      assert.equal(node.value, '');
      if (++attempts === 1) throw Error('INPUT_FOCUS_UNCONFIRMED');
      assert.equal(changed.length, 0);
    },
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(attempts, 2);
});

test('recorded input never repeats an unverified write', async () => {
  let attempts = 0;
  const result = await playback({
    snapshot: async () => page(),
    async perform() {
      attempts++;
      throw Error('INPUT_NOT_VERIFIED');
    },
  });
  assert.equal(result.reason, 'INPUT_NOT_VERIFIED');
  assert.equal(attempts, 1);
});

test('named task gives the model fresh actions following a rejected input', async () => {
  const task = await parseTask(
    {
      schemaVersion: 1,
      id: 'search',
      goal: 'Fill the query',
      apps: [app],
      actions: ['query', 'replacement'].map((id) => ({ name: id, app, step: command(id) })),
      checkpoints: [{ name: 'done', app, target: { id: 'replacement' }, afterAction: 'replacement' }],
    },
    'harmony',
  );
  let view = page();
  const device = {
    snapshot: async () => view,
    async perform(step, current, node) {
      if (node.id === 'query') {
        view = page('replacement');
        throw Error('INPUT_TARGET_CHANGED');
      }
      view = page('replacement', step.text);
    },
  };
  const decide = async (messages, tools, deadline, count) => {
    count();
    const obs = JSON.parse(messages.at(-1).content);
    assert.deepEqual(obs.actions, [view.controls[0].id]);
    if (obs.actions[0] === 'replacement')
      assert.equal(
        JSON.parse(messages.findLast((m) => m.role === 'tool').content).outcome,
        'INPUT_TARGET_CHANGED',
      );
    return {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: obs.observationId,
          type: 'function',
          function: {
            name: 'act',
            arguments: JSON.stringify({ observationId: obs.observationId, action: obs.actions[0] }),
          },
        },
      ],
    };
  };
  const result = await runTask(device, identity, task, decide, false, new AbortController().signal);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(
    result.actions.map((a) => a.outcome),
    ['INPUT_TARGET_CHANGED', 'dispatched'],
  );
  assert.equal(result.modelCalls, 2);
});

test('playback reads through a temporary layout failure and reacquires a disabled target', async () => {
  let reads = 0;
  let lookups = 0;
  let writes = 0;
  const result = await playback({
    async snapshot() {
      if (!reads++) throw Error('HDC_LAYOUT_UNAVAILABLE');
      return page();
    },
    async perform() {
      if (!lookups++) throw Error('ELEMENT_DISABLED');
      writes++;
    },
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(lookups, 2);
  assert.equal(writes, 1);
});

async function namedTask(
  device,
  choose,
  { visual = false, step = { action: 'tap', id: 'query' } } = {},
) {
  const actions = [{ name: 'open', app, step }];
  if (visual) actions.push({ name: 'crop', app, step: { action: 'tap', id: 'query' }, visual: true });
  const task = await parseTask(
    {
      schemaVersion: 1,
      id: 'open',
      goal: 'Open the result',
      apps: [app],
      actions,
      checkpoints: [{ name: 'done', app, target: { id: 'result' }, afterAction: 'open' }],
      limits: { turns: 6 },
    },
    'harmony',
  );
  const decide = async (messages, tools, deadline, count) => {
    count();
    const obs = JSON.parse(
      messages.findLast((m) => m.role === 'user' && typeof m.content === 'string').content,
    );
    const last = messages.findLast((m) => m.role === 'tool');
    const [name, action] = choose(last && JSON.parse(last.content).outcome);
    return {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: obs.observationId,
          type: 'function',
          function: {
            name,
            arguments: JSON.stringify({ observationId: obs.observationId, action }),
          },
        },
      ],
    };
  };
  return runTask(device, identity, task, decide, visual, new AbortController().signal);
}

test('named task falls back from an unreadable crop, then rechecks its checkpoint without tapping twice', async () => {
  let taps = 0;
  let resultReads = 0;
  const device = {
    snapshot: async () => {
      if (taps && resultReads++ === 1) throw Error('FOREGROUND_WINDOW_AMBIGUOUS');
      return page(taps ? 'result' : 'query');
    },
    screenshot: async () => Buffer.from('incomplete screenshot'),
    perform: async () => {
      taps++;
    },
  };
  const result = await namedTask(
    device,
    (last) => {
      if (!last) return ['request_view', 'crop'];
      assert.equal(last, 'INVALID_PNG');
      return ['act', 'open'];
    },
    { visual: true },
  );
  assert.equal(result.status, 'succeeded');
  assert.equal(taps, 1);
  assert.equal(result.modelCalls, 2);
  assert.deepEqual(
    result.evidence.map((e) => e.name),
    ['done'],
  );
});

test('named task suppresses a repeated committed tap on the same observation', async () => {
  let taps = 0;
  const result = await namedTask(
    {
      snapshot: async () => page(),
      perform: async () => {
        taps++;
      },
    },
    () => ['act', 'open'],
  );
  assert.equal(result.reason, 'NO_PROGRESS');
  assert.equal(taps, 1);
  assert.deepEqual(result.evidence, []);
});

test('named task reevaluates scope after a stale target and stops on a sensitive screen', async () => {
  let attempts = 0;
  const device = {
    snapshot: async () => {
      const current = page();
      current.controls[0].secret = attempts > 0;
      return current;
    },
    perform: async () => {
      attempts++;
      throw Error('AMBIGUOUS_OR_MISSING_ELEMENT');
    },
  };
  const result = await namedTask(device, () => ['act', 'open']);
  assert.equal(result.reason, 'SENSITIVE_OR_BLOCKED_SCREEN');
  assert.equal(result.status, 'needs_review');
  assert.equal(result.modelCalls, 1);
  assert.equal(attempts, 1);
});

test('a named wait checks scope on every poll before accepting a matching selector', async () => {
  let reads = 0;
  const result = await namedTask(
    {
      snapshot: async () => {
        if (++reads === 4) return page('result', '', 'example.other');
        return page(reads < 4 ? 'query' : 'result');
      },
    },
    () => ['act', 'open'],
    { step: { action: 'waitFor', id: 'result', timeoutMs: 2500 } },
  );
  assert.equal(result.reason, 'APP_OUT_OF_SCOPE');
  assert.equal(result.status, 'needs_review');
  assert.deepEqual(result.evidence, []);
});

test('persistent read failures return the observation error without dispatching or calling the model', async () => {
  let reads = 0;
  const result = await namedTask(
    {
      snapshot: async () => {
        reads++;
        throw Error('HDC_LAYOUT_UNAVAILABLE');
      },
    },
    () => assert.fail('there was no page to act on'),
  );
  assert.equal(reads, 3);
  assert.equal(result.modelCalls, 0);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.reason, 'HDC_LAYOUT_UNAVAILABLE');
});
