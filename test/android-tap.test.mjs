import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { DOMParser } from '@xmldom/xmldom';
import { WebDriver } from '../dist/webdriver.js';
import { xmlControls } from '../dist/native-layout.js';
import { executeStep, guardObservation, resolveControl, screenAvailable, uniqueSelector } from '../dist/steps.js';
import { compileStep } from '../dist/script.js';
import { compileRecording, recordStep, replayRecording } from '../dist/recording.js';

const app = 'example.feed', role = 'android.widget.Button', id = app + ':id/comments';
const w3cId = 'element-6066-11e4-a52e-4f735466cecf';
const appium = createRequire(createRequire(import.meta.url).resolve('appium-uiautomator2-driver/package.json'));
const { select } = createRequire(appium.resolve('appium-chromedriver/package.json'))('xpath');

function inLiveXml(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return query => select(query, doc).map(n => n.getAttribute('test-handle')).reverse();
}

function page(names, twoButtons = false) {
  const rows = names.map((name, index) => {
    const y = index * 200;
    const button = x => `<node test-handle="button-${index}-${x}" package="${app}" class="${role}" resource-id="${id}" content-desc="评论" bounds="[${x},${y+80}][${x+48},${y+128}]"/>`;
    return `<node test-handle="row-${index}" package="${app}" class="android.widget.FrameLayout" resource-id="row" bounds="[0,${y}][360,${y+200}]">
      <node package="${app}" class="android.widget.TextView" resource-id="title" text="${name}" bounds="[0,${y}][200,${y+32}]"/>
      ${button(240)}${twoButtons ? button(300) : ''}</node>`;
  }).join('');
  const layout = `<hierarchy><node package="${app}" class="androidx.recyclerview.widget.RecyclerView" bounds="[0,0][360,800]">${rows}</node></hierarchy>`;
  return { app, window: 'feed', width: 360, height: 800, rotation: 0, layout,
    screen: { page: 'other' }, controls: xmlControls('android', layout, app, 360, 800) };
}

async function driver(t, find, rect = {}) {
  const clicks = [], lookups = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const pathname = new URL(url).pathname;
    let value;
    if (pathname === '/session') value = { sessionId: 'test' };
    else if (pathname.endsWith('/elements')) {
      const query = JSON.parse(options.body).value;
      lookups.push(query);
      value = find(query).map(key => ({ [w3cId]: key }));
    } else if (pathname.endsWith('/rect')) value = rect[pathname.split('/').at(-2)];
    else if (pathname.endsWith('/click')) { clicks.push(pathname.split('/').at(-2)); value = null; }
    else assert.fail('Unexpected request ' + pathname);
    return Response.json({ value });
  });
  const dev = await WebDriver.open('android', 'test', async (_kind, perform) => perform(), 'foreground');
  return { dev, clicks, lookups };
}

test('a unique live Android id and role survive a moving comment button', async t => {
  const v = page(['作品甲']);
  const node = v.controls.find(c => c.id === id);
  const { dev, clicks, lookups } = await driver(t, query => query.includes('@bounds=') ? [] : ['moving']);
  await dev.perform({ kind: 'tap', selector: { id, role } }, v, node);
  assert.equal(lookups.length, 1);
  assert.ok(lookups[0].includes(id) && lookups[0].includes(role) && lookups[0].includes(app));
  assert.deepEqual(clicks, ['moving']);
});

test('same-id comment buttons are selectable by card, including after list reordering and on replay', async t => {
  const before = page(['作品甲', '作品乙']);
  const node = before.controls.filter(c => c.id === id)[1];
  const selector = uniqueSelector(before, node);
  assert.equal(selector?.within, '作品乙');
  const command = { action: 'tap', ...selector };
  const { step } = await compileStep(command, 'android');
  const recorded = recordStep(before, command, node);
  const tape = JSON.parse(JSON.stringify({ schemaVersion: 2, platform: 'android', steps: [recorded] }));
  const [replay] = await compileRecording(tape, 'android');
  assert.deepEqual(replay.step, step);
  const after = page(['作品乙', '作品甲']);
  const { dev, clicks } = await driver(t, inLiveXml(after.layout));
  dev.snapshot = async () => after;
  await executeStep(dev, 'android:test', step, guardObservation('android:test', before, step, screenAvailable));
  assert.deepEqual(clicks, ['button-0-240']);
  const result = await replayRecording(dev, 'android:test', [replay], new AbortController().signal, () => {});
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(clicks, ['button-0-240', 'button-0-240']);
});

test('a disappearing selected card cannot redirect its click to the sole remaining candidate', async t => {
  const v = page(['作品甲','作品乙']);
  const node = v.controls.filter(c => c.id === id)[0];
  const selector = uniqueSelector(v, node);
  assert.ok(selector?.within);
  const { dev, clicks } = await driver(t, inLiveXml(page(['作品乙']).layout));
  await assert.rejects(dev.perform({ kind: 'tap', selector }, v, node), /STALE_OBSERVATION|AMBIGUOUS_OR_MISSING_ELEMENT/);
  assert.deepEqual(clicks, []);
});

test('multiple buttons in one card use its relative hit position and reject overlap', async t => {
  const v = page(['作品甲','作品乙'], true);
  const node = v.controls.filter(c => c.id === id)[3];
  const selector = uniqueSelector(v, node);
  assert.equal(selector?.within, '作品乙');
  assert.ok(Number.isFinite(selector.cardX) && Number.isFinite(selector.cardY));
  const { step } = await compileStep({ action:'tap', ...selector }, 'android');
  const scaled = page(['作品乙','作品甲'], true).layout.replace(
    /\[(\d+),(\d+)\]/g, (_match, x, y) => `[${Number(x)*2},${Number(y)*2}]`);
  const moved = { ...v, width: 720, height: 1600, layout: scaled, controls: xmlControls('android', scaled, app, 720, 1600) };
  assert.equal(resolveControl(moved, step.selector, false).bounds.x, 600);
  const rect = {
    'row-0': { x: 0, y: 0, width: 720, height: 400 },
    'button-0-240': { x: 482, y: 162, width: 96, height: 96 },
    'button-0-300': { x: 602, y: 162, width: 96, height: 96 },
  };
  const { dev, clicks } = await driver(t, inLiveXml(moved.layout), rect);
  const current = resolveControl(moved, step.selector, false);
  await dev.perform(step, moved, current);
  assert.deepEqual(clicks, ['button-0-300']);
  rect['button-0-240'] = rect['button-0-300'];
  await assert.rejects(dev.perform(step, moved, current), /AMBIGUOUS_OR_MISSING_ELEMENT/);
  assert.deepEqual(clicks, ['button-0-300']);
});

test('a nested suggested item cannot supply the title of its outer card', async t => {
  const v = page(['作品甲','作品乙']);
  const node = v.controls.filter(c => c.id === id)[0];
  const selector = uniqueSelector(v, node);
  const nested = `<node package="${app}" class="android.widget.GridView" bounds="[0,0][150,70]">
    <node package="${app}" class="android.widget.FrameLayout" bounds="[0,0][150,70]">
      <node package="${app}" class="android.widget.TextView" resource-id="title" text="作品甲" bounds="[0,0][90,30]"/>
    </node></node>`;
  const wrongCard = page(['作品乙']).layout.replace('<node test-handle="button-', nested + '<node test-handle="button-');
  const { dev, clicks } = await driver(t, inLiveXml(wrongCard));
  await assert.rejects(dev.perform({ kind: 'tap', selector }, v, node), /STALE_OBSERVATION|AMBIGUOUS_OR_MISSING_ELEMENT/);
  assert.deepEqual(clicks, []);
});

test('a reused singleton on a different observed item is stale before dispatch', () => {
  const before = page(['作品甲']);
  const validate = guardObservation('android:test', before, { kind: 'tap', selector: { id, role } }, screenAvailable);
  assert.throws(() => validate(page(['作品乙'])), /STALE_OBSERVATION/);
});

test('two indistinguishable cards do not get a positional-only selector', () => {
  const v = page(['同名作品','同名作品']);
  for (const button of v.controls.filter(c => c.id === id)) assert.equal(uniqueSelector(v, button), undefined);
});

test('ordinary repeated row layouts can use distinct titles without a RecyclerView class', () => {
  const old = page(['作品甲','作品乙']);
  const layout = old.layout.replaceAll('androidx.recyclerview.widget.RecyclerView', 'android.view.ViewGroup')
    .replaceAll('resource-id="row"', 'resource-id="obfuscated"');
  const v = { ...old, layout, controls: xmlControls('android', layout, app, old.width, old.height) };
  assert.deepEqual(v.controls.filter(n => n.id === id).map(n => uniqueSelector(v, n)?.within), ['作品甲','作品乙']);
});

test('a sibling moving away cannot turn a surviving button into the recorded right-hand target', async t => {
  const v = page(['作品甲'], true), node = v.controls.filter(n => n.id === id)[1];
  const selector = uniqueSelector(v, node);
  assert.ok(Number.isFinite(selector.cardX));
  const live = page(['作品甲']);
  const { dev, clicks } = await driver(t, inLiveXml(live.layout), {
    'row-0': {x:0,y:0,width:360,height:200}, 'button-0-240': {x:240,y:80,width:48,height:48},
  });
  await assert.rejects(dev.perform({kind:'tap',selector}, v, node), /AMBIGUOUS_OR_MISSING_ELEMENT/);
  assert.deepEqual(clicks, []);
});

test('two live cards now carrying the same title cannot be disambiguated by the old screen position', async t => {
  const v = page(['作品甲','作品乙']);
  const node = v.controls.find(c => c.id === id);
  const selector = uniqueSelector(v, node);
  const { dev, clicks } = await driver(t, inLiveXml(page(['作品甲','作品甲']).layout));
  await assert.rejects(dev.perform({kind:'tap',selector}, v, node), /AMBIGUOUS_OR_MISSING_ELEMENT/);
  assert.deepEqual(clicks, []);
});

test('an explicit label stays part of the live lookup even when the node has an id', async t => {
  const v = page(['作品甲']);
  const node = v.controls.find(c => c.id === id);
  const changed = v.layout.replace('content-desc="评论"', 'content-desc="分享"');
  const { dev, clicks } = await driver(t, inLiveXml(changed));
  await assert.rejects(dev.perform({ kind: 'tap', selector: { role, label: '评论' } }, v, node),
    /AMBIGUOUS_OR_MISSING_ELEMENT/);
  assert.deepEqual(clicks, []);
});

test('the row title can contain both kinds of XPath quotes', async t => {
  const v = page(['普通标题', 'Alice\'s &quot;B&quot;']);
  const node = v.controls.filter(c => c.id === id)[1];
  const selector = uniqueSelector(v, node);
  assert.equal(selector.within, 'Alice\'s "B"');
  const { dev, clicks } = await driver(t, inLiveXml(v.layout));
  await dev.perform({ kind: 'tap', selector }, v, node);
  assert.deepEqual(clicks, ['button-1-240']);
});

test('card-relative coordinates must be paired, bounded and attached to an Android card', async () => {
  const command = { action: 'tap', id, role, within: '作品乙', cardX: 0.5 };
  await assert.rejects(compileStep(command, 'android'), /INVALID_SELECTOR/);
  await assert.rejects(compileStep({ ...command, cardY: 2 }, 'android'), /COORDINATE_OUT_OF_RANGE/);
  await assert.rejects(compileStep({ ...command, cardY: 0.5 }, 'ios'), /INVALID_SELECTOR/);
});

test('unknown owners and absent ids fail closed on multiple live matches', async t => {
  const v = page(['作品甲']);
  const node = { ...v.controls.find(c => c.id === id), card: undefined };
  const { dev, clicks, lookups } = await driver(t, () => ['one', 'two']);
  await assert.rejects(dev.perform({ kind:'tap', selector:{id,role} }, v, node), /AMBIGUOUS_OR_MISSING_ELEMENT/);
  await assert.rejects(dev.perform({ kind:'tap', selector:{label:'评论',role} }, v, {...node,id:''}), /AMBIGUOUS_OR_MISSING_ELEMENT/);
  assert.match(lookups.at(-1), /@bounds=/);
  await assert.rejects(dev.perform({kind:'input',selector:{id,role},text:'test',replace:true}, v, node), /AMBIGUOUS_OR_MISSING_ELEMENT/);
  assert.match(lookups.at(-1), /@bounds=/);
  assert.deepEqual(clicks, []);
});
