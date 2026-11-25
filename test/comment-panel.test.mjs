import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { androidWorkbench } from '../test-support/http-workbench.mjs';
import { WebDriver } from '../dist/webdriver.js';
import { executeStep } from '../dist/steps.js';
import { commentTapPoint } from '../dist/comment-panel.js';

const app = 'com.ss.android.ugc.aweme', phoneId = 'android:fixture';
const closeId = app + ':id/back_btn';
const panel = '<n class="android.widget.TextView" text="673条评论" bounds="[536,965][736,1105]"/>' +
  '<n class="android.widget.ImageView" resource-id="' + closeId + '" content-desc="关闭" clickable="true" bounds="[1118,972][1258,1112]"/>';
function video(title) {
  return '<n class="android.view.SurfaceView" bounds="[0,200][1272,1800]"/>' +
    '<n class="android.view.View" content-desc="暂停视频，按钮" clickable="true" bounds="[0,200][1272,1800]"/>' +
    '<n class="android.widget.TextView" resource-id="' + app + ':id/desc" text="' + title + '" bounds="[0,1900][600,1980]"/>' +
    '<n class="android.view.View" content-desc="评论673，按钮" clickable="true" bounds="[1100,1800][1250,1950]"/>';
}
const display = '  Display: mDisplayId=0\n  DisplayFrames w=1272 h=2772 r=0\n    InsetsState:\n' +
  '      InsetsSource id=1 type=systemGestures frame=[1167,0][1272,2772] visible=true flags= sideHint=RIGHT\n';
const selector = { kind: 'tap', selector: { id: closeId, role: 'android.widget.ImageView' } };
const atCenter = { kind: 'tap', point: { x: 1188/1271, y: 1042/2771 } };

async function setup(t, after, dump = display) {
  const taps = [];
  let content = video('原作品'), sent = false;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const path = new URL(url).pathname;
    let value;
    if (path === '/session') value = { sessionId: 'test' };
    else if (path.endsWith('/execute/sync')) value = JSON.parse(opts.body).script.includes('Package') ? app : 'detail';
    else if (path.endsWith('/rotation')) value = { z: 0 };
    else if (path.endsWith('/window/rect')) value = { width: 1272, height: 2772 };
    else if (path.endsWith('/source')) {
      if (sent && Array.isArray(after)) content = after.shift() ?? content;
      value = '<hierarchy><root package="' + app + '" class="android.widget.FrameLayout" bounds="[0,0][1272,2772]">' +
        content.replaceAll('<n ', '<n package="' + app + '" ') + '</root></hierarchy>';
    }
    else if (path.endsWith('/elements')) value = [{ 'element-6066-11e4-a52e-4f735466cecf': 'close' }];
    else if (path.endsWith('/actions') || path.endsWith('/click')) {
      taps.push(path.endsWith('/actions') ? JSON.parse(opts.body).actions[0].actions : 'native');
      sent = true;
      if (typeof after === 'string') content = after;
      value = null;
    } else assert.fail('Unexpected WebDriver call ' + path);
    return Response.json({ value });
  });
  const d = await WebDriver.open('android', 'fixture', async (_kind, send) => send(), 'foreground');
  d.gestureDisplay = async () => dump;
  await d.snapshot();
  content = panel;
  return { d, taps, displayContent(value) { content = value; } };
}

for (const [name, step] of [['selector', selector], ['preview point', atCenter]]) {
  test(name + ' closes the original video comments with one tap outside the system gesture region', async t => {
    const { d, taps } = await setup(t, video('原作品'));
    const result = await executeStep(d, phoneId, step);
    assert.equal(result.commentPanelClosed, true);
    assert.equal(taps.length, 1);
    assert.deepEqual(taps[0].map(a => a.type), ['pointerMove','pointerDown','pause','pointerUp']);
    assert.equal(taps[0][0].x, 1142);
    assert.equal(taps[0][0].y, 1042);
  });
}
for (const [name, after, error] of [
  ['HTTP success with comments still visible', panel, 'COMMENT_PANEL_STILL_OPEN'],
  ['missing panel markers but no player', '', 'COMMENT_CLOSE_UNCONFIRMED'],
  ['another video underneath', video('不同作品'), 'COMMENT_CLOSE_UNCONFIRMED'],
]) {
  test(name + ' cannot succeed or issue a second tap', async t => {
    const { d, taps } = await setup(t, after);
    await assert.rejects(executeStep(d, phoneId, atCenter), { message: error });
    assert.equal(taps.length, 1);
  });
}
test('a fully reserved button cannot be tapped', async t => {
  const { d, taps } = await setup(t, panel, display.replace('1167,0', '1100,0'));
  await assert.rejects(executeStep(d, phoneId, selector), { message: 'COMMENT_CLOSE_POINT_UNAVAILABLE' });
  assert.equal(taps.length, 0);
});

test('the two-row Douyin header also uses the guarded safe point; an unrelated distant title cannot trigger a native click', async t => {
  const { d, taps, displayContent } = await setup(t, video('原作品'));
  const twoRows = panel.replace('text="673条评论"', 'resource-id="' + app + ':id/title" text="1207条评论"')
    .replace('[536,965][736,1105]', '[527,1112][745,1218]').replace('[1118,972][1258,1112]', '[1118,968][1258,1108]');
  displayContent(twoRows.replace('[527,1112][745,1218]', '[527,1500][745,1606]'));
  await assert.rejects(executeStep(d, phoneId, selector), /COMMENT_CLOSE_POINT_UNAVAILABLE/);
  assert.deepEqual(taps, []);
  displayContent(twoRows);
  const result = await executeStep(d, phoneId, selector);
  assert.equal(result.commentPanelClosed, true);
  assert.deepEqual(result.tapPoint, { x: 1142, y: 1038 });
  assert.equal(taps.length, 1);
});

test('a dismiss animation is observed to completion without repeating the tap', async t => {
  const { d, taps } = await setup(t, [panel, video('原作品')]);
  const result = await executeStep(d, phoneId, selector);
  assert.equal(result.commentPanelClosed, true);
  assert.equal(taps.length, 1);
});

test('a partially rendered panel header or its surviving close button each blocks success', async t => {
  const { d, taps } = await setup(t, [
    video('原作品') + panel.split('/>')[0] + '/>', video('原作品') + panel.split('/>')[1] + '/>',
  ]);
  await assert.rejects(executeStep(d, phoneId, selector), { message: 'COMMENT_PANEL_STILL_OPEN' });
  assert.equal(taps.length, 1);
});

test('use the current display, preserve a safe centre and reject unconfirmed geometry', () => {
  const frame = { width: 1272, height: 2772, rotation: 0 };
  const button = { x: 1000, y: 972, width: 140, height: 140 };
  assert.deepEqual(commentTapPoint(frame, button, display.replace('mDisplayId=0', 'mDisplayId=1') + display),
    { x: 1070, y: 1042 });
  assert.throws(() => commentTapPoint({ ...frame, rotation: 90 }, button, display), /COMMENT_CLOSE_POINT_UNAVAILABLE/);
  assert.throws(() => commentTapPoint(frame, button, ''), /COMMENT_CLOSE_POINT_UNAVAILABLE/);
});

test('a panel visible again in the returned workbench preview cannot be reported closed', async t => {
  const transport = fetch;
  const { d, taps, displayContent } = await setup(t, [video('原作品'), panel]);
  const png = await sharp({ create: { width: 1272, height: 2772, channels: 3, background: 'white' } }).png().toBuffer();
  d.screenshot = async () => png;
  const { wb, id } = await androidWorkbench(t, d, transport);
  displayContent(video('原作品'));
  await wb.refresh(id);
  displayContent(panel);
  const { frame: before } = await wb.refresh(id);
  const { result, frame } = await wb.action(id, { action: 'tap', ...selector.selector }, before.observationId);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.reason, 'COMMENT_PANEL_STILL_OPEN');
  assert.ok(frame.controls.some(c => c.labels.includes('673条评论')));
  assert.equal(taps.length, 1);
});

test('an observed close button cannot fall through to a generic click if its comment heading disappears', async t => {
  const transport = fetch;
  const { d, taps, displayContent } = await setup(t, video('原作品'));
  const png = await sharp({ create: { width: 1272, height: 2772, channels: 3, background: 'white' } }).png().toBuffer();
  d.screenshot = async () => png;
  const { wb, id } = await androidWorkbench(t, d, transport);
  const { frame } = await wb.refresh(id);
  displayContent(panel.replace('673条评论', '正在加载'));
  const { result } = await wb.action(id, { action: 'tap', ...selector.selector }, frame.observationId);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'STALE_OBSERVATION');
  assert.deepEqual(taps, []);
});
