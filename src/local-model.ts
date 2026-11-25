import { modelConfig } from './chat.js';
import type { ModelProfile } from './run-service.js';

const ollama = 'http://127.0.0.1:11434';
type OllamaModel = {
  name?: unknown;
  model?: unknown;
  capabilities?: unknown;
  remote_host?: unknown;
  remote_model?: unknown;
};

function remote(model: OllamaModel) {
  return Boolean(model.remote_host || model.remote_model);
}

export async function detectLocalOllama(
  allowImages: boolean,
  transport = fetch,
  signal = AbortSignal.timeout(1800),
): Promise<ModelProfile | undefined> {
  let models: unknown;
  try {
    const response = await transport(ollama + '/api/tags', { signal, redirect: 'error' });
    if (!response.ok) return;
    models = (await response.json() as { models?: unknown } | null)?.models;
  } catch {
    return;
  }
  if (!Array.isArray(models)) return;

  for (const entry of models as (OllamaModel | null)[]) {
    if (signal.aborted) return;
    if (!entry || remote(entry)) continue;
    const name = typeof entry.name === 'string' ? entry.name : entry.model;
    if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[:-]cloud(?=[:/-]|$)/i.test(name))
      continue;

    try {
      const response = await transport(ollama + '/api/show', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name }), signal, redirect: 'error',
      });
      if (!response.ok) continue;
      const details = await response.json() as OllamaModel | null;
      if (!details || remote(details) || !Array.isArray(details.capabilities) ||
          !details.capabilities.includes('tools') || details.capabilities.includes('cloud')) continue;
      return {
        id: 'ollama',
        allowsImages: allowImages && details.capabilities.includes('vision'),
        config: modelConfig({ baseURL: ollama + '/v1', model: name }),
      };
    } catch {
      // A stale model entry does not prevent inspecting the next installed model.
    }
  }
}
