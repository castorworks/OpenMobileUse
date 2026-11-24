import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { harmonyView } from '../dist/native-layout.js';
import { executeImageTarget, imageTarget, isImageTarget } from '../dist/screen-image.js';
import { guardObservation } from '../dist/steps.js';

const width = 240;
const height = 480;
const icon = { x: 174, y: 42 };
const point = { x: icon.x / (width - 1), y: icon.y / (height - 1) };

function screenshot(icons, background = '#cedbee', video = '') {
  const shapes = icons.map(({ x, y, handle = true }) => `
    <g transform="translate(${x} ${y})" fill="none" stroke="#f9fafb" stroke-width="1.2">
      <circle cx="-1" cy="-1" r="4"/>
      ${handle ? '<path d="M2 2 l4 4"/>' : ''}
    </g>`);
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="${background}"/>
    ${video}
    ${shapes.join('')}
  </svg>`)).png().toBuffer();
}

async function dispatch(anchor, frame, taps) {
  const view = { app: 'example.feed', window: 'main', width, height, rotation: 0, controls: [] };
  const device = {
    screenshot: async () => frame,
    snapshot: async () => view,
    perform: async (step) => taps.push(step.point),
  };
  await executeImageTarget(device, 'harmony:test', view, anchor, true, new AbortController().signal);
}

test('a visual tap tolerates a video clock change behind the icon and rejects changes to its hit stack', async () => {
  const bounds = `[0,0][${width},${height}]`;
  function view(time, change = '') {
    const video = { attributes: { type: 'Text', bounds, text: time, clickable: 'false' } };
    const button = { attributes: { type: 'Image', bounds: '[163,31][185,53]', clickable: 'true' } };
    if (change === 'moved') button.attributes.bounds = '[169,30][191,52]';
    if (change === 'renamed') button.attributes.description = 'Other action';
    if (change === 'interactive background') video.attributes.clickable = 'true';
    const children = change === 'removed' ? [video] : [video, button];
    if (change === 'covered') children.push({ attributes: { type: 'Text', bounds, text: 'Overlay' } });
    return harmonyView({
      attributes: { bounds, bundleName: 'example.feed', focused: 'true', hostWindowId: change === 'window' ? '2' : '1' },
      children,
    }, 0);
  }
  const image = await screenshot([icon]);
  const anchor = await imageTarget(image, point);
  const initial = view('0:01');
  const next = view('0:02');
  const identity = 'harmony:test';
  const taps = [];
  const device = {
    screenshot: async () => image,
    snapshot: async () => next,
    perform: async (step) => taps.push(step.point),
  };
  const run = () => executeImageTarget(device, identity, initial, anchor, true, new AbortController().signal);
  await run();
  assert.throws(() => guardObservation(identity, initial, { kind: 'tap', point })(next), /STALE_OBSERVATION/);
  for (const change of ['moved', 'renamed', 'removed', 'covered', 'interactive background', 'window']) {
    device.snapshot = async () => view('0:02', change);
    await assert.rejects(run(), /STALE_OBSERVATION/, change);
  }
  assert.deepEqual(taps, [point]);
});

test('a faint search icon is found again after the background and its position change', async () => {
  const anchor = await imageTarget(await screenshot([icon]), point);
  assert.equal(anchor.match, 'contour');
  assert.ok(isImageTarget(anchor));
  const moved = { x: 155, y: 44 };
  const taps = [];
  const video = '<path d="M0 48 L146 49 L160 53 L240 90" fill="none" stroke="#a58d71" stroke-width="3"/>';
  await dispatch(anchor, await screenshot([moved], '#352b27', video), taps);
  assert.deepEqual(taps, [{ x: moved.x / (width - 1), y: moved.y / (height - 1) }]);
});

test('uniform frames, missing icons and multiple candidate icons do not dispatch a tap', async () => {
  const anchor = await imageTarget(await screenshot([icon]), point);
  const duplicate = await screenshot([icon, { x: 63, y: 44 }]);
  await assert.rejects(imageTarget(await screenshot([]), point), /VISUAL_TARGET_UNCLEAR/);
  await assert.rejects(imageTarget(duplicate, point), /VISUAL_TARGET_UNCLEAR/);
  const taps = [];
  await assert.rejects(dispatch(anchor, await screenshot([]), taps), /VISUAL_TARGET_UNCLEAR/);
  const ring = await screenshot([{ ...icon, handle: false }]);
  await assert.rejects(dispatch(anchor, ring, taps), /VISUAL_TARGET_UNCLEAR/);
  await assert.rejects(dispatch(anchor, duplicate, taps), /VISUAL_TARGET_UNCLEAR/);
  assert.deepEqual(taps, []);
});

test('previously recorded RGB patches still use their original colour and uniqueness checks', async () => {
  const original = await screenshot([icon], '#0a1720');
  const { rgb, dx, dy } = await imageTarget(original, point);
  const legacy = { rgb, dx, dy };
  assert.ok(isImageTarget(legacy));
  assert.equal(isImageTarget({ ...legacy, match: 'other' }), false);
  assert.equal(isImageTarget({ ...legacy, unknown: true }), false);
  const taps = [];
  await dispatch(legacy, original, taps);
  assert.deepEqual(taps, [point]);
  const changed = await screenshot([icon], '#925823');
  await assert.rejects(dispatch(legacy, changed, taps), /VISUAL_TARGET_UNCLEAR/);
  assert.equal(taps.length, 1);
});
