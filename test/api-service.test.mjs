import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import sharp from 'sharp';
import { apiDocument, matchOperation } from '../dist/api-contract.js';
import { ApiData } from '../dist/api-data.js';
import { createApiServer } from '../dist/http.js';

const app = 'example.settings';
const target = { id: 'test-bridge', platform: 'android', model: 'Mock phone', connection: 'usb', state: 'device', available: true };
const secret = 'test-' + randomUUID();
const selector = { id: 'open_settings' };
const action = { action: 'tap', ...selector };
const scope = { platform: 'android', steps: [action] };
const require = createRequire(import.meta.url);
const Ajv = require('ajv/dist/2020.js').default;
const ajv = new Ajv({ strict: false });
require('ajv-formats').default(ajv);
const schemaId = 'urn:open-mobile-use:test-contract';
ajv.addSchema({ $id: schemaId, components: apiDocument.components });

function checkJsonResponse(response, method, body) {
  const { operation } = matchOperation(new URL(response.url).pathname, method);
  const definition = operation.responses[response.status];
  const described = definition.$ref ? apiDocument.components.responses[definition.$ref.split('/').at(-1)] : definition;
  const media = response.headers.get('content-type').split(';')[0];
  const schema = described.content[media].schema;
  const validate = ajv.compile(schema.$ref ? { $ref: schemaId + schema.$ref } : schema);
  assert.ok(validate(body), JSON.stringify({ operation: operation.operationId, errors: validate.errors, body }));
  return body;
}

function mockDevices(image) {
  let activated = false;
  let operationGate;
  const actions = [];
  const control = {
    ...selector, labels: ['Settings'], role: 'android.widget.Button', bounds: { x: 10, y: 40, width: 60, height: 20 },
    enabled: true, clickable: true, editable: false, focused: false, secret: false,
  };
  const drivers = {
    discover: async (platform) => platform === 'android' ? [{ ...target, hardwareKey: 'test-hardware' }] : [],
    status: async (platform) => ({ platform, available: platform === 'android' }),
    toolchain: async () => ({ driver: 'mock' }),
    async open(_target, dispatch) {
      const device = {
        snapshot: async () => ({
          app, window: activated ? 'settings' : 'current', width: 100, height: 150, rotation: 0,
          controls: activated ? [control, { ...control, id: 'done', labels: ['Done'] }] : [control],
          layout: '<hierarchy/>',
        }),
        screenshot: async () => image,
        foregroundApp: async () => app,
        observe: async () => ({ page: 'other' }),
        close: async () => {},
        perform: (step) => dispatch(step.kind, async () => {
          actions.push(step.kind);
          await operationGate;
          activated = true;
        }),
      };
      return { device, close: device.close };
    },
    close: async () => {},
  };
  return { actions, drivers, blockUntil: (value) => { operationGate = value; } };
}

async function modelServer() {
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const data of req) raw += data;
    const { messages, tools } = JSON.parse(raw);
    const message = messages.findLast((entry) => entry.role === 'user' && typeof entry.content === 'string');
    const observation = JSON.parse(message.content);
    const isTask = tools.some((tool) => tool.function.name === 'act');
    const arguments_ = isTask ? { action: 'open' } :
      { evidence: observation.controls[0].ref, message: 'Settings visible.' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: 'mock', choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant',
      tool_calls: [{
        id: 'call', type: 'function', function: {
          name: isTask ? 'act' : 'finish',
          arguments: JSON.stringify({ observationId: observation.observationId, ...arguments_ }),
        },
      }],
    } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: 'http://127.0.0.1:' + server.address().port, close: () => server.close() };
}

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'omu-api-service-'));
  const original = process.env.OMU_STATE_DIR;
  process.env.OMU_STATE_DIR = directory;
  const image = await sharp({ create: { width: 100, height: 150, channels: 3, background: 'white' } }).png().toBuffer();
  const { drivers, actions, blockUntil } = mockDevices(image);
  const model = await modelServer();
  const service = await createApiServer({
    directory: join(directory, 'api'),
    port: 0,
    bootstrapToken: secret,
    drivers,
    profiles: [{ id: 'default', config: { model: 'mock', baseURL: model.url } }],
  });
  t.after(async () => {
    await service.close();
    model.close();
    if (original === undefined) delete process.env.OMU_STATE_DIR;
    else process.env.OMU_STATE_DIR = original;
    await rm(directory, { recursive: true, force: true });
  });
  const request = (path, { method = 'GET', body, headers, token = secret } = {}) => fetch(service.url + path, {
    method, headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const get = async (path) => {
    const res = await request(path);
    assert.equal(res.status, 200, await res.clone().text());
    return checkJsonResponse(res, 'GET', await res.json());
  };
  const { items: [device] } = await get('/api/devices');
  const submit = (kind, input, key = randomUUID(), extra = {}) => request('/api/runs', {
    method: 'POST', body: { deviceId: device.id, kind, input, ...extra }, headers: { 'Idempotency-Key': key },
  });
  const accepted = async (...args) => {
    const res = await submit(...args);
    assert.equal(res.status, 202, await res.clone().text());
    const run = checkJsonResponse(res, 'POST', await res.json());
    assert.equal(res.headers.get('location'), '/api/runs/' + run.id);
    return run;
  };
  const wait = async (id) => {
    const signal = AbortSignal.timeout(8000);
    for (;;) {
      const run = await get('/api/runs/' + id);
      if (['succeeded', 'failed', 'cancelled', 'needs_review'].includes(run.status)) return run;
      await sleep(20, undefined, { signal });
    }
  };
  return { directory, get, request, device, submit, accepted, wait, image, actions, blockUntil };
}

test('HTTP drives the shared device, recording and script services without Desktop', async (t) => {
  const client = await setup(t);
  const { request, get, accepted, wait, image, device, actions } = client;
  const unauth = await request('/api/devices', { token: '' });
  assert.equal(unauth.status, 401);
  assert.equal(unauth.headers.get('content-type'), 'application/problem+json');
  assert.equal((await get('/openapi.json')).openapi, '3.1.2');
  assert.equal((await get('/readyz')).status, 'ok');
  assert.equal((await get('/api/devices/' + device.id)).state, 'available');

  const capture = await wait((await accepted('capture', { includeLayout: true })).id);
  assert.equal(capture.status, 'succeeded', capture.reason);
  assert.ok(capture.result.observationId);
  assert.equal(capture.result.actionWidth, 100);
  const png = await request(capture.artifacts.find((artifact) => artifact.kind === 'screenshot').url);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await png.arrayBuffer()), image);
  assert.equal((await wait((await accepted('diagnose', {})).id)).result.controllable, true);

  const contact = await wait((await accepted('step', {
    step: { action: 'tap', x: 0.2, y: 0.4 }, observationId: capture.result.observationId,
  })).id);
  assert.equal(contact.status, 'succeeded', contact.reason);
  const oldCapture = await wait((await accepted('step', {
    step: { action: 'tap', x: 0.2, y: 0.4 }, observationId: capture.result.observationId,
  })).id);
  assert.equal(oldCapture.reason, 'STALE_OBSERVATION');
  assert.deepEqual(actions, ['tap']);

  const key = randomUUID();
  const original = await accepted('chat', { message: 'Read the settings screen' }, key);
  const chat = await wait(original.id);
  assert.equal(chat.status, 'succeeded', chat.reason);
  assert.equal(chat.result.answer, 'Settings visible.');
  const repeated = await client.submit('chat', { message: 'Read the settings screen' }, key);
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).id, chat.id);
  const conflict = await client.submit('chat', { message: 'Different instruction' }, key);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, 'IDEMPOTENCY_CONFLICT');
  const conversation = '/api/conversations/' + chat.conversationId;
  assert.equal((await get(conversation + '/messages')).items.length, 2);
  const exported = await get(conversation + '/recording');
  assert.equal(exported.platform, 'android');
  assert.equal(exported.steps[0].action, 'check');

  const recorded = chat.artifacts.find((item) => item.kind === 'recording');
  const create = await request('/api/scripts', { method: 'POST', body: {
    source: 'runRecording', title: 'Settings capture', runId: chat.id, artifactId: recorded.id,
  } });
  assert.equal(create.status, 201, await create.clone().text());
  const scriptId = (await create.json()).id;
  const scriptPath = '/api/scripts/' + scriptId;
  const patch = await request(scriptPath, { method: 'PATCH', body: { title: 'My settings' },
    headers: { 'If-Match': create.headers.get('etag') } });
  assert.equal(patch.status, 200);
  const stale = await request(scriptPath, { method: 'PATCH', body: { title: 'Outdated' },
    headers: { 'If-Match': create.headers.get('etag') } });
  assert.equal(stale.status, 412);
  assert.deepEqual(await get(scriptPath + '/content'), exported);
  const scriptRun = await wait((await accepted('script', { scriptId })).id);
  assert.equal(scriptRun.status, 'succeeded');
  assert.equal(scriptRun.title, 'My settings');

  const task = {
    schemaVersion: 1, id: 'test.settings', goal: 'Open settings', apps: [app],
    actions: [{ name: 'open', app, step: action }],
    checkpoints: [{ name: 'done', app, target: { id: 'done' }, afterAction: 'open' }],
  };
  const agent = await wait((await accepted('agent', { task })).id);
  assert.equal(agent.status, 'succeeded', agent.reason);
  const eventsUrl = '/api/runs/' + agent.id + '/events';
  const events = await get(eventsUrl);
  assert.ok(events.items.length > 1);
  const stream = await request(eventsUrl, {
    headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(events.items[0].sequence) },
  });
  assert.match(await stream.text(), /event: run.status/);
});

test('HTTP rejects simultaneous writes, cancels queued runs and enforces device scopes', async (t) => {
  const client = await setup(t);
  const { request, accepted, submit, wait, get, blockUntil, actions, device, directory } = client;
  const { promise, resolve } = Promise.withResolvers();
  blockUntil(promise);
  let active, queued;
  try {
    active = await accepted('script', { script: scope });
    const signal = AbortSignal.timeout(5000);
    while (!actions.length) await sleep(20, undefined, { signal });
    const rejected = await submit('script', { script: scope });
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).code, 'DEVICE_BUSY');
    queued = await accepted('script', { script: scope }, randomUUID(), { onBusy: 'queue', startWithinMs: 3000 });
    assert.equal((await request('/api/runs/' + queued.id + '/cancel', { method: 'POST' })).status, 200);
    assert.equal((await request('/api/runs/' + active.id + '/cancel', { method: 'POST' })).status, 202);
    assert.equal((await get('/api/runs/' + active.id)).status, 'cancelling');
  } finally {
    resolve();
  }
  assert.equal((await wait(active.id)).status, 'cancelled');
  assert.equal((await wait(queued.id)).status, 'cancelled');
  assert.deepEqual(actions, ['tap']);

  const data = new ApiData(join(directory, 'api'));
  const allowed = data.issueToken('viewer', ['devices:read'], [device.id]);
  const other = data.issueToken('other', ['devices:read'], [randomUUID()]);
  const capturer = data.issueToken('capturer', ['runs:submit'], [device.id]);
  assert.equal((await request('/api/runs', {
    method: 'POST', token: capturer.token, headers: { 'Idempotency-Key': randomUUID() },
    body: { deviceId: device.id, kind: 'capture', input: { reconcilePendingActions: true } },
  })).status, 403);
  assert.equal((await request('/api/devices/' + device.id, { token: allowed.token })).status, 200);
  assert.equal((await request('/api/devices/' + device.id, { token: other.token })).status, 404);
  assert.equal((await request('/api/runs/' + active.id, { token: allowed.token })).status, 403);
  data.revokeToken(allowed.id);
  assert.equal((await request('/api/devices', { token: allowed.token })).status, 401);
  data.close();
});
