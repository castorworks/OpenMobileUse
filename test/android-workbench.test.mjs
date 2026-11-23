import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workbench } from '../desktop/workbench.mjs';
import { openDevice } from '../dist/doctor.js';

test('only Android workbench sessions request a one-second UI idle wait', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'omu-session-settings-'));
  const previous = process.env.OMU_STATE_DIR;
  process.env.OMU_STATE_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.OMU_STATE_DIR;
    else process.env.OMU_STATE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const capabilities = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options.method === 'DELETE') return Response.json({ value: null });
    capabilities.push(JSON.parse(options.body).capabilities.alwaysMatch);
    return Response.json({ value: { sessionId: 'fixture' } });
  });
  const workbench = new Workbench(() => {}, { appium: { ensureReady: async () => {} } });
  const android = { id: 'fixture', platform: 'android', available: true };
  const ios = { ...android, platform: 'ios' };
  for (const target of [android, ios])
    await workbench.session(target, 'test', null, 'foreground', async () => {}, undefined, 630);
  const cli = await openDevice(android, async () => {});
  await cli.close();
  assert.deepEqual(capabilities.map(c => c['appium:settings[waitForIdleTimeout]']), [1000, undefined, undefined]);
  assert.deepEqual(capabilities.map(c => c['appium:newCommandTimeout']), [630, 630, 90]);
});
