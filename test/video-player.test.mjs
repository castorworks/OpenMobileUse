import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { xmlControls } from '../dist/native-layout.js';
import { readVideoPlayer, pauseVideoCenter } from '../dist/video-player.js';
import { compileScript, executeRound } from '../dist/run.js';
import { runConversation } from '../dist/conversation.js';

const app = 'example.video', identity = 'android:test', signal = new AbortController().signal;
const screenshot = await sharp({ create: { width: 200, height: 400, channels: 3, background: 'orange' } }).png().toBuffer();

function frame({ label = '暂停视频，按钮', caption = '猫咪的一天', overlay = '', area = '[20,40][180,280]' } = {}) {
  const node = (role, bounds, fields = '', children = '') =>
    `<node class="android.${role}" package="${app}" bounds="${bounds}" displayed="true" ${fields}>${children}</node>`;
  const video = node('view.SurfaceView', area);
  const action = node('view.View', area, `content-desc="${label}" clickable="true"`);
  const title = node('widget.TextView', '[20,245][150,279]', `resource-id="example.video:id/desc" text="${caption}"`);
  const surface = node('widget.FrameLayout', area, '', video + title + action);
  const layout = '<hierarchy>' + node('widget.FrameLayout', '[0,0][200,400]', '', surface + overlay) + '</hierarchy>';
  return { app, window: 'detail', width: 200, height: 400, rotation: 0, layout,
    controls: xmlControls('android', layout, app, 200, 400), screen: { page: 'other' } };
}

const playing = frame(), paused = frame({ label: '播放视频，按钮' });
const sheet = frame({ overlay: '<node class="android.view.View" package="example.video" bounds="[0,140][200,400]" clickable="true"/>' });
const item = () => readVideoPlayer(playing).key;
function phone(views) {
  let i = 0;
  const clicks = [];
  return { clicks, screenshot: async () => screenshot,
    snapshot: async () => views[Math.min(i++, views.length - 1)],
    perform: async step => { assert.equal(step.kind, 'tap'); assert.ok(step.point); clicks.push(step.point); } };
}

test('pause uses the visible video centre once and verifies the play action on the same work', async () => {
  const phoneDevice = phone([playing, playing, paused]);
  const result = await pauseVideoCenter(phoneDevice, identity, playing, item(), signal);
  assert.deepEqual(phoneDevice.clicks, [{ x: 100 / 199, y: 160 / 399 }]);
  assert.deepEqual(result, { tapped: true, evidence: '播放视频，按钮' });
});

test('an already paused player is verified without a toggle', async () => {
  const phoneDevice = phone([paused]);
  assert.deepEqual(await pauseVideoCenter(phoneDevice, identity, playing, item(), signal),
    { tapped: false, evidence: '播放视频，按钮' });
  assert.equal(phoneDevice.clicks.length, 0);
});

test('a sheet covering a still-visible player or a switch of work blocks dispatch', async () => {
  assert.equal(readVideoPlayer(sheet), undefined);
  const systemOverlay = frame({ overlay: '<node class="android.view.View" package="android" bounds="[0,140][200,400]"/>' });
  for (const other of [sheet, systemOverlay, frame({ caption: '同一作者的另一条视频' }), { ...playing, window: 'comment' }]) {
    const phoneDevice = phone([other]);
    await assert.rejects(pauseVideoCenter(phoneDevice, identity, playing, item(), signal), /STALE_OBSERVATION/);
    assert.equal(phoneDevice.clicks.length, 0);
  }
});

test('recorded pauses recompute the player centre on replay and skip a paused work', async () => {
  const command = { action: 'pauseVideoCenter', item: item() };
  const data = { schemaVersion: 2, platform: 'android', steps: [{ inApp: app, command }] };
  const script = await compileScript(JSON.parse(JSON.stringify(data)), 'android');
  const area = '[32,8][180,168]';
  const resized = frame({ area }), stopped = frame({ area, label: '播放视频，按钮' });
  const phoneDevice = phone([resized, resized, stopped, stopped, stopped]);
  for (let i = 0; i < 2; i++)
    assert.equal((await executeRound(phoneDevice, identity, { script }, signal, () => {})).status, 'succeeded');
  assert.deepEqual(phoneDevice.clicks, [{ x: 106 / 199, y: 88 / 399 }]);
  await assert.rejects(compileScript({ ...data, platform: 'ios' }, 'ios'), /INVALID_SCRIPT_STEP/);
  await assert.rejects(compileScript({ ...data, steps: [{ inApp: app, command: { ...command, x: 0.5 } }] }, 'android'), /INVALID_SCRIPT_STEP/);
});

async function requestCenterPause(phoneDevice) {
  let decisions = 0;
  const events = [];
  const result = await runConversation(phoneDevice, identity, 'android', [{ user: '点视频中央一次并确认暂停' }],
    async (messages, tools, deadline, count) => {
      count();
      assert.equal(++decisions, 1);
      assert.ok(tools.some(t => t.function.name === 'pause_video_center'));
      const observation = JSON.parse(messages.findLast(m => m.role === 'user' && typeof m.content === 'string').content);
      return { role: 'assistant', content: null, tool_calls: [{ type: 'function', id: 'pause',
        function: { name: 'pause_video_center', arguments: JSON.stringify({ observationId: observation.observationId }) } }] };
    }, signal, async () => assert.fail('An unverified pause cannot be recorded as successful'),
    (name, status) => events.push(status), () => true);
  return { result, events };
}

test('a conversation reports an unconfirmed pause and stops after the single on-screen tap', async () => {
  const phoneDevice = phone([playing]);
  const { result, events } = await requestCenterPause(phoneDevice);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.reason, 'VIDEO_PAUSE_UNCONFIRMED');
  assert.match(result.answer, /已点击视频中央一次/);
  assert.deepEqual(events, ['VIDEO_PAUSE_UNCONFIRMED']);
  assert.equal(phoneDevice.clicks.length, 1);
});

test('a screenshot with the wrong orientation stops the centre-pause request before any tap', async () => {
  const phoneDevice = phone([playing]);
  phoneDevice.screenshot = () => sharp(screenshot).rotate(90).png().toBuffer();
  const { result } = await requestCenterPause(phoneDevice);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.reason, 'SCREENSHOT_GEOMETRY_MISMATCH');
  assert.match(result.answer, /未点击视频中央/);
  assert.equal(phoneDevice.clicks.length, 0);
});

test('missing pause evidence never retries the toggle, including on recording replay', async () => {
  const script = await compileScript({ schemaVersion: 2, platform: 'android', steps: [
    { inApp: app, command: { action: 'pauseVideoCenter', item: item() } },
  ] }, 'android');
  const phoneDevice = phone([playing, playing, frame({ label: '播放视频，按钮', caption: '下一条' })]);
  const result = await executeRound(phoneDevice, identity, { script }, signal, () => {});
  assert.equal(result.reason, 'VIDEO_PAUSE_UNCONFIRMED');
  assert.equal(phoneDevice.clicks.length, 1);
});
