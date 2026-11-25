import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { serviceEnvironment } from '../desktop/service-environment.mjs';

test('the managed service inherits host tools and saved credentials without rewriting preferences', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omu-host-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'desktop-settings.json');
  const settings = JSON.stringify({
    endpoint: 'https://provider.example/v1/', model: 'saved-model', keyRequired: true,
    cipher: Buffer.from('encrypted fixture').toString('base64'), team: 'ABCDE12345', bundle: 'com.example.wda',
  });
  await writeFile(path, settings);
  const secure = { async decryptStringAsync(buffer) {
    assert.equal(buffer.toString(), 'encrypted fixture');
    return { result: 'test-model-key' };
  } };
  const environment = { OMU_API_TOKEN: 'client-only', OMU_STATE_DIR: directory };
  const configure = (child) => { child.JAVA_HOME = join(directory, 'jdk'); };
  const child = await serviceEnvironment(secure, { environment, directory, configure });
  assert.deepEqual(child, {
    OMU_STATE_DIR: directory, JAVA_HOME: join(directory, 'jdk'), OMU_MODEL_BASE_URL: 'https://provider.example/v1',
    OMU_MODEL: 'saved-model', OMU_MODEL_KEY_ENV: 'OMU_DESKTOP_MODEL_KEY', OMU_DESKTOP_MODEL_KEY: 'test-model-key',
    OMU_IOS_TEAM_ID: 'ABCDE12345', OMU_WDA_BUNDLE_ID: 'com.example.wda',
  });
  assert.deepEqual(environment, { OMU_API_TOKEN: 'client-only', OMU_STATE_DIR: directory });
  assert.equal(await readFile(path, 'utf8'), settings);

  let decryptions = 0;
  const locked = { async decryptStringAsync() { decryptions++; throw Error('locked'); } };
  const overrides = { ...environment, OMU_MODEL_PROFILES: '[]', OMU_IOS_XCCONFIG: 'owned.xcconfig' };
  const explicit = await serviceEnvironment(locked, { environment: overrides, directory, configure });
  assert.equal(decryptions, 0);
  assert.equal(explicit.OMU_MODEL_PROFILES, '[]');
  assert.equal(explicit.OMU_IOS_TEAM_ID, undefined);
  const fallback = await serviceEnvironment(locked, { environment, directory, configure });
  assert.equal(decryptions, 1);
  assert.equal(fallback.OMU_MODEL_BASE_URL, undefined);
  assert.equal(fallback.OMU_DESKTOP_MODEL_KEY, undefined);
});
