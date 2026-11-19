import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pending, withDevice } from '../dist/session.js';

test('locks are per device; an unknown action survives and is never replayed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omu-state-test-'));
  const previous = process.env.OMU_STATE_DIR;
  process.env.OMU_STATE_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.OMU_STATE_DIR;
    else process.env.OMU_STATE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const target = { platform: 'harmony', id: 'test-device' };
  let sends = 0;
  await assert.rejects(withDevice(target, 'aaa', async dispatch => {
    await assert.rejects(withDevice(target, 'bbb', async () => {}), /DEVICE_BUSY/);
    await withDevice({ ...target, id: 'second' }, 'ccc', async () => {});
    await dispatch('forward', async () => {
      assert.equal(pending(target)[0].runId, 'aaa');
      sends++;
      throw new Error('lost connection after dispatch');
    });
  }), /ACTION_OUTCOME_UNKNOWN/);
  await withDevice(target, 'ddd', async () => {
    assert.equal(pending(target)[0].kind, 'forward');
  });
  assert.equal(sends, 1);
});
