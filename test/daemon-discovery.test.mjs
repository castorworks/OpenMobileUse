import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApiServer } from '../dist/http.js';

const daemon = new URL('../dist/http.js', import.meta.url).href;
const fixtureSecret = 'fixture-' + randomUUID();
const childProgram = `
import { serveFromArgs } from ${JSON.stringify(daemon)};
const [scenario, ...args] = process.argv.slice(1);
process.on('message', (message) => {
  if (message === 'stop') process.emit('SIGTERM');
});
const actualFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const requested = new URL(String(url));
  if (requested.origin !== 'http://127.0.0.1:11434') return actualFetch(url, options);
  const path = requested.pathname;
  const model = options?.body ? JSON.parse(options.body).model : undefined;
  process.send({ path, model, scrubbed: process.env.OMU_API_TOKEN === undefined });
  if (scenario === 'unavailable') throw new Error('Local Ollama is not running');
  if (path === '/api/tags') return Response.json({ models: [
    { name: 'from-tags', remote_host: 'https://ollama.com' },
    { name: 'hidden-cloud:latest' },
    { name: 'from-show' },
    { name: 'plain-local' },
    { model: 'tool-local:latest' },
  ] });
  if (path === '/api/show' && model === 'from-show')
    return Response.json({ remote_model: 'foo', capabilities: ['tools'] });
  if (path === '/api/show' && model === 'plain-local')
    return Response.json({ capabilities: ['vision'] });
  if (path === '/api/show' && model === 'tool-local:latest')
    return Response.json({ capabilities: ['tools', 'vision'] });
  throw new Error('Unexpected Ollama call');
};
try {
  await serveFromArgs(args);
} finally {
  process.disconnect?.();
}
`;

async function startDaemon(t, scenario, environment = {}) {
  const root = await mkdtemp(join(tmpdir(), 'omu-daemon-discovery-'));
  const directory = join(root, 'api');
  await mkdir(directory);
  await writeFile(join(directory, 'connection.json'),
    JSON.stringify({ url: 'http://127.0.0.1:1', instanceId: 'old-instance' }), { mode: 0o600 });
  const env = { ...process.env };
  for (const name of [
    'OMU_MODEL_PROFILES', 'OMU_MODEL_BASE_URL', 'OMU_MODEL', 'OMU_MODEL_KEY_ENV', 'DEEPSEEK_API_KEY',
    'OMU_ALLOW_MODEL_IMAGES',
  ]) delete env[name];
  const child = spawn(process.execPath, [
    '--input-type=module', '--eval', childProgram, '--', scenario, '--port', '0',
    '--host', 'localhost', '--state-dir', directory, '--appium-mode', 'external',
    '--appium-url', 'http://127.0.0.1:1',
  ], {
    env: {
      ...env, OMU_API_TOKEN: fixtureSecret, OMU_STATE_DIR: root,
      ADB_PATH: join(root, 'missing-adb'), HDC_PATH: join(root, 'missing-hdc'), ...environment,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  const closed = once(child, 'close');
  const probes = [];
  child.on('message', (probe) => probes.push(probe));
  let output = '', errors = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { errors += chunk; });
  const announced = new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
      const end = output.indexOf('\n');
      if (end !== -1) {
        try { resolve(JSON.parse(output.slice(0, end))); }
        catch (error) { reject(error); }
      }
    });
    closed.then(([code]) => reject(new Error('Daemon stopped at startup: ' + code + '\n' + errors)), reject);
  });
  t.after(async () => {
    if (child.connected) child.send('stop');
    await closed;
    await rm(root, { recursive: true, force: true });
  });
  const { url } = await announced;
  return {
    directory, url, probes,
    async close() {
      if (child.connected) child.send('stop');
      const [code] = await closed;
      assert.equal(code, 0, errors);
    },
  };
}

test('serve publishes its exact loopback listener, authenticates health by instance and discovers only installed tool models',
  { timeout: 20000 }, async (t) => {
    const service = await startDaemon(t, 'local', { OMU_ALLOW_MODEL_IMAGES: 'true' });
    const file = join(service.directory, 'connection.json');
    const raw = await readFile(file, 'utf8');
    const connection = JSON.parse(raw);
    assert.deepEqual(Object.keys(connection).sort(), ['instanceId', 'url']);
    assert.equal(connection.url, service.url);
    assert.match(service.url, /^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9]\d*$/);
    assert.notEqual(connection.instanceId, 'old-instance');
    assert.ok(!raw.includes(fixtureSecret));
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.ok(!(await readdir(service.directory)).some((name) => name.startsWith('connection.json.')));

    const health = await fetch(service.url + '/healthz');
    assert.deepEqual(await health.json(), { status: 'ok' });
    assert.equal(health.headers.get('X-OMU-Instance'), connection.instanceId);
    const response = await fetch(service.url + '/api/capabilities', {
      headers: { Authorization: 'Bearer ' + fixtureSecret },
    });
    const capabilities = await response.json();
    assert.deepEqual(capabilities.modelProfiles, [{ id: 'ollama', allowsImages: true }]);
    assert.deepEqual(service.probes, [
      { path: '/api/tags', scrubbed: true },
      { path: '/api/show', model: 'from-show', scrubbed: true },
      { path: '/api/show', model: 'plain-local', scrubbed: true },
      { path: '/api/show', model: 'tool-local:latest', scrubbed: true },
    ]);
    await service.close();
    await assert.rejects(readFile(file), { code: 'ENOENT' });
  });

test('serve honors explicit model profiles and starts when the local probe is unavailable',
  { timeout: 20000 }, async (t) => {
    const configured = await startDaemon(t, 'local', {
      OMU_MODEL_PROFILES: JSON.stringify([{ id: 'configured', model: 'pinned', baseURL: 'http://127.0.0.1:1/v1' }]),
    });
    const profiles = async (url) => {
      const response = await fetch(url + '/api/capabilities', {
        headers: { Authorization: 'Bearer ' + fixtureSecret },
      });
      return (await response.json()).modelProfiles;
    };
    assert.deepEqual(await profiles(configured.url), [{ id: 'configured', allowsImages: false }]);
    assert.deepEqual(configured.probes, []);
    await configured.close();

    const offline = await startDaemon(t, 'unavailable');
    assert.deepEqual(await profiles(offline.url), []);
    assert.deepEqual(offline.probes, [{ path: '/api/tags', scrubbed: true }]);
    await offline.close();
  });

test('closing a listener preserves a connection announcement with a different instance ID', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omu-connection-owner-'));
  const service = await createApiServer({
    directory, lockDirectory: directory, port: 0, announceLocalConnection: true,
    drivers: {
      discover: async () => [], status: async (platform) => ({ platform, available: false }),
      close: async () => {},
    },
  });
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  const file = join(directory, 'connection.json');
  const active = JSON.parse(await readFile(file, 'utf8'));
  const replacement = { url: active.url, instanceId: randomUUID() };
  await writeFile(file, JSON.stringify(replacement), { mode: 0o600 });
  await service.close();
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), replacement);
});
