import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { runConversation } from '../dist/conversation.js';
import { compileRecording } from '../dist/recording.js';

function control(id, role = 'Stack', bounds = { x: 0, y: 0, width: 10, height: 10 }) {
  return { id, role, bounds, labels: [], enabled: true, editable: false, focused: false, secret: false };
}

function phone(controls = []) {
  const view = { app: 'example.feed', window: 'main', width: 200, height: 400, rotation: 0, controls };
  return {
    view,
    snapshot: async () => view,
    async screenshot() {
      throw Error('Unexpected screenshot');
    },
    async perform() {
      throw Error('Unexpected gesture');
    },
  };
}

function frame(colour) {
  return sharp({ create: { width: 200, height: 400, channels: 3, background: colour } })
    .png()
    .toBuffer();
}

async function run(device, choose, useImages = false) {
  const records = [],
    events = [];
  const decide = async (messages, tools, deadline, count) => {
    count();
    const current = messages.findLast((m) => m.role === 'user' && typeof m.content === 'string');
    const obs = JSON.parse(current.content);
    const [name, args] = choose(
      obs,
      tools.map((t) => t.function.name),
      messages,
    );
    return {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          type: 'function',
          id: obs.observationId,
          function: { name, arguments: JSON.stringify({ observationId: obs.observationId, ...args }) },
        },
      ],
    };
  };
  const result = await runConversation(
    device,
    'android:test',
    'android',
    [{ user: '浏览并总结' }],
    decide,
    new AbortController().signal,
    async (s) => records.push(s),
    (name, status) => events.push(status),
    () => true,
    undefined,
    useImages,
  );
  return { result, records, events };
}

test('a late toolbar icon is offered ahead of layout wrappers', async () => {
  const controls = Array.from({ length: 90 }, (_, i) => control('layout' + i));
  controls.push(control('toolbar_search', 'Image'));
  const device = phone(controls);
  device.perform = async (step, view, node) => {
    assert.equal(node.id, 'toolbar_search');
    view.controls = [{ ...control('search_box', 'TextInput'), editable: true }];
  };
  const { result, records } = await run(device, (obs) => {
    const field = obs.controls.find((c) => c.editable);
    if (field) return ['finish', { evidence: field.ref, message: '搜索框已打开。' }];
    return ['tap', { target: obs.controls.find((c) => c.id === 'toolbar_search').ref }];
  });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(
    records.map((s) => s.command.action),
    ['tap', 'check'],
  );
});

test('an unclear visual tap can recover a native target beyond the control limit', async () => {
  const controls = Array.from({ length: 1000 }, (_, i) => control('icon' + i, 'Image'));
  controls.push(control('search', 'Image', { x: 160, y: 20, width: 40, height: 40 }));
  const device = phone(controls);
  const blank = await frame('#202020');
  device.screenshot = async () => blank;
  device.perform = async (step, view, node) => {
    assert.equal(node.id, 'search');
    assert.equal(step.point, undefined);
    view.controls = [control('search_field', 'TextInput')];
  };
  const { result, records, events } = await run(
    device,
    (obs, tools) => {
      if (obs.controls[0].id === 'search_field')
        return ['finish', { evidence: obs.controls[0].ref, message: '已看到搜索框。' }];
      if (tools.includes('inspect_screen')) return ['inspect_screen', {}];
      if (!obs.lastBlocker) {
        assert.equal(obs.controls.length, 1000);
        assert.equal(obs.controls.at(-1).ref, 'n1000');
        assert.ok(!obs.controls.some((c) => c.id === 'search'));
        return ['tap_visual', { x: 0.9, y: 0.1, label: '搜索' }];
      }
      assert.equal(obs.lastBlocker.outcome, 'VISUAL_TARGET_UNCLEAR');
      const target = obs.controls.find((c) => c.atVisualTarget && c.id === 'search');
      return ['tap', { target: target.ref }];
    },
    true,
  );
  assert.equal(result.status, 'succeeded');
  assert.ok(events.includes('VISUAL_TARGET_UNCLEAR'));
  assert.deepEqual(
    records.map((s) => s.command.action),
    ['tap', 'check'],
  );
});

test('the 1000th decision is reserved for reporting the result', async () => {
  const device = phone([control('open', 'Button')]);
  const picture = await frame('#202020');
  device.screenshot = async () => picture;
  device.perform = async () => {
    device.view.app = device.view.app === 'example.feed' ? 'example.item' : 'example.feed';
  };
  let decisions = 0;
  const { result, records } = await run(
    device,
    (obs, tools) => {
      decisions++;
      if (decisions === 1000) {
        assert.ok(!tools.includes('tap'));
        return ['finish', { evidence: obs.controls[0].ref, message: '完成。' }];
      }
      assert.ok(tools.includes('tap'));
      if (tools.includes('inspect_screen')) return ['inspect_screen', {}];
      return ['tap', { target: obs.controls[0].ref }];
    },
    true,
  );
  assert.equal(result.status, 'succeeded');
  assert.equal(result.modelCalls, 1000);
  assert.equal(records.length, 500);
});

test('consecutive swipes through a visual feed retain item notes across history pruning', async () => {
  const device = phone();
  const frames = await Promise.all(
    Array.from({ length: 10 }, (_, i) => frame({ r: i * 18, g: 20, b: 90 })),
  );
  let index = 0;
  device.screenshot = async () => frames[index];
  device.perform = async (step) => {
    assert.equal(step.kind, 'swipe');
    index++;
    if (index === 9) device.view.controls = [control('last_item', 'Text')];
  };
  // Keep enough native evidence on each page to force messagesFor to trim previous turns.
  device.view.controls = Array.from({ length: 70 }, (_, i) => ({
    ...control('field' + i, 'Text'),
    labels: ['内容'.repeat(60) + i],
  }));
  const { result, records } = await run(
    device,
    (obs, tools) => {
      if (tools.includes('inspect_screen')) return ['inspect_screen', {}];
      assert.deepEqual(
        obs.savedNotes,
        Array.from({ length: index }, (_, i) => '条目 ' + (i + 1)),
      );
      if (index === 9) return ['finish', { evidence: obs.controls[0].ref, message: '已读到第十条。' }];
      return ['swipe', { direction: 'up', note: '条目 ' + (index + 1) }];
    },
    true,
  );
  assert.equal(result.status, 'succeeded');
  assert.equal(records.filter((s) => s.command.action === 'swipe').length, 9);
  await compileRecording({ schemaVersion: 2, platform: 'android', steps: records }, 'android');
});

test('an unchanged feed gets a bounded recovery and reports partial findings', async () => {
  const device = phone();
  const blank = await frame('#202020');
  const clockTick = await sharp(blank)
    .composite([
      {
        input: { create: { width: 10, height: 5, channels: 3, background: '#eeeeee' } },
        top: 0,
        left: 0,
      },
    ])
    .png()
    .toBuffer();
  let screenshots = 0;
  device.screenshot = async () => (screenshots++ % 2 ? clockTick : blank);
  let dispatched = 0;
  device.perform = async () => {
    dispatched++;
  };
  // Even a model that ignores every recovery hint cannot repeatedly dispatch the gesture.
  const { result } = await run(
    device,
    () => ['swipe', { direction: 'up', note: '只读到第一条。' }],
    true,
  );
  assert.equal(dispatched, 1);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.reason, 'NO_PROGRESS');
  assert.match(result.answer, /只读到第一条/);
  assert.match(result.answer, /上滑动/);
});

test('reused native ids with changing captions support consecutive swipes without images', async () => {
  const caption = { ...control('caption', 'Text'), labels: ['第一条'] };
  const device = phone([caption]);
  const captions = ['第一条', '第二条', '第三条'];
  let index = 0;
  device.perform = async (step) => {
    assert.equal(step.kind, 'swipe');
    caption.labels = [captions[++index]];
  };
  const { result, records } = await run(device, (obs) =>
    index === 2
      ? ['finish', { evidence: obs.controls[0].ref, message: '已读到第三条。' }]
      : ['swipe', { direction: 'up' }],
  );
  assert.equal(result.status, 'succeeded');
  assert.equal(records.length, 3);
});

test('a rejected input is replanned from the current field and only verified steps are recorded', async () => {
  const field = { ...control('query', 'TextInput'), editable: true, value: '' };
  const device = phone([field]);
  let attempts = 0;
  device.perform = async (step, view, node) => {
    assert.equal(step.kind, 'input');
    if (++attempts === 1) {
      view.controls = [{ ...field, id: 'updated_query', value: 'suggestion' }];
      throw Error('INPUT_TARGET_CHANGED');
    }
    assert.equal(node.id, 'updated_query');
    view.controls = [{ ...node, value: step.text }];
  };
  const { result, records, events } = await run(device, (obs) => {
    const target = obs.controls[0];
    if (target.value === 'hello') return ['finish', { evidence: target.ref, message: '已输入。' }];
    if (target.id === 'updated_query') assert.equal(obs.lastBlocker.outcome, 'INPUT_TARGET_CHANGED');
    return ['input_text', { target: target.ref, text: 'hello' }];
  });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(events, ['INPUT_TARGET_CHANGED', 'dispatched', 'observed']);
  assert.deepEqual(records.map((s) => s.command.action), ['input', 'check']);
  assert.equal(records[0].command.id, 'updated_query');
  assert.equal(records[0].reading.value, 'suggestion');
});

test('an unverified text write pauses for review without a second input', async () => {
  const device = phone([{ ...control('query', 'TextInput'), editable: true }]);
  device.perform = async () => { throw Error('INPUT_NOT_VERIFIED'); };
  const { result, records } = await run(device, (obs) => [
    'input_text', { target: obs.controls[0].ref, text: 'hello' },
  ]);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.reason, 'INPUT_NOT_VERIFIED');
  assert.equal(result.modelCalls, 1);
  assert.deepEqual(records, []);
});

test('a sensitive screen or unconfirmed action stops dispatch immediately', async () => {
  const device = phone([control('next', 'Button')]);
  device.perform = async () => {
    throw Error('ACTION_OUTCOME_UNKNOWN');
  };
  const choose = (obs) => ['tap', { target: obs.controls[0].ref }];
  const unknown = await run(device, choose);
  assert.equal(unknown.result.reason, 'ACTION_OUTCOME_UNKNOWN');
  assert.equal(unknown.result.modelCalls, 1);
  device.view.controls[0].secret = true;
  const blocked = await run(device, choose);
  assert.equal(blocked.result.reason, 'SENSITIVE_OR_BLOCKED_SCREEN');
  assert.equal(blocked.result.modelCalls, 0);
});

test('a truncated screenshot drops the previous visual point and uses fresh native evidence', async () => {
  const device = phone([control('old_control', 'Button')]);
  const blank = await frame('#202020');
  // The PNG signature, IHDR chunk and dimensions pass geometry validation. Pixel decoding fails.
  const truncated = blank.subarray(0, 33);
  let captures = 0;
  let fallback;
  device.screenshot = async () => {
    if (++captures === 1) return blank;
    device.view.controls = [
      control('current_result', 'Button', { x: 90, y: 190, width: 20, height: 20 }),
    ];
    return truncated;
  };
  const { result, records, events } = await run(
    device,
    (obs, tools, messages) => {
      if (obs.textStatus === 'INVALID_PNG') {
        fallback = { obs, tools, messages };
        return ['finish', { evidence: obs.controls[0].ref, message: '已看到当前结果。' }];
      }
      if (tools.includes('tap_visual')) return ['tap_visual', { x: 0.5, y: 0.5, label: '打开结果' }];
      return ['inspect_screen', {}];
    },
    true,
  );
  assert.equal(result.status, 'succeeded');
  assert.equal(fallback.obs.lastBlocker.outcome, 'INVALID_PNG');
  assert.deepEqual(
    fallback.obs.controls.map((n) => n.id),
    ['current_result'],
  );
  assert.ok(!fallback.obs.controls[0].atVisualTarget);
  assert.ok(!fallback.tools.includes('tap_visual') && !fallback.tools.includes('finish_visual'));
  assert.ok(
    !fallback.messages.some(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'),
    ),
  );
  assert.deepEqual(events, ['observed', 'VISUAL_TARGET_UNCLEAR', 'INVALID_PNG', 'observed']);
  assert.deepEqual(
    records.map((s) => s.command),
    [{ action: 'check', id: 'current_result', role: 'Button' }],
  );
});

test('a disabled tap target replans to an enabled native control and records the successful action', async () => {
  const device = phone([control('first_route', 'Button')]);
  const blank = await frame('#202020');
  device.screenshot = async () => blank;
  const taps = [];
  device.perform = async (step, view, node) => {
    assert.equal(step.kind, 'tap');
    if (node.id === 'first_route') {
      view.controls = [{ ...node, enabled: false }, control('second_route', 'Button')];
      throw Error('ELEMENT_DISABLED');
    }
    taps.push(node.id);
    view.controls = [control('result', 'Text')];
  };
  const { result, records, events } = await run(
    device,
    (obs) => {
      const current = obs.controls.find((n) => n.enabled);
      if (current.id === 'result') return ['finish', { evidence: current.ref, message: '已打开。' }];
      if (current.id === 'second_route') {
        assert.equal(obs.lastBlocker.outcome, 'ELEMENT_DISABLED');
        assert.equal(obs.controls.find((n) => n.id === 'first_route').enabled, false);
      }
      return ['tap', { target: current.ref }];
    },
    true,
  );
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(taps, ['second_route']);
  assert.deepEqual(events, ['ELEMENT_DISABLED', 'dispatched', 'observed']);
  assert.deepEqual(
    records.map((s) => [s.command.action, s.command.id]),
    [
      ['tap', 'second_route'],
      ['check', 'result'],
    ],
  );
});

test('an unreadable initial view returns a partial answer after bounded read attempts', async () => {
  const device = phone();
  let reads = 0;
  device.snapshot = async () => {
    reads++;
    throw Error('DISPLAY_ROTATION_UNAVAILABLE');
  };
  const { result, records } = await run(device, () => assert.fail('there was no view for the model'));
  assert.equal(reads, 3);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.reason, 'DISPLAY_ROTATION_UNAVAILABLE');
  assert.equal(result.replyRequested, true);
  assert.ok(result.answer.length);
  assert.equal(result.modelCalls, 0);
  assert.deepEqual(records, []);
});
