import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { chatClient } from '../dist/chat.js';

const config = { baseURL: 'http://127.0.0.1', model: 'test', requestTimeoutMs: 15 };
const lateReply = JSON.stringify({
  choices: [
    {
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        tool_calls: [{ id: 'late', type: 'function', function: { name: 'wait', arguments: '{}' } }],
      },
    },
  ],
});

test('a stalled response body times out and retries with increasing backoff', async () => {
  const attempts = [];
  const transport = async (_url, { signal }) => {
    attempts.push(performance.now());
    return { ok: true, text: () => sleep(150, lateReply, { signal }) };
  };
  const decide = chatClient(config, transport, undefined, undefined, true);

  await assert.rejects(decide([], [], Date.now() + 5000, () => {}), /MODEL_REQUEST_TIMEOUT/);
  assert.equal(attempts.length, 3);
  assert.ok(attempts[1] - attempts[0] >= 300);
  assert.ok(attempts[2] - attempts[1] >= 600);
});

test('the retry limit applies after the initial attempt and honors Retry-After', async () => {
  const transport = async () => new Response(null, { status: 503, headers: { 'Retry-After': '0' } });
  const decide = chatClient({ ...config, requestTimeoutMs: 1000, maxRetries: 5 }, transport);
  let attempts = 0;

  await assert.rejects(decide([], [], Date.now() + 5000, () => attempts++), /MODEL_HTTP_503/);
  assert.equal(attempts, 6);
});

test('the task deadline ends a model request without retrying', async () => {
  const transport = async (_url, { signal }) => sleep(150, new Response(lateReply), { signal });
  const decide = chatClient({ ...config, requestTimeoutMs: 1000 }, transport);
  let attempts = 0;

  await assert.rejects(decide([], [], Date.now() + 30, () => attempts++), /TIME_BUDGET/);
  assert.equal(attempts, 1);
});

test('stopping during backoff cancels the model request', async () => {
  const stop = new AbortController();
  const transport = async () => {
    throw new Error('connection reset');
  };
  const decide = chatClient(config, transport, undefined, stop.signal);
  let attempts = 0;

  const stopped = assert.rejects(decide([], [], Date.now() + 5000, () => attempts++), /CANCELLED/);
  await sleep(20);
  stop.abort();
  await stopped;
  assert.equal(attempts, 1);
});
