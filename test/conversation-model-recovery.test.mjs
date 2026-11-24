import assert from 'node:assert/strict';
import test from 'node:test';
import { chatClient } from '../dist/chat.js';
import { runConversation } from '../dist/conversation.js';

function reply(finish_reason, fields) {
  return Response.json({ choices: [{ finish_reason, message: { role: 'assistant', ...fields } }] });
}

function action(observationId, name, args) {
  return reply('tool_calls', {
    tool_calls: [
      {
        id: observationId,
        type: 'function',
        function: { name, arguments: JSON.stringify({ observationId, ...args }) },
      },
    ],
  });
}

async function run(respond, updateDuringFirstReply = false) {
  const observations = [], records = [], events = [];
  let screen = 'first';
  const device = {
    async snapshot() {
      return {
        app: 'example.feed',
        window: 'main',
        width: 200,
        height: 400,
        rotation: 0,
        controls: [
          {
            id: screen,
            labels: [screen],
            role: 'Button',
            enabled: true,
            editable: false,
            focused: false,
            secret: false,
            bounds: { x: 2, y: 2, width: 30, height: 30 },
          },
        ],
      };
    },
    async perform() {
      screen = 'after-swipe';
    },
  };
  const transport = async (_url, options) => {
    const observation = JSON.parse(JSON.parse(options.body).messages.at(-1).content);
    observations.push(observation);
    const response = respond(observation, observations.length);
    if (updateDuringFirstReply && observations.length === 1) screen = 'updated';
    return response;
  };
  const decide = chatClient(
    { baseURL: 'http://localhost', model: 'test' }, transport, undefined, undefined, true,
  );
  const result = await runConversation(
    device, 'android:test', 'android', [{ user: '查看当前页面' }], decide, new AbortController().signal,
    async (step) => records.push(step), (_name, status) => events.push(status), () => true,
  );
  return { result, observations, records, events };
}

for (const [code, invalid] of [
  ['MODEL_INVALID_JSON', () => new Response('{')],
  ['MODEL_TOOL_CALL_REQUIRED', () => reply('stop', { content: '' })],
  ['MODEL_INVALID_TOOL_CALL', () => reply('tool_calls', { tool_calls: [{ type: 'function' }] })],
  ['MODEL_REPLY_TRUNCATED', () => reply('length', { content: 'partial' })],
]) {
  test(`${code} gets a new observation before asking the model again`, async () => {
    const { result, observations, records, events } = await run((obs, call) => {
      if (call === 1) return invalid();
      return action(obs.observationId, 'finish', { evidence: obs.controls[0].ref, message: '已看到新页面。' });
    }, true);
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(observations.map(obs => obs.controls[0].id), ['first', 'updated']);
    assert.ok(observations[1].modelReplyHint);
    assert.deepEqual(events, [code, 'observed']);
    assert.deepEqual(records.map(step => step.command), [{ action: 'check', id: 'updated', role: 'Button' }]);
  });
}

test('persistently unusable model replies stop with the saved findings', async () => {
  const { result, events, records } = await run((obs, call) => {
    if (call === 1) return action(obs.observationId, 'swipe', { direction: 'up', note: '第一条已读。' });
    return reply('length', { content: 'partial' });
  });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.reason, 'MODEL_REPLY_TRUNCATED');
  assert.match(result.answer, /第一条已读/);
  assert.equal(result.modelCalls, 4);
  assert.equal(events.length, 4);
  assert.deepEqual(records.map(step => step.command.action), ['swipe']);
});

test('explicit refusals, provider errors and meaningful plain text do not trigger another model call', async () => {
  for (const [response, code] of [
    [reply('content_filter', {}), 'MODEL_CONTENT_FILTERED'],
    [reply('stop', { refusal: 'Declined' }), 'MODEL_REFUSED'],
    [Response.json({ error: { message: 'request declined' } }), 'MODEL_PROVIDER_ERROR'],
    [new Response(null, { status: 401 }), 'MODEL_HTTP_401'],
    [reply('stop', { content: '请在手机上解锁。' }), undefined],
  ]) {
    const { result } = await run(() => response);
    assert.equal(result.modelCalls, 1);
    assert.equal(result.reason, code);
    if (!code) assert.equal(result.answer, '请在手机上解锁。');
  }
});
