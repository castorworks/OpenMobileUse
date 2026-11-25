import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { modelConfig } from '../dist/chat.js';
import { stateRoot } from './library.mjs';
import { configureHost } from './setup.mjs';

const savedKeyName = 'OMU_DESKTOP_MODEL_KEY';

async function savedHostSettings(directory) {
  try {
    const raw = JSON.parse(await readFile(join(directory, 'desktop-settings.json'), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export async function serviceEnvironment(secure, {
  environment = process.env,
  directory = stateRoot(),
  configure = configureHost,
} = {}) {
  const child = { ...environment };
  delete child.OMU_API_TOKEN;
  const saved = await savedHostSettings(directory);
  if (!child.OMU_IOS_TEAM_ID && !child.OMU_IOS_XCCONFIG && /^[A-Z0-9]{10}$/.test(saved.team ?? ''))
    child.OMU_IOS_TEAM_ID = saved.team;
  if (!child.OMU_WDA_BUNDLE_ID && /^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/i.test(saved.bundle ?? ''))
    child.OMU_WDA_BUNDLE_ID = saved.bundle;
  await configure(child);

  const explicitModel = ['OMU_MODEL_BASE_URL', 'OMU_MODEL', 'OMU_MODEL_KEY_ENV', 'DEEPSEEK_API_KEY'];
  if (child.OMU_MODEL_PROFILES !== undefined || explicitModel.some((name) => child[name]) ||
      typeof saved.endpoint !== 'string' || typeof saved.model !== 'string')
    return child;

  try {
    let secret;
    if (typeof saved.cipher === 'string' && saved.cipher) {
      const decrypted = await secure?.decryptStringAsync(Buffer.from(saved.cipher, 'base64'));
      if (typeof decrypted?.result !== 'string' || !decrypted.result) return child;
      secret = decrypted.result;
    }
    if (saved.keyRequired && !secret) return child;
    const config = modelConfig({ baseURL: saved.endpoint, model: saved.model, apiKeyEnv: secret ? savedKeyName : undefined },
      secret ? { [savedKeyName]: secret } : {});
    child.OMU_MODEL_BASE_URL = config.baseURL;
    child.OMU_MODEL = config.model;
    if (secret) {
      child.OMU_MODEL_KEY_ENV = savedKeyName;
      child[savedKeyName] = secret;
    }
  } catch {
    // Local model discovery remains available when a saved credential cannot be opened.
  }
  return child;
}
