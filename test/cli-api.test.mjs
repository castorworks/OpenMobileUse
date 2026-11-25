import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { ApiClient } from '../dist/api-client.js';
import { discoverLocalConnection, localConnectionFile, localInstanceHeader } from '../dist/local-connection.js';

const deviceId = '4b72e972-e30b-4db1-9f0c-9ce629ef989e';
const runId = '57246269-2262-4a25-8d88-17b13f58ad28';
const runPath = '/api/runs/' + runId;
const token = 'test-token';
const exec = promisify(execFile);
const summary = (kind, status) => ({
  id: runId, deviceId, kind, status, createdAt: '2026-11-25T08:00:00Z', lastEventId: 1,
});

async function fakeApi(t, handler) {
  const failures = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, request.url === '/healthz' ? undefined : 'Bearer ' + token);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
      const send = (value, status = 200) => response.writeHead(status, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(value));
      await handler(request, response, send, body);
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(failures, []);
  });
  return { ...process.env, OMU_API_URL: 'http://127.0.0.1:' + server.address().port, OMU_API_TOKEN: token };
}

const cli = (env, ...args) => exec(process.execPath, ['dist/cli.js', ...args], { env });

test('CLI without an explicit URL discovers only a verified local daemon', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omu-cli-discovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let probes = 0;
  const env = await fakeApi(t, (request, response, send) => {
    if (request.url === '/healthz') {
      probes++;
      response.setHeader(localInstanceHeader, runId);
      return send({ status: 'ok' });
    }
    if (request.url === '/api/devices?refresh=true') return send({ items: [] });
    assert.equal(request.url, '/api/capabilities');
    return send({ drivers: [] });
  });
  const file = join(directory, localConnectionFile);
  const url = env.OMU_API_URL;
  const save = (instanceId, address = url) => writeFile(file, JSON.stringify({ url: address, instanceId }), { mode: 0o600 });
  await save(deviceId);
  assert.equal(await discoverLocalConnection(directory), undefined);
  await save(runId, 'https://example.invalid');
  assert.equal(await discoverLocalConnection(directory), undefined);
  assert.equal(probes, 1);
  await save(runId);
  if (process.platform !== 'win32') {
    await chmod(file, 0o644);
    assert.equal(await discoverLocalConnection(directory), undefined);
    await chmod(file, 0o600);
  }
  delete env.OMU_API_URL;
  env.OMU_API_STATE_DIR = directory;
  assert.deepEqual(JSON.parse((await cli(env, 'devices', '--json')).stdout).devices, []);
  assert.equal(probes, 2);
});

test('CLI discovery uses server IDs and coordinate actions carry the capture token', async (t) => {
  let submissions = 0;
  const env = await fakeApi(t, (request, _response, send, body) => {
    if (request.url === '/api/devices?refresh=true') return send({
      items: [{ id: deviceId, name: 'Phone', platform: 'android', state: 'available' }],
    });
    if (request.url === '/api/capabilities') return send({
      drivers: [{ platform: 'android', available: true }, { platform: 'ios', available: false }],
    });
    if (request.url === '/api/runs') {
      submissions++;
      assert.ok(request.headers['idempotency-key']);
      assert.deepEqual(body, {
        kind: 'step', deviceId,
        input: { step: { action: 'tap', x: 0.5, y: 0.25 }, observationId: 'server-observation-1' },
      });
      return send(summary('step', 'queued'), 202);
    }
    assert.equal(request.url, runPath);
    send({ ...summary('step', 'succeeded'), artifacts: [], result: { kind: 'step', action: 'tap' } });
  });
  const listing = JSON.parse((await cli(env, 'devices', '--json')).stdout);
  assert.equal(listing.devices[0].id, deviceId);
  assert.deepEqual(listing.unavailable, ['ios']);
  const args = ['tap', '--device', deviceId, '--x', '0.5', '--y', '0.25'];
  await assert.rejects(cli(env, ...args), (error) => error.code === 2 && /--observation/.test(error.stderr));
  const result = JSON.parse((await cli(env, ...args, '--observation', 'server-observation-1')).stdout);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.runId, runId);
  assert.equal(submissions, 1);
});

test('CLI capture and recording are downloaded to local paths', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omu-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let kind;
  const screenshot = Buffer.from('mock PNG bytes');
  const layout = Buffer.from('<layout />');
  const recording = { platform: 'harmony', steps: [{ action: 'tap', label: 'Settings' }] };
  const env = await fakeApi(t, (request, response, send, body) => {
    if (request.url === '/api/runs') {
      kind = body.kind;
      if (kind === 'capture') assert.deepEqual(body.input, { includeLayout: true });
      else assert.deepEqual(body.input, { message: 'Confirm Settings', modelProfile: 'local', useImages: true });
      return send(summary(kind, 'starting'), 202);
    }
    if (request.url === runPath + '/artifacts/screen') return response.end(screenshot);
    if (request.url === runPath + '/artifacts/layout') return response.end(layout);
    if (request.url === runPath + '/artifacts/recording') return send(recording);
    if (request.url.startsWith(runPath + '/events')) return send({ items: [{
      sequence: 1, type: 'run.progress', data: { name: 'Read screen', status: 'observed' },
    }], lastEventId: 1 });
    assert.equal(request.url, runPath);
    if (kind === 'capture') return send({
      ...summary(kind, 'succeeded'),
      result: { kind, stable: true, observationId: 'observation-1', controls: [] },
      artifacts: [
        { kind: 'screenshot', mediaType: 'image/png', url: runPath + '/artifacts/screen' },
        { kind: 'layout', mediaType: 'application/xml', url: runPath + '/artifacts/layout' },
      ],
    });
    send({
      ...summary(kind, 'succeeded'),
      result: { kind, answer: 'Settings is open', confirmedStepCount: 1 },
      artifacts: [{ kind: 'recording', mediaType: 'application/json', url: runPath + '/artifacts/recording' }],
    });
  });
  const frame = JSON.parse((await cli(env, 'inspect', '--device', deviceId, '--output', directory, '--include-layout')).stdout);
  assert.deepEqual(await readFile(join(frame.directory, 'screen.png')), screenshot);
  assert.deepEqual(await readFile(join(frame.directory, 'layout.xml')), layout);
  const controls = JSON.parse(await readFile(join(frame.directory, 'controls.json'), 'utf8'));
  assert.equal(controls.observationId, 'observation-1');
  const output = join(directory, '录制.json');
  const chat = JSON.parse((await cli(
    env, 'chat', '--device', deviceId, '--message', 'Confirm Settings', '--model-profile', 'local', '--vision', '--output', output,
  )).stdout);
  assert.equal(chat.stepCount, 1);
  assert.equal(chat.recordingFile, output);
  assert.deepEqual(chat.events, [{ name: 'Read screen', status: 'observed' }]);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), recording);
});

test('an interrupted CLI retries submission by key and waits for the cancellation terminal state', async (t) => {
  let key;
  let cancellations = 0;
  let polls = 0;
  const env = await fakeApi(t, (request, response, send, body) => {
    if (request.url === '/api/runs') {
      assert.equal(body.kind, 'script');
      if (!key) {
        key = request.headers['idempotency-key'];
        return response.destroy();
      }
      assert.equal(request.headers['idempotency-key'], key);
      return send(summary('script', 'queued'), 202);
    }
    if (request.url === runPath + '/cancel') {
      cancellations++;
      return send({ ...summary('script', 'cancelling'), artifacts: [] }, 202);
    }
    assert.equal(request.url, runPath);
    const status = ++polls === 1 ? 'cancelling' : 'cancelled';
    send({ ...summary('script', status), reason: 'CANCELLED', artifacts: [] });
  });
  const directory = await mkdtemp(join(tmpdir(), 'omu-cli-cancel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'script.json');
  await writeFile(script, JSON.stringify({ steps: [{ action: 'tap', label: 'Settings' }] }));
  const simulatedInterrupt = `
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const response = await nativeFetch(url, options);
      if (new URL(url).pathname === '/api/runs' && options.method === 'POST') process.emit('SIGINT');
      return response;
    };
    process.argv.splice(1, 0, 'dist/cli.js');
    await import('./dist/cli.js');
  `;
  await assert.rejects(
    exec(process.execPath, ['--input-type=module', '-e', simulatedInterrupt, '--', 'run', '--device', deviceId, '--script', script], { env }),
    (error) => error.code === 1 && JSON.parse(error.stdout).status === 'cancelled',
  );
  assert.equal(cancellations, 1);
  assert.equal(polls, 2);
});

test('the shared client parses split SSE and sends a resume cursor with bearer auth', async () => {
  const chunks = [
    ': heartbeat\r', '\nid: 3\r\nevent: run.status\r\ndata: {"sequence":3,\r\n',
    'data: "type":"run.status","at":"now","data":{"status":"succeeded"}}\r\n\r\n',
    'id: 3\ndata: {"sequence":3,"type":"run.status","at":"now","data":{}}\n\n',
  ];
  let calls = 0;
  const api = new ApiClient({
    baseURL: 'https://local.example',
    token,
    fetch: async (url, options) => {
      calls++;
      assert.equal(url.pathname, runPath + '/events');
      assert.equal(options.headers.get('Authorization'), 'Bearer ' + token);
      assert.equal(options.headers.get('Last-Event-ID'), '2');
      return new Response(new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  const events = [];
  for await (const event of api.events(runId, { after: 2 })) events.push(event);
  assert.deepEqual(events, [{ sequence: 3, type: 'run.status', at: 'now', data: { status: 'succeeded' } }]);
  await assert.rejects(api.request('https://different.example/api/runs'), { code: 'API_INVALID_URL' });
  assert.equal(calls, 1);
});
