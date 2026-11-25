import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../dist/api-client.js';
import { Workbench } from '../desktop/workbench.mjs';

const at = '2026-11-25T10:00:00.000Z';
const deviceId = 'b91310a8-dc0a-4aac-8c4c-82caedf242ac';
const runId = '76a03ed3-818b-4380-b5ba-36d70cb42a9a';
const chatId = '246fc15f-75fc-41fe-836d-eaa72e26590a';
const artifact = {
  id: 'e3aa97ec-5851-4f11-9f89-9ff8ba221bc4', kind: 'screenshot', mediaType: 'image/png', createdAt: at,
};
const event = (sequence, type, data) => ({ sequence, type, at, data });
function sse(events) {
  return new Response(events.map((value) =>
    `id: ${value.sequence}\nevent: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`,
  ).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
}

const preferences = {
  config: () => ({ local: false, model: 'sample', useImages: true }),
};

test('Desktop watches HTTP chat progress, resumes SSE without duplication, and reads preview PNG separately', { timeout: 6000 }, async (t) => {
  const runPath = '/api/runs/' + runId;
  const submitted = { id: runId, deviceId, kind: 'chat', status: 'starting', createdAt: at, conversationId: chatId, lastEventId: 1 };
  const preview = event(3, 'artifact.available', artifact);
  const requests = [];
  let finished = false;
  let streams = 0;
  const api = new ApiClient({ baseURL: 'https://service.example', token: 'token', fetch: async (url, options) => {
    requests.push([url.pathname, options.method]);
    assert.equal(options.headers.get('Authorization'), 'Bearer token');
    if (url.pathname === '/api/runs' && options.method === 'POST') {
      assert.ok(options.headers.has('Idempotency-Key'));
      assert.deepEqual(JSON.parse(options.body), {
        deviceId, kind: 'chat', preview: true, input: { message: 'Open the feed.', modelProfile: 'sample', useImages: true },
      });
      return Response.json(submitted, { status: 202 });
    }
    if (url.pathname === runPath + '/events') {
      if (options.headers.get('Accept') !== 'text/event-stream') return Response.json({ items: [], lastEventId: finished ? 5 : 1 });
      if (++streams === 1) {
        assert.equal(options.headers.get('Last-Event-ID'), null);
        return sse([
          event(1, 'run.status', { status: 'running' }),
          event(2, 'run.progress', { name: '打开应用', status: 'dispatched' }), preview,
        ]);
      }
      assert.equal(options.headers.get('Last-Event-ID'), '3');
      finished = true;
      return sse([preview, event(4, 'run.progress', { name: '核对结果', status: 'observed' }),
        event(5, 'run.status', { status: 'succeeded' })]);
    }
    if (url.pathname === runPath + '/artifacts/' + artifact.id) {
      assert.equal(options.headers.get('Accept'), 'image/png');
      return new Response('png fixture', { headers: { 'Content-Type': 'image/png' } });
    }
    if (url.pathname === runPath) return Response.json({
      ...submitted, status: finished ? 'succeeded' : 'running', artifacts: finished ? [artifact] : [],
      result: finished ? { kind: 'chat', conversationId: chatId, turn: 1, answer: 'Opened.', modelCalls: 2 } : undefined,
    });
    assert.fail('Unexpected HTTP request ' + url.href);
  } });
  const frames = [];
  const terminal = Promise.withResolvers();
  const workbench = new Workbench((event) => {
    if (event.type === 'frame') frames.push(event.frame);
    if (event.type === 'run' && event.record.status === 'succeeded') terminal.resolve(event.record);
  }, { api, preferences });
  t.after(() => workbench.shutdown());

  assert.equal(await workbench.start(deviceId, 'chat', { message: 'Open the feed.' }), runId);
  const result = await terminal.promise;
  assert.equal(result.result.answer, 'Opened.');
  assert.equal(result.chatId, chatId);
  assert.deepEqual(result.events.map((entry) => entry.name), ['打开应用', '核对结果']);
  assert.equal(streams, 2);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].image, 'data:image/png;base64,' + Buffer.from('png fixture').toString('base64'));
  assert.equal(frames[0].observationId, undefined);
  await workbench.shutdown();
  assert.ok(requests.every((entry) => !entry[0].endsWith('/cancel')));
});

test('Desktop capture uses stable tokens for manual steps and keeps success distinct from a failed post-step screen', async (t) => {
  const sent = [];
  let captures = 0;
  const observationId = 'observation_1';
  const api = new ApiClient({ baseURL: 'https://service.example', token: 'token', fetch: async (url, options) => {
    if (url.pathname === '/api/runs') {
      const body = JSON.parse(options.body);
      sent.push(body);
      const id = body.kind === 'capture' ? 'capture-' + ++captures : 'step';
      return Response.json({ id, deviceId, kind: body.kind, status: 'starting', lastEventId: 1 }, { status: 202 });
    }
    if (url.pathname === '/api/runs/capture-1') return Response.json({
      id: 'capture-1', kind: 'capture', status: 'succeeded', artifacts: [artifact],
      result: { kind: 'capture', stable: true, observationId, controls: [] },
    });
    if (url.pathname === '/api/runs/capture-2') return Response.json({ status: 'failed', reason: 'SCREENSHOT_UNAVAILABLE' });
    if (url.pathname === '/api/runs/step') return Response.json({ status: 'succeeded', result: { action: 'tap' } });
    if (url.pathname.endsWith('/pending-actions')) return Response.json({ items: [] });
    if (url.pathname.endsWith('/artifacts/' + artifact.id)) return new Response('png fixture', { headers: { 'Content-Type': 'image/png' } });
    if (url.pathname === '/api/conversations/' + chatId) return Response.json({ deviceId }, { headers: { ETag: '"chat-1"' } });
    assert.fail('Unexpected HTTP request ' + url.href);
  } });
  const workbench = new Workbench(() => {}, { api, preferences });
  t.after(() => workbench.shutdown());
  const { frame } = await workbench.refresh(deviceId);
  assert.equal(frame.observationId, observationId);
  const step = { action: 'tap', x: 0.5, y: 0.5 };
  assert.deepEqual(await workbench.action(deviceId, step, frame.observationId, chatId), {
    result: { action: 'tap', status: 'succeeded' }, captureError: 'SCREENSHOT_UNAVAILABLE',
  });
  assert.deepEqual(sent[1], {
    kind: 'step', deviceId, input: { step, observationId, conversationId: chatId, conversationETag: '"chat-1"' }, preview: true,
  });
});
