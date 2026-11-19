import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { modelConfig } from '../dist/chat.js';
import { stateRoot, writeJSON } from './library.mjs';

// Probe only the local Ollama service. Skip cloud-backed models and require native tool calls.
async function detectLocalModel() {
  const host = 'http://127.0.0.1:11434';
  const signal = AbortSignal.timeout(1800);
  try {
    const list = await fetch(host + '/api/tags', { signal, redirect: 'error' });
    if (!list.ok) return;
    const { models } = await list.json();
    for (const model of (models || []).slice(0, 8)) {
      if (!model.name || model.remote_model || /:cloud$|-cloud$/.test(model.name)) continue;
      const res = await fetch(host + '/api/show', {
        method: 'POST',
        signal,
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model.name }),
      });
      if (!res.ok) continue;
      const info = await res.json();
      if (!info.remote_model && info.capabilities?.includes('tools'))
        return { endpoint: host + '/v1', model: model.name };
    }
  } catch {
    /* An unconfigured desktop falls back to its default provider. */
  }
}
export class Preferences {
  constructor(secure) {
    this.secure = secure;
    this.endpoint = process.env.OMU_MODEL_BASE_URL || 'https://api.deepseek.com';
    this.model = process.env.OMU_MODEL || 'deepseek-flash';
    this.useImages = false;
    const name =
      process.env.OMU_MODEL_KEY_ENV ||
      (this.endpoint.replace(/\/$/, '') === 'https://api.deepseek.com' ? 'DEEPSEEK_API_KEY' : undefined);
    this.key = name && process.env[name];
    this.keyRequired = Boolean(name);
    if (name) delete process.env[name];
  }
  async load() {
    const file = await readFile(join(stateRoot(), 'desktop-settings.json'), 'utf8').catch((e) => {
      if (e.code === 'ENOENT') return;
      throw e;
    });
    if (!file) {
      if (!this.key && !process.env.OMU_MODEL_BASE_URL && !process.env.OMU_MODEL) {
        const local = await detectLocalModel();
        if (local) Object.assign(this, local, { keyRequired: false });
      }
      return;
    }
    const data = JSON.parse(file);
    if (this.endpoint !== data.endpoint) this.key = undefined;
    this.endpoint = data.endpoint;
    this.model = data.model;
    this.useImages = data.useImages === true;
    this.keyRequired = data.keyRequired;
    if (data.cipher) {
      try {
        this.key = (await this.secure.decryptStringAsync(Buffer.from(data.cipher, 'base64'))).result;
      } catch {
        this.key = undefined;
      }
    }
    this.team = data.team;
    if (this.team) process.env.OMU_IOS_TEAM_ID = this.team;
    this.bundle = data.bundle;
    if (this.bundle) process.env.OMU_WDA_BUNDLE_ID = this.bundle;
  }
  config() {
    return {
      endpoint: this.endpoint,
      model: this.model,
      useImages: this.useImages,
      needsKey: this.keyRequired && !this.key,
      macHost: process.platform === 'darwin',
      hasKey: !!this.key,
      team: this.team || process.env.OMU_IOS_TEAM_ID || '',
      bundle: this.bundle || process.env.OMU_WDA_BUNDLE_ID || 'com.castorworks.openmobileuse.wda',
    };
  }
  clientConfig() {
    const options = {
      baseURL: this.endpoint,
      model: this.model,
      apiKeyEnv: this.key || this.keyRequired ? 'OMU_DESKTOP_KEY' : undefined,
    };
    if (this.keyRequired && !this.key) throw Error('MODEL_KEY_REQUIRED');
    return modelConfig(options, this.key ? { OMU_DESKTOP_KEY: this.key } : {});
  }
  async save({ endpoint, model, key, team, bundle, useImages = false }) {
    if (
      [endpoint, model, key, team, bundle].some((s) => typeof s !== 'string') ||
      key.length > 4096 ||
      endpoint.length > 2048 ||
      model.length > 200 ||
      typeof useImages !== 'boolean' ||
      (team && !/^[A-Z0-9]{10}$/.test(team)) ||
      (bundle && !/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/.test(bundle))
    )
      throw Error('INVALID_SETTINGS');
    let normalized;
    try {
      normalized = modelConfig(
        { baseURL: endpoint.trim(), model: model.trim(), apiKeyEnv: 'KEY' },
        { KEY: 'validate' },
      );
    } catch {
      throw Error('INVALID_SETTINGS');
    }
    const same = normalized.baseURL === this.endpoint.replace(/\/$/, '');
    if (
      useImages &&
      new URL(normalized.baseURL).hostname === 'api.deepseek.com' &&
      normalized.model === 'deepseek-v4-pro'
    )
      throw Error('MODEL_IMAGES_UNSUPPORTED');
    const secret = key.trim() || (same ? this.key : undefined);
    const keyRequired = normalized.baseURL === 'https://api.deepseek.com' || !!secret;
    let cipher;
    if (secret) {
      try {
        cipher = (await this.secure.encryptStringAsync(secret)).toString('base64');
      } catch {
        throw Error('KEYCHAIN_UNAVAILABLE');
      }
    }
    await writeJSON(stateRoot(), 'desktop-settings.json', {
      endpoint: normalized.baseURL,
      model: normalized.model,
      useImages,
      cipher,
      keyRequired,
      team,
      bundle,
    });
    Object.assign(this, {
      endpoint: normalized.baseURL,
      useImages,
      model: normalized.model,
      key: secret,
      keyRequired,
      team,
      bundle,
    });
    if (team) process.env.OMU_IOS_TEAM_ID = team;
    else delete process.env.OMU_IOS_TEAM_ID;
    if (bundle) process.env.OMU_WDA_BUNDLE_ID = bundle;
    else delete process.env.OMU_WDA_BUNDLE_ID;
    return this.config();
  }
}
