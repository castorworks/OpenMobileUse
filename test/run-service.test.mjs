import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { RunService } from '../dist/run-service.js';

const actor = { subject: 'fixture' };
const png = Buffer.alloc(24);
Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
png.write('IHDR', 12);
png.writeUInt32BE(100, 16);
png.writeUInt32BE(100, 20);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'omu-run-service-'));
  const previousRoot = process.env.OMU_STATE_DIR;
  process.env.OMU_STATE_DIR = root;
  const db = new DatabaseSync(join(root, 'api.sqlite'));
  db.exec('PRAGMA foreign_keys = ON');
  const data = {
    db,
    transaction(work) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  const state = {
    app: 'com.example', window: 'main', width: 100, height: 100, rotation: 0,
    controls: [], taps: 0, action: async () => {}, connection: 'usb', alias: 'native-usb',
  };
  const drivers = {
    async discover(platform) {
      return platform === 'android' ? [{
        id: state.alias, hardwareKey: 'same-phone', platform,
        available: true, model: 'Fixture Android', connection: state.connection,
      }] : [];
    },
    async status(platform) { return { platform, available: platform === 'android' }; },
    async open(target, dispatch) {
      const snapshot = async () => ({
        app: state.app, window: state.window, width: state.width, height: state.height,
        rotation: state.rotation, controls: state.controls,
      });
      const device = {
        snapshot,
        screenshot: async () => png,
        perform: async (step) => dispatch(step.kind, async () => {
          state.taps++;
          await state.action();
        }),
        back: async () => dispatch('back', async () => {}),
        launch: async (step) => dispatch('launch', async () => {
          state.app = step.app;
          return step.app;
        }).then(() => state.app),
        foregroundApp: async () => state.app,
        observe: async () => ({ page: 'other' }),
        move: async () => {},
        close: async () => {},
      };
      return { device, owned: { endpoint: 'http://127.0.0.1:4723', sessionId: randomUUID(), ports: [4724] }, close: device.close };
    },
    async close() {},
  };
  let service;
  const start = async () => {
    service = new RunService({ data, artifactDir: join(root, 'artifacts'), drivers });
    await service.start();
    return service;
  };
  t.after(async () => {
    await service?.close();
    db.close();
    if (previousRoot === undefined) delete process.env.OMU_STATE_DIR;
    else process.env.OMU_STATE_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  });
  await start();
  const [{ id }] = await service.listDevices();
  return {
    get service() { return service; }, id, state, db,
    async restart() { await service.close(); return start(); },
  };
}

async function waitForRun(service, id, status) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const run = service.getRun(id);
    if (status ? run.status === status : ['succeeded', 'failed', 'cancelled', 'needs_review'].includes(run.status))
      return run;
    await sleep(5);
  }
  assert.fail('Run did not reach expected state: ' + JSON.stringify(service.getRun(id)));
}

async function accept(service, deviceId, kind, input, key = randomUUID(), fields = {}) {
  return service.submit({ deviceId, kind, input, ...fields }, actor, key);
}

test('capture observations, raw artifacts, idempotency and transport changes share the persistent run engine', async (t) => {
  const { service, id, state } = await fixture(t);
  const capture = await accept(service, id, 'capture', {});
  const screen = await waitForRun(service, capture.id);
  assert.equal(screen.status, 'succeeded');
  assert.equal(screen.result.stable, true);
  const artifact = await service.getArtifact(capture.id, screen.artifacts[0].id);
  assert.equal(artifact.mediaType, 'image/png');
  assert.deepEqual(artifact.data, png);

  const input = { step: { action: 'tap', x: 0.3, y: 0.5 }, observationId: screen.result.observationId };
  const key = randomUUID();
  const accepted = await Promise.all([
    accept(service, id, 'step', input, key),
    accept(service, id, 'step', { ...input, step: { y: 0.5, x: 0.3, action: 'tap' } }, key),
  ]);
  assert.equal(accepted[0].id, accepted[1].id);
  const step = await waitForRun(service, accepted[0].id);
  assert.equal(step.status, 'succeeded');
  assert.equal(state.taps, 1);
  await assert.rejects(accept(service, id, 'step', { ...input, step: { action: 'back' } }, key),
    { code: 'IDEMPOTENCY_CONFLICT' });
  const events = service.events(step.id).items;
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5]);
  assert.equal(events.at(-2).type, 'step.result');

  state.connection = 'network';
  state.alias = 'tcp-alias';
  const [device] = await service.listDevices(true);
  assert.equal(device.id, id);
  assert.equal(device.connection, 'network');
});

test('ambiguous dispatch gates device writes until a matching, fresh capture is acknowledged', async (t) => {
  const { service, id, state } = await fixture(t);
  const script = { steps: [{ action: 'tap', x: 0.3, y: 0.5 }] };
  state.action = async () => { throw Error('lost receipt'); };
  const first = await accept(service, id, 'script', { script });
  assert.equal((await waitForRun(service, first.id)).reason, 'ACTION_OUTCOME_UNKNOWN');
  const [marker] = service.listPendingActions(id);
  assert.equal(marker.runId, first.id);
  await assert.rejects(accept(service, id, 'script', { script }), { code: 'PENDING_ACTION_REVIEW_REQUIRED' });

  await assert.rejects(service.acknowledgeAction(id, marker.id, {
    observationId: randomUUID(), outcome: 'accepted_current_state',
  }, actor), { code: 'STALE_OBSERVATION' });
  const capture = await accept(service, id, 'capture', {});
  const screen = await waitForRun(service, capture.id);
  const evidence = { observationId: screen.result.observationId, outcome: 'accepted_current_state' };
  state.window = 'changed';
  await assert.rejects(service.acknowledgeAction(id, marker.id, evidence, actor), { code: 'STALE_OBSERVATION' });
  state.window = 'main';
  const acknowledgement = await service.acknowledgeAction(id, marker.id, evidence, actor);
  assert.deepEqual(await service.acknowledgeAction(id, marker.id, evidence, actor), acknowledgement);
  assert.deepEqual(service.listPendingActions(id), []);

  state.action = async () => {};
  const second = await accept(service, id, 'script', { script });
  assert.equal((await waitForRun(service, second.id)).status, 'succeeded');
  assert.equal(state.taps, 2);
});

test('a cancellation waits for driver acknowledgement and a queued cancellation never dispatches', async (t) => {
  const { service, id, state } = await fixture(t);
  const gate = Promise.withResolvers();
  const dispatched = Promise.withResolvers();
  state.action = async () => {
    dispatched.resolve();
    await gate.promise;
  };
  const script = { steps: [{ action: 'tap', x: 0.3, y: 0.5 }] };
  const running = await accept(service, id, 'script', { script });
  await dispatched.promise;
  t.after(() => gate.resolve());
  await assert.rejects(accept(service, id, 'script', { script }), { code: 'DEVICE_BUSY' });
  const queued = await accept(service, id, 'script', { script }, randomUUID(), { onBusy: 'queue', startWithinMs: 2000 });
  assert.equal(service.cancelRun(queued.id).status, 'cancelled');
  assert.equal(service.cancelRun(running.id).status, 'cancelling');
  await sleep(10);
  assert.equal(service.getRun(running.id).status, 'cancelling');
  gate.resolve();
  assert.equal((await waitForRun(service, running.id)).status, 'cancelled');
  assert.equal(state.taps, 1);
});

test('restart preserves completed records and fails claimed work without repeating actions', async (t) => {
  const context = await fixture(t);
  const { id, state, db } = context;
  const script = { steps: [{ action: 'tap', x: 0.3, y: 0.5 }] };
  const accepted = await accept(context.service, id, 'script', { script });
  assert.equal((await waitForRun(context.service, accepted.id)).status, 'succeeded');
  await context.service.close();
  // Simulate a durable claim surviving abrupt process termination.
  db.prepare("UPDATE service_runs SET status = 'running', finishedAt = NULL WHERE id = ?").run(accepted.id);
  const service = await context.restart();
  assert.equal(service.getRun(accepted.id).reason, 'RUN_INTERRUPTED');
  assert.equal(state.taps, 1);
});

test('external Appium receives separate local forwarding ports and only this service closes its sessions', async (t) => {
  const { createServer } = await import('node:http');
  const { NativeServiceDrivers } = await import('../dist/service-drivers.js');
  const active = new Map();
  const deleted = [];
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url === '/status') {
      response.end(JSON.stringify({ value: { ready: true, build: { version: '3.9.1' } } }));
    } else if (request.method === 'POST' && request.url === '/session') {
      let data = '';
      for await (const chunk of request) data += chunk;
      const sessionId = randomUUID();
      const caps = JSON.parse(data).capabilities.alwaysMatch;
      active.set(sessionId, caps);
      response.end(JSON.stringify({ value: { sessionId } }));
    } else if (request.method === 'DELETE' && request.url?.startsWith('/session/')) {
      const sessionId = request.url.split('/').at(-1);
      deleted.push(sessionId);
      active.delete(sessionId);
      response.end(JSON.stringify({ value: null }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ value: { error: 'invalid session id' } }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const drivers = new NativeServiceDrivers({ appiumUrl: 'http://127.0.0.1:' + server.address().port });
  const target = (id) => ({ platform: 'android', id, model: id, available: true });
  const signal = new AbortController().signal;
  const [first, second] = await Promise.all([
    drivers.open(target('one'), (_kind, work) => work(), 'foreground', signal),
    drivers.open(target('two'), (_kind, work) => work(), 'foreground', signal),
  ]);
  const firstPort = active.get(first.owned.sessionId)['appium:systemPort'];
  const secondPort = active.get(second.owned.sessionId)['appium:systemPort'];
  assert.ok(Number.isInteger(firstPort));
  assert.ok(Number.isInteger(secondPort));
  assert.notEqual(firstPort, secondPort);
  await first.close();
  await drivers.recover(second.owned);
  await drivers.close();
  assert.deepEqual(deleted, [first.owned.sessionId, second.owned.sessionId]);
});
