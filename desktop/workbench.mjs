import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { list } from '../dist/host.js';
import { connectionError, diagnose, doctor, openDevice } from '../dist/doctor.js';
import { pending, withDevice } from '../dist/session.js';
import { captureView } from '../dist/inspect.js';
import { compileStep, readScript, reason } from '../dist/script.js';
import { executeStep } from '../dist/steps.js';
import { executeRound } from '../dist/run.js';
import { parseTask } from '../dist/task.js';
import { chatClient, modelConfig } from '../dist/chat.js';
import { LocalAppium } from './appium.mjs';

const platforms = ['harmony', 'ios', 'android'];
const builtins = {
  'agent-bluetooth': { mode: 'agent', title: '蓝牙导航' },
  'script-bluetooth': { mode: 'script', title: '蓝牙导航', file: 'settings-bluetooth.json' },
  'script-search': { mode: 'script', title: '设置搜索', file: 'settings-search.json' },
};
export function errorCode(error) {
  if (error instanceof SyntaxError) return 'INVALID_JSON';
  const code = reason(error);
  return code === 'DEVICE_ERROR' ? diagnose(error) : code;
}
function imageUrl(png) {
  return 'data:image/png;base64,' + png.toString('base64');
}
function reportDir(identity) {
  const device = createHash('sha256').update(identity).digest('hex');
  return join(process.env.OMU_STATE_DIR || join(homedir(), '.openmobileuse'), 'workbench', device);
}
async function saveRun(identity, record) {
  const dir = reportDir(identity);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, record.id + '.json');
  await writeFile(file + '.tmp', JSON.stringify(record), { mode: 0o600 });
  await rename(file + '.tmp', file);
}
async function readRuns(identity) {
  const dir = reportDir(identity);
  let files;
  try {
    files = await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const rows = await Promise.all(
    files
      .filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))
      .map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8'))),
  );
  return rows.sort((a, b) => b.started.localeCompare(a.started)).slice(0, 30);
}

export class Workbench {
  targets = new Map();
  operations = new Map();
  runs = new Map();
  closing = false;
  constructor(emit, options = {}) {
    this.emit = emit;
    this.bridge = options.bridge || { list, openDevice, doctor };
    this.appium = options.appium || new LocalAppium();
    this.modelOptions = {
      baseURL: process.env.OMU_MODEL_BASE_URL,
      model: process.env.OMU_MODEL,
      apiKeyEnv: process.env.OMU_MODEL_KEY_ENV,
    };
    this.keyEnv =
      this.modelOptions.apiKeyEnv ||
      (!this.modelOptions.baseURL ||
      new URL(this.modelOptions.baseURL).href === 'https://api.deepseek.com/'
        ? 'DEEPSEEK_API_KEY'
        : undefined);
    this.credential = this.keyEnv ? process.env[this.keyEnv] : undefined;
    if (this.keyEnv) delete process.env[this.keyEnv];
  }
  config() {
    return {
      model: this.modelOptions.model || 'deepseek-flash',
      endpoint: this.modelOptions.baseURL || 'https://api.deepseek.com',
      needsKey: Boolean(this.keyEnv && !this.credential),
    };
  }
  setKey(key) {
    if (typeof key !== 'string' || !key.trim() || key.length > 2048 || !this.keyEnv)
      throw Error('INVALID_MODEL_KEY');
    this.credential = key.trim();
    return this.config();
  }
  async devices() {
    const results = await Promise.allSettled(platforms.map((p) => this.bridge.list(p)));
    const rows = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    this.targets = new Map(rows.map((t) => [t.platform + ':' + t.id, t]));
    return {
      devices: [...this.targets].map(([id, t]) => ({ ...t, id })),
      unavailable: platforms.filter((_, i) => results[i].status === 'rejected'),
    };
  }
  target(identity) {
    const t = this.targets.get(identity);
    if (!t) throw Error('DEVICE_UNAVAILABLE');
    return t;
  }
  exclusive(identity, work) {
    const target = this.target(identity);
    if (this.closing) throw Error('CANCELLED');
    if (this.operations.has(identity)) throw Error('DEVICE_BUSY');
    const done = Promise.resolve()
      .then(() => work(target))
      .finally(() => this.operations.delete(identity));
    this.operations.set(identity, done);
    return done;
  }
  async session(t, id, signal, mode, work, onCleanupError) {
    if (!t.available) throw Error(connectionError(t));
    return withDevice(t, id, async (dispatch) => {
      if (t.platform !== 'harmony') await this.appium.ensureReady();
      signal?.throwIfAborted();
      const device = await this.bridge.openDevice(
        t,
        (kind, perform) => {
          signal?.throwIfAborted();
          return dispatch(kind, perform);
        },
        mode,
      );
      try {
        return await work(device);
      } finally {
        try {
          await device.close();
        } catch {
          onCleanupError?.('DEVICE_SESSION_CLOSE_FAILED');
        }
      }
    });
  }
  async frame(device, identity) {
    let capture;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        capture = await captureView(device, identity);
        if (!capture.metadata.controlsChangedDuringCapture) break;
        if (attempt === 2) throw Error('STALE_OBSERVATION');
      } catch (error) {
        if (
          attempt === 2 ||
          !['FOREGROUND_WINDOW_AMBIGUOUS', 'STALE_OBSERVATION', 'FOREGROUND_APP_UNAVAILABLE'].includes(
            error.message,
          )
        )
          throw error;
      }
      await wait(200);
    }
    const { metadata, controls, image } = capture;
    return {
      ...metadata,
      image: imageUrl(image),
      controls: controls.map((c) => ({
        id: c.secret ? '' : c.id,
        labels: c.secret ? [] : c.labels,
        role: c.role,
        bounds: c.bounds,
        enabled: c.enabled,
        navigation: c.navigation,
        editable: c.editable && !c.secret,
        secret: c.secret,
      })),
    };
  }
  refresh(id) {
    return this.exclusive(id, (t) =>
      this.session(t, randomUUID(), null, 'foreground', async (d) => ({
        frame: await this.frame(d, id),
        unconfirmed: pending(t),
      })),
    );
  }
  probe(id) {
    return this.exclusive(id, (t) =>
      this.bridge.doctor(t, randomUUID(), () => this.appium.ensureReady()),
    );
  }
  action(id, raw, observation) {
    return this.exclusive(id, async (t) => {
      if (!/^[a-f0-9]{64}$/.test(observation) || !['tap', 'swipe', 'input', 'back'].includes(raw?.action))
        throw Error('INVALID_ACTION');
      const { step } = await compileStep(raw, t.platform);
      return this.session(t, randomUUID(), null, 'foreground', async (device) => {
        const result = await executeStep(device, id, step, observation);
        // Keep a confirmed write distinct from a subsequent capture failure.
        try {
          return { result, frame: await this.frame(device, id) };
        } catch (e) {
          return { result, captureError: errorCode(e) };
        }
      });
    });
  }
  async history(id) {
    this.target(id);
    return { history: await readRuns(id), current: this.runs.get(id)?.record };
  }
  async start(id, choice, imported, vision = false) {
    const t = this.target(id);
    if (!t.available) throw Error(connectionError(t));
    const custom = choice === 'custom-agent' || choice === 'custom-script';
    const preset = custom
      ? {
          title: choice === 'custom-agent' ? '自定义 Agent' : '自定义脚本',
          mode: choice === 'custom-agent' ? 'agent' : 'script',
        }
      : Object.hasOwn(builtins, choice) && builtins[choice];
    if (!preset) throw Error('UNKNOWN_TASK');
    if (custom && (typeof imported !== 'string' || Buffer.byteLength(imported) > 262144))
      throw Error('INVALID_FILE');
    const data = custom
      ? JSON.parse(imported)
      : preset.file
        ? JSON.parse(await readFile(new URL('../examples/' + preset.file, import.meta.url), 'utf8'))
        : undefined;
    const script = preset.mode === 'script' ? await readScript(data, t.platform) : undefined;
    const task = custom && preset.mode === 'agent' ? await parseTask(data, t.platform) : undefined;
    if (vision && !task?.actions.some((a) => a.visual)) throw Error('TASK_HAS_NO_VISUAL_ACTIONS');
    const controller = new AbortController();
    const config =
      preset.mode === 'agent'
        ? modelConfig(this.modelOptions, this.keyEnv ? { [this.keyEnv]: this.credential } : {})
        : undefined;
    const record = {
      id: randomUUID(),
      title: task?.id || preset.title,
      mode: preset.mode,
      model: config?.model,
      endpoint: config?.baseURL,
      started: new Date().toISOString(),
      status: 'running',
      events: [],
    };
    const notify = () => this.emit({ type: 'run', device: id, record });
    const decide =
      config &&
      chatClient(
        config,
        fetch,
        (m) => {
          record.servedModel = m;
        },
        controller.signal,
      );
    const done = this.exclusive(id, async (target) => {
      try {
        notify();
        await this.session(
          target,
          record.id,
          controller.signal,
          task || script?.kind === 'general' ? 'foreground' : 'settings',
          async (device) => {
            const showFrame = async () => {
              if (controller.signal.aborted) return;
              try {
                this.emit({
                  type: 'frame',
                  device: id,
                  runId: record.id,
                  frame: {
                    image: imageUrl(await device.screenshot()),
                    observedAt: new Date().toISOString(),
                    controls: [],
                  },
                });
              } catch (e) {
                this.emit({ type: 'frameError', device: id, runId: record.id, error: errorCode(e) });
              }
            };
            // The task's own session supplies previews, in order, after actual native operations.
            const watched = {};
            for (const name of ['snapshot', 'foregroundApp', 'observe', 'screenshot', 'close']) {
              watched[name] = device[name].bind(device);
            }
            for (const name of ['move', 'perform', 'launch', 'back']) {
              watched[name] = async (...args) => {
                const value = await device[name](...args);
                await showFrame();
                return value;
              };
            }
            const result = await executeRound(
              watched,
              id,
              { task, script, decide, vision },
              controller.signal,
              (event) => {
                record.events.push({ ...event, at: new Date().toISOString() });
                notify();
              },
            );
            record.result = result;
            record.status = result.status;
            record.reason = result.reason;
            try {
              this.emit({
                type: 'frame',
                device: id,
                runId: record.id,
                frame: await this.frame(device, id),
              });
            } catch (e) {
              this.emit({ type: 'frameError', device: id, runId: record.id, error: errorCode(e) });
            }
          },
          (code) => {
            record.cleanupError = code;
          },
        );
      } catch (e) {
        if (record.result) record.cleanupError = errorCode(e);
        else {
          record.reason = errorCode(e);
          record.status = 'failed';
        }
      } finally {
        if (record.reason === 'CANCELLED') record.status = 'cancelled';
        record.ended = new Date().toISOString();
        try {
          await saveRun(id, record);
        } catch {
          record.historyError = 'HISTORY_WRITE_FAILED';
        }
        this.runs.delete(id);
        notify();
      }
    });
    this.runs.set(id, { controller, record });
    // Observe unexpected infrastructure failures even if the window has already closed.
    done.catch(() => {});
    return record.id;
  }
  stop(id, runId) {
    const active = this.runs.get(id);
    if (!active || active.record.id !== runId) throw Error('RUN_NOT_ACTIVE');
    active.controller.abort(Error('CANCELLED'));
  }
  async shutdown() {
    this.closing = true;
    for (const { controller } of this.runs.values()) controller.abort(Error('CANCELLED'));
    await Promise.allSettled(this.operations.values());
    await this.appium.close();
    this.credential = undefined;
  }
}
