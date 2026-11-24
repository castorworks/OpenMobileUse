import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compileScript, executeRound } from '../dist/run.js';
import { compileStep } from '../dist/script.js';
import { parseStep } from '../dist/steps.js';

test('CLI flags and JSON compile to the same structured operation', async () => {
  const text = '--help=你好\nnext';
  const raw = { action: 'input', label: 'Search', text, replace: true };
  const cli = await parseStep(
    'input',
    ['--device', 'android:phone', '--label', 'Search', '--stdin', '--replace'],
    async () => text,
  );
  assert.deepEqual(await compileStep(raw, 'android'), {
    step: cli.step,
    observation: cli.observation,
  });
  await assert.rejects(compileStep({ action: 'tap', x: '0.5', y: 0.5 }, 'android'), {
    message: 'INVALID_STEP_ARGUMENT',
  });
  await assert.rejects(compileStep({ action: 'back' }, 'ios'), {
    message: 'BACK_REQUIRES_IOS_NAVIGATION_SELECTOR_ONLY',
  });
});

test('the shared script entry preserves session modes and replays exported recordings', async () => {
  const bluetooth = JSON.parse(
    await readFile(new URL('../examples/settings-bluetooth.json', import.meta.url), 'utf8'),
  );
  assert.equal((await compileScript(bluetooth, 'android')).mode, 'settings');
  const general = { schemaVersion: 1, steps: [{ action: 'tap', x: 0.25, y: 0.5 }] };
  assert.equal((await compileScript(general, 'android')).mode, 'foreground');
  const raw = {
    schemaVersion: 2,
    platform: 'android',
    steps: [{ inApp: 'com.example', command: general.steps[0] }],
  };
  const script = await compileScript(raw, 'android');
  assert.equal(script.mode, 'foreground');
  await assert.rejects(compileScript(raw, 'harmony'), { message: 'RECORDING_PLATFORM_MISMATCH' });

  const performed = [];
  const device = {
    snapshot: async () => ({
      app: 'com.example',
      window: 'main',
      width: 100,
      height: 100,
      rotation: 0,
      controls: [],
    }),
    perform: async (step) => performed.push(step),
  };
  const progress = [];
  const result = await executeRound(
    device,
    'android:phone',
    { script },
    new AbortController().signal,
    (event) => progress.push(event),
  );
  assert.deepEqual(result, { status: 'succeeded' });
  assert.deepEqual(performed, [{ kind: 'tap', point: { x: 0.25, y: 0.5 } }]);
  assert.deepEqual(progress, [{ kind: 'step', name: 'tap', status: 'succeeded' }]);
});
