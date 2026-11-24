import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { runConversation } from '../dist/conversation.js';
import { compileRecording, replayRecording } from '../dist/recording.js';
import { captureView } from '../dist/inspect.js';

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

test('Android Home is verified and replays with a different starting app and default launcher', async () => {
  const device = phone([control('player')]);
  let launcher = 'example.launcher';
  let presses = 0;
  device.goHome = async () => {
    presses++;
    device.view.app = launcher;
    return launcher;
  };
  device.foregroundApp = async () => device.view.app;
  const { result, records } = await run(device, (obs, tools) => {
    if (obs.app === launcher) return ['finish', { evidence: 'foreground', message: '已回到主屏幕。' }];
    assert.ok(tools.includes('home'));
    return ['home', {}];
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(presses, 1);
  assert.deepEqual(records.map((step) => step.command), [{ action: 'goHome' }]);

  const steps = await compileRecording({ schemaVersion: 2, platform: 'android', steps: records }, 'android');
  device.view.app = 'example.other';
  launcher = 'example.customhome';
  const replay = await replayRecording(device, 'android:test', steps, new AbortController().signal, () => {});
  assert.equal(replay.status, 'succeeded');
  assert.equal(device.view.app, launcher);
  assert.equal(presses, 2);
});

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

test('a blocked swipe cannot be completed by checking the page or the screenshot', async () => {
  for (const finish of ['finish', 'finish_visual']) {
    const device = phone([control('caption', 'Text')]);
    device.snapshot = async () => structuredClone(device.view);
    const picture = await frame('#202020');
    device.screenshot = async () => picture;
    let decisions = 0;
    const { result, records } = await run(device, (obs) => {
      if (++decisions === 1) {
        device.view.window = 'changed';
        return ['swipe', { direction: 'down' }];
      }
      if (decisions === 2) return ['wait', {}];
      return finish === 'finish'
        ? [finish, { message: '已查看当前页。', evidence: obs.controls[0].ref }]
        : [finish, { message: '已查看当前页。', x: 0.5, y: 0.5 }];
    }, true);
    assert.equal(result.status, 'needs_review');
    assert.equal(result.reason, 'STALE_OBSERVATION');
    assert.match(result.answer, /向下滑动/);
    assert.deepEqual(records.map(s => s.command.action), ['pause']);
    assert.equal(decisions, 3);
  }
});

test('a read-only result can finish using a control without dispatching a gesture', async () => {
  const { result, records } = await run(phone([control('caption', 'Text')]), obs =>
    ['finish', { message: '已看到标题。', evidence: obs.controls[0].ref }]);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(records.map(s => s.command.action), ['check']);
});

test('a helper tap does not complete a rejected swipe; a dispatched retry does', async () => {
  for (const retry of [false, true]) {
    const device = phone([control('open', 'Button')]);
    device.snapshot = async () => structuredClone(device.view);
    const sent = [];
    device.perform = async (step) => { sent.push(step.kind); };
    let decisions = 0;
    const { result } = await run(device, (obs) => {
      decisions++;
      if (decisions === 1) {
        device.view.window = 'new';
        return ['swipe', { direction: 'down' }];
      }
      if (decisions === 2) return ['tap', { target: obs.controls[0].ref }];
      if (decisions === 3 && retry) return ['swipe', { direction: 'down' }];
      return ['finish', { message: '已核对。', evidence: obs.controls[0].ref }];
    });
    assert.deepEqual(sent, retry ? ['tap', 'swipe'] : ['tap']);
    assert.equal(result.status, retry ? 'succeeded' : 'needs_review');
  }
});

test('after a swipe, a newly observed native caption can verify the result without another screenshot', async () => {
  const caption = { ...control('caption', 'Text'), labels: ['第一条'] };
  const device = phone([caption]);
  const picture = await frame('#202020');
  let screenshots = 0, decisions = 0;
  device.screenshot = async () => { screenshots++; return picture; };
  device.perform = async (step) => {
    assert.equal(step.kind, 'swipe');
    device.view.controls = [{ ...caption, labels: ['第二条'] }];
  };
  const { result, records } = await run(device, (obs, tools) => {
    if (++decisions === 1) return ['inspect_screen', {}];
    if (decisions === 2) return ['swipe', { direction: 'up' }];
    assert.ok(tools.includes('inspect_screen'));
    assert.ok(!tools.includes('finish_visual'));
    const title = obs.controls.find(n => n.label === '第二条');
    return ['finish', { message: '已到第二条。', evidence: title.ref }];
  }, true);
  assert.equal(result.status, 'succeeded');
  assert.equal(screenshots, 1);
  assert.deepEqual(records.map(s => s.command.action), ['swipe', 'check']);
  assert.equal(records.at(-1).reading.label, '第二条');
});

test('layout jitter alone does not authorize a second identical swipe on an unchanged item', async () => {
  const device = phone([{ ...control('caption', 'Text'), labels: ['同一条'] }]);
  device.snapshot = async () => structuredClone(device.view);
  let moves = 0;
  device.perform = async () => { moves++; device.view.controls[0].bounds.y++; };
  const { result } = await run(device, () => ['swipe', { direction: 'up' }]);
  assert.equal(moves, 1);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.reason, 'NO_PROGRESS');
});

test('real scrolling still permits another swipe when the visible labels are unchanged', async () => {
  const device = phone([{ ...control('caption', 'Text'), labels: ['同一段长文'] }]);
  device.snapshot = async () => structuredClone(device.view);
  let moves = 0;
  device.perform = async () => { moves++; device.view.controls[0].bounds.y += 40; };
  const { result } = await run(device, obs =>
    moves === 2 || obs.lastBlocker
      ? ['finish', { message: '已读。', evidence: obs.controls[0].ref }]
      : ['swipe', { direction: 'down' }]);
  assert.equal(result.status, 'succeeded');
  assert.equal(moves, 2);
});

test('a new native caption still permits a requested visual inspection', async () => {
  const caption = { ...control('caption', 'Text'), labels: ['第一条'] };
  const device = phone([caption]);
  const picture = await frame('#202020');
  device.screenshot = async () => picture;
  device.perform = async () => { device.view.controls = [{ ...caption, labels: ['第二条'] }]; };
  let decisions = 0;
  const { result } = await run(device, (obs, tools) => {
    if (++decisions === 1) return ['swipe', { direction: 'up' }];
    if (decisions === 2) {
      assert.ok(obs.newLabelRefs.includes(obs.controls[0].ref));
      return ['inspect_screen', {}];
    }
    assert.ok(tools.includes('finish_visual'));
    return ['finish', { message: '已核对。', evidence: obs.controls[0].ref }];
  }, true);
  assert.equal(result.status, 'succeeded');
  assert.equal(decisions, 3);
});

test('a verified preview rechecks the window after its screenshot and recaptures a changed window', async () => {
  const device = phone([control('caption', 'Text')]);
  device.view.screen = { page: 'other', marker: '' };
  const before = structuredClone(device.view);
  let snapshots = 0, images = 0;
  const picture = await frame('#202020');
  device.snapshot = async () => { snapshots++; return structuredClone(device.view); };
  device.screenshot = async () => { images++; return picture; };
  device.view.controls[0].labels = ['新标题'];
  const current = await captureView(device, 'android:test', before);
  assert.equal(snapshots, 1);
  assert.equal(images, 1);
  assert.equal(current.metadata.controlsChangedDuringCapture, true);
  device.view.window = 'new window';
  const moved = await captureView(device, 'android:test', before);
  assert.equal(snapshots, 4);
  assert.equal(images, 3);
  assert.equal(moved.before.window, 'new window');
});
