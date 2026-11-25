import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../dist/api-client.js';
import { Workbench } from '../desktop/workbench.mjs';

const script = {
  platform: 'android',
  steps: [{ action: 'launchApp', app: 'settings' }, { action: 'check', inApp: 'com.android.settings' }],
};

test('Desktop submits unified HTTP scripts and uses service ETags to archive and restore', async (t) => {
  let archived = false;
  let writes = 0;
  const api = new ApiClient({ token: 'token', fetch: async (url, options) => {
    const body = options.body === undefined ? undefined : JSON.parse(options.body);
    if (url.pathname === '/api/scripts' && options.method === 'POST') {
      assert.deepEqual(body, { title: '设置', source: 'document', script });
      return Response.json({ id: 'saved' }, { status: 201 });
    }
    if (url.pathname === '/api/scripts/saved/content') return Response.json(script);
    if (url.pathname === '/api/scripts/saved' && options.method === 'GET') return Response.json({ title: '设置', archived }, { headers: { ETag: '"v' + writes + '"' } });
    if (url.pathname === '/api/scripts/saved' && options.method === 'PATCH') {
      assert.equal(options.headers.get('If-Match'), '"v' + writes++ + '"');
      archived = body.archived;
      return Response.json({ archived });
    }
    assert.fail('Unexpected HTTP request ' + url.href);
  } });
  const workbench = new Workbench(() => {}, { api });
  t.after(() => workbench.shutdown());
  const id = await workbench.importScript('设置', JSON.stringify(script));
  assert.equal(id, 'saved');
  assert.deepEqual(await workbench.exportScript(id), { title: '设置', script });
  assert.deepEqual(await workbench.removeScript(id), { archived: true });
  assert.deepEqual(await workbench.restoreRecording(id), { archived: false });
  assert.equal(writes, 2);
});

test('Desktop can diagnose a missing service without a token', async (t) => {
  const api = new ApiClient({ token: '', fetch: async () => { throw Error('offline'); } });
  const workbench = new Workbench(() => {}, { api });
  t.after(() => workbench.shutdown());
  assert.deepEqual((await workbench.diagnoseService()).map((check) => check.status), [
    'API_UNREACHABLE', 'API_UNREACHABLE', 'API_TOKEN_REQUIRED',
  ]);
});
