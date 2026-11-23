import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workbench } from '../desktop/workbench.mjs';
import { openDevice } from '../dist/doctor.js';
import { guardObservation, screenAvailable } from '../dist/steps.js';
import { compileRecording, replayRecording } from '../dist/recording.js';

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
  const steps = await compileRecording({ schemaVersion: 2, platform: 'android', steps: [{
    inApp: 'example.feed',
    command: { action: 'swipe', fromX: 0.5, fromY: 0.78, toX: 0.5, toY: 0.26 },
    screen: { width: 1272, height: 2772, rotation: 0, anchors: [{ id: 'image' }] },
  }] }, 'android');
  let reads = 0, moves = 0;
  const result = await replayRecording({
    snapshot: async () => reads++ % 2 ? player(297, 1690) : player(),
    perform: async (step) => { assert.equal(step.kind, 'swipe'); moves++; },
  }, 'android:test', steps, new AbortController().signal, () => {});
  assert.equal(result.status, 'succeeded');
  assert.equal(moves, 1);
});
