import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { compileScript, executeRound } from '../dist/run.js';
import { executeTextTarget, recognizePortableText } from '../dist/screen-text.js';

const width = 600;
const height = 300;
const app = 'example.settings';
const identity = 'android:screen-text';
const view = { app, window: 'main', width, height, rotation: 0, controls: [] };
const image = () => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="white"/>
  <text x="80" y="155" font-family="Arial, sans-serif" font-size="60">OPEN SETTINGS</text>
</svg>`)).png().toBuffer();

test('portable local OCR replays screen-text steps without a model', async () => {
  const png = await image();
  const taps = [];
  const device = {
    snapshot: async () => view,
    screenshot: async () => png,
    perform: async (step) => taps.push(step),
  };
  const recording = {
    platform: 'android',
    steps: ['checkScreenText', 'tapScreenText'].map((action) => ({
      action,
      text: 'OPEN SETTINGS',
      inApp: app,
    })),
  };
  const script = await compileScript(recording, 'android');
  const result = await executeRound(
    device, identity, { script, recognizeText: recognizePortableText }, AbortSignal.timeout(25_000),
  );
  assert.equal(result.status, 'succeeded', result.reason);
  assert.equal(taps.length, 1);
  assert.equal(taps[0].kind, 'tap');
  assert.ok(taps[0].point.x > 0.4 && taps[0].point.x < 0.7);
  assert.ok(taps[0].point.y > 0.35 && taps[0].point.y < 0.55);
});

test('screen text must still be unique across all OCR lines before dispatching', async () => {
  const png = await image();
  const device = {
    snapshot: async () => view,
    screenshot: async () => png,
    perform: async () => assert.fail('ambiguous text must never dispatch a tap'),
  };
  const recognize = async () => [
    { text: '开 启', confidence: 0.95, x: 0.2, y: 0.3 },
    { text: '开启', confidence: 0.4, x: 0.5, y: 0.6 },
  ];
  await assert.rejects(
    executeTextTarget(device, identity, view, '开启', 'tap', AbortSignal.timeout(5000), recognize),
    { message: 'SCREEN_TEXT_NOT_UNIQUE_OR_MISSING' },
  );
});
