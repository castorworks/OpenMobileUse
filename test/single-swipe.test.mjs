import assert from 'node:assert/strict';
import test from 'node:test';
import { runConversation } from '../dist/conversation.js';
import { singleSwipeRequest } from '../dist/single-swipe.js';

const instruction = '只上滑一次。读出上滑前后的作者或作品标题，确认是否换片。如果还是同一条就报告并停止。';
function control(id, label, y, role = 'android.widget.TextView') {
  return { id, labels: [label], role, enabled: true, secret: false, editable: false, focused: false,
    bounds: { x: 0, y, width: 160, height: 20 } };
}
const card = (title, author, time = '00:01') => ({
  app: 'example.feed', window: 'video', width: 200, height: 400, rotation: 0,
  controls: [
    ...(title ? [control('caption', title, 24)] : []), ...(author ? [control('author', author, 54)] : []),
    control('seek', time, 375, 'android.widget.SeekBar'), control('more', '详情', 75, 'android.widget.Button'),
  ],
});
const first = card('作品甲', '@作者甲'), next = card('作品乙', '@作者乙');

async function run({ replies, after = [next], before = first, request = instruction, lost = false, stale = false }) {
  let sends = 0, reads = 0, polls = 0, decisions = 0;
  const records = [], events = [], actions = [];
  const device = {
    async snapshot() {
      if (sends) {
        const observed = after[Math.min(polls++, after.length - 1)];
        if (observed instanceof Error) throw observed;
        return structuredClone(observed);
      }
      if (stale && ++reads === 2) return { ...before, window: 'transition' };
      return structuredClone(before);
    },
    async perform(step) {
      actions.push(step.kind);
      if (step.kind === 'swipe') {
        sends++;
        if (lost) throw Error('ACTION_OUTCOME_UNKNOWN: driver timeout');
      }
    },
  };
  const decide = async (messages, _tools, _deadline, count) => {
    count();
    const obs = JSON.parse(messages.findLast(m => m.role === 'user' && typeof m.content === 'string').content);
    const name = replies[decisions++] ?? 'finish';
    if (name === 'text') return { role: 'assistant', content: '已换到作品乙。', tool_calls: [] };
    if (name === 'timeout') throw Error('MODEL_TIMEOUT');
    const tool = name === 'down' ? 'swipe' : name;
    const args = name === 'swipe' ? { direction: 'up' } : name === 'tap'
      ? { target: obs.controls.find(c => c.id === 'more').ref }
      : name === 'down' ? { direction: 'down' }
        : { evidence: obs.controls.find(c => c.id === 'caption')?.ref ?? 'foreground', message: '已核对。' };
    return { role: 'assistant', content: null, tool_calls: [{ id: obs.observationId, type: 'function',
      function: { name: tool, arguments: JSON.stringify({ observationId: obs.observationId, ...args }) } }] };
  };
  const result = await runConversation(device, 'android:fixture', 'android', [{ user: request }], decide,
    new AbortController().signal, async step => { records.push(step); },
    (name, outcome) => { events.push([name, outcome]); }, () => true);
  return { result, records, events, sends, decisions, actions };
}

for (const ending of ['text', 'finish']) {
  test('the phone settles the single swipe without depending on a queued ' + ending + ' reply', async () => {
    const r = await run({ replies: ['swipe', ending] });
    assert.equal(r.result.status, 'succeeded');
    for (const fact of ['作品甲', '作品乙', '@作者甲', '@作者乙']) assert.ok(r.result.answer.includes(fact));
    assert.equal(r.sends, 1);
    assert.equal(r.decisions, 1);
    assert.deepEqual(r.records.map(s => s.action).filter(a => a === 'swipe'), ['swipe']);
    assert.ok(r.records.some(s => s.action === 'check' && s.reading?.label === '作品乙'));
  });
}
test('a second request after the timer ticks cannot send another swipe; unchanged is a valid report', async () => {
  const r = await run({ replies: ['swipe', 'swipe'], after: [card('作品甲', '@作者甲', '00:02')] });
  assert.equal(r.sends, 1);
  assert.equal(r.decisions, 1);
  assert.equal(r.result.status, 'succeeded');
  assert.match(r.result.answer, /相同/);
  const repeated = await run({ request: '只上滑一次，核对作品标题，再点详情。',
    replies: ['swipe','swipe','tap','finish'], after: [card('作品甲', '@作者甲', '00:02')] });
  assert.ok(repeated.events.some(([, outcome]) => outcome === 'SWIPE_LIMIT_REACHED'));
  assert.deepEqual(repeated.actions, ['swipe','tap']);
});
test('changing the timer alone or losing a previously visible author cannot prove a switch', async () => {
  for (const view of [card(undefined, undefined, '00:02'), card('作品甲', undefined),
    { ...next, window: 'other' }, new Error('DEVICE_UNAVAILABLE')]) {
    const r = await run({ replies: ['swipe','finish'], after: [view] });
    assert.equal(r.result.status, 'needs_review');
    assert.match(r.result.answer, /待核对|未能核对/);
    assert.equal(r.sends, 1);
    assert.deepEqual(r.records.map(s => s.action), ['swipe']);
  }
});
test('transitional or ambiguous captions must settle before reporting the new work', async () => {
  const r = await run({ replies: ['swipe', 'text'], after: [first, card(undefined, undefined), next, next] });
  assert.equal(r.result.status, 'succeeded');
  assert.match(r.result.answer, /作品乙/);
  assert.equal(r.sends, 1);
});
test('an uncertain dispatch stops for review and a stale pre-dispatch observation can retry', async () => {
  const lost = await run({ replies: ['swipe','swipe'], lost: true });
  assert.equal(lost.sends, 1);
  assert.equal(lost.result.status, 'needs_review');
  assert.equal(lost.result.reason, 'ACTION_OUTCOME_UNKNOWN');
  assert.match(lost.result.answer, /当前读到.*作品乙/);
  assert.deepEqual(lost.records, []);
  const retry = await run({ replies: ['swipe','swipe','text'], stale: true });
  assert.equal(retry.sends, 1);
  assert.equal(retry.result.status, 'succeeded');
});
test('a skipped swipe cannot succeed, and a swipe cannot complete other requested work', async () => {
  const skipped = await run({ replies: ['finish'] });
  assert.equal(skipped.sends, 0);
  assert.equal(skipped.result.status, 'needs_review');
  const request = '只上滑一次，核对作品标题，然后点详情。';
  const unfinished = await run({ request, replies: ['swipe','text'] });
  assert.equal(unfinished.result.status, 'needs_review');
  const completed = await run({ request, replies: ['swipe','swipe','tap','finish'] });
  assert.equal(completed.result.status, 'succeeded');
  assert.deepEqual(completed.actions, ['swipe', 'tap']);
});

test('only the actual single-swipe instruction allocates the limit', () => {
  for (const text of ['连续浏览三条作品', '不要只上滑一次，接着浏览', '每条视频都上滑一次',
    '搜索「只上滑一次」', '为什么只上滑一次？', '上滑一次，然后再上滑一次', '上滑一次，再上滑两次']) {
    assert.equal(singleSwipeRequest(text), undefined, text);
  }
  for (const text of [instruction, '向上滑动 1 次，告诉我是否换片。',
    '「只上滑一次，告诉我有没有换片」',
    '只做一次向上滑动，核对作者和标题。',
    '在抖音只上滑一次，看看是不是换到下一个视频了；如果还是同一条就报告并停下来。',
    '请只向上滑动一次，并根据作者或标题判断是否切换到了下一条内容，若仍然是同一条请停止。',
    'Swipe up once and report whether the video changed.']) {
    assert.equal(singleSwipeRequest(text)?.reportOnly, true, text);
  }
  assert.equal(singleSwipeRequest('只上滑一次，然后打开评论')?.reportOnly, false);
});

test('identity is compared across like fields, and an explicit required switch must be observed', async () => {
  for (const [before, target] of [
    [first, card('作品乙', '@作者甲')], [first, card('作品甲', '@作者乙')],
    [card(undefined, '@作者甲'), card(undefined, '@作者乙')],
  ]) {
    const r = await run({ before, after: [target], replies: ['swipe','text'] });
    assert.equal(r.result.status, 'succeeded');
    assert.match(r.result.answer, /已换片/);
    assert.equal(r.sends, 1);
  }
  const same = await run({ request: '只上滑一次，必须换到下一条视频。', after: [first], replies: ['swipe','finish'] });
  assert.equal(same.result.status, 'needs_review');
  assert.equal(same.result.reason, 'SWIPE_ITEM_UNCHANGED');
});

test('missing evidence before dispatch leaves the gesture unsent', async () => {
  const r = await run({ before: card(undefined, undefined), replies: ['swipe','text'] });
  assert.equal(r.sends, 0);
  assert.equal(r.result.status, 'needs_review');
  assert.equal(r.result.reason, 'SWIPE_BASELINE_UNAVAILABLE');
  const justSwipe = await run({ request: '只上滑一次', before: card(undefined, undefined), replies: ['swipe','text'] });
  assert.equal(justSwipe.result.status, 'succeeded');
  assert.equal(justSwipe.sends, 1);
  assert.doesNotMatch(justSwipe.result.answer, /已换片/);
});

test('a wrong direction does not spend the swipe and a terminal result needs no more model calls', async () => {
  const r = await run({ replies: ['down','swipe','timeout'] });
  assert.equal(r.sends, 1);
  assert.equal(r.decisions, 2);
  assert.equal(r.result.status, 'succeeded');
  assert.match(r.result.answer, /作品乙/);
});

test('the limit survives a later tap, while ordinary multi-item browsing can keep swiping', async () => {
  const compound = await run({ request: '只上滑一次，再点详情。', replies: ['swipe','tap','swipe','finish'] });
  assert.deepEqual(compound.actions, ['swipe','tap']);
  assert.equal(compound.result.status, 'succeeded');
  const browsing = await run({ request: '连续浏览作品并汇总', replies: ['swipe','swipe','finish'] });
  assert.equal(browsing.sends, 2);
});
