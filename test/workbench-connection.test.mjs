import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ApiError } from '../dist/api-client.js';
import { Preferences } from '../desktop/preferences.mjs';
import { Workbench } from '../desktop/workbench.mjs';

const fallbackAddress = 'http://127.0.0.1:18765';
const autoAddress = 'http://127.0.0.1:20210';
const nextAddress = 'http://127.0.0.1:20211';
const autoToken = 'local-fixture-token';
const manualToken = 'manual-fixture-token';
const privateKeys = ['OMU_STATE_DIR', 'OMU_API_URL', 'OMU_API_TOKEN'];
const tokenStore = {
  async encryptStringAsync(value) { return Buffer.from(Array.from(Buffer.from(value), (byte) => byte ^ 73)); },
  async decryptStringAsync(value) { return { result: Buffer.from(value.map((byte) => byte ^ 73)).toString() }; },
};

async function settingsDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'omu-workbench-connection-'));
  const previous = Object.fromEntries(privateKeys.map((key) => [key, process.env[key]]));
  process.env.OMU_STATE_DIR = directory;
  delete process.env.OMU_API_URL;
  delete process.env.OMU_API_TOKEN;
  t.after(async () => {
    for (const key of privateKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, filename: join(directory, 'desktop-api-settings.json') };
}

test('Desktop defaults to automatic local mode and remembers separate encrypted endpoint credentials', async (t) => {
  const { directory, filename } = await settingsDir(t);
  const stateDirectory = join(directory, 'api');
  const prefs = new Preferences(tokenStore);
  await prefs.load();
  assert.equal(prefs.config().mode, 'local');
  assert.deepEqual(prefs.clientConfig(), { baseURL: fallbackAddress, token: '', stateDirectory: undefined });
  await prefs.configureLocal({ baseURL: autoAddress, token: autoToken, stateDirectory });
  const reopened = new Preferences(tokenStore);
  await reopened.load();
  assert.deepEqual(reopened.clientConfig(), { baseURL: autoAddress, token: autoToken, stateDirectory });

  await reopened.save({ mode: 'custom', endpoint: fallbackAddress, key: manualToken, model: 'manual-model' });
  const manual = new Preferences(tokenStore);
  await manual.load();
  assert.equal(manual.config().mode, 'custom');
  assert.equal(manual.config().local, true);
  assert.equal(manual.clientConfig().token, manualToken);
  await manual.save({ mode: 'local' });
  assert.deepEqual(manual.clientConfig(), { baseURL: autoAddress, token: autoToken, stateDirectory });
  assert.equal(manual.config().customHasKey, true);
  const saved = await readFile(filename, 'utf8');
  assert.ok(!saved.includes(autoToken) && !saved.includes(manualToken));
  assert.equal(JSON.parse(saved).mode, 'local');
});

test('Explicit environment and previously saved addresses remain manual, including localhost', async (t) => {
  const { filename } = await settingsDir(t);
  await writeFile(filename, JSON.stringify({ endpoint: 'https://old.example', model: 'legacy' }));
  const legacy = new Preferences(tokenStore);
  await legacy.load();
  assert.equal(legacy.config().mode, 'custom');
  assert.equal(legacy.clientConfig().baseURL, 'https://old.example');
  process.env.OMU_API_URL = fallbackAddress;
  process.env.OMU_API_TOKEN = manualToken;
  const manual = new Preferences(tokenStore);
  await manual.load();
  assert.equal(process.env.OMU_API_TOKEN, undefined);
  const bench = new Workbench(() => {}, {
    preferences: manual,
    ensureLocalService: () => assert.fail('manual local addresses must never start the daemon'),
    createClient: ({ token, baseURL }) => ({
      async json(path) {
        assert.equal(token, manualToken);
        assert.equal(baseURL, fallbackAddress);
        if (path.startsWith('/api/devices?')) return { items: [] };
        return { drivers: [], modelProfiles: [] };
      },
    }),
  });
  t.after(() => bench.shutdown());
  await bench.devices();
  await bench.checkLocal();
  assert.equal(bench.config().mode, 'custom');
  assert.equal(bench.config().connectionStatus, 'online');
});

test('An unavailable keychain keeps the automatic credential in memory alone', async (t) => {
  const { filename } = await settingsDir(t);
  const prefs = new Preferences({
    isAsyncEncryptionAvailable: async () => false,
    encryptStringAsync: async () => assert.fail('the vault is unavailable'),
  });
  await prefs.load();
  await prefs.configureLocal({ baseURL: autoAddress, token: autoToken });
  assert.equal(prefs.clientConfig().token, autoToken);
  assert.equal(prefs.config().storageWarning, 'KEYCHAIN_UNAVAILABLE');
  const saved = await readFile(filename, 'utf8');
  assert.ok(!saved.includes(autoToken));
  assert.equal(JSON.parse(saved).local.cipher, undefined);
});

test('Automatic startup coalesces requests and recovers a crashed service without closing the workbench', async (t) => {
  const { directory } = await settingsDir(t);
  const stateDirectory = join(directory, 'api');
  const prefs = new Preferences(tokenStore);
  await prefs.load();
  const phases = [];
  let starts = 0;
  let connectedAddress = autoAddress;
  const bench = new Workbench((event) => phases.push(event), {
    preferences: prefs,
    ensureLocalService: async (settings, options) => {
      assert.equal(options.secure, tokenStore);
      assert.ok(!options.signal.aborted);
      if (++starts === 2) assert.equal(settings.clientConfig().stateDirectory, stateDirectory);
      return { baseURL: connectedAddress, token: autoToken, stateDirectory };
    },
    createClient: ({ baseURL }) => ({
      async json(path) {
        if (baseURL !== connectedAddress) throw new ApiError('API_UNREACHABLE', 0);
        if (path === '/readyz') return { status: 'ok' };
        if (path.startsWith('/api/devices?')) return { items: [] };
        return { drivers: [], modelProfiles: [] };
      },
    }),
  });
  t.after(() => bench.shutdown());
  await Promise.all([bench.devices(), bench.devices()]);
  assert.equal(starts, 1);
  await bench.checkLocal();
  assert.equal(starts, 1);
  connectedAddress = nextAddress;
  await bench.checkLocal();
  assert.equal(starts, 2);
  assert.equal(prefs.clientConfig().baseURL, nextAddress);
  assert.equal(bench.config().connectionStatus, 'online');
  assert.ok(phases.some((event) => event.reconnected));
});

test('An active Desktop watcher follows the accepted run on the recovered local port', async (t) => {
  const { directory } = await settingsDir(t);
  const stateDirectory = join(directory, 'api');
  const prefs = new Preferences(tokenStore);
  await prefs.load();
  const at = '2026-11-25T10:00:00Z';
  const run = { id: 'accepted-run', deviceId: 'device', kind: 'chat', status: 'running', createdAt: at, artifacts: [] };
  const recorded = [];
  const resumed = [];
  let submitted = 0;
  let starts = 0;
  const bench = new Workbench((event) => {
    if (event.type === 'run') recorded.push(event.record);
  }, {
    preferences: prefs,
    ensureLocalService: async () => ({
      baseURL: starts++ ? nextAddress : autoAddress, token: autoToken, stateDirectory,
    }),
    createClient: ({ baseURL }) => ({
      async json(path) {
        if (path.startsWith('/api/devices?')) return { items: [] };
        if (path === '/api/capabilities') return { drivers: [], modelProfiles: [] };
        assert.equal(path.split('?')[0], '/api/runs/' + run.id + '/events');
        if (baseURL === autoAddress) return { items: [] };
        resumed.push(path);
        return { items: [{ sequence: 3, type: 'run.progress', at, data: { name: 'Recovered' } }] };
      },
      async submitRun() { submitted++; assert.equal(baseURL, autoAddress); return run; },
      async getRun(id) {
        assert.equal(id, run.id);
        return baseURL === autoAddress ? run : { ...run, status: 'succeeded', result: { answer: 'Done.' } };
      },
      async *events() {
        assert.equal(baseURL, autoAddress);
        yield { sequence: 2, type: 'run.progress', at, data: { name: 'Started' } };
        throw new ApiError('API_UNREACHABLE', 0);
      },
    }),
  });
  t.after(() => bench.shutdown());
  await bench.devices();
  const id = await bench.start('device', 'chat', { message: 'Test' });
  await bench.watchers.get(id)?.done;
  assert.equal(submitted, 1);
  assert.equal(starts, 2);
  assert.match(resumed[0], /after=2$/);
  assert.equal(recorded.at(-1).result.answer, 'Done.');
  assert.deepEqual(recorded.at(-1).events.map((entry) => entry.name), ['Started', 'Recovered']);
});

test('A failed automatic launch remains diagnosable and can be retried in the same session', async (t) => {
  await settingsDir(t);
  const prefs = new Preferences(tokenStore);
  await prefs.load();
  let ready = false;
  const bench = new Workbench(() => {}, {
    preferences: prefs,
    ensureLocalService: async () => {
      if (!ready) throw Error('LOCAL_SERVICE_START_FAILED');
      return { baseURL: autoAddress, token: autoToken };
    },
    createClient: () => ({
      async json(path) {
        if (!ready) throw new ApiError('API_UNREACHABLE', 0);
        if (path.startsWith('/api/devices?')) return { items: [] };
        return { drivers: [], modelProfiles: [] };
      },
    }),
  });
  t.after(() => bench.shutdown());
  await assert.rejects(bench.devices(), { message: 'LOCAL_SERVICE_START_FAILED' });
  assert.equal(bench.config().connectionStatus, 'offline');
  const checks = await bench.diagnoseService();
  assert.equal(checks[0].status, 'API_UNREACHABLE');
  ready = true;
  await bench.devices();
  assert.equal(bench.config().connectionStatus, 'online');
});
