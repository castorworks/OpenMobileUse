import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { androidWorkbench } from '../test-support/http-workbench.mjs';
import { NativeServiceDrivers } from '../dist/service-drivers.js';
import { openDevice } from '../dist/doctor.js';
import { guardObservation, screenAvailable } from '../dist/steps.js';
import { compileScript, executeRound } from '../dist/run.js';

test('only Android workbench sessions request a one-second UI idle wait', async (t) => {
  const capabilities = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/status')) return Response.json({ value: { ready: true, build: { version: 'test' } } });
    if (options.method === 'DELETE') return Response.json({ value: null });
    capabilities.push(JSON.parse(options.body).capabilities.alwaysMatch);
    return Response.json({ value: { sessionId: 'fixture' } });
  });
  const drivers = new NativeServiceDrivers({ appiumMode: 'external' });
  const android = { id: 'fixture', platform: 'android', available: true };
  const ios = { ...android, platform: 'ios' };
  for (const target of [android, ios])
    await (await drivers.open(target, async () => {}, 'foreground', new AbortController().signal, 630)).close();
  const cli = await openDevice(android, async () => {});
  await cli.close();
  assert.deepEqual(capabilities.map(c => c['appium:settings[waitForIdleTimeout]']), [1000, undefined, undefined]);
  assert.deepEqual(capabilities.map(c => c['appium:newCommandTimeout']), [630, 630, 90]);
});

const swipe = { kind: 'swipe', from: { x: 0.5, y: 0.78 }, to: { x: 0.5, y: 0.26 }, duration: 400 };
test('cancelling a run during shared Appium startup releases its waiter before the driver opens', async t => {
  const drivers = new NativeServiceDrivers({ appiumMode: 'managed' });
  const warmup = Promise.withResolvers();
  t.mock.method(drivers, 'endpoint', () => warmup.promise);
  const reserve = t.mock.method(drivers, 'reservePort', () => assert.fail('cancelled waiter reserved a driver port'));
  const controller = new AbortController();
  const opening = drivers.open({ platform: 'android', id: 'test' }, async () => {}, 'foreground', controller.signal);
  controller.abort(Error('CANCELLED'));
  await assert.rejects(opening, /CANCELLED/);
  warmup.resolve('http://127.0.0.1:4723');
  assert.equal(reserve.mock.callCount(), 0);
});

function player(y = 298, height = 1688) {
  return {
    app: 'example.feed', window: 'player', width: 1272, height: 2772, rotation: 0,
    controls: [{
      id: 'image', role: 'android.widget.ImageView', labels: ['当前作品'],
      enabled: true, focused: false, editable: false, secret: false,
      bounds: { x: 0, y, width: 1272, height },
    }],
  };
}

test('the Android swipe guard accepts slight edge jitter on the same gesture path', () => {
  const validate = guardObservation('android:test', player(), swipe, screenAvailable);
  validate(player(297, 1690));
  validate(player(301, 1682));
});

test('a one-pixel passive player edge can move behind a live native button; a covering control still cancels it', () => {
  const v = player();
  const button = { ...v.controls[0], role: 'android.widget.Button', id: 'comments',
    bounds: { x: 100, y: 400, width: 100, height: 100 }, clickable: true };
  const background = { ...button, role: 'android.widget.FrameLayout', id: 'video', labels: [], clickable: false,
    bounds: { x: 0, y: 0, width: 150, height: 900 } };
  const view = { ...v, controls: [background, button] };
  const guard = guardObservation('android:phone', view, { kind: 'tap', selector: { id: button.id, role: button.role } });
  guard({ ...view, controls: [{ ...background, bounds: { ...background.bounds, width: 151 } }, button] });
  assert.throws(() => guard({ ...view, controls: [...view.controls, { ...button, id: 'new-overlay' }] }), /STALE_OBSERVATION/);
});

test('swipe revalidation rejects a changed target, window, overlay or touch endpoint', () => {
  const validate = guardObservation('android:test', player(), swipe, screenAvailable);
  assert.throws(() => validate({ ...player(), window: 'other' }), /STALE_OBSERVATION/);
  assert.throws(() => validate({ ...player(), rotation: 90 }), /STALE_OBSERVATION/);
  assert.throws(() => validate(player(320)), /STALE_OBSERVATION/);
  const changed = player();
  changed.controls[0].labels = ['其他作品'];
  assert.throws(() => validate(changed), /STALE_OBSERVATION/);
  const overlay = player();
  overlay.controls.push({ ...overlay.controls[0], id: 'overlay', role: 'Button' });
  assert.throws(() => validate(overlay), /STALE_OBSERVATION/);
  overlay.controls[1].role = 'Dialog';
  assert.throws(() => validate(overlay), /SENSITIVE_OR_BLOCKED_SCREEN/);

  const endY = Math.round((2772 - 1) * swipe.to.y);
  const nearEdge = guardObservation('android:test', player(endY), swipe);
  assert.throws(() => nearEdge(player(endY + 1)), /STALE_OBSERVATION/);
});

test('an existing v2 recording replays a swipe across player edge jitter', async () => {
  const script = await compileScript({ schemaVersion: 2, platform: 'android', steps: [{
    inApp: 'example.feed',
    command: { action: 'swipe', fromX: 0.5, fromY: 0.78, toX: 0.5, toY: 0.26 },
    screen: { width: 1272, height: 2772, rotation: 0, anchors: [{ id: 'image' }] },
  }] }, 'android');
  let reads = 0, moves = 0;
  const result = await executeRound({
    snapshot: async () => reads++ % 2 ? player(297, 1690) : player(),
    perform: async (step) => { assert.equal(step.kind, 'swipe'); moves++; },
  }, 'android:test', { script }, new AbortController().signal, () => {});
  assert.equal(result.status, 'succeeded');
  assert.equal(moves, 1);
});

async function previewFixture(t) {
  const button = (id, text, x, y) => ({
    id, role: 'android.widget.Button', labels: [text], bounds: { x, y, width: 24, height: 24 },
    enabled: true, focused: false, editable: false, secret: false,
  });
  const video = { ...player(), screen: { page: 'other' }, width: 100, height: 200,
    controls: [button('comments', '评论', 70, 100)] };
  const panel = { ...video, controls: [...video.controls, button('reply', '回复', 70, 100), button('close', '关闭', 60, 50)] };
  const image = await sharp({ create: { width: 100, height: 200, channels: 3, background: 'black' } }).png().toBuffer();
  const taps = [];
  const phone = {
    view: video,
    snapshot: async () => phone.view,
    screenshot: async () => image,
    perform: async (step, view, node) => { taps.push(node?.id ?? step.point); phone.view = video; },
  };
  const http = await androidWorkbench(t, phone);
  const { frame: preview } = await http.wb.refresh(http.id);
  http.open.mock.resetCalls();
  return { ...http, phone, panel, taps, session: http.open, preview };
}

test('a covered preview tap is cancelled and returns a fresh actionable panel in the same session', async t => {
  for (const location of [{ x: 0.82, y: 0.56 }, { id: 'comments', role: 'android.widget.Button' }]) {
    const { id, wb, phone, panel, taps, session, preview } = await previewFixture(t);
    phone.view = panel;
    const capture = t.mock.method(phone, 'screenshot');
    const recovery = await wb.action(id, { action: 'tap', ...location }, preview.observationId);
    assert.equal(recovery.result.status, 'cancelled');
    assert.equal(recovery.result.reason, 'STALE_OBSERVATION');
    assert.deepEqual(taps, []);
    assert.equal(session.mock.callCount(), 1);
    assert.equal(capture.mock.callCount(), 1);
    assert.notEqual(recovery.frame.observationId, preview.observationId);
    assert.ok(recovery.frame.controls.some(c => c.id === 'close'));
    const next = await wb.action(id, { action: 'tap', id: 'close' }, recovery.frame.observationId);
    assert.equal(next.result.status, 'succeeded');
    assert.deepEqual(taps, ['close']);
  }
});

test('an unavailable replacement frame leaves a stale tap cancelled and invalidates its preview', async t => {
  const { id, wb, phone, panel, taps, preview } = await previewFixture(t);
  phone.view = panel;
  phone.screenshot = async () => { throw Error('SCREENSHOT_UNAVAILABLE'); };
  const recovery = await wb.action(id, { action: 'tap', id: 'comments' }, preview.observationId);
  assert.equal(recovery.result.status, 'cancelled');
  assert.equal(recovery.captureError, 'SCREENSHOT_UNAVAILABLE');
  assert.equal(recovery.frame, undefined);
  phone.view = player();
  const again = await wb.action(id, { action: 'tap', id: 'comments' }, preview.observationId);
  assert.equal(again.result.reason, 'STALE_OBSERVATION');
  assert.deepEqual(taps, []);
});

test('a tap with a missing dispatch receipt is never reported as a cancelled stale tap', async t => {
  const { id, wb, phone, preview } = await previewFixture(t);
  const dispatched = t.mock.method(phone, 'perform', async () => { throw Error('ACTION_OUTCOME_UNKNOWN'); });
  const capture = t.mock.method(phone, 'screenshot');
  await assert.rejects(wb.action(id, { action: 'tap', id: 'comments' }, preview.observationId), /ACTION_OUTCOME_UNKNOWN/);
  assert.equal(dispatched.mock.callCount(), 1);
  assert.equal(capture.mock.callCount(), 0);
});

test('a changing Android frame authorizes a revalidated gesture and rejects input and back', async t => {
  const { id, wb, phone, api, taps } = await previewFixture(t);
  const view = phone.view;
  let tick = 0;
  phone.snapshot = async () => ({ ...view, controls: [...view.controls, {
    ...view.controls[0], id: 'timer', labels: [String(++tick)], bounds: { x: 1, y: 1, width: 15, height: 10 },
  }] });
  const { frame } = await wb.refresh(id);
  assert.equal(frame.observationId, undefined);
  assert.ok(frame.gestureObservationId);
  for (const step of [{ action: 'back' }, { action: 'input', id: 'query', text: 'test' }])
    await assert.rejects(api.submitRun({ kind: 'step', deviceId: id, input: {
      step, observationId: frame.gestureObservationId,
    } }), /STALE_OBSERVATION/);
  const r = await wb.action(id, { action: 'tap', id: 'comments' }, frame.gestureObservationId);
  assert.equal(r.result.status, 'succeeded');
  assert.deepEqual(taps, ['comments']);
});

test('HTTP chat refuses a second up request after only the playback timer changes and records one swipe', async t => {
  const field = (id, label, y, role = 'android.widget.TextView') => ({
    id, role, labels: [label], bounds: { x: 0, y, width: 65, height: 12 }, enabled: true, secret: false,
    editable: false, focused: false,
  });
  let sends = 0, decisions = 0;
  const model = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks));
    const obs = JSON.parse(body.messages.findLast(m => m.role === 'user' && typeof m.content === 'string').content);
    const name = ++decisions <= 2 ? 'swipe' : 'finish';
    const args = name === 'swipe' ? { direction: 'up' } :
      { evidence: obs.controls.find(c => c.id === 'seek').ref, message: obs.singleSwipe.readback + ' 当前进度 00:02。' };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [
      { id: obs.observationId, type: 'function', function: { name, arguments: JSON.stringify({ ...args, observationId: obs.observationId }) } },
    ] } }] }));
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  t.after(() => { model.closeAllConnections(); return new Promise(resolve => model.close(resolve)); });
  const image = await sharp({ create: { width: 100, height: 200, channels: 3, background: 'white' } }).png().toBuffer();
  const phone = {
    snapshot: async () => ({ app: 'example.feed', window: 'main', width: 100, height: 200, rotation: 0,
      controls: [field('caption', '同一作品', 25), field('author', '@作者', 42),
        field('seek', sends ? '00:02' : '00:01', 184, 'android.widget.SeekBar')] }),
    screenshot: async () => image, foregroundApp: async () => 'example.feed', back: async () => {}, launch: async () => {},
    perform: async step => { assert.equal(step.kind, 'swipe'); sends++; },
  };
  const { wb, api, id } = await androidWorkbench(t, phone, fetch,
    [{ id: 'fixture', config: { baseURL: 'http://127.0.0.1:' + model.address().port, model: 'fixture' } }]);
  const runId = await wb.start(id, 'chat', { message: '只上滑一次，核对作品标题，再读出当前播放进度。' });
  await wb.watchers.get(runId)?.done;
  const run = await api.getRun(runId);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.result.modelCalls, 3);
  assert.equal(sends, 1);
  assert.match(run.result.answer, /作品信息相同/);
  assert.ok((await wb.events(api, runId)).some(e => e.data.status === 'SWIPE_LIMIT_REACHED'));
  const tape = await api.json('/api/conversations/' + run.conversationId + '/recording');
  assert.equal(tape.steps.filter(s => s.action === 'swipe').length, 1);
  assert.ok(run.result.frame.observationId);
});

test('a stale screenshot after a confirmed tap preserves the successful action and its receipt', async t => {
  const { id, wb, preview, taps } = await previewFixture(t);
  t.mock.method(wb, 'frame', async () => { throw Error('STALE_OBSERVATION'); });
  const { result, captureError } = await wb.action(id, { action: 'tap', id: 'comments' }, preview.observationId);
  assert.equal(result.status, 'succeeded');
  assert.equal(captureError, 'STALE_OBSERVATION');
  assert.deepEqual(taps, ['comments']);
});


test('an imported V2 recording continues in an independent HTTP conversation and a stale tap appends no step', async t => {
  const { id, wb, api, phone, panel, preview, taps } = await previewFixture(t);
  const original = JSON.stringify({ schemaVersion: 2, platform: 'android', steps: [
    { inApp: 'example.feed', command: { action: 'check', id: 'comments' } },
  ] });
  const script = await wb.importScript('旧录制', original);
  const flat = { platform: 'android', steps: [{ inApp: 'example.feed', action: 'check', id: 'comments' }] };
  assert.deepEqual((await wb.exportScript(script)).script, flat);
  const entry = await wb.scriptInfo(script);
  await assert.rejects(wb.continueRecording(id, script, '"outdated"'), { message: 'PRECONDITION_FAILED' });
  const copy = await wb.continueRecording(id, script, entry.revision);
  assert.notEqual(copy.id, script);
  phone.view = panel;
  const blocked = await wb.action(id, { action: 'tap', id: 'comments' }, preview.observationId, copy.id);
  assert.equal(blocked.result.status, 'cancelled');
  assert.deepEqual(taps, []);
  assert.deepEqual(await api.json('/api/conversations/' + copy.id + '/recording'), flat);
  const ok = await wb.action(id, { action: 'tap', id: 'close' }, blocked.frame.observationId, copy.id);
  assert.equal(ok.result.status, 'succeeded');
  const continued = await api.json('/api/conversations/' + copy.id + '/recording');
  assert.deepEqual(continued.steps.map(({ action, id }) => [action, id]), [['check','comments'], ['tap','close']]);
  assert.equal((await compileScript(continued, 'android')).steps.length, 2);
  assert.deepEqual((await wb.exportScript(script)).script, flat);
  assert.equal((await wb.scriptInfo(script)).revision, entry.revision);
  await assert.rejects(wb.importScript('未知版本', original.replace('"schemaVersion":2', '"schemaVersion":99')), /INVALID_REQUEST|INVALID_SCRIPT/);
});
