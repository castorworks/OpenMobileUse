import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { runConversation } from '../dist/conversation.js';
import { compileRecording, replayRecording } from '../dist/recording.js';
import { captureView } from '../dist/inspect.js';
import { Harmony } from '../dist/harmony.js';

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

async function run(device, choose, useImages = false, preview) {
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
    preview,
  );
  return { result, records, events };
}

// Skip the 10 s foreground poll while exercising the actual launch timeout branch.
function expireLaunchPoll(t) {
  let time = 0;
  t.mock.method(performance, 'now', () => (time += 10001));
}

test('a delayed settings launch is recorded once after its resolved app is observed', async (t) => {
  expireLaunchPoll(t);
  const device = phone([control('heading', 'Text')]);
  const targetApp = 'vendor.oem.settings';
  const launches = [];
  device.launch = async (step, guard) => {
    assert.equal(step.app, 'settings');
    guard(targetApp);
    launches.push(step.app);
    device.view.app = targetApp;
    return targetApp;
  };
  device.foregroundApp = async () => 'vendor.transition';
  const { result, records, events } = await run(device, (obs) =>
    obs.app === targetApp
      ? ['finish', { evidence: 'foreground', message: '设置已打开。' }]
      : ['launch_app', { app: 'settings' }],
  );
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(launches, ['settings']);
  assert.deepEqual(events, ['APP_NOT_FOREGROUND', 'observed', 'observed']);
  assert.deepEqual(records.map((s) => [s.inApp, s.command.action]), [
    ['example.feed', 'launchApp'], [targetApp, 'check'],
  ]);
});

for (const firstRequest of ['settings', 'vendor.oem.settings']) {
  test('an unconfirmed launch via ' + firstRequest + ' can continue through the visible chooser', async (t) => {
    expireLaunchPoll(t);
    const targetApp = 'vendor.oem.settings';
    const device = phone([control('open', 'Button')]);
    let launches = 0;
    device.launch = async (step, guard) => {
      guard(targetApp);
      launches++;
      device.view.app = 'vendor.chooser';
      return targetApp;
    };
    device.foregroundApp = async () => device.view.app;
    device.perform = async (step, view, node) => {
      assert.equal(step.kind, 'tap');
      assert.equal(node.id, 'open');
      view.app = targetApp;
    };
    const { result, records, events } = await run(device, (obs) => {
      if (obs.app === targetApp) return ['finish', { evidence: 'foreground', message: '设置已打开。' }];
      if (!obs.lastBlocker) return ['launch_app', { app: firstRequest }];
      if (obs.lastBlocker.outcome === 'APP_NOT_FOREGROUND')
        return ['launch_app', { app: firstRequest === 'settings' ? targetApp : 'settings' }];
      assert.equal(obs.lastBlocker.outcome, 'APP_LAUNCH_ALREADY_ATTEMPTED');
      return ['tap', { target: obs.controls[0].ref }];
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(launches, 1);
    assert.deepEqual(events, ['APP_NOT_FOREGROUND', 'APP_LAUNCH_ALREADY_ATTEMPTED', 'dispatched', 'observed']);
    assert.deepEqual(records.map((s) => [s.inApp, s.command.action]), [
      ['vendor.chooser', 'tap'], [targetApp, 'check'],
    ]);
  });
}

test('ordinary foreground launches and later intentional returns still dispatch', async (t) => {
  expireLaunchPoll(t);
  const targetApp = 'example.feed';
  const device = phone([control('leave', 'Button')]);
  let launches = 0;
  device.launch = async (step, guard) => {
    guard(targetApp);
    launches++;
    device.view.app = targetApp;
    return targetApp;
  };
  device.foregroundApp = async () => 'example.transition';
  device.perform = async () => { device.view.app = 'example.launcher'; };
  let turn = 0;
  const { result, events, records } = await run(device, (obs) => {
    turn++;
    if (turn === 1 || turn === 2 || turn === 4) return ['launch_app', { app: targetApp }];
    if (turn === 3) return ['tap', { target: obs.controls[0].ref }];
    return ['finish', { evidence: 'foreground', message: '已返回应用。' }];
  });
  assert.equal(result.status, 'succeeded');
  assert.ok(events.includes('APP_LAUNCH_ALREADY_ATTEMPTED'));
  assert.equal(launches, 2);
  assert.deepEqual(records.map((s) => s.command.action), ['launchApp', 'tap', 'launchApp', 'check']);
});

test('malformed Harmony launch metadata allows another route without dispatching a launch', async () => {
  const device = phone([control('shortcut', 'Button')]);
  const targetApp = 'example.browser';
  const harmony = new Harmony('test', () => assert.fail('Unexpected launch dispatch'));
  harmony.shell = async () => '{"name":"example.browser","hapModuleInfos":[';
  device.launch = (step, guard) => harmony.launch(step, guard);
  device.perform = async (step, view, node) => {
    assert.equal(node.id, 'shortcut');
    view.app = targetApp;
  };
  const { result, records } = await run(device, (obs) => {
    if (obs.app === targetApp) return ['finish', { evidence: 'foreground', message: '浏览器已打开。' }];
    if (!obs.lastBlocker) return ['launch_app', { app: targetApp }];
    assert.equal(obs.lastBlocker.outcome, 'BUNDLE_INFO_UNAVAILABLE');
    return ['tap', { target: obs.controls[0].ref }];
  });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(records.map((s) => s.command.action), ['tap', 'check']);
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

for (const screenChanges of [false, true]) {
  test('repeated visual misses replan from the current screen, changed=' + screenChanges, async () => {
    const device = phone();
    const initial = await frame('#eeeeee');
    const changed = await frame('#222222');
    let attempted = 0;
    device.screenshot = async () => screenChanges && attempted === 2 ? changed : initial;
    device.perform = async step => {
      assert.equal(step.kind, 'swipe');
      device.view.controls = [control('channels', 'Text')];
    };
    const { result, records, events } = await run(device, (obs, tools) => {
      if (obs.controls.length) return ['finish', { evidence: obs.controls[0].ref, message: '已找到视频号。' }];
      if (attempted < 2) {
        attempted++;
        return ['tap_visual', { x: 0.88, y: 0.47, label: '视频号的更多' }];
      }
      assert.equal(tools.includes('tap_visual'), screenChanges);
      assert.ok(!tools.includes('report_partial'));
      return ['swipe', { direction: 'up' }];
    }, true);
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(events, ['VISUAL_TARGET_UNCLEAR', 'VISUAL_TARGET_UNCLEAR', 'dispatched', 'observed']);
    assert.deepEqual(records.map(s => s.command.action), ['swipe', 'check']);
  });
}

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
  assert.equal(result.replyRequested, false);
  assert.match(result.answer, /只读到第一条/);
  assert.match(result.answer, /上滑动/);
});

test('the final decision can report saved findings without asking the user to continue', async () => {
  const device = phone();
  const blank = await frame('#202020');
  device.screenshot = async () => blank;
  device.perform = async () => {};
  const { result, records } = await run(device, (obs, tools) => {
    if (tools.includes('report_partial'))
      return ['report_partial', { message: '页面没有显示更多结果。' }];
    return ['swipe', { direction: 'up', note: '已读到第一条。' }];
  }, true);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.reason, 'NO_PROGRESS');
  assert.equal(result.replyRequested, false);
  assert.match(result.answer, /已读到第一条。/);
  assert.match(result.answer, /页面没有显示更多结果。/);
  assert.deepEqual(records.map(s => s.command.action), ['swipe']);
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

const query = 'deepseek';
function field(id, value = '', labels = []) {
  return { ...control(id, 'TextInput'), editable: true, focused: true, labels, value };
}
function typeQuery(control) {
  return ['input_text', { target: control.ref, text: query }];
}

for (const confirmed of [true, false]) {
  test(
    confirmed
      ? 'a fresh field reading confirms the original input before tapping the result'
      : 'a same-text suggestion lets the task continue without recording an unverified input',
    async () => {
      const device = phone([field('query', 'previous')]);
      const performed = [];
      device.snapshot = async () => structuredClone(device.view);
      device.perform = async (step, current, node) => {
        performed.push([step.kind, node.id]);
        if (step.kind === 'input') {
          device.view.controls = [
            field('query', confirmed ? query : ''),
            { ...control('suggestion', 'Text'), labels: [query] },
          ];
          throw Error('INPUT_NOT_VERIFIED');
        }
        device.view.controls = [control('detail', 'Text')];
      };
      const { result, records, events } = await run(device, (obs) => {
        const detail = obs.controls.find((c) => c.id === 'detail');
        if (detail) return ['finish', { evidence: detail.ref, message: '已打开结果。' }];
        const suggestion = obs.controls.find((c) => c.id === 'suggestion');
        if (suggestion) return ['tap', { target: suggestion.ref }];
        return typeQuery(obs.controls[0]);
      });
      assert.equal(result.status, 'succeeded');
      assert.deepEqual(performed, [['input', 'query'], ['tap', 'suggestion']]);
      assert.deepEqual(
        records.map((s) => s.command.action),
        confirmed ? ['input', 'tap', 'check'] : ['tap', 'check'],
      );
      if (confirmed) {
        assert.equal(records[0].command.id, 'query');
        assert.equal(records[0].command.text, query);
        assert.equal(records[0].reading.value, 'previous');
      } else assert.ok(events.includes('INPUT_NOT_VERIFIED'));
    },
  );
}

test('late input verification compares the full field value beyond the model preview', async () => {
  const prefix = 'a'.repeat(160);
  const device = phone([field('query')]);
  let writes = 0;
  device.perform = async () => {
    writes++;
    device.view.controls = [field('query', prefix + 'B'), control('result', 'Text')];
    throw Error('INPUT_NOT_VERIFIED');
  };
  const { result, records, events } = await run(device, (obs) => {
    const target = obs.controls.find((c) => c.id === 'query');
    if (target.value === '')
      return ['input_text', { target: target.ref, text: prefix + 'A' }];
    assert.equal(target.value, prefix);
    return ['ask_user', { message: '还需核实最后一个字符。' }];
  });
  assert.equal(result.replyRequested, true);
  assert.equal(writes, 1);
  assert.ok(events.includes('INPUT_NOT_VERIFIED'));
  assert.deepEqual(records, []);
});

test('an unresolved edit survives navigation and changed refs while another app remains editable', async () => {
  const device = phone([field('', '', ['搜索']), control('leave', 'Button')]);
  device.snapshot = async () => structuredClone(device.view);
  const writes = [];
  const originalApp = device.view.app;
  device.perform = async (step, current, node) => {
    if (step.kind === 'input') {
      writes.push(current.app);
      if (current.app === originalApp) throw Error('INPUT_NOT_VERIFIED');
      device.view.controls = [{ ...node, value: step.text }, control('return', 'Button')];
    } else if (node.id === 'leave') {
      device.view.app = 'example.notes';
      device.view.controls = [field('note')];
    } else {
      assert.equal(node.id, 'return');
      device.view.app = originalApp;
      device.view.controls = [control('heading', 'Button'), field('', '', ['输入关键字'])];
    }
  };
  let firstRef;
  let decisions = 0;
  const { result, records, events } = await run(device, (obs) => {
    const target = obs.controls.find((c) => c.editable);
    switch (++decisions) {
      case 1:
        firstRef = target.ref;
        return typeQuery(target);
      case 2:
        return ['tap', { target: obs.controls.find((c) => c.id === 'leave').ref }];
      case 3:
        return typeQuery(target);
      case 4:
        return ['tap', { target: obs.controls.find((c) => c.id === 'return').ref }];
      case 5:
        assert.notEqual(target.ref, firstRef);
        return typeQuery(target);
      case 6:
        return ['ask_user', { message: '已返回搜索页，请核对搜索框。' }];
      default:
        assert.fail('Expected the model to finish after the suppressed repeat');
    }
  });
  assert.equal(result.replyRequested, true);
  assert.deepEqual(writes, [originalApp, 'example.notes']);
  assert.ok(events.includes('INPUT_ALREADY_ATTEMPTED'));
  assert.deepEqual(records.filter((s) => s.command.action === 'input').map((s) => s.command.id), ['note']);
});

test('a distinct named field in the same app remains editable after an unverified write', async () => {
  const device = phone([field('first'), field('second')]);
  const writes = [];
  device.perform = async (step, current, node) => {
    writes.push(node.id);
    if (node.id === 'first') throw Error('INPUT_NOT_VERIFIED');
    device.view.controls = [{ ...node, value: step.text }];
  };
  const { result, records } = await run(device, (obs) => {
    const target = obs.controls.find((c) => c.id === (writes.length ? 'second' : 'first'));
    return target.value === query
      ? ['finish', { evidence: target.ref, message: '第二个字段已填写。' }]
      : typeQuery(target);
  });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(writes, ['first', 'second']);
  assert.deepEqual(records.filter((s) => s.command.action === 'input').map((s) => s.command.id), ['second']);
});

test('a model repeating an unverified edit gets bounded attempts with only one device write', async () => {
  const device = phone([field('query')]);
  let writes = 0;
  device.perform = async () => {
    writes++;
    throw Error('INPUT_NOT_VERIFIED');
  };
  const { result, records, events } = await run(device, (obs) => typeQuery(obs.controls[0]));
  assert.equal(result.status, 'needs_review');
  assert.ok(result.modelCalls > 1 && result.modelCalls < 10);
  assert.equal(writes, 1);
  assert.ok(events.includes('INPUT_ALREADY_ATTEMPTED'));
  assert.deepEqual(records, []);
});

test('input already containing the requested value is observed without rewriting it', async () => {
  const device = phone([field('query', query)]);
  let decisions = 0;
  const { result, records, events } = await run(device, (obs) =>
    ++decisions === 1
      ? typeQuery(obs.controls[0])
      : ['finish', { evidence: obs.controls[0].ref, message: '已核对搜索词。' }],
  );
  assert.equal(result.status, 'succeeded');
  assert.equal(events[0], 'observed');
  assert.ok(records.every((s) => s.command.action === 'check' && s.reading.value === query));
});

test('an input with an unknown dispatch outcome stops before a second decision', async () => {
  const device = phone([field('query')]);
  device.perform = async () => { throw Error('ACTION_OUTCOME_UNKNOWN: TEXT_DRIVER_ERROR'); };
  const { result, records } = await run(device, (obs) => typeQuery(obs.controls[0]));
  assert.equal(result.reason, 'ACTION_OUTCOME_UNKNOWN');
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

test('a stale screenshot at the stall limit is discarded and a fresh observation can still act', async () => {
  const device = phone([control('open', 'Button')]);
  const stable = await frame('#eeeeee');
  const stale = await frame('#222222');
  let attempts = 0, capturesAtLimit = 0, transientWindow = false;
  device.snapshot = async () => {
    if (!transientWindow) return device.view;
    transientWindow = false;
    return { ...device.view, window: 'transition' };
  };
  device.screenshot = async () => {
    if (attempts === 5 && ++capturesAtLimit === 1) {
      transientWindow = true;
      return stale;
    }
    return stable;
  };
  device.perform = async (_step, view) => {
    if (++attempts <= 5) throw Error('ELEMENT_DISABLED');
    view.controls = [control('result', 'Text')];
  };
  const published = [];
  const { result, records, events } = await run(device, (obs, tools) => {
    const current = obs.controls[0];
    if (current.id === 'result') return ['finish', { evidence: current.ref, message: '已打开结果。' }];
    assert.ok(tools.includes('tap'));
    if (attempts === 5) assert.equal(capturesAtLimit, 2);
    return ['tap', { target: current.ref }];
  }, true, image => { if (image) published.push(image); });
  assert.equal(result.status, 'succeeded');
  assert.ok(!published.some(image => image.equals(stale)));
  assert.equal(events.filter(e => e === 'STALE_OBSERVATION').length, 1);
  assert.deepEqual(records.map(s => s.command.action), ['tap', 'check']);
});

test('persistent stale screenshots fall back to current native controls with bounded read attempts', async () => {
  const device = phone([control('route', 'Button')]);
  const picture = await frame('#222222');
  let captures = 0, stale = false;
  device.snapshot = async () => {
    if (!stale) return device.view;
    stale = false;
    return { ...device.view, window: 'other' };
  };
  device.screenshot = async () => { captures++; stale = true; return picture; };
  const { result, records } = await run(device, (obs, tools) => {
    if (!obs.textStatus) return ['inspect_screen', {}];
    assert.equal(obs.textStatus, 'STALE_OBSERVATION');
    assert.ok(!tools.includes('tap_visual'));
    return ['finish', { evidence: obs.controls[0].ref, message: '已看到原生入口。' }];
  }, true);
  assert.equal(captures, 2);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(records.map(s => s.command.action), ['check']);
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

for (const opens of [true, false]) {
  test('a newly appeared route gets one chance at the stall limit, opens=' + opens, async () => {
    const device = phone([{ ...control('entry', 'Button'), labels: ['加载中'] }]);
    const blank = await frame('#202020');
    device.screenshot = async () => blank;
    let attempts = 0;
    device.perform = async (step, view, node) => {
      attempts++;
      if (attempts === 5) view.controls = [{ ...node, labels: ['视频号'] }];
      if (attempts === 6) {
        assert.deepEqual(node.labels, ['视频号']);
        view.controls = [control(opens ? 'result' : 'another', 'Text')];
        if (opens) return;
      }
      throw Error('ELEMENT_DISABLED');
    };
    const { result, records } = await run(device, (obs, tools) => {
      const [current] = obs.controls;
      if (current.id === 'result') return ['finish', { evidence: current.ref, message: '已打开视频号。' }];
      if (current.id === 'another') {
        assert.ok(!tools.includes('tap'));
        return ['ask_user', { message: '入口仍无法打开。' }];
      }
      assert.ok(tools.includes('tap'));
      return ['tap', { target: current.ref }];
    }, true);
    assert.equal(attempts, 6);
    assert.equal(result.status, opens ? 'succeeded' : 'needs_review');
    assert.deepEqual(records.map((s) => s.command.action), opens ? ['tap', 'check'] : []);
  });
}

test('a slow window transition after a tap waits for a new view without replaying the tap', async () => {
  const device = phone([control('open', 'Button')]);
  let remainingFailures = 0;
  let taps = 0;
  device.perform = async (step) => {
    assert.equal(step.kind, 'tap');
    taps++;
    device.view.controls = [control('result', 'Text')];
    remainingFailures = 3;
  };
  device.snapshot = async () => {
    if (remainingFailures > 0) {
      remainingFailures--;
      throw Error('FOREGROUND_WINDOW_AMBIGUOUS');
    }
    return device.view;
  };
  const { result, records } = await run(device, (obs) => {
    const [item] = obs.controls;
    if (item.id === 'open') return ['tap', { target: item.ref }];
    assert.equal(item.id, 'result');
    return ['finish', { evidence: item.ref, message: '结果页已打开。' }];
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(taps, 1);
  assert.equal(result.modelCalls, 2);
  assert.deepEqual(records.map((r) => r.command.action), ['tap', 'check']);
});

test('an unreadable initial view returns a partial answer after bounded read attempts', async () => {
  const device = phone();
  let reads = 0;
  device.snapshot = async () => {
    reads++;
    throw Error('DISPLAY_ROTATION_UNAVAILABLE');
  };
  const { result, records } = await run(device, () => assert.fail('there was no view for the model'));
  assert.equal(reads, 6);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.reason, 'DISPLAY_ROTATION_UNAVAILABLE');
  assert.equal(result.replyRequested, true);
  assert.ok(result.answer.length);
  assert.equal(result.modelCalls, 0);
  assert.deepEqual(records, []);
});

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

test('a write to a different editable field cannot settle a rejected input to an existing field', async () => {
  const device = phone([field('first'), field('second')]);
  let decisions = 0;
  device.perform = async (step, _view, node) => {
    assert.equal(step.kind, 'input');
    if (node.id === 'first') throw Error('INPUT_TARGET_CHANGED');
    node.value = step.text;
  };
  const { result, records } = await run(device, (obs) => {
    if (++decisions <= 2) return typeQuery(obs.controls.find(c => c.id === (decisions === 1 ? 'first' : 'second')));
    return ['finish', { evidence: obs.controls.find(c => c.id === 'second').ref, message: '已完成输入。' }];
  });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.reason, 'INPUT_TARGET_CHANGED');
  assert.deepEqual(records.map(r => r.command.id), ['second']);
});

test('a previously visible native control cannot verify a visual tap rejected before dispatch', async () => {
  const device = phone([control('unchanged', 'Button')]);
  const blank = await frame('#202020');
  let reads = 0;
  device.screenshot = async () => ++reads === 1 ? blank : blank.subarray(0, 33);
  const { result, records } = await run(device, (obs, tools) => {
    if (obs.textStatus === 'INVALID_PNG')
      return ['finish', { evidence: obs.controls[0].ref, message: '已看到控件。' }];
    if (tools.includes('tap_visual')) return ['tap_visual', { x: 0.5, y: 0.5, label: '打开结果' }];
    return ['inspect_screen', {}];
  }, true);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.reason, 'VISUAL_TARGET_UNCLEAR');
  assert.deepEqual(records, []);
});
