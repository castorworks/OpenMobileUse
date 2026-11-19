import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../dist/agent.js';
import { chatClient, modelConfig, messagesFor, remember } from '../dist/chat.js';

function handset(readSwitch = () => false) {
  let page = 'home',
    visits = 0;
  const moves = [];
  return {
    moves,
    layoutKey: 'portrait',
    async observe() {
      return {
        page,
        marker: page,
        entries:
          page === 'home'
            ? [
                { key: 'wifi', label: 'Wi-Fi', allowed: false },
                { key: 'bt', label: '蓝牙', allowed: true },
              ]
            : undefined,
        layoutKey: this.layoutKey,
        bluetooth: page === 'bluetooth' ? readSwitch(visits) : undefined,
      };
    },
    async move(action, from, key) {
      if (action === 'tap') assert.equal(key, 'bt');
      moves.push(action);
      if (action === 'forward' || action === 'tap') {
        page = 'bluetooth';
        visits++;
      } else page = 'home';
    },
  };
}
function call(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}
function response(calls, finish = 'tool_calls') {
  return Response.json({
    choices: [
      {
        finish_reason: finish,
        message: {
          role: 'assistant',
          content: null,
          reasoning_content: 'reasoning for next request',
          tool_calls: calls,
        },
      },
    ],
  });
}
const config = { model: 'deepseek-flash', baseURL: 'http://localhost:8000/v1' };
function simulate(next) {
  const requests = [];
  const decide = chatClient(config, async (url, init) => {
    assert.equal(url, config.baseURL + '/chat/completions');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'deepseek-flash');
    const view = JSON.parse(body.messages.at(-1).content);
    requests.push(body);
    return next(view, requests.length, body);
  });
  return { decide, requests };
}
function navigate(v, i) {
  const node = v.navigationEntries.find((n) => n.label === '蓝牙');
  return call(
    'call-' + i,
    node ? 'tap' : 'back',
    node ? { observationId: v.observationId, nodeId: node.id } : { observationId: v.observationId },
  );
}
test('429 retries one model request, keeps paired reasoning and validates the off state', async () => {
  const device = handset();
  const { decide, requests } = simulate((v, i) =>
    i === 1
      ? new Response(null, { status: 429, headers: { 'Retry-After': '0' } })
      : response([navigate(v, i)]),
  );
  const r = await runAgent(device, decide);
  assert.equal(r.status, 'succeeded');
  assert.equal(r.modelCalls, 3);
  assert.equal(r.decisions, 2);
  assert.equal(r.initial, false);
  assert.equal(r.final, false);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(
    r.actions.map((x) => x.tool),
    ['tap', 'back'],
  );
  assert.deepEqual(requests[0], requests[1]);
  const [, , assistant, tool] = requests[2].messages;
  assert.equal(assistant.reasoning_content, 'reasoning for next request');
  assert.equal(tool.tool_call_id, assistant.tool_calls[0].id);
  assert.equal(r.evidence.find((e) => e.observationId === r.satisfied.arrived).phase, 'execution');
  assert.equal(r.evidence.at(-1).page, 'home');
  assert.equal(device.moves.filter((a) => a === 'forward').length, 2); // setup and independent verification
});
test('rejected premature completion cannot use setup evidence', async () => {
  const { decide } = simulate((v, i) =>
    response([call('c' + i, 'finish', { observationId: v.observationId })]),
  );
  const r = await runAgent(handset(), decide);
  assert.equal(r.status, 'needs_review');
  assert.equal(r.reason, 'NO_PROGRESS');
  assert.ok(r.missing.includes('arrived'));
});
test('invalid node, stale observation, and batched proposals produce zero execution moves', async () => {
  const device = handset();
  const { decide, requests } = simulate((v, i) => {
    if (i === 1)
      return response([call('c1', 'tap', { observationId: v.observationId, nodeId: 'switch' })]);
    if (i === 2) return response([call('c2', 'tap', { observationId: 'old', nodeId: 'n1' })]);
    if (i === 3)
      return response([navigate(v, i), call('c4', 'finish', { observationId: v.observationId })]);
    return response([call('c5', 'request_help', { observationId: v.observationId })]);
  });
  const r = await runAgent(device, decide);
  assert.deepEqual(device.moves, ['openSettings', 'forward', 'back']);
  assert.deepEqual(
    r.actions.slice(0, 3).map((a) => a.outcome),
    ['INVALID_ARGUMENTS', 'STALE_OBSERVATION', 'ONE_ACTION_PER_OBSERVATION'],
  );
  assert.deepEqual(
    requests[3].messages
      .filter((m) => m.role === 'tool')
      .slice(-2)
      .map((m) => m.tool_call_id),
    ['call-3', 'c4'],
  );
});
test('changed bounds while model was thinking invalidate even a correct node', async () => {
  const d = handset();
  const { decide } = simulate((v, i) => {
    d.layoutKey = 'landscape';
    return response([navigate(v, i)]);
  });
  const r = await runAgent(d, decide, { turns: 1, ms: 5000 });
  assert.equal(r.reason, 'DECISION_BUDGET');
  assert.equal(r.actions[0].outcome, 'STALE_OBSERVATION');
  assert.deepEqual(d.moves, ['openSettings', 'forward', 'back']);
});
test('auth errors and truncated responses do not dispatch or retry', async () => {
  for (const [reply, reason] of [
    [() => new Response(null, { status: 401 }), 'MODEL_HTTP_401'],
    [(v, i) => response([navigate(v, i)], 'length'), 'MODEL_REPLY_TRUNCATED'],
  ]) {
    const d = handset();
    const r = await runAgent(d, simulate(reply).decide);
    assert.equal(r.reason, reason);
    assert.equal(r.modelCalls, 1);
    assert.deepEqual(d.moves, ['openSettings', 'forward', 'back']);
  }
});
test('changed final reading fails after restoring Settings home', async () => {
  const r = await runAgent(
    handset((visits) => visits >= 3),
    simulate((v, i) => response([navigate(v, i)])).decide,
  );
  assert.equal(r.reason, 'BLUETOOTH_STATE_CHANGED');
  assert.ok(r.missing.includes('statePreserved'));
  assert.equal(r.evidence.at(-1).page, 'home');
});
test('custom endpoint does not inherit the default credential, and history prunes whole turns', (t) => {
  const original = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'offline-test-credential';
  t.after(() => {
    if (original === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = original;
  });
  assert.equal(modelConfig({}).key, 'offline-test-credential');
  assert.equal(modelConfig({ baseURL: 'http://localhost:8000/v1' }).key, undefined);
  assert.throws(() => modelConfig({ baseURL: 'http://example.com/v1' }), /HTTPS/);
  const history = [];
  for (const id of ['a', 'b'])
    remember(
      history,
      { observationId: id },
      {
        role: 'assistant',
        content: null,
        reasoning_content: id.repeat(400),
        tool_calls: [call(id, 'wait', {})],
      },
      ['{}'],
    );
  const msg = messagesFor('goal', history, { page: 'home' }, [], 850);
  assert.equal(history.length, 1);
  assert.equal(msg[2].tool_calls[0].id, 'b');
  assert.equal(msg[3].tool_call_id, 'b');
  assert.throws(() => messagesFor('x'.repeat(1000), [], {}, [], 100), /CONTEXT_BUDGET/);
});

test('the model chooses a node from the current rows; a visible off-task row is rejected', async () => {
  const d = handset();
  const { decide } = simulate((v, i) => {
    if (i === 1) {
      assert.deepEqual(
        v.navigationEntries.map((n) => n.label),
        ['Wi-Fi', '蓝牙'],
      );
      return response([
        call('c1', 'tap', { observationId: v.observationId, nodeId: v.navigationEntries[0].id }),
      ]);
    }
    return response([navigate(v, i)]);
  });
  const r = await runAgent(d, decide);
  assert.equal(r.status, 'succeeded');
  assert.equal(r.actions[0].outcome, 'TARGET_OUT_OF_SCOPE');
  assert.equal(d.moves.filter((a) => a === 'tap').length, 1);
});
test('unknown dispatch outcome stops immediately and a foreign foreground is never sent', async () => {
  const d = handset(),
    original = d.move;
  d.move = async function (action, ...args) {
    if (action === 'tap') throw new Error('ACTION_OUTCOME_UNKNOWN: disconnected');
    return original.call(this, action, ...args);
  };
  const { decide, requests } = simulate((v, i) => response([navigate(v, i)]));
  let r = await runAgent(d, decide);
  assert.equal(r.reason, 'ACTION_OUTCOME_UNKNOWN');
  assert.equal(requests.length, 1);
  const d2 = handset();
  let hidden = false;
  const observe = d2.observe.bind(d2);
  d2.observe = async () => (hidden ? { page: 'other', marker: 'private foreground' } : observe());
  const model = simulate((v, i) => {
    hidden = true;
    return response([navigate(v, i)]);
  });
  r = await runAgent(d2, model.decide);
  assert.equal(r.status, 'needs_review');
  assert.equal(model.requests.length, 1);
  assert.ok(!JSON.stringify(model.requests).includes('private foreground'));
});

test('cancelling an in-flight decision does not dispatch or retry', async () => {
  const controller = new AbortController();
  const device = handset();
  const decide = chatClient(
    config,
    async (_url, { signal }) => {
      controller.abort();
      signal.throwIfAborted();
    },
    undefined,
    controller.signal,
  );
  const r = await runAgent(device, decide, undefined, controller.signal);
  assert.equal(r.reason, 'CANCELLED');
  assert.equal(r.modelCalls, 1);
  assert.deepEqual(device.moves, ['openSettings', 'forward', 'back']);
});
