import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgent } from '../dist/agent.js';
import { route } from '../dist/navigation.js';

const home = (key) => ({
  page: 'home',
  marker: 'settings',
  entries: [{ key, label: 'Bluetooth', allowed: true }],
  layoutKey: key,
});
const bluetooth = { page: 'bluetooth', marker: 'toggle', bluetooth: true };

test('Bluetooth route resolves a rejected target on the fresh page and only observes after dispatch', async () => {
  let page = home('old');
  const moves = [];
  const reads = [];
  const device = {
    async observe() {
      const read = reads.shift() ?? page;
      if (read instanceof Error) throw read;
      return read;
    },
    async move(action, from) {
      assert.equal(action, 'forward');
      moves.push(from.layoutKey);
      if (moves.length === 1) {
        page = home('new');
        throw Error('STALE_OBSERVATION');
      }
      reads.push(Error('HDC_LAYOUT_UNAVAILABLE'), { page: 'other' });
      page = bluetooth;
    },
  };
  assert.equal(await route(device, 'bluetooth', 2000), bluetooth);
  assert.deepEqual(moves, ['old', 'new']);
});

test('Bluetooth route never repeats an unconfirmed move, confirmed move, or out-of-scope target', async () => {
  for (const code of ['ACTION_OUTCOME_UNKNOWN', 'PAGE_NOT_OBSERVED', 'TARGET_OUT_OF_SCOPE']) {
    let attempts = 0;
    const device = {
      observe: async () => home('entry'),
      async move() {
        attempts++;
        if (code !== 'PAGE_NOT_OBSERVED') throw Error(code);
      },
    };
    await assert.rejects(route(device, 'bluetooth', 30), new RegExp(code));
    assert.equal(attempts, 1);
  }
});

test('Bluetooth agent requests a new decision for a rejected locator and still checks every milestone', async () => {
  let page = home('old');
  const taps = [];
  const device = {
    observe: async () => page,
    async move(action, from, key) {
      if (action === 'tap') {
        taps.push(key);
        if (key === 'old') {
          page = home('new');
          throw Error('AMBIGUOUS_OR_MISSING_ELEMENT');
        }
      }
      if (action === 'forward' || action === 'tap') page = bluetooth;
      else if (action === 'back' || action === 'openSettings') page = home('old');
    },
  };
  const decide = async (messages, tools, deadline, count) => {
    count();
    const obs = JSON.parse(messages.at(-1).content);
    if (taps.length === 1)
      assert.equal(
        JSON.parse(messages.findLast((m) => m.role === 'tool').content).outcome,
        'AMBIGUOUS_OR_MISSING_ELEMENT',
      );
    const name = obs.page === 'home' ? 'tap' : 'back';
    const args = { observationId: obs.observationId };
    if (name === 'tap') args.nodeId = obs.navigationEntries[0].id;
    return {
      role: 'assistant',
      content: null,
      tool_calls: [{
        type: 'function',
        id: obs.observationId,
        function: { name, arguments: JSON.stringify(args) },
      }],
    };
  };
  const result = await runAgent(device, decide);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.missing, []);
  assert.deepEqual(taps, ['old', 'new']);
  assert.deepEqual(
    result.actions.map((a) => a.outcome),
    ['AMBIGUOUS_OR_MISSING_ELEMENT', 'dispatched', 'dispatched'],
  );
});
