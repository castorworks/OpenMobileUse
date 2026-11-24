import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { runConversation } from '../dist/conversation.js';
import { xmlControls } from '../dist/native-layout.js';
import { compileRecording, replayRecording } from '../dist/recording.js';
import { asksToSubmitQuery, firstSearchResult, requestedSearch, searchForm } from '../dist/verified-search.js';

const app = 'example.search', id = 'android:search-test';
const request = '把搜索框里的「猫咪」改成「橘猫」再搜索，读出实际搜索词和第一条结果。';
function page(query, title, listId = 'search_results') {
  const node = (role, name, bounds, attrs = '', children = '') =>
    `<node class="android.${role}" package="${app}" resource-id="${app}:id/${name}" bounds="${bounds}" ${attrs}>${children}</node>`;
  const row = (text, x) => node('widget.FrameLayout', 'row', `[${x},80][${x + 98},230]`, '',
    node('widget.TextView', 'desc', `[${x},160][${x + 98},200]`, `text="${text}"`));
  const layout = '<hierarchy>' + node('widget.FrameLayout', 'root', '[0,0][200,400]', '',
    node('widget.EditText', 'query', '[10,10][140,50]', `text="${query}" focused="true"`) +
    node('widget.TextView', 'submit', '[150,10][200,50]', 'text="搜索" clickable="true"') +
    (title ? node('widget.ListView', listId, '[0,70][200,400]', '', row(title, 0) + row('右侧第二条', 100)) : '')) + '</hierarchy>';
  return { app, window: 'search', width: 200, height: 400, rotation: 0, layout, screen: { page: 'other' },
    controls: xmlControls('android', layout, app, 200, 400) };
}
function phone({ refuseInput = false, staleResults = false } = {}) {
  return { query: '猫咪', title: '旧词的第一条', actions: [], reads: 0,
    async snapshot() {
      if (this.actions.includes('tap') && ++this.reads > 1 && !staleResults) this.title = '左上角的橘猫打哈欠';
      return page(this.query, this.title);
    },
    async perform(step, view, control) {
      this.actions.push(step.kind);
      if (step.kind === 'input') { if (!refuseInput) this.query = step.text; }
      else { assert.equal(step.kind, 'tap'); assert.equal(control.id, app + ':id/submit'); }
    },
  };
}
async function conversation(device, choose, task = request, useImages = false) {
  const records = [];
  const decide = async (messages, tools, _deadline, count) => {
    count();
    const obs = JSON.parse(messages.findLast(m => m.role === 'user' && typeof m.content === 'string').content);
    const choice = choose(obs, tools.map(t => t.function.name));
    if (typeof choice === 'string') return { role: 'assistant', content: choice, tool_calls: [] };
    const [name, args] = choice;
    return { role: 'assistant', content: null, tool_calls: [{ id: obs.observationId, type: 'function',
      function: { name, arguments: JSON.stringify({ observationId: obs.observationId, ...args }) } }] };
  };
  const dialogue = typeof task === 'string' ? [{ user: task }] : task;
  const result = await runConversation(device, id, 'android', dialogue, decide, new AbortController().signal,
    async s => records.push(s), () => {}, () => true, undefined, useImages);
  return { result, records };
}
const finish = () => ['finish', { evidence: 'foreground', message: '已完成。' }];
const search = (_obs, tools) => tools.includes('verified_search') ? ['verified_search', { next: 'report' }] : finish();

test('only an explicitly requested submit binds a literal target, independently of the example words', () => {
  assert.deepEqual(requestedSearch(request), { query: '橘猫', firstResult: true });
  assert.deepEqual(requestedSearch('先在搜索框实际输入咖啡，再点搜索提交。'), { query: '咖啡', firstResult: false });
  assert.deepEqual(requestedSearch('Replace "tea" with "iced coffee" and click Search. Read the first result.'),
    { query: 'iced coffee', firstResult: true });
  assert.equal(requestedSearch('把搜索框改成「橘猫」，不要点搜索。'), undefined);
  assert.equal(requestedSearch('把搜索框改成「橘猫」，读出框里的词。'), undefined);
  assert.equal(requestedSearch('不要把搜索框里的「咖啡」改成「奶茶」再搜索。'), undefined);
  assert.equal(asksToSubmitQuery('填入「橘猫」后点击搜索。', '猫'), false);
  assert.equal(asksToSubmitQuery('填入「橘猫」，不要点击搜索。', '橘猫'), false);
  assert.equal(asksToSubmitQuery('不要填入「橘猫」再搜索。', '橘猫'), false);
});

test('equivalent replacement verbs require the same verified submission and respect a request not to submit', () => {
  for (const verb of ['改成', '改为', '换成', '换为', '替换成', '替换为']) {
    assert.deepEqual(requestedSearch(request.replace('改成', verb)), { query: '橘猫', firstResult: true });
    assert.equal(requestedSearch('把搜索词' + verb + '「橘猫」，不要点搜索。'), undefined);
  }
});

test('an unverified write to the search box cannot turn into a successful old-query search', async () => {
  const fallback = '搜索框原来是「猫咪」，请填入「橘猫」后点击搜索，读出第一条结果。';
  for (const [task, expectedActions] of [[request.replace('改成', '换为'), ['input', 'input']], [fallback, ['input']]]) {
    const d = phone();
    const perform = d.perform.bind(d);
    d.perform = async (step, view, control) => {
      if (step.kind === 'input') {
        d.actions.push('input');
        throw Error('INPUT_NOT_VERIFIED');
      }
      return perform(step, view, control);
    };
    const { result, records } = await conversation(d, (obs, tools) => {
      if (tools.includes('verified_search')) return ['verified_search', { next: 'report' }];
      if (!d.actions.length) return ['input_text', { target: obs.controls.find(c => c.editable).ref, text: '橘猫' }];
      if (!d.actions.includes('tap')) return ['tap', { target: obs.controls.find(c => c.id.endsWith('/submit')).ref }];
      return finish();
    }, task);
    assert.equal(result.status, 'needs_review');
    assert.equal(result.reason, 'SEARCH_NOT_SUBMITTED');
    assert.match(result.answer, /猫咪/);
    assert.deepEqual(d.actions, expectedActions);
    assert.deepEqual(records, []);
  }
});

test('a failed ordinary edit still allows choosing the requested suggestion and submitting its verified value', async () => {
  const d = phone();
  const read = d.snapshot.bind(d), perform = d.perform.bind(d);
  d.snapshot = async () => {
    const v = await read();
    v.controls.push({ ...v.controls.find(c => c.id.endsWith('/submit')), id: 'suggestion', labels: ['橘猫'],
      bounds: { x: 0, y: 60, width: 150, height: 20 } });
    return v;
  };
  d.perform = async (step, view, node) => {
    if (step.kind === 'input') { d.actions.push('input'); throw Error('INPUT_NOT_VERIFIED'); }
    if (node.id === 'suggestion') { d.actions.push('suggestion'); d.query = '橘猫'; return; }
    await perform(step, view, node);
  };
  const { result } = await conversation(d, obs => {
    if (!d.actions.length) return ['input_text', { target: obs.controls.find(c => c.editable).ref, text: '橘猫' }];
    if (!d.actions.includes('suggestion')) return ['tap', { target: obs.controls.find(c => c.id === 'suggestion').ref }];
    if (!d.actions.includes('tap')) return ['tap', { target: obs.controls.find(c => c.id.endsWith('/submit')).ref }];
    return finish();
  }, '请选择联想词「橘猫」后点击搜索。');
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(d.actions, ['input', 'suggestion', 'tap']);
});

test('a finish without the requested search cannot mark the old query successful', async () => {
  const d = phone();
  const { result } = await conversation(d, finish);
  assert.equal(result.status, 'needs_review');
  assert.match(result.answer, /猫咪/);
  assert.deepEqual(d.actions, []);
});

test('search verifies the replacement and reads the refreshed first card, including on replay', async () => {
  const d = phone();
  const { result, records } = await conversation(d, search);
  assert.equal(result.status, 'succeeded');
  assert.match(result.answer, /橘猫/);
  assert.match(result.answer, /左上角的橘猫打哈欠/);
  assert.deepEqual(d.actions, ['input', 'tap']);
  const steps = await compileRecording({ schemaVersion: 2, platform: 'android', steps: records }, 'android');
  const replay = phone();
  assert.equal((await replayRecording(replay, id, steps, new AbortController().signal, () => {})).status, 'succeeded');
  assert.deepEqual(replay.actions, ['input', 'tap']);
});

test('when the field stays on the old word, search is not submitted and the conversation reports the actual value', async () => {
  const d = phone({ refuseInput: true });
  const { result, records } = await conversation(d, search);
  assert.equal(result.status, 'needs_review');
  assert.match(result.answer, /猫咪/);
  assert.deepEqual(d.actions, ['input', 'input']);
  assert.equal(records.length, 0);
});

test('a correct query and a successful search click cannot validate the previous results', async () => {
  const d = phone({ staleResults: true });
  const { result } = await conversation(d, search);
  assert.equal(result.status, 'needs_review');
  assert.deepEqual(d.actions, ['input', 'tap']);
  assert.doesNotMatch(result.answer, /旧词的第一条/);
});

test('an autocomplete row is never the first search result', () => {
  const suggestions = page('橘猫', '橘猫领养', 'search_suggestions');
  assert.equal(firstSearchResult(suggestions, searchForm(suggestions).field), undefined);
  const mixed = page('橘猫', '旧词的第一条');
  mixed.layout = mixed.layout.replace('</hierarchy>', '<node package="example.search" class="android.widget.ListView" resource-id="example.search:id/search_sug_list" bounds="[0,60][200,400]"/></hierarchy>');
  assert.equal(firstSearchResult(mixed, searchForm(mixed).field), undefined);
});

test('a first-position live card is reported ahead of a video and its viewer count is not its title', () => {
  for (const count of [11, 13]) {
    const v = page('橘猫', '占位');
    v.layout = v.layout.replace(/<node class="android.widget.TextView"[^>]*text="占位"><\/node>/u,
      `<node class="android.view.ViewGroup" package="${app}" bounds="[0,80][98,175]" content-desc="橘子日记的直播间，直播中，观众${count}人，按钮"/>`);
    assert.equal(firstSearchResult(v, searchForm(v).field), '橘子日记的直播间');
  }
});

test('the exact field value is checked again at the point of dispatch', async () => {
  const d = phone();
  let readsSinceWrite = 0;
  d.snapshot = async () => {
    if (d.query === '橘猫' && !d.actions.includes('tap') && ++readsSinceWrite === 2) {
      d.query = '猫咪';
      readsSinceWrite = 0;
    }
    return page(d.query, d.title);
  };
  const { result } = await conversation(d, search);
  assert.equal(result.status, 'needs_review');
  assert.match(result.answer, /猫咪/);
  assert.deepEqual(d.actions, ['input', 'input']);
});

test('a changed query cannot be completed later by either finish route', async () => {
  for (const end of ['finish', 'finish_visual']) {
    const d = phone();
    d.screenshot = () => sharp({ create: { width: 200, height: 400, channels: 3, background: 'white' } }).png().toBuffer();
    const { result } = await conversation(d, (obs, tools) => {
      if (tools.includes('verified_search')) return ['verified_search', { next: 'continue' }];
      if (end === 'finish_visual' && tools.includes('inspect_screen')) return ['inspect_screen', {}];
      d.query = '猫咪';
      if (end === 'finish_visual') {
        assert.ok(tools.includes(end));
        return [end, { message: '已完成。', x: 0.5, y: 0.5 }];
      }
      return finish();
    }, request, end === 'finish_visual');
    assert.equal(result.status, 'needs_review');
    assert.match(result.answer, /猫咪/);
    assert.deepEqual(d.actions, ['input', 'tap']);
  }
});

test('an unrelated tap cannot clear a missed input; a verified retry of that input can', async () => {
  for (const retry of [false, true]) {
    const d = phone();
    let window = 'initial', turn = 0;
    d.snapshot = async () => ({ ...page(d.query, d.title), window });
    const { result } = await conversation(d, obs => {
      const field = obs.controls.find(c => c.editable).ref;
      const submit = obs.controls.find(c => c.id.endsWith('/submit')).ref;
      turn++;
      if (turn === 1) { window = 'updated'; return ['input_text', { target: field, text: '橘猫' }]; }
      if (turn === 2 && retry) return ['input_text', { target: field, text: '橘猫' }];
      if (turn === (retry ? 3 : 2)) return ['tap', { target: submit }];
      return finish();
    }, '请执行约好的输入和点击操作。');
    assert.equal(result.status, retry ? 'succeeded' : 'needs_review');
    assert.deepEqual(d.actions, retry ? ['input', 'tap'] : ['tap']);
  }
});

test('a retry can repair an initial unsuccessful replacement, with one submit', async () => {
  const d = phone();
  const perform = d.perform.bind(d);
  d.perform = async (...args) => {
    await perform(...args);
    if (d.actions.length === 1) d.query = '猫咪';
  };
  const { result } = await conversation(d, search);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(d.actions, ['input', 'input', 'tap']);
});

for (const [code, reads] of [['STALE_OBSERVATION', 5], ['OBSERVATION_TIMEOUT', 5], ['SENSITIVE_OR_BLOCKED_SCREEN', 1]]) {
  test('persistent ' + code + ' on replay never resubmits a completed tap', async () => {
    const d = phone();
    const read = d.snapshot.bind(d);
    let resultReads = 0;
    d.snapshot = async () => {
      if (d.actions.includes('tap')) {
        resultReads++;
        throw Error(code);
      }
      return read();
    };
    const steps = await compileRecording({ schemaVersion: 2, platform: 'android', steps: [
      { inApp: app, command: { action: 'verifiedSearch', query: '橘猫', firstResult: true } },
    ] }, 'android');
    const result = await replayRecording(d, id, steps, new AbortController().signal, () => {});
    assert.equal(result.reason, 'SEARCH_RESULTS_UNVERIFIED');
    assert.equal(resultReads, reads);
    assert.deepEqual(d.actions, ['input', 'tap']);
  });
}

for (const code of ['OBSERVATION_TIMEOUT', 'LAYOUT_UNAVAILABLE']) {
  test('a temporary ' + code + ' after submit only retries the result read', async () => {
    const d = phone();
    const read = d.snapshot.bind(d);
    let resultReads = 0;
    d.snapshot = async () => {
      if (d.actions.includes('tap') && ++resultReads === 1) throw Error(code + ': first result read');
      return read();
    };
    const { result } = await conversation(d, search);
    assert.equal(result.status, 'succeeded');
    assert.match(result.answer, /左上角的橘猫打哈欠/);
    assert.deepEqual(d.actions, ['input', 'tap']);
  });
}

test('continuing an unsubmitted search keeps the required term; an unrelated turn starts normally', async () => {
  const prior = { user: request, assistant: '搜索框仍为猫咪。', reason: 'SEARCH_NOT_SUBMITTED' };
  const retry = await conversation(phone(), finish, [prior, { user: '继续' }]);
  assert.equal(retry.result.reason, 'SEARCH_NOT_SUBMITTED');
  const other = await conversation(phone(), finish, [prior, { user: '只确认前台应用' }]);
  assert.equal(other.result.status, 'succeeded');
});

test('a continued search can finish with evidence after a plain-text model reply', async () => {
  const d = phone();
  let textSent = false;
  const { result } = await conversation(d, (obs, tools) => {
    if (tools.includes('verified_search')) return ['verified_search', { next: 'continue' }];
    if (!textSent) { textSent = true; return '搜索已完成。'; }
    return finish();
  });
  assert.equal(result.status, 'succeeded');
  assert.match(result.answer, /左上角的橘猫打哈欠/);
  assert.deepEqual(d.actions, ['input', 'tap']);
});
