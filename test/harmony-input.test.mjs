import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Harmony } from '../dist/harmony.js';
import { harmonyView } from '../dist/native-layout.js';
import { pending, withDevice } from '../dist/session.js';

const previousDir = process.env.OMU_STATE_DIR;
let stateDir;
before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'omu-harmony-input-'));
  process.env.OMU_STATE_DIR = stateDir;
});
after(async () => {
  if (previousDir === undefined) delete process.env.OMU_STATE_DIR;
  else process.env.OMU_STATE_DIR = previousDir;
  await rm(stateDir, { recursive: true, force: true });
});

function view(value, focused = true, app = 'example.editor') {
  const control = {
    id: 'query',
    role: 'TextInput',
    labels: [],
    editable: true,
    enabled: true,
    secret: false,
    bounds: { x: 0, y: 0, width: 20, height: 20 },
    value,
    focused,
  };
  return { app, window: 'main', rotation: 0, width: 100, height: 100, controls: [control] };
}

function input(
  initial,
  snapshots,
  { replace = false, reply = 'No Error', selector = { id: 'query' }, text = 'X' } = {},
) {
  const target = { platform: 'harmony', id: randomUUID() };
  const commands = [];
  let reads = 0;
  const result = withDevice(target, randomUUID(), async (dispatch) => {
    const phone = new Harmony(target.id, dispatch);
    phone.snapshot = async () => {
      assert.ok(reads < 10, 'input verification should end after a bounded number of reads');
      const observed = snapshots[Math.min(reads++, snapshots.length - 1)];
      if (observed instanceof Error) throw observed;
      return observed;
    };
    phone.shell = async (...args) => {
      commands.push(args);
      return reply;
    };
    await phone.perform(
      { kind: 'input', selector, text, replace },
      initial,
      initial.controls[0],
    );
  });
  return { result, commands, unconfirmed: () => pending(target).map((r) => r.kind) };
}

const focusTap = ['uitest', 'uiInput', 'click', '10', '10'];
const appendAtEnd = ['uitest', 'uiInput', 'keyEvent', '2072', '2082'];
const selectAll = ['uitest', 'uiInput', 'keyEvent', '2072', '2017'];
const deleteSelection = ['uitest', 'uiInput', 'keyEvent', '2055'];
const typeX = ["uitest uiInput text 'X'"];

for (const [change, snapshot, error] of [
  ['value changed', view('autofilled'), 'INPUT_TARGET_CHANGED'],
  ['foreground app changed', view('', true, 'example.other'), 'INPUT_TARGET_CHANGED'],
  ['same app opened another window', { ...view(''), window: 'details' }, 'INPUT_TARGET_CHANGED'],
  ['field lost focus', view('', false), 'INPUT_FOCUS_UNCONFIRMED'],
]) {
  test('after a confirmed focus tap, no text is sent when the ' + change, async () => {
    const attempt = input(view('', false), [snapshot]);
    await assert.rejects(attempt.result, { message: error });
    assert.deepEqual(attempt.commands, [focusTap]);
    assert.deepEqual(attempt.unconfirmed(), []);
  });
}

test('an id-less field keeps its selected label when focus moves', async () => {
  const original = view('');
  const other = view('');
  Object.assign(original.controls[0], { id: '', labels: ['From'] });
  Object.assign(other.controls[0], { id: '', labels: ['To'] });
  const attempt = input(original, [other], { selector: { label: 'From' } });
  await assert.rejects(attempt.result, { message: 'INPUT_TARGET_CHANGED' });
  assert.deepEqual(attempt.commands, []);
});

test('a missing focus tap acknowledgement remains pending', async () => {
  const attempt = input(view('', false), [], { reply: '' });
  await assert.rejects(attempt.result, /^Error: ACTION_OUTCOME_UNKNOWN:/);
  assert.deepEqual(attempt.commands, [focusTap]);
  assert.equal(attempt.unconfirmed().length, 1);
});

test('a brief focus transition before typing needs only one focus tap and one write', async () => {
  const attempt = input(view('', false), [
    Error('FOREGROUND_WINDOW_AMBIGUOUS'),
    view('', false),
    view(''),
    view('X'),
  ]);
  await attempt.result;
  assert.deepEqual(attempt.commands, [focusTap, typeX]);
  assert.deepEqual(attempt.unconfirmed(), []);
});

test('losing the target after clearing does not resend the input', async () => {
  const attempt = input(view('old'), [view('old'), view('', true, 'example.other')], { replace: true });
  await assert.rejects(attempt.result, /^Error: ACTION_OUTCOME_UNKNOWN:/);
  assert.deepEqual(attempt.commands, [selectAll, deleteSelection]);
  assert.deepEqual(attempt.unconfirmed(), ['input']);
});

test('verification tolerates temporary foreground and focus changes after appending', async () => {
  const attempt = input(view('old'), [
    view('old'),
    view('oldX', true, 'example.other'),
    view('oldX', false),
    view('oldX'),
  ]);
  await attempt.result;
  assert.deepEqual(attempt.commands, [appendAtEnd, typeX]);
  assert.deepEqual(attempt.unconfirmed(), []);
});

for (const code of ['FOREGROUND_WINDOW_AMBIGUOUS', 'HDC_LAYOUT_UNAVAILABLE']) {
  test('a post-write ' + code + ' cannot trigger another append', async () => {
    const attempt = input(view('old'), [view('old'), Error(code)]);
    await assert.rejects(attempt.result, { message: 'INPUT_NOT_VERIFIED' });
    assert.deepEqual(attempt.commands, [appendAtEnd, typeX]);
  });
}

test('a permanent foreground change after replacing ends verification without rewriting', async () => {
  const attempt = input(view('old'), [view('old'), view(''), view('X', true, 'example.other')], {
    replace: true,
  });
  await assert.rejects(attempt.result, { message: 'INPUT_NOT_VERIFIED' });
  assert.deepEqual(attempt.commands, [selectAll, deleteSelection, typeX]);
});

// The label of this id-less field changes from the placeholder to the query, and the
// suggestion below it repeats the query. Both reflect nodes seen in a Harmony search UI.
function searchView(value, options = {}) {
  const {
    handle = '38', focused = true, field = {}, window = {}, duplicate = false, rotation = 0,
  } = options;
  const hostWindowId = window.hostWindowId ?? '66';
  const input = {
    attributes: {
      type: 'TextInput', id: '', hostWindowId, bounds: '[24,120][900,204]',
      ...(handle ? { accessibilityId: handle, hashcode: handle } : {}),
      text: value, hint: value ? '' : '搜索', focused: String(focused), ...field,
    },
  };
  const suggestion = { attributes: { type: 'Text', bounds: '[24,250][900,334]', text: 'deepseek' } };
  const fields = [input];
  if (duplicate)
    fields.push({ attributes: { ...input.attributes, hint: '收件人', focused: 'false' } });
  return harmonyView({
    attributes: { bounds: '[0,0][1216,2688]' },
    children: [{
      attributes: {
        bundleName: 'example.chat', hostWindowId, focused: 'true', abilityName: 'EntryAbility',
        pagePath: 'pages/WechatAppPage', bounds: '[0,107][1216,2688]', ...window,
      },
      children: [...fields, suggestion],
    }],
  }, rotation);
}

const searchOptions = { text: 'deepseek', replace: true, selector: { label: '搜索', role: 'TextInput' } };
const typeQuery = ["uitest uiInput text 'deepseek'"];
for (const [description, initialOptions, finalOptions] of [
  ['placeholder disappears', {}, {}],
  ['unique field loses focus and its dump handles change', {}, { handle: '40', focused: false }],
  ['keyboard resizes the window', {}, { window: { bounds: '[0,107][1216,1667]' } }],
  ['bounds identify a field without a handle', { handle: '' }, { handle: '', focused: false }],
]) {
  test('verifies the original search field (' + description + ')', async () => {
    const original = searchView('', initialOptions);
    const beforeWrite = searchView('', { handle: '39', ...initialOptions });
    const attempt = input(original, [beforeWrite, searchView('deepseek', finalOptions)], searchOptions);
    await attempt.result;
    assert.deepEqual(attempt.commands, [typeQuery]);
  });
}

for (const [description, initialOptions, value, finalOptions] of [
  ['a different window handle', {}, 'deepseek', { window: { hostWindowId: '67' } }],
  ['a different page in the same window', {}, 'deepseek', { window: { pagePath: 'pages/Other' } }],
  ['changed orientation', {}, 'deepseek', { rotation: 90 }],
  [
    'a different description at the same bounds',
    { field: { description: 'Find contacts' } },
    'deepseek',
    { focused: false, field: { description: 'Find files' } },
  ],
  [
    'a different resource id at the same bounds',
    { field: { id: 'contacts' } },
    'deepseek',
    { field: { id: 'files' } },
  ],
  ['changed letter case', {}, 'DeepSeek', {}],
  ['a noneditable suggestion alone', {}, '', {}],
  ['duplicate fields at the same bounds', { handle: '' }, 'deepseek', { handle: '', duplicate: true }],
  ['bounds shared by two original fields', { duplicate: true }, 'deepseek', { focused: false }],
]) {
  test('search verification rejects ' + description + ' without resending text', async () => {
    const original = searchView('', initialOptions);
    const attempt = input(original, [original, searchView(value, finalOptions)], searchOptions);
    await assert.rejects(attempt.result, { message: 'INPUT_NOT_VERIFIED' });
    assert.deepEqual(attempt.commands, [typeQuery]);
  });
}
