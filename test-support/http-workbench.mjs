import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workbench } from '../desktop/workbench.mjs';
import { ApiClient } from '../dist/api-client.js';
import { createApiServer } from '../dist/http.js';

export async function androidWorkbench(t, phone, transport = fetch, profiles = []) {
  const directory = await mkdtemp(join(tmpdir(), 'omu-http-android-'));
  const previous = process.env.OMU_STATE_DIR;
  process.env.OMU_STATE_DIR = directory;
  const token = randomUUID();
  const open = t.mock.fn(async () => ({ device: phone, close: async () => {} }));
  const service = await createApiServer({ directory, port: 0, bootstrapToken: token, profiles, drivers: {
    discover: async platform => platform === 'android' ? [{ platform, id: 'test-phone', model: 'Android', connection: 'usb', available: true }] : [],
    status: async platform => ({ platform, available: platform === 'android' }), open, close: async () => {},
  } });
  const api = new ApiClient({ baseURL: service.url, token, fetch: transport });
  const wb = new Workbench(() => {}, { api, preferences: { config: () => ({ model: profiles[0]?.id, useImages: false }) } });
  t.after(async () => {
    await wb.shutdown();
    await service.close();
    if (previous === undefined) delete process.env.OMU_STATE_DIR;
    else process.env.OMU_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const { devices: [target] } = await wb.devices();
  return { id: target.id, wb, api, open };
}
