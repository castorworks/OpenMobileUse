import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { list } from '../dist/host.js';
import { connectionError, diagnose, doctor, openDevice } from '../dist/doctor.js';
import { pending, withDevice } from '../dist/session.js';
import { captureView } from '../dist/inspect.js';
import { compileStep, maxScriptSteps, readScriptEnvelope, reason } from '../dist/script.js';
import {
  executeStep,
  guardObservation,
  isScreenContainer,
  resolveControl,
  screenAvailable,
  uniqueSelector,
} from '../dist/steps.js';
import { compileScript, executeRound } from '../dist/run.js';
import {
  listScripts,
  importScript,
  removeScript,
  renameScript,
  recordOptions,
  restoreRecording,
  scriptEntry,
} from './script-library.mjs';
import { chatClient } from '../dist/chat.js';
import { LocalAppium } from './appium.mjs';
import { androidSetupStatus, androidToolchain, applyAndroidToolchain } from './android-sdk.mjs';

import { conversationTimeLimitMs, runConversation } from '../dist/conversation.js';
import { recordStep } from '../dist/recording.js';
import {
  conversations,
  deviceDir,
  loadConversation,
  overview,
  saveConversation,
  writeJSON,
} from './library.mjs';
import { DesktopEmulator } from './emulator.mjs';
import { Preferences } from './preferences.mjs';

const platforms = ['harmony', 'ios', 'android'];
export function errorCode(error) {
  if (error instanceof SyntaxError) return 'INVALID_JSON';
  const code = reason(error);
  return code === 'DEVICE_ERROR' ? diagnose(error) : code;
}
function imageUrl(png) {
  return 'data:image/png;base64,' + png.toString('base64');
}
function conversationScript(chat, platform) {
  try {
    const script = readScriptEnvelope(chat.script, true);
    return script.platform === platform ? script : undefined;
  } catch {
    return undefined;
  }
}
async function writableConversation(identity, chatId, platform) {
  const chat = await loadConversation(identity, chatId);
  const script = conversationScript(chat, platform);
  if (!script) throw Error('INVALID_CONVERSATION_RECORDING');
  if (chat.script.schemaVersion !== 2) return chat;
  // A continuation gets its own file. Listing, exporting and replaying never rewrite the source.
  if (script.steps.length) {
    try { await compileScript(script, platform); }
    catch { throw Error('INVALID_CONVERSATION_RECORDING'); }
  }
  return { ...chat, id: randomUUID(), sourceChatId: chat.id, script };
}
async function readRuns(identity, ids) {
  const dir = deviceDir(identity, 'workbench');
  let files;
  try {
    files = ids ? ids.map((id) => id + '.json') : await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const rows = await Promise.all(
    files
      .filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))
      .map(async (f) => {
        try {
          return JSON.parse(await readFile(join(dir, f), 'utf8'));
        } catch (e) {
          if (e.code === 'ENOENT') return null; // An active turn has no completed run file yet.
          throw e;
        }
      }),
  );
  return rows.filter(Boolean).sort((a, b) => b.started.localeCompare(a.started));
}

// Older turns predate runId. Only pair matching outcomes within this chat, in execution order.
function turnsWithRuns(turns, runs) {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const linked = new Set(turns.map((t) => t.runId));
  const key = (title, status, reason, answer) => JSON.stringify([title, status, reason, answer]);
  const legacy = new Map(),
    counts = new Map();
  const turnKey = (t) => key(t.user.slice(0, 64), t.status, t.reason, t.assistant);
  for (const t of turns) if (!t.runId) counts.set(turnKey(t), (counts.get(turnKey(t)) || 0) + 1);
  for (const r of runs.slice().reverse()) {
    if (linked.has(r.id)) continue;
    const k = key(r.title, r.status, r.reason, r.result?.answer);
    if (!legacy.has(k)) legacy.set(k, []);
    legacy.get(k).push(r);
  }
  for (const [k, rows] of legacy) if (rows.length !== counts.get(k)) legacy.delete(k);
  return turns.map((t) => {
    const r = t.runId ? byId.get(t.runId) : legacy.get(turnKey(t))?.shift();
    if (!r) return t;
    const events = t.runId
      ? r.events
      : r.events.map((e) =>
          e.name?.startsWith('输入「') ? { ...e, name: '在' + e.name.slice(2) + '中输入' } : e,
        );
    return {
      ...t,
      runId: r.id,
      events,
      started: r.started,
      ended: r.ended,
      replyRequested: r.result?.replyRequested,
      historyError: r.historyError || r.cleanupError,
    };
  });
}

export class Workbench {
  targets = new Map();
  frames = new Map();
  operations = new Map();
  runs = new Map();
  closing = false;
  constructor(emit, options = {}) {
    this.emit = emit;
    this.bridge = options.bridge || { list, openDevice, doctor };
    this.appium = options.appium || new LocalAppium();
    this.emulator = new DesktopEmulator(options.confirmSetup, (message) =>
      this.emit({ type: 'setup', message }),
    );
    this.preferences = options.preferences || new Preferences(options.secure);
  }
  startEmulator() {
    return this.emulator.start();
  }
  config() {
    return this.preferences.config();
  }
  saveSettings(options) {
    return this.preferences.save(options);
  }
  async library(id) {
    this.target(id);
    return conversations(id);
  }
  async conversation(id, chatId) {
    const { platform } = this.target(id);
    const chat = await loadConversation(id, chatId);
    const group = basename(deviceDir(id, 'conversations'));
    const options = await recordOptions(group, chat.id);
    const runIds = chat.turns.every((t) => t.runId) ? chat.turns.map((t) => t.runId) : undefined;
    const runs = await readRuns(id, runIds);
    return {
      ...overview(chat),
      turns: turnsWithRuns(
        chat.turns,
        runs.filter((r) => r.chatId === chat.id || (chat.sourceChatId && r.chatId === chat.sourceChatId)),
      ),
      recordingId: conversationScript(chat, platform) ? 'record:' + group + ':' + chat.id : undefined,
      recordingHidden: !!options.hidden,
    };
  }
  scripts() {
    return listScripts();
  }
  importScript(title, text) {
    return importScript(title, text);
  }
  renameScript(id, title) {
    return renameScript(id, title);
  }
  removeScript(id) {
    return removeScript(id);
  }
  restoreRecording(id) {
    return restoreRecording(id);
  }
  async devices() {
    const tools = androidToolchain();
    applyAndroidToolchain(tools);
    const results = await Promise.allSettled(platforms.map((p) => this.bridge.list(p)));
    const rows = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    const scanErrors = Object.fromEntries(
      results.flatMap((r, i) =>
        r.status === 'rejected'
          ? [[platforms[i], r.reason?.stderr?.trim() || r.reason?.message || String(r.reason)]]
          : [],
      ),
    );
    this.targets = new Map(rows.map((t) => [t.platform + ':' + t.id, t]));
    for (const id of this.frames.keys()) if (!this.targets.has(id)) this.frames.delete(id);
    return {
      devices: [...this.targets].map(([id, t]) => ({ ...t, id })),
      unavailable: Object.keys(scanErrors),
      scanErrors,
      androidSetup: androidSetupStatus(tools),
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
  withAppium(target, work) {
    if (target.platform === 'harmony' || !this.appium.withEnvironment) return work();
    return this.appium.withEnvironment(work);
  }
  async session(t, id, signal, mode, work, onCleanupError, newCommandTimeoutSeconds) {
    if (!t.available) throw Error(connectionError(t));
    return withDevice(t, id, (dispatch) => this.withAppium(t, async () => {
      signal?.throwIfAborted();
      if (t.platform !== 'harmony') await this.appium.ensureReady();
      signal?.throwIfAborted();
      const device = await this.bridge.openDevice(
        t,
        (kind, perform) => {
          signal?.throwIfAborted();
          return dispatch(kind, perform);
        },
        mode,
        newCommandTimeoutSeconds,
        t.platform === 'android' ? 1000 : undefined,
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
    }));
  }
  async frame(device, identity, initialView) {
    const { metadata, controls, image, before, view } = await captureView(device, identity, initialView);
    this.frames.set(identity, {
      token: metadata.observationId,
      view: { ...view, layout: undefined },
      before: metadata.controlsChangedDuringCapture ? { ...before, layout: undefined } : undefined,
    });
    return {
      ...metadata,
      image: imageUrl(image),
      controls: controls
        .filter((c) => !isScreenContainer(view, c))
        .map((c) => {
          const selector = c.card && !c.secret ? uniqueSelector(view, c) : undefined;
          return {
            id: c.secret ? '' : c.id,
            labels: c.secret ? [] : c.labels,
            role: c.role,
            cardSelector: selector?.within ? selector : undefined,
            bounds: c.bounds,
            enabled: c.enabled,
            navigation: c.navigation,
            editable: c.editable && !c.secret,
            secret: c.secret,
          };
        }),
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
      this.withAppium(t, () => this.bridge.doctor(t, randomUUID(), () => this.appium.ensureReady())),
    );
  }
  action(id, raw, observation, chatId) {
    return this.exclusive(id, async (t) => {
      if (
        !/^[a-f0-9]{64}$/.test(observation) ||
        !['tap', 'swipe', 'input', 'back'].includes(raw?.action)
      )
        throw Error('INVALID_ACTION');
      const { step } = await compileStep(raw, t.platform);
      const chat = chatId ? await writableConversation(id, chatId, t.platform) : null;
      if (chat && chat.script.steps.length >= maxScriptSteps) throw Error('RECORDING_FULL');
      return this.session(t, randomUUID(), null, 'foreground', async (device) => {
        let result;
        try {
          const frame = this.frames.get(id);
          if (!frame || frame.token !== observation) throw Error('STALE_OBSERVATION');
          const view = frame.view;
          const validate = guardObservation(id, view, step, chat ? screenAvailable : undefined);
          // A screenshot falls between two layout reads. Check the actual gesture region on both sides.
          if (frame.before && (step.kind === 'swipe' || 'point' in step)) validate(frame.before);
          let item;
          if (chat) {
            screenAvailable(view);
            const node = step.selector && resolveControl(view, step.selector, step.kind === 'input');
            if (node && !raw.id && !raw.label) {
              const selector = uniqueSelector(view, node);
              if (!selector) throw Error('RECORDING_TARGET_UNAVAILABLE');
              raw = { ...raw, ...selector };
            }
            item = recordStep(view, raw, node);
          }
          result = await executeStep(device, id, step, validate);
          if (chat) {
            chat.script.steps.push(item);
            chat.updated = new Date().toISOString();
            await saveConversation(id, chat).catch(() => {
              throw Error('RECORDING_WRITE_FAILED');
            });
          }
        } catch (error) {
          if (step.kind !== 'tap' || reason(error) !== 'STALE_OBSERVATION') throw error;
          this.frames.delete(id);
          result = { action: 'tap', status: 'cancelled', reason: 'STALE_OBSERVATION' };
        }
        const continuation = chat && chat.id !== chatId && result.status === 'succeeded' ? { chatId: chat.id } : {};
        // Capture on the open session. A failed preview cannot change the tap outcome.
        try {
          return { result, ...continuation, frame: await this.frame(device, id) };
        } catch (e) {
          return { result, ...continuation, captureError: errorCode(e) };
        }
      });
    });
  }
  async history(id, scriptsOnly = false) {
    this.target(id);
    const rows = await readRuns(id);
    return {
      history: (scriptsOnly ? rows.filter((r) => !r.chatId) : rows).slice(0, 30),
      current: this.runs.get(id)?.record,
    };
  }
  async start(id, choice, imported) {
    const t = this.target(id);
    if (!t.available) throw Error(connectionError(t));
    const conversational = choice === 'chat';
    if (!conversational && choice !== 'script') throw Error('UNKNOWN_TASK');
    if (
      conversational &&
      (typeof imported?.message !== 'string' ||
        !imported.message.trim() ||
        imported.message.length > 2000)
    )
      throw Error('INVALID_MESSAGE');
    const entry = conversational ? undefined : await scriptEntry(imported);
    if (entry && !entry.platforms.includes(t.platform)) throw Error('SCRIPT_PLATFORM_MISMATCH');
    const script = entry ? await compileScript(entry.script, t.platform) : undefined;
    const controller = new AbortController();
    const config = conversational ? this.preferences.clientConfig() : undefined;
    const useImages = conversational && this.preferences.useImages === true;
    const record = {
      id: randomUUID(),
      title: conversational ? imported.message.trim().slice(0, 64) : entry.title,
      user: conversational ? imported.message.trim() : undefined,
      chatId: conversational ? imported.chatId || randomUUID() : undefined,
      mode: choice,
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
        { ...config, requestTimeoutMs: 15_000, maxRetries: 5 },
        fetch,
        (m) => {
          record.servedModel = m;
        },
        controller.signal,
        conversational,
      );
    const done = this.exclusive(id, async (target) => {
      let chat, turn;
      const progress = (event) => {
        delete record.activity;
        record.events.push({ ...event, at: new Date().toISOString() });
        notify();
      };
      const persist = async () => {
        chat.updated = new Date().toISOString();
        await saveConversation(id, chat).catch(() => {
          throw Error('RECORDING_WRITE_FAILED');
        });
      };
      try {
        if (conversational) {
          chat = imported.chatId
            ? await writableConversation(id, imported.chatId, t.platform)
            : {
                id: record.chatId,
                turns: [],
                script: { platform: t.platform, steps: [] },
              };
          record.chatId = chat.id;
          turn = { runId: record.id, started: record.started, user: record.user, status: 'running' };
          chat.turns.push(turn);
          await persist();
        }
        await this.session(
          target,
          record.id,
          controller.signal,
          script?.mode ?? 'foreground',
          async (device) => {
            let screenshotAt;
            const screenshot = async () => {
              const image = await device.screenshot();
              screenshotAt = new Date().toISOString();
              return image;
            };
            const showFrame = async (captured) => {
              if (controller.signal.aborted) return false;
              try {
                const image = captured ?? await screenshot();
                if (controller.signal.aborted) return false;
                this.emit({
                  type: 'frame',
                  device: id,
                  runId: record.id,
                  frame: {
                    image: imageUrl(image),
                    observedAt: screenshotAt,
                    controls: [],
                  },
                });
                return true;
              } catch (e) {
                this.emit({ type: 'frameError', device: id, runId: record.id, error: errorCode(e) });
                return false;
              }
            };
            // Chat publishes at the next observation so navigation has time to settle.
            // Scripts without a decision loop still publish after each native operation.
            let previewDue = true;
            const watched = { screenshot };
            let lastView;
            watched.snapshot = async () => {
              lastView = await device.snapshot();
              return lastView;
            };
            for (const name of ['foregroundApp', 'observe', 'close']) {
              watched[name] = device[name].bind(device);
            }
            const actions = ['move', 'perform', 'launch', 'back'];
            if (device.goHome) actions.push('goHome');
            for (const name of actions) {
              watched[name] = async (...args) => {
                lastView = undefined;
                const value = await device[name](...args);
                if (conversational) previewDue = true;
                else await showFrame();
                return value;
              };
            }
            let result;
            if (conversational) {
              const dialogue = chat.turns
                .slice(-8)
                .map(({ user, assistant, reason }) => ({ user, assistant: assistant || reason, reason }));
              const capture = async (item) => {
                chat.script.steps.push(item);
                await persist();
                record.stepCount = chat.script.steps.length;
                if (item.action === 'pause') previewDue = true;
              };
              result = await runConversation(
                watched,
                id,
                t.platform,
                dialogue,
                decide,
                controller.signal,
                capture,
                (name, status) => progress({ kind: 'action', name, status }),
                () => chat.script.steps.length < maxScriptSteps,
                (activity) => {
                  record.activity = activity;
                  notify();
                },
                useImages,
                async (image) => {
                  if (!image && !previewDue) return;
                  previewDue = !(await showFrame(image));
                },
              );
            } else {
              result = await executeRound(watched, id, { script }, controller.signal, progress);
            }
            record.result = result;
            record.status = result.status;
            record.reason = result.reason;
            try {
              // A successful chat just checked this view. The preview still reads again after its screenshot.
              const initialView = conversational && result.status === 'succeeded' ? lastView : undefined;
              this.emit({
                type: 'frame',
                device: id,
                runId: record.id,
                frame: await this.frame(device, id, initialView),
              });
            } catch (e) {
              this.emit({ type: 'frameError', device: id, runId: record.id, error: errorCode(e) });
            }
          },
          (code) => {
            record.cleanupError = code;
          },
          conversational ? conversationTimeLimitMs / 1000 + 30 : undefined,
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
          if (turn) {
            turn.assistant = record.result?.answer;
            turn.status = record.status;
            turn.reason = record.reason;
            chat.updated = record.ended;
            await saveConversation(id, chat);
          }
          await writeJSON(deviceDir(id, 'workbench'), record.id + '.json', record);
        } catch {
          record.historyError = 'HISTORY_WRITE_FAILED';
        }
        this.runs.delete(id);
        notify();
      }
    });
    this.runs.set(id, { controller, record });
    notify();
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
    const installation = this.emulator.close();
    await Promise.allSettled(this.operations.values());
    await this.appium.close();
    await installation;
    this.preferences.key = undefined;
  }
}
