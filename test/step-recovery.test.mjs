import assert from 'node:assert/strict';
import test from 'node:test';
import { readScript, runScript } from '../dist/script.js';
import { observationId } from '../dist/steps.js';

const identity = 'android:script-test';
const app = 'example.editor';
function control(id, overrides = {}) {
  return {
    id,
    labels: [],
    role: 'Button',
    enabled: true,
    focused: false,
    editable: false,
    secret: false,
    bounds: { x: 0, y: 0, width: 30, height: 10 },
    ...overrides,
  };
}
function view(controls, foreground = app) {
  return { app: foreground, window: 'main', rotation: 0, width: 200, height: 400, controls };
}
async function script(device, steps) {
  const plan = await readScript({ schemaVersion: 1, steps }, 'android');
  return runScript(device, identity, plan.steps, new AbortController().signal);
}

test('a script waits for a named button to enable before executing it and the next step once', async () => {
  let reads = 0;
  const taps = [];
  const device = {
    async snapshot() {
      return view([control('first', { enabled: ++reads > 1 }), control('next')]);
    },
    async perform(step, current, node) {
      assert.ok(node.enabled);
      taps.push(node.id);
    },
  };
  const result = await script(device, ['first', 'next'].map((id) => ({ action: 'tap', id })));
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(taps, ['first', 'next']);
});

for (const change of ['app', 'value']) {
  test('a script cannot send a rejected input to a changed ' + change, async () => {
    let attempts = 0;
    const device = {
      async snapshot() {
        const field = control('query', {
          role: 'TextInput',
          editable: true,
          focused: true,
          value: attempts && change === 'value' ? 'edited' : '',
        });
        return view([field], attempts && change === 'app' ? 'example.other' : app);
      },
      async perform() {
        attempts++;
        throw Error('INPUT_TARGET_CHANGED');
      },
    };
    const result = await script(device, [
      { action: 'input', id: 'query', text: 'X' },
      { action: 'tap', id: 'next' },
    ]);
    assert.equal(result.status, 'failed');
    assert.equal(result.failedStep, 1);
    assert.equal(result.reason, 'STALE_OBSERVATION');
    assert.equal(attempts, 1);
    assert.equal(result.steps.length, 1);
  });
}

test('a script keeps an unknown action outcome terminal even if its cause is a stale target', async () => {
  let attempts = 0;
  const result = await script({
    snapshot: async () => view([control('button')]),
    async perform() {
      attempts++;
      throw Error('ACTION_OUTCOME_UNKNOWN: STALE_OBSERVATION');
    },
  }, [{ action: 'tap', id: 'button' }]);
  assert.equal(result.reason, 'ACTION_OUTCOME_UNKNOWN');
  assert.equal(attempts, 1);
});

test('launch waits for two consecutive matching foreground reads without launching again', async () => {
  const reads = [app, Error('FOREGROUND_APP_UNAVAILABLE'), app, app];
  let launches = 0;
  const result = await script({
    async launch() {
      launches++;
      return app;
    },
    async foregroundApp() {
      assert.ok(reads.length);
      const observed = reads.shift();
      if (observed instanceof Error) throw observed;
      return observed;
    },
  }, [{ action: 'launchApp', app }]);
  assert.equal(result.status, 'succeeded');
  assert.equal(launches, 1);
  assert.equal(reads.length, 0);
});

for (const state of ['visible', 'hidden']) {
  test('waitFor ' + state + ' polls past a duplicated control', async () => {
    let reads = 0;
    const result = await script({
      async snapshot() {
        if (++reads === 1) return view([control('item'), control('item')]);
        return view(state === 'visible' ? [control('item')] : []);
      },
    }, [{ action: 'waitFor', id: 'item', state, timeoutMs: 2000 }]);
    assert.equal(result.status, 'succeeded');
    assert.equal(reads, 2);
  });
}

test('waitFor rejects an explicitly stale observation even after a transient snapshot error', async () => {
  const observation = observationId(identity, view([control('before')]));
  let reads = 0;
  const result = await script({
    async snapshot() {
      if (++reads === 1) throw Error('FOREGROUND_WINDOW_AMBIGUOUS');
      return view([control('item')]);
    },
  }, [{ action: 'waitFor', id: 'item', observation, timeoutMs: 2000 }]);
  assert.equal(result.reason, 'STALE_OBSERVATION');
  assert.equal(reads, 2);
});
