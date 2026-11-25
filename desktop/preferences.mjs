import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { apiURL, defaultApiURL } from '../dist/api-client.js';
import { stateRoot, writeJSON } from './library.mjs';

const filename = 'desktop-api-settings.json';
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
const blank = () => ({ endpoint: defaultApiURL, model: '', useImages: false });
const modes = new Set(['local', 'custom']);

function endpointURL(value) {
  try {
    return apiURL(value).href.replace(/\/$/, '');
  } catch {
    throw Error('INVALID_SETTINGS');
  }
}

function localEndpoint(value) {
  return loopback.has(new URL(value).hostname);
}

function savedConnection(record) {
  if (!record || typeof record !== 'object') return;
  const { endpoint, model, useImages, cipher, stateDirectory } = record;
  return {
    endpoint, model, useImages, cipher: typeof cipher === 'string' ? cipher : undefined,
    stateDirectory: typeof stateDirectory === 'string' ? stateDirectory : undefined,
  };
}

export class Preferences {
  constructor(secure) {
    this.secure = secure;
    this.environmentEndpoint = process.env.OMU_API_URL;
    this.environmentToken = process.env.OMU_API_TOKEN;
    delete process.env.OMU_API_TOKEN;
    this.mode = 'local';
    this.connections = { local: blank(), custom: blank() };
    this.saved = {};
    this.writes = Promise.resolve();
  }

  async readConnection(record, mode) {
    const connection = blank();
    try {
      if (record?.endpoint !== undefined) connection.endpoint = endpointURL(record.endpoint);
      if (mode === 'local' && !localEndpoint(connection.endpoint)) throw Error('INVALID_SETTINGS');
    } catch {
      return { ...blank(), configError: 'API_INVALID_URL' };
    }
    connection.model = typeof record?.model === 'string' ? record.model : '';
    connection.useImages = record?.useImages === true;
    if (mode === 'local' && typeof record?.stateDirectory === 'string') connection.stateDirectory = record.stateDirectory;
    if (typeof record?.cipher === 'string') {
      try {
        const { result: token } = await this.secure.decryptStringAsync(Buffer.from(record.cipher, 'base64'));
        if (typeof token !== 'string' || !token || /[^!-~]/.test(token)) throw Error('KEYCHAIN_UNAVAILABLE');
        connection.token = connection.savedToken = token;
      } catch {
        connection.storageWarning = 'KEYCHAIN_UNAVAILABLE';
      }
    }
    return connection;
  }

  async load() {
    let data = {};
    try {
      data = JSON.parse(await readFile(join(stateRoot(), filename), 'utf8')) || {};
    } catch (error) {
      if (error.code !== 'ENOENT') this.configError = 'INVALID_SETTINGS';
    }
    // A flat file is an explicitly saved address from the previous desktop client.
    const custom = data.custom ?? (Object.hasOwn(data, 'endpoint') ? data : undefined);
    this.saved = { local: savedConnection(data.local), custom: savedConnection(custom) };
    const [local, remote] = await Promise.all([
      this.readConnection(data.local, 'local'), this.readConnection(custom, 'custom'),
    ]);
    this.connections = { local, custom: remote };
    this.mode = modes.has(data.mode) ? data.mode : custom ? 'custom' : 'local';
    if (this.environmentEndpoint !== undefined) {
      this.mode = 'custom';
      try {
        const endpoint = endpointURL(this.environmentEndpoint);
        const same = endpoint === remote.endpoint && !remote.configError;
        this.connections.custom = {
          ...(same ? remote : blank()), endpoint,
          token: this.environmentToken || (same ? remote.token : undefined),
        };
      } catch {
        this.connections.custom = { ...blank(), configError: 'API_INVALID_URL' };
      }
    } else if (this.environmentToken && this.mode === 'custom' && !remote.configError) {
      remote.token = this.environmentToken;
    }
    this.environmentToken = undefined;
  }

  config() {
    const connection = this.connections[this.mode];
    const custom = this.connections.custom;
    return {
      mode: this.mode,
      endpoint: connection.endpoint,
      customEndpoint: custom.endpoint,
      customHasKey: !!custom.token,
      profiles: Object.fromEntries([...modes].map((mode) => {
        const { model, useImages } = this.connections[mode];
        return [mode, { model, useImages }];
      })),
      model: connection.model,
      useImages: connection.useImages,
      needsKey: this.mode === 'custom' && !connection.token,
      hasKey: !!connection.token,
      local: localEndpoint(connection.endpoint),
      macHost: process.platform === 'darwin',
      configError: connection.configError || this.configError,
      storageWarning: connection.storageWarning,
    };
  }

  clientConfig() {
    const { endpoint, token, stateDirectory } = this.connections[this.mode];
    return { baseURL: endpoint, token: token || '', stateDirectory };
  }

  async persist(mode, connection, signal) {
    signal?.throwIfAborted();
    const { endpoint, model, useImages, token, stateDirectory } = connection;
    const previous = this.connections[mode];
    const old = this.saved[mode];
    let cipher;
    if (token) {
      const unchanged = token === previous.token && endpoint === previous.endpoint;
      if (unchanged && old?.endpoint === endpoint && previous.savedToken === token) cipher = old.cipher;
      if (!cipher) {
        try {
          if (await this.secure?.isAsyncEncryptionAvailable?.() === false ||
              (process.platform === 'linux' && this.secure?.getSelectedStorageBackend?.() === 'basic_text'))
            throw Error('KEYCHAIN_UNAVAILABLE');
          cipher = (await this.secure.encryptStringAsync(token)).toString('base64');
        } catch {
          connection.storageWarning = 'KEYCHAIN_UNAVAILABLE';
        }
      }
    }
    signal?.throwIfAborted();
    const saved = { ...this.saved, [mode]: { endpoint, model, useImages, cipher, stateDirectory } };
    this.connections[mode] = connection;
    this.mode = mode;
    this.configError = undefined;
    try {
      await writeJSON(stateRoot(), filename, { mode, ...saved });
      this.saved = saved;
      connection.savedToken = cipher ? token : undefined;
    } catch {
      connection.storageWarning ||= 'SETTINGS_WRITE_FAILED';
    }
  }

  queue(work) {
    const writing = this.writes.then(work);
    this.writes = writing.catch(() => {});
    return writing;
  }

  configureLocal({ baseURL, token, stateDirectory }, signal) {
    const endpoint = endpointURL(baseURL);
    if (!localEndpoint(endpoint) || typeof token !== 'string' || !token || /[^!-~]/.test(token))
      throw Error('INVALID_LOCAL_SERVICE_CONNECTION');
    return this.queue(async () => {
      signal?.throwIfAborted();
      if (this.mode !== 'local') return;
      if (this.saved.local?.endpoint === endpoint &&
          this.saved.local.stateDirectory === stateDirectory &&
          this.connections.local.savedToken === token) return;
      const { model, useImages } = this.connections.local;
      await this.persist('local', { endpoint, model, useImages, token, stateDirectory }, signal);
    });
  }

  save({ mode = 'custom', endpoint = '', model = '', key = '', useImages = false }) {
    if (
      !modes.has(mode) || [endpoint, model, key].some((s) => typeof s !== 'string') ||
      endpoint.length > 2048 || model.length > 200 || key.length > 4096 ||
      typeof useImages !== 'boolean' || /[^!-~]/.test(key.trim())
    ) throw Error('INVALID_SETTINGS');
    return this.queue(async () => {
      const current = this.connections[mode];
      const normalized = mode === 'local' ? current.endpoint : endpointURL(endpoint.trim());
      const suppliedToken = mode === 'custom' ? key.trim() : '';
      const token = suppliedToken || (normalized === current.endpoint ? current.token : undefined);
      await this.persist(mode, {
        endpoint: normalized, token, model: model.trim(), useImages, stateDirectory: current.stateDirectory,
      });
      return this.config();
    });
  }
}
