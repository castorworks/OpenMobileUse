import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { ApiClient, terminalRunStatus } from '../dist/api-client.js';
import { createApiServer } from '../dist/http.js';
import { Workbench } from '../desktop/workbench.mjs';

test('Desktop uses the real HTTP service for device work and leaves an active run intact on exit', { timeout: 10000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omu-workbench-http-'));
  const previousStateDirectory = process.env.OMU_STATE_DIR;
  process.env.OMU_STATE_DIR = directory;
  const token = 'workbench-integration-token';
  const png = await sharp({ create: { width: 100, height: 200, channels: 3, background: '#224466' } }).png().toBuffer();
  const view = {
    app: 'example.settings', window: 'settings', width: 100, height: 200, rotation: 0,
    controls: [{
      id: 'settings', role: 'Button', labels: ['Settings'],
      bounds: { x: 12, y: 20, width: 60, height: 15 },
      enabled: true, editable: false, focused: false, secret: false,
    }],
  };
  const target = {
    id: 'fixture-phone', platform: 'harmony', model: 'Fixture phone', available: true, connection: 'usb',
  };
  const running = Promise.withResolvers();
  const unblock = Promise.withResolvers();
  let waitForTap = false;
  let taps = 0;
  const noop = async () => {};
  const drivers = {
    discover: async (platform) => platform === 'harmony' ? [target] : [],
    status: async (platform) => ({ platform, available: platform === 'harmony' }),
    open: async (_target, dispatch) => ({
      device: {
        snapshot: async () => view,
        screenshot: async () => png,
        foregroundApp: async () => view.app,
        perform: async (step) => dispatch(step.kind, async () => {
          assert.equal(step.kind, 'tap');
          taps++;
          if (waitForTap) {
            running.resolve();
            await unblock.promise;
          }
        }),
        observe: async () => ({ page: 'other' }),
        close: noop, launch: noop, back: noop, move: noop,
      },
      close: noop,
    }),
    close: noop,
  };
  const model = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const observation = JSON.parse(body.messages.findLast((entry) => entry.role === 'user').content);
    const args = {
      evidence: observation.controls[0].ref, message: '设置已打开。', observationId: observation.observationId,
    };
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant', tool_calls: [{ id: 'call', type: 'function', function: {
        name: 'finish', arguments: JSON.stringify(args),
      } }],
    } }] }));
  });
  let service, workbench;
  t.after(async () => {
    unblock.resolve();
    await workbench?.shutdown();
    await service?.close();
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
    if (previousStateDirectory === undefined) delete process.env.OMU_STATE_DIR;
    else process.env.OMU_STATE_DIR = previousStateDirectory;
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
  service = await createApiServer({
    directory, port: 0, bootstrapToken: token, drivers,
    profiles: [{
      id: 'fixture', config: { baseURL: 'http://127.0.0.1:' + model.address().port, model: 'fixture-model' },
    }],
  });
  const api = new ApiClient({ baseURL: service.url, token });
  const finished = new Map();
  workbench = new Workbench((event) => {
    if (event.type === 'run' && terminalRunStatus(event.record.status)) finished.set(event.record.id, event.record);
  }, { api, preferences: { config: () => ({ local: false, model: 'fixture', useImages: false }) } });
  const { devices: [device] } = await workbench.devices();
  assert.equal(device.model, 'Fixture phone');
  assert.ok(!device.needsReview);
  const { frame } = await workbench.refresh(device.id);
  assert.match(frame.image, /^data:image\/png;base64,/);
  assert.ok(frame.observationId);
  assert.equal((await workbench.action(device.id, { action: 'tap', x: 0.3, y: 0.13 }, frame.observationId)).result.action, 'tap');

  const chatRun = await workbench.start(device.id, 'chat', { message: '核对应用已打开' });
  await workbench.watchers.get(chatRun)?.done;
  const chatResult = finished.get(chatRun);
  assert.equal(chatResult.result.answer, '设置已打开。');
  const chat = await workbench.conversation(device.id, chatResult.chatId);
  assert.equal(chat.turns[0].assistant, '设置已打开。');
  assert.ok(chat.revision);
  assert.equal(chat.stepCount, 1);
  const scriptId = await workbench.saveRecording(chat.id, '检查设置');
  assert.equal((await workbench.exportScript(scriptId)).script.steps[0].action, 'check');
  const replayId = await workbench.start(device.id, 'script', { id: scriptId, title: '检查设置' });
  await workbench.watchers.get(replayId)?.done;
  assert.equal(finished.get(replayId).status, 'succeeded');
  assert.equal(finished.get(replayId).title, '检查设置');
  assert.equal((await workbench.history(device.id, true)).history[0].id, replayId);

  const tapScript = await workbench.importScript('点击设置', JSON.stringify({ steps: [{ action: 'tap', id: 'settings' }] }));
  waitForTap = true;
  const active = await workbench.start(device.id, 'script', tapScript);
  await running.promise;
  await workbench.shutdown();
  assert.equal((await api.getRun(active)).status, 'running');
  unblock.resolve();
  assert.equal((await api.waitRun(active)).status, 'succeeded');
  assert.equal((await api.json('/healthz')).status, 'ok');
  assert.equal(taps, 2);
});
