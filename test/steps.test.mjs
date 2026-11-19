import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveCapture } from '../dist/inspect.js';
import {
  executeStep,
  inputValue,
  observationId,
  parseStep,
  pointInView,
  resolveControl,
  visibleCenter,
} from '../dist/steps.js';
import { harmonyView, nodeXPath, xmlControls, xpathLiteral } from '../dist/native-layout.js';

const input = {
  id: 'box',
  labels: ['Search'],
  role: 'TextInput',
  bounds: { x: 10, y: 20, width: 80, height: 40 },
  value: '',
  editable: true,
  secret: false,
  enabled: true,
  focused: true,
};
const view = {
  app: 'example',
  window: 'main',
  width: 390,
  height: 844,
  rotation: 0,
  controls: [input],
  layout: {},
  screen: { page: 'other' },
};
const parse = (cmd, args, read = async () => '') =>
  parseStep(cmd, ['--device', 'ios:example', ...args], read);
test('coordinates map screenshot edges into the current logical touch area including landscape', async () => {
  assert.deepEqual(pointInView(view, { x: 1, y: 1 }), { x: 389, y: 843 });
  assert.deepEqual(pointInView({ ...view, width: 844, height: 390 }, { x: 1, y: 0 }), { x: 843, y: 0 });
  assert.deepEqual(visibleCenter(view, { x: -20, y: 15, width: 22, height: 10 }), { x: 1, y: 20 });
  assert.throws(() => visibleCenter(view, { x: 390, y: 20, width: 5, height: 5 }), /OUTSIDE/);
  for (const args of [
    ['--x', '1.1', '--y', '0'],
    ['--x', 'NaN', '--y', '.2'],
    ['--label', 'Search', '--x', '.5', '--y', '.3'],
  ])
    await assert.rejects(parse('tap', args));
  await assert.rejects(
    parse('swipe', ['--from-x', '.1', '--from-y', '.1', '--to-x', '.1', '--to-y', '.1']),
  );
  await assert.rejects(parse('tap', ['--id', 'x', '--replace']));
});
test('changed device, app, bounds, rotation or layout rejects a previous observation before dispatch', async () => {
  const key = 'ios:example',
    token = observationId(key, view);
  for (const [id, current] of [
    ['ios:second', view],
    [key, { ...view, rotation: 180 }],
    [key, { ...view, app: 'other' }],
    [key, { ...view, controls: [{ ...input, bounds: { ...input.bounds, x: 99 } }] }],
    [key, { ...view, window: 'other' }],
  ]) {
    const driver = {
      snapshot: async () => current,
      perform: async () => assert.fail('dispatched stale tap'),
    };
    await assert.rejects(
      executeStep(driver, id, { kind: 'tap', point: { x: 0.2, y: 0.4 } }, token),
      /STALE_OBSERVATION/,
    );
  }
});
test('selectors match native names exactly and distinguish absent, ambiguous and secure inputs', () => {
  const v = { ...view, controls: [input, { ...input, id: 'button', role: 'Button', editable: false }] };
  assert.throws(() => resolveControl(v, { label: 'Sea' }, false), /NOT_FOUND/);
  assert.throws(() => resolveControl(v, { label: 'Search' }, false), /AMBIGUOUS/);
  assert.equal(resolveControl(v, { label: 'Search', role: 'Button' }, false).id, 'button');
  assert.equal(resolveControl(v, {}, true).id, 'box');
  assert.throws(
    () =>
      resolveControl({ ...view, controls: [{ ...input, focused: false }] }, { role: 'TextInput' }, true),
    /NO_FOCUSED_FIELD/,
  );
  assert.throws(() => resolveControl(v, { id: 'button' }, true), /EDITABLE/);
  assert.throws(
    () => resolveControl({ ...view, controls: [{ ...input, secret: true }] }, { id: 'box' }, true),
    /EDITABLE/,
  );
});

test('capture retries a rotated layout and pairs a stable screenshot with the latest live text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omu-inspect-test-'));
  try {
    const next = { ...view, controls: [{ ...input, value: 'live update' }] };
    const frames = [{ ...view, rotation: 90 }, view, view, next];
    const image = Buffer.alloc(24);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(image);
    image.write('IHDR', 12);
    image.writeUInt32BE(view.width * 3, 16);
    image.writeUInt32BE(view.height * 3, 20);
    const device = { snapshot: async () => frames.shift(), screenshot: async () => image };
    const result = await saveCapture(join(dir, 'capture'), device, 'ios:fixture');
    const saved = JSON.parse(await readFile(join(result.directory, 'controls.json'), 'utf8'));
    assert.equal(saved.observationId, observationId('ios:fixture', next));
    assert.equal(saved.controls[0].value, 'live update');
    assert.equal(saved.controlsChangedDuringCapture, true);
    assert.equal(saved.width, 1170);
    assert.equal(saved.actionWidth, 390);
    assert.equal(frames.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('stdin preserves spaces, quotes and newlines; append and explicit replace have distinct results', async () => {
  const text = ' 中文 \' " \n';
  const { step } = await parse('input', ['--stdin'], async () => text);
  assert.equal(step.text, text);
  assert.equal(inputValue('old', step), 'old' + text);
  assert.equal(inputValue('old', { ...step, replace: true }), text);
  await assert.rejects(parse('input', ['--text', 'x', '--stdin']));
  await assert.rejects(parse('input', ['--text', '\0']));
  assert.equal((await parse('input', ['--text', '', '--replace'])).step.text, '');
});
test('native selectors preserve punctuation and ignore other packages, placeholders and invisible elements', () => {
  const xml =
    '<hierarchy><e class="android.widget.EditText" package="app" resource-id="search" bounds="[0,0][50,30]" focused="true" text="Search" hint="Search" showing-hint="true"/><e class="button" package="other" bounds="[0,0][50,30]"/></hierarchy>';
  const nodes = xmlControls('android', xml, 'app', 100, 100);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].value, '');
  assert.ok(nodeXPath('android', 'app', nodes[0]).includes("@resource-id='search'"));
  assert.equal(xpathLiteral('a\'b"c'), `concat('a', "'", 'b"c')`);
  const ios =
    '<root><e type="XCUIElementTypeSecureTextField" name="secret" visible="true" width="10" height="10" value="hidden"/><e visible="false" width="10" height="10"/></root>';
  const [secure] = xmlControls('ios', ios, 'app', 50, 80);
  assert.ok(secure.secret);
  assert.equal(secure.value, undefined);
});
test('Harmony uses the active window, screen bounds, and the focus of the Search container', () => {
  const wrap = (attributes, children = []) => ({ attributes, children });
  const field = wrap({
    id: 'field',
    type: 'SearchField',
    text: '',
    hint: 'Find',
    bounds: '[0,10][80,60]',
    visible: 'true',
    focused: 'false',
  });
  const win = wrap({ bundleName: 'app', focused: 'true', bounds: '[0,10][80,180]' }, [
    wrap({ type: 'Search', focused: 'true', bounds: '[0,10][80,60]' }, [field]),
  ]);
  const inactive = wrap({ bundleName: 'other', focused: 'false' }, [field]);
  const v = harmonyView(wrap({ bounds: '[0,0][80,180]' }, [inactive, win]), 90);
  assert.equal(v.width, 80);
  assert.equal(v.height, 180);
  assert.equal(resolveControl(v, {}, true).id, 'field');
  assert.throws(() => harmonyView(wrap({ bounds: '[0,0][80,180]' }, [win, win]), 0), /AMBIGUOUS/);
});
