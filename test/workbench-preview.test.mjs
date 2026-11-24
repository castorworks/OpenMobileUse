import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { Workbench } from '../desktop/workbench.mjs';

test('chat previews follow observations and waits, reusing the model screenshot', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'omu-preview-'));
  const previous = process.env.OMU_STATE_DIR;
  process.env.OMU_STATE_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.OMU_STATE_DIR;
    else process.env.OMU_STATE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const view = {
    app: 'example.feed', window: 'main', width: 40, height: 80, rotation: 0, screen: {},
    controls: [{
      id: 'open', role: 'Button', labels: ['Open'], enabled: true,
      bounds: { x: 1, y: 1, width: 15, height: 12 },
    }],
  };
  const colours = ['red', 'green', 'blue'];
  const frames = await Promise.all(colours.map(background =>
    sharp({ create: { width: 40, height: 80, channels: 3, background } }).png().toBuffer(),
  ));
  let stage = 'home', taps = 0;
  const captures = [], previews = [], errors = [], decisions = [];
  const device = {
    async snapshot() {
      if (stage === 'transition') stage = 'green';
      return view;
    },
    async screenshot() {
      captures.push(stage);
      if (captures.length === 1) throw Error('SCREENSHOT_UNAVAILABLE');
      if (stage === 'home') return frames[0];
      return frames[colours.indexOf(stage)];
    },
    async perform(step) {
      assert.equal(step.kind, 'tap');
      taps++;
      stage = 'transition';
    },
    foregroundApp() {}, observe() {}, close() {}, move() {}, launch() {}, back() {},
  };
  const workbench = new Workbench(event => {
    if (event.type === 'frame') previews.push(event.frame.image);
    if (event.type === 'frameError') errors.push(event.error);
  }, {
    bridge: { openDevice: async () => device },
    preferences: { useImages: true, clientConfig: () => ({ baseURL: 'http://localhost', model: 'test' }) },
  });
  const target = { id: 'preview-test', platform: 'harmony', available: true };
  const id = target.platform + ':' + target.id;
  workbench.targets.set(id, target);
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    const current = messages.findLast(message => message.role === 'user' && typeof message.content === 'string');
    const { observationId, controls } = JSON.parse(current.content);
    decisions.push(observationId);
    if (decisions.length === 1) return new Response('{');
    let name, args = {};
    switch (decisions.length) {
      case 2: name = 'tap'; args = { target: controls[0].ref }; break;
      case 3: name = 'wait'; stage = 'blue'; break;
      case 4: name = 'inspect_screen'; stage = 'red'; break;
      default: name = 'finish'; args = { evidence: 'foreground', message: 'Done' };
    }
    return Response.json({ choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant', tool_calls: [{ id: observationId, type: 'function', function: {
        name, arguments: JSON.stringify({ observationId, ...args }),
      } }],
    } }] });
  });
  await workbench.start(id, 'chat', { message: 'Open the feed.' });
  await workbench.operations.get(id);
  const { history } = await workbench.history(id);
  assert.equal(history[0].status, 'succeeded');
  assert.equal(taps, 1);
  assert.deepEqual(errors, ['SCREENSHOT_UNAVAILABLE']);
  // The last capture is the normal interactive frame restored when the run ends.
  assert.deepEqual(captures, ['home', 'home', 'green', 'blue', 'red', 'red']);
  assert.deepEqual(previews, [0, 1, 2, 0, 0].map(i => 'data:image/png;base64,' + frames[i].toString('base64')));
});
