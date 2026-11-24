import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConversation, saveConversation } from '../desktop/library.mjs';
import { scriptEntry } from '../desktop/script-library.mjs';
import { Workbench } from '../desktop/workbench.mjs';

test('workbench imports the shared script shape and does not append to obsolete recordings', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'omu-script-format-'));
  const previous = process.env.OMU_STATE_DIR;
  process.env.OMU_STATE_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.OMU_STATE_DIR;
    else process.env.OMU_STATE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });

  const device = 'android:example';
  const workbench = new Workbench(() => {}, {
    bridge: { openDevice: () => assert.fail('invalid recordings must be rejected before opening the device') },
    appium: { ensureReady: () => assert.fail('invalid recordings must be rejected before starting Appium') },
    preferences: { clientConfig: () => ({ baseURL: 'http://127.0.0.1:11434', model: 'test' }) },
  });
  workbench.targets.set(device, { id: 'example', platform: 'android', available: true });

  const script = {
    platform: 'android',
    steps: [{ action: 'launchApp', app: 'settings' }, { action: 'check', inApp: 'com.android.settings' }],
  };
  const id = await workbench.importScript('设置', JSON.stringify(script));
  const saved = await scriptEntry(id);
  assert.deepEqual(saved.script, script);
  assert.deepEqual(saved.platforms, ['android']);

  const old = {
    id: randomUUID(),
    turns: [{ user: '旧对话', status: 'succeeded' }],
    script: {
      schemaVersion: 99,
      platform: 'android',
      steps: [{ inApp: 'com.android.settings', command: { action: 'check' } }],
    },
  };
  const v2 = { ...old, id: randomUUID(), script: { ...old.script, schemaVersion: 2 } };
  await saveConversation(device, v2);
  const converted = { platform: 'android', steps: [{ inApp: 'com.android.settings', action: 'check' }] };
  const imported = await workbench.importScript('旧录制', JSON.stringify(v2.script));
  assert.deepEqual((await scriptEntry(imported)).script, converted);
  const accessible = await workbench.conversation(device, v2.id);
  assert.deepEqual((await scriptEntry(accessible.recordingId)).script, converted);
  assert.ok((await workbench.scripts()).some(entry => entry.id === accessible.recordingId));
  assert.deepEqual(await loadConversation(device, v2.id), v2);

  await saveConversation(device, old);
  await assert.rejects(workbench.importScript('旧录制', JSON.stringify(old.script)), { message: 'INVALID_SCRIPT' });
  const conversation = await workbench.conversation(device, old.id);
  assert.equal(conversation.turns[0].user, '旧对话');
  assert.equal(conversation.recordingId, undefined);
  assert.ok(!(await workbench.scripts()).some(entry => entry.id.endsWith(old.id)));

  await workbench.start(device, 'chat', { chatId: old.id, message: '继续' });
  await workbench.operations.get(device);
  assert.equal((await workbench.history(device)).history[0].reason, 'INVALID_CONVERSATION_RECORDING');
  await assert.rejects(workbench.action(device, { action: 'tap', x: 0.5, y: 0.5 }, 'a'.repeat(64), old.id), {
    message: 'INVALID_CONVERSATION_RECORDING',
  });
  assert.deepEqual(await loadConversation(device, old.id), old);
});
