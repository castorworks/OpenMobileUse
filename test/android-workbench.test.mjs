import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Workbench } from '../desktop/workbench.mjs';
import { deviceDir, loadConversation, saveConversation } from '../desktop/library.mjs';
import { scriptEntry } from '../desktop/script-library.mjs';
import { openDevice } from '../dist/doctor.js';
import { guardObservation, screenAvailable } from '../dist/steps.js';
import { compileScript, executeRound } from '../dist/run.js';

test('only Android workbench sessions request a one-second UI idle wait', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'omu-session-settings-'));
  const previous = process.env.OMU_STATE_DIR;
  process.env.OMU_STATE_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.OMU_STATE_DIR;
    else process.env.OMU_STATE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const capabilities = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options.method === 'DELETE') return Response.json({ value: null });
    capabilities.push(JSON.parse(options.body).capabilities.alwaysMatch);
    return Response.json({ value: { sessionId: 'fixture' } });
  });
  const workbench = new Workbench(() => {}, { appium: { ensureReady: async () => {} } });
  const android = { id: 'fixture', platform: 'android', available: true };
  const ios = { ...android, platform: 'ios' };
  for (const target of [android, ios])
    await workbench.session(target, 'test', null, 'foreground', async () => {}, undefined, 630);
  const cli = await openDevice(android, async () => {});
  await cli.close();
  assert.deepEqual(capabilities.map(c => c['appium:settings[waitForIdleTimeout]']), [1000, undefined, undefined]);
  assert.deepEqual(capabilities.map(c => c['appium:newCommandTimeout']), [630, 630, 90]);
});

const swipe = { kind: 'swipe', from: { x: 0.5, y: 0.78 }, to: { x: 0.5, y: 0.26 }, duration: 400 };
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
  const id = 'android:preview';
  const wb = new Workbench(() => {});
  wb.targets.set(id, { id: 'preview', platform: 'android', available: true });
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
  const session = t.mock.method(wb, 'session', async (_target, _run, _signal, _mode, work) => work(phone));
  const preview = await wb.frame(phone, id);
  return { id, wb, phone, panel, taps, session, preview };
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
  assert.equal(wb.frames.has(id), false);
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

test('a stale screenshot after a confirmed tap preserves the successful action and its receipt', async t => {
  const { id, wb, preview, taps } = await previewFixture(t);
  t.mock.method(wb, 'frame', async () => { throw Error('STALE_OBSERVATION'); });
  const { result, captureError } = await wb.action(id, { action: 'tap', id: 'comments' }, preview.observationId);
  assert.equal(result.status, 'succeeded');
  assert.equal(captureError, 'STALE_OBSERVATION');
  assert.deepEqual(taps, ['comments']);
});


test('a stale manual tap never forks a V2 recording; a successful continuation writes a separate flat copy', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omu-v2-continuation-'));
  const previous = process.env.OMU_STATE_DIR;
  process.env.OMU_STATE_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.OMU_STATE_DIR;
    else process.env.OMU_STATE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const { id, wb, phone, panel, preview, taps } = await previewFixture(t);
  const oldId = '01234567-89ab-4cde-8123-0123456789ab';
  const originalStep = { inApp: 'example.feed', command: { action: 'check', id: 'comments' } };
  await saveConversation(id, {
    id: oldId, updated: new Date().toISOString(), turns: [{ user: '已录制', status: 'succeeded' }],
    script: { schemaVersion: 2, platform: 'android', steps: [originalStep] },
  });
  const folder = deviceDir(id, 'conversations'), file = join(folder, oldId + '.json');
  const originalBytes = await readFile(file);
  phone.view = panel;
  const blocked = await wb.action(id, { action: 'tap', id: 'comments' }, preview.observationId, oldId);
  assert.equal(blocked.result.status, 'cancelled');
  assert.equal(blocked.chatId, undefined);
  assert.deepEqual(await readdir(folder), [oldId + '.json']);
  const ok = await wb.action(id, { action: 'tap', id: 'close' }, blocked.frame.observationId, oldId);
  assert.deepEqual(taps, ['close']);
  assert.ok(ok.chatId && ok.chatId !== oldId);
  assert.deepEqual(await readFile(file), originalBytes);
  const copy = await loadConversation(id, ok.chatId);
  assert.equal(copy.sourceChatId, oldId);
  assert.equal(copy.script.schemaVersion, undefined);
  assert.deepEqual(copy.script.steps.map(({ action, id }) => [action, id]), [['check', 'comments'], ['tap', 'close']]);
  const old = await wb.conversation(id, oldId);
  const exported = (await scriptEntry(old.recordingId)).script;
  assert.deepEqual(exported.steps, [{ inApp: 'example.feed', action: 'check', id: 'comments' }]);
  assert.equal((await compileScript(copy.script, 'android')).steps.length, 2);
  assert.deepEqual(await readFile(file), originalBytes);
});
