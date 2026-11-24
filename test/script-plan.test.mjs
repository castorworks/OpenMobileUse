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

test('both built-in scripts compile for every supported mobile platform', async () => {
  async function load(name) {
    return JSON.parse(await readFile(new URL('../examples/' + name + '.json', import.meta.url), 'utf8'));
  }
  const [bluetooth, search] = await Promise.all([load('settings-bluetooth'), load('settings-search')]);
  for (const platform of ['android', 'harmony', 'ios']) {
    const bluetoothPlan = await compileScript(bluetooth, platform);
    const searchPlan = await compileScript(search, platform);
    assert.equal(bluetoothPlan.mode, 'settings');
    assert.equal(bluetoothPlan.steps.length, 6);
    assert.equal(searchPlan.mode, 'foreground');
    assert.equal(searchPlan.steps.length, platform === 'ios' ? 8 : 9);
  }
});

test('the shared compiler rejects invalid envelopes and nested commands outside a V2 recording', async () => {
  const action = { action: 'tap', x: 0.25, y: 0.5 };
  const nested = { inApp: 'com.example', command: action };
  for (const raw of [
    { schemaVersion: 1, steps: [action] },
    { schemaVersion: 2, steps: [nested] },
    { schemaVersion: 2, platform: 'android', steps: [{ inApp: 'example.app', command: { ...action, inApp: 'other.app' } }] },
    { schemaVersion: 2, platform: 'android', steps: [{ inApp: 'example.app', command: { ...action, platforms: ['ios'] } }] },
    { platform: 'android', steps: [nested] },
    { steps: [{ ...action, command: action }] },
  ]) {
    await assert.rejects(compileScript(raw, 'android'), /INVALID_SCRIPT/);
  }
});

test('one script mixes hand-written actions with recorded foreground, state and screen guards', async () => {
  const app = 'com.example';
  const raw = {
    platform: 'android',
    targets: { toggle: { android: { id: 'toggle' } } },
    steps: [
      { action: 'tap', x: 0.25, y: 0.5 },
      {
        action: 'tap',
        target: 'toggle',
        inApp: app,
        reading: { checked: false },
        screen: { width: 100, height: 100, rotation: 0, anchors: [{ id: 'heading' }] },
      },
    ],
  };
  const script = await compileScript(raw, 'android');
  assert.equal(script.mode, 'foreground');
  await assert.rejects(compileScript(raw, 'harmony'), /PLATFORM_MISMATCH/);
  const control = {
    labels: [],
    role: 'Switch',
    enabled: true,
    focused: false,
    editable: false,
    secret: false,
    bounds: { x: 20, y: 20, width: 40, height: 15 },
  };
  const toggle = { ...control, id: 'toggle', checked: false };
  const heading = { ...control, id: 'heading', role: 'Text' };
  const ready = {
    app,
    window: 'main',
    width: 100,
    height: 100,
    rotation: 0,
    controls: [heading, toggle],
  };
  const mismatches = [
    { ...ready, app: 'com.other' },
    { ...ready, controls: [heading, { ...toggle, checked: true }] },
    { ...ready, controls: [toggle] },
  ];
  const performed = [];
  const device = {
    snapshot: async () => (performed.length ? mismatches.shift() ?? ready : ready),
    async perform(step, view, node) {
      if (performed.length) {
        assert.equal(view, ready);
        assert.equal(node, toggle);
      }
      performed.push(step);
    },
  };
  const progress = [];
  const result = await executeRound(
    device,
    'android:phone',
    { script },
    new AbortController().signal,
    (event) => progress.push(event),
  );
  assert.equal(result.status, 'succeeded', result.reason);
  assert.equal(mismatches.length, 0);
  assert.equal(performed.length, 2);
  assert.deepEqual(performed[0], { kind: 'tap', point: { x: 0.25, y: 0.5 } });
  assert.equal(performed[1].selector.id, 'toggle');
  assert.deepEqual(progress, [
    { kind: 'step', name: 'tap', status: 'succeeded' },
    { kind: 'step', name: 'tap', status: 'succeeded' },
  ]);
});

test('a failed step keeps its original file index after platform filtering', async () => {
  const script = await compileScript({
    steps: [
      { action: 'back', platforms: ['ios'], id: 'back' },
      { action: 'tap', x: 0.25, y: 0.5 },
    ],
  }, 'android');
  const device = {
    snapshot: async () => ({
      app: 'com.example', window: 'main', width: 100, height: 100, rotation: 0, controls: [],
    }),
    async perform() {
      throw Error('ACTION_OUTCOME_UNKNOWN');
    },
  };
  const result = await executeRound(device, 'android:phone', { script }, new AbortController().signal);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'ACTION_OUTCOME_UNKNOWN');
  assert.equal(result.failedStep, 2);
  assert.equal(result.steps[0].index, 2);
});


test('V2 guards and card selectors produce the same plan as shared steps and platform targets', async () => {
  const inApp = 'example.feed';
  const selector = { id: 'example.feed:id/comments', role: 'android.widget.Button', within: '作品乙', cardX: 0.5, cardY: 0.6 };
  const reading = { label: '评论' };
  const legacy = { schemaVersion: 2, platform: 'android', steps: [
    { inApp, command: { action: 'check', ...selector }, reading },
    { inApp, command: { action: 'tap', ...selector } },
  ] };
  const bytes = JSON.stringify(legacy);
  const authored = { platform: 'android', targets: { comment: { android: selector } }, steps: [
    { action: 'check', target: 'comment', inApp, reading }, { action: 'tap', target: 'comment', inApp },
  ] };
  const flat = { platform: 'android', steps: legacy.steps.map(({ command, ...guards }) => ({ ...command, ...guards })) };
  const expected = await compileScript(flat, 'android');
  assert.deepEqual(await compileScript(legacy, 'android'), expected);
  assert.deepEqual(await compileScript(authored, 'android'), expected);
  assert.equal(JSON.stringify(legacy), bytes);
  await assert.rejects(compileScript(legacy, 'ios'), /PLATFORM_MISMATCH/);
});

test('all three mobile recording actions share the same compiled guards in V2 and in flat scripts', async () => {
  const commands = [
    { action: 'verifiedSearch', query: '橘猫', firstResult: true },
    { action: 'pauseVideoCenter', item: 'a'.repeat(64) },
    { action: 'goHome' },
  ];
  const inApp = 'example.media';
  const legacy = { schemaVersion: 2, platform: 'android', steps: commands.map(command => ({ inApp, command })) };
  const flat = { platform: 'android', steps: commands.map(command => ({ inApp, ...command })) };
  const plan = await compileScript(flat, 'android');
  assert.deepEqual(await compileScript(legacy, 'android'), plan);
  assert.deepEqual(plan.steps.map(s => s.action), ['verifiedSearch', 'pauseVideoCenter', 'goHome']);
  assert.ok(plan.steps.every(s => s.kind === 'guarded' && s.command.inApp === inApp));
  assert.deepEqual(plan.steps[0].command.search, { query: '橘猫', firstResult: true });
  assert.equal(plan.steps[1].command.videoItem, commands[1].item);
});
