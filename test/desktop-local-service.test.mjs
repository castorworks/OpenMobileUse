import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { ensureLocalService } from '../desktop/local-service.mjs';

const instanceId = '2cc20d06-e86d-48d2-ae17-6b38ed87ab76';
const differentInstance = '39ca0140-62a3-42b9-acfb-e3ad2511a598';
const current = 'http://127.0.0.1:29827';
const outdated = 'http://127.0.0.1:18765';
const preferences = (config = {}) => ({ clientConfig: () => config });
const health = (instance = instanceId) => Response.json({ status: 'ok' }, { headers: { 'X-OMU-Instance': instance } });

async function state(t) {
  const directory = await mkdtemp(join(tmpdir(), 'omu-local-service-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

async function publish(directory, url = current) {
  const staging = join(directory, '.connection.tmp');
  await writeFile(staging, JSON.stringify({ url, instanceId }), { mode: 0o600 });
  await rename(staging, join(directory, 'connection.json'));
}

test('a cached local token is reused with a verified instance on a new port', async (t) => {
  const stateDir = await state(t);
  await publish(stateDir);
  const calls = [];
  const result = await ensureLocalService(
    preferences({ baseURL: outdated, token: 'saved-token', stateDirectory: stateDir }),
    {
      stateDir,
      fetch: async (url, { headers, redirect }) => {
        assert.equal(url.origin, current);
        assert.equal(redirect, 'error');
        calls.push([url.pathname, headers?.Authorization]);
        return url.pathname === '/healthz' ? health() : Response.json({});
      },
      spawn: () => assert.fail('verified service already running'),
      execFile: () => assert.fail('cached local token is valid'),
    },
  );
  assert.deepEqual(result, { baseURL: current, token: 'saved-token', stateDirectory: stateDir });
  assert.deepEqual(calls, [['/healthz', undefined], ['/api/capabilities', 'Bearer saved-token']]);
});

test('concurrent callers launch one detached daemon on a free port and issue one local token', async (t) => {
  const stateDir = await state(t);
  await publish(stateDir, outdated);
  const calls = [];
  let spawned = 0, unreferenced = 0, issued = 0;
  let published;
  const options = {
    stateDir,
    timeoutMs: 2000,
    serviceEnvironment: async () => ({ OMU_API_TOKEN: 'not-for-daemon', JAVA_HOME: 'fixture-jdk' }),
    fetch: async (url, { headers, redirect }) => {
      assert.equal(redirect, 'error');
      calls.push([url.origin, url.pathname, headers?.Authorization]);
      if (url.pathname === '/healthz') return health(url.origin === current ? instanceId : differentInstance);
      return Response.json({});
    },
    spawn(node, [entry, ...args], { detached, windowsHide, stdio, env }) {
      spawned++;
      assert.equal(node, process.execPath);
      assert.ok(isAbsolute(entry));
      assert.deepEqual(args, ['serve', '--host', '127.0.0.1', '--port', '0', '--state-dir', stateDir]);
      assert.equal(detached, true);
      assert.equal(windowsHide, true);
      assert.equal(stdio[0], 'ignore');
      assert.ok(Number.isInteger(stdio[1]));
      assert.equal(stdio[1], stdio[2]);
      assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
      assert.equal(env.OMU_API_TOKEN, undefined);
      assert.equal(env.JAVA_HOME, 'fixture-jdk');
      published = publish(stateDir);
      const child = new EventEmitter();
      child.unref = () => { unreferenced++; };
      return child;
    },
    async execFile(node, [entry, ...args], { env }) {
      issued++;
      assert.equal(node, process.execPath);
      assert.ok(isAbsolute(entry));
      assert.deepEqual(args, ['auth', 'token', 'create', '--subject', 'desktop-local', '--state-dir', stateDir]);
      assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
      assert.equal(env.OMU_API_TOKEN, undefined);
      assert.equal(env.DEEPSEEK_API_KEY, undefined);
      return { stdout: JSON.stringify({ token: 'fresh-token' }) };
    },
  };
  const controller = new AbortController();
  const abortable = ensureLocalService(preferences({ token: 'must-not-send' }), { ...options, signal: controller.signal });
  const stable = ensureLocalService(preferences(), options);
  controller.abort(Error('CANCELLED'));
  await assert.rejects(abortable, { message: 'CANCELLED' });
  const result = await stable;
  await published;
  assert.deepEqual(result, { baseURL: current, token: 'fresh-token', stateDirectory: stateDir });
  assert.equal(spawned, 1);
  assert.equal(unreferenced, 1);
  assert.equal(issued, 1);
  assert.deepEqual(calls.filter(([_, __, auth]) => auth), [[current, '/api/capabilities', 'Bearer fresh-token']]);
  assert.equal(await readFile(join(stateDir, 'desktop-service.log'), 'utf8'), '');
});

test('the auto credential is scoped to its state directory and health is rechecked after issuance', async (t) => {
  const stateDir = await state(t);
  await publish(stateDir);
  let tokenIssued = false;
  await assert.rejects(ensureLocalService(
    preferences({ baseURL: current, token: 'other-state', stateDirectory: join(stateDir, 'other') }),
    {
      stateDir,
      async fetch(url, { headers }) {
        assert.equal(url.pathname, '/healthz');
        assert.equal(headers?.Authorization, undefined);
        return health(tokenIssued ? differentInstance : instanceId);
      },
      spawn: () => assert.fail('verified service already running'),
      async execFile() {
        tokenIssued = true;
        return { stdout: '{"token":"fresh-local"}' };
      },
    },
  ), { message: 'LOCAL_SERVICE_AUTH_FAILED' });
  assert.equal(tokenIssued, true);
});

test('a daemon which never publishes a verified connection times out', async (t) => {
  const stateDir = await state(t);
  await assert.rejects(ensureLocalService(preferences(), {
    stateDir,
    timeoutMs: 25,
    serviceEnvironment: async () => ({}),
    fetch: () => assert.fail('no published connection'),
    spawn: () => Object.assign(new EventEmitter(), { unref() {} }),
    execFile: () => assert.fail('unverified service must never receive a token'),
  }), { message: 'LOCAL_SERVICE_START_TIMEOUT' });
});
