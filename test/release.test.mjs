import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import sharp from 'sharp';
import { parseTask, runTask } from '../dist/task.js';
import { readScript, runScript } from '../dist/script.js';
import { pending, withDevice } from '../dist/session.js';
import { doctor, diagnose } from '../dist/doctor.js';
import { classifyXml } from '../dist/webdriver.js';
import { executeStep } from '../dist/steps.js';

const raw = JSON.parse(
  await readFile(new URL('../examples/agent-open-search-android.json', import.meta.url)),
);
const portable = JSON.parse(
  await readFile(new URL('../examples/settings-search.json', import.meta.url)),
);
const control = (id, x = 20) => ({
  id,
  labels: [],
  role: 'Button',
  enabled: true,
  focused: false,
  editable: false,
  secret: false,
  bounds: { x, y: 20, width: 20, height: 15 },
});
const view = (app, controls) => ({
  app,
  window: app,
  width: 100,
  height: 100,
  rotation: 0,
  controls,
  screen: { page: 'other' },
  layout: {},
});
const first = view(raw.apps[0], [control(raw.actions[0].step.id)]),
  last = view(raw.apps[1], [control(raw.checkpoints[0].target.id)]);
const signal = () => new AbortController().signal;
test('one portable script compiles to native navigation and validates all active steps before connecting', async () => {
  for (const platform of ['ios', 'android', 'harmony']) {
    const script = await readScript(portable, platform);
    assert.equal(script.kind, 'general');
    assert.equal(script.steps.filter((s) => s.step.kind === 'back').length, platform === 'ios' ? 1 : 2);
    assert.equal(script.steps.at(-1).index, 10);
  }
  for (const step of [
    { action: 'tap', x: 2, y: 0 },
    { action: 'input', text: 23 },
    { action: 'back', id: 'wrong' },
    { action: 'waitFor', id: 'a', state: 'maybe' },
    { action: 'launch', app: ';id' },
  ]) {
    await assert.rejects(
      readScript({ schemaVersion: 1, steps: [{ action: 'tap', id: 'first' }, step] }, 'android'),
      /INVALID_SCRIPT_STEP: 2/,
    );
  }
});
test('wait tolerates transient window change, hidden means absent, failure stops dispatch and retains index', async () => {
  let reads = 0;
  const device = {
    snapshot: async () => {
      if (!reads++) throw Error('STALE_OBSERVATION');
      return first;
    },
  };
  const step = { kind: 'waitFor', selector: { id: 'gone' }, state: 'hidden', timeoutMs: 1000 };
  assert.equal((await executeStep(device, 'a', step)).status, 'succeeded');
  const result = await runScript(
    device,
    'a',
    [
      { index: 3, step: { ...step, state: 'visible', timeoutMs: 1 } },
      { index: 4, step: { kind: 'launch', app: 'forbidden' } },
    ],
    signal(),
  );
  assert.equal(result.failedStep, 3);
  assert.equal(result.reason, 'WAIT_TIMEOUT');
  assert.equal(result.steps.length, 1);
});
test('visual tool receives only the selected crop, taps the corresponding device point and requires an independent checkpoint', async () => {
  const task = await parseTask(
    { ...raw, checkpoints: [...raw.checkpoints, { ...raw.checkpoints[0], name: 'stillVisible' }] },
    'android',
  );
  let current = first,
    moves = 0,
    readsAfter = 0;
  const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: 'white' } })
    .png()
    .toBuffer();
  const device = {
    snapshot: async () => {
      if (moves) readsAfter++;
      return current;
    },
    screenshot: async () => png,
    perform: async (step) => {
      assert.equal(step.kind, 'tap');
      assert.ok(step.point.x > 0.29 && step.point.x < 0.31);
      assert.ok(step.point.y > 0.26 && step.point.y < 0.29);
      current = last;
      moves++;
    },
  };
  const choose = async (messages, tools, deadline, count) => {
    count();
    const visual = tools.find((t) => t.function.name === 'tap_visual');
    const t = visual ?? tools.find((t) => t.function.name === 'request_view');
    if (visual) {
      const content = messages.at(-1).content;
      assert.equal(content[0].type, 'text');
      assert.equal(JSON.parse(content[0].text).sourceCall, 'call-view');
      const data = Buffer.from(content[1].image_url.url.split(',')[1], 'base64');
      const { width, height } = await sharp(data).metadata();
      assert.deepEqual([width, height], [60, 45]);
      assert.ok(messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call-view'));
    }
    const args = {
      observationId: t.function.parameters.properties.observationId.enum[0],
      action: 'openSearch',
      ...(visual ? { x: 0.5, y: 0.5 } : {}),
    };
    return {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: visual ? 'call-tap' : 'call-view',
          type: 'function',
          function: { name: t.function.name, arguments: JSON.stringify(args) },
        },
      ],
    };
  };
  const result = await runTask(device, 'android:t', task, choose, true, signal());
  assert.equal(result.status, 'succeeded');
  assert.equal(moves, 1);
  assert.ok(readsAfter >= 2);
  assert.equal(result.evidence.length, 2);
});
test('foreign apps and sensitive controls pause before calling the model, and visual access is opt-in', async () => {
  const task = await parseTask(raw, 'android');
  for (const v of [view('outside', []), view(raw.apps[0], [{ ...first.controls[0], secret: true }])]) {
    const r = await runTask(
      { snapshot: async () => v },
      'd',
      task,
      () => assert.fail('sent data'),
      true,
      signal(),
    );
    assert.equal(r.status, 'needs_review');
  }
  const r = await runTask(
    { snapshot: async () => first },
    'd',
    task,
    async (m, t) => {
      assert.ok(!t.some((x) => x.function.name === 'request_view' || x.function.name === 'tap_visual'));
      const id = t[0].function.parameters.properties.observationId.enum[0];
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'x',
            type: 'function',
            function: { name: 'request_help', arguments: JSON.stringify({ observationId: id }) },
          },
        ],
      };
    },
    false,
    signal(),
  );
  assert.equal(r.status, 'needs_review');
  assert.equal(r.actions.at(-1).outcome, 'MODEL_REQUESTED_HELP');
  await assert.rejects(
    parseTask(
      {
        ...raw,
        actions: [{ ...raw.actions[0], visual: false, step: { action: 'launch', app: 'com.other' } }],
      },
      'android',
    ),
    /OUT_OF_SCOPE/,
  );
});
test('localized iOS 18 Settings exposes English bar identifier and Chinese switch / parent', () => {
  const s = classifyXml(
    'ios',
    '<root><bar type="XCUIElementTypeNavigationBar" name="Bluetooth" visible="true"><e type="XCUIElementTypeButton" name="设置" visible="true"/></bar><e type="XCUIElementTypeSwitch" name="蓝牙" visible="true" value="0"/></root>',
  );
  assert.equal(s.page, 'bluetooth');
  assert.equal(s.bluetooth, false);
});
test('doctor distinguishes USB authorization, offline, signing and locked devices', async () => {
  for (const [state, code] of [
    ['unauthorized', 'AUTHORIZATION_REQUIRED'],
    ['offline', 'DEVICE_OFFLINE'],
  ]) {
    const r = await doctor(
      { id: 'test', platform: 'android', model: 'fixture', available: false, state },
      'test',
    );
    assert.equal(r.controllable, false);
    assert.equal(r.probes[0].error, code);
  }
  assert.equal(diagnose(Error('Unknown device or simulator UDID')), 'DEVICE_UNAVAILABLE');
  assert.equal(diagnose(Error('No provisioning profile')), 'WDA_SIGNING_FAILED');
  assert.equal(diagnose(Error('device is locked')), 'DEVICE_LOCKED');
  assert.equal(diagnose(Error('The port #8100 is occupied by an other process')), 'PORT_IN_USE');
});
test('a killed process leaves exactly one ambiguous action and releases the real process lock', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'omu-crash-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = new URL('../dist/session.js', import.meta.url).href;
  const target = { id: 'test', platform: 'android' };
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {withDevice} from ${JSON.stringify(path)};await withDevice(${JSON.stringify(target)},'aaa',dispatch=>dispatch('tap',async()=>{console.log('sent');await new Promise(()=>setInterval(()=>{},60000))}))`,
    ],
    { env: { ...process.env, OMU_STATE_DIR: dir }, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  try {
    await once(child.stdout, 'data');
    const closed = once(child, 'close');
    child.kill('SIGKILL');
    await closed;
    const previous = process.env.OMU_STATE_DIR;
    process.env.OMU_STATE_DIR = dir;
    try {
      await withDevice(target, 'bbb', async () => {
        assert.deepEqual(
          pending(target).map((x) => x.kind),
          ['tap'],
        );
      });
    } finally {
      if (previous === undefined) delete process.env.OMU_STATE_DIR;
      else process.env.OMU_STATE_DIR = previous;
    }
  } finally {
    child.kill();
  }
});
