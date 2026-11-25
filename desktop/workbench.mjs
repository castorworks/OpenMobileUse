import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { ApiClient, terminalRunStatus } from '../dist/api-client.js';
import { discoverLocalConnection } from '../dist/local-connection.js';
import { isScreenContainer } from '../dist/steps.js';
import { androidSetupStatus, androidToolchain } from './android-sdk.mjs';
import { DesktopEmulator } from './emulator.mjs';
import { Preferences } from './preferences.mjs';
import { listItems, ScriptLibrary } from './script-library.mjs';

const devicePath = (id) => '/api/devices/' + encodeURIComponent(id);
const conversationPath = (id) => '/api/conversations/' + encodeURIComponent(id);
const runPath = (id) => '/api/runs/' + encodeURIComponent(id);
const labels = { chat: '对话', script: '脚本重放', agent: 'Agent 任务' };
const visibleRun = (run) => Object.hasOwn(labels, run.kind);
const recoverableConnectionErrors = new Set([
  'API_UNREACHABLE', 'API_TIMEOUT', 'UNAUTHORIZED', 'API_TOKEN_REQUIRED', 'SERVICE_DRAINING', 'SERVICE_UNAVAILABLE',
]);

function createApiClient(config) {
  const { baseURL, stateDirectory } = config;
  if (!stateDirectory) return new ApiClient(config);
  const origin = new URL(baseURL).origin;
  return new ApiClient({ ...config, fetch: async (url, options) => {
    // A detached daemon's old port can later belong to another process.
    const connection = await discoverLocalConnection(stateDirectory, { signal: options.signal });
    if (!connection || new URL(connection.url).origin !== origin) throw Error('API_UNREACHABLE');
    return fetch(url, options);
  } });
}

export function errorCode(error) {
  if (error instanceof SyntaxError) return 'INVALID_JSON';
  if (error?.name === 'TimeoutError') return 'API_TIMEOUT';
  if (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code)) return error.code;
  return /^[A-Z][A-Z_0-9]*(?=:|$)/.exec(error?.message)?.[0] || 'API_REQUEST_FAILED';
}

function progressEvent(event) {
  const { at, data } = event;
  if (event.type === 'run.progress') return { ...data, name: data.name, at };
  if (event.type === 'step.result') return { kind: 'step', name: data.action, status: data.error || data.status, at };
}

function runView(run, events = [], display = {}) {
  const lastRound = run.result?.rounds?.at(-1);
  const progress = events.map(progressEvent).filter(Boolean);
  const evidence = lastRound?.evidence;
  for (const entry of evidence || []) {
    if (entry.phase && typeof entry.bluetooth === 'boolean') {
      progress.push({ kind: 'evidence', ...entry, name: entry.page, at: run.finishedAt });
    }
  }
  return {
    id: run.id,
    status: run.status,
    mode: run.kind === 'agent' ? 'script' : run.kind,
    title: display.title || run.title || labels[run.kind],
    user: display.user,
    chatId: run.conversationId || run.result?.conversationId,
    started: run.startedAt || run.createdAt,
    ended: run.finishedAt,
    activity: !terminalRunStatus(run.status) ? progress.at(-1)?.message : undefined,
    events: progress,
    result: lastRound || run.result,
    reason: run.reason || lastRound?.reason,
    cleanupError: run.cleanupError,
  };
}

function chatOverview(chat) {
  return { ...chat, updated: chat.updatedAt, stepCount: chat.recordedStepCount };
}

export class Workbench {
  watchers = new Map();
  pendingSubmissions = new Map();
  lifecycle = new AbortController();
  closing = false;
  capabilities = null;
  connectionStatus = 'idle';
  localReady = false;

  constructor(emit, options = {}) {
    this.emit = emit;
    this.http = options.api;
    this.hasInjectedApi = !!options.api;
    this.makeClient = options.createClient || createApiClient;
    this.launchLocal = options.ensureLocalService || (async (preferences, settings) => {
      const { ensureLocalService } = await import('./local-service.mjs');
      return ensureLocalService(preferences, settings);
    });
    this.localOptions = options.localServiceOptions || {};
    this.emulator = options.emulator || new DesktopEmulator(options.confirmSetup, (message) =>
      this.emit({ type: 'setup', message }),
    );
    this.preferences = options.preferences || new Preferences(options.secure);
    this.secure = options.secure || this.preferences.secure;
  }

  context() {
    this.lifecycle.signal.throwIfAborted();
    this.http ??= this.makeClient(this.preferences.clientConfig());
    return { api: this.http, signal: this.lifecycle.signal };
  }

  config() {
    return {
      ...this.preferences.config(), modelProfiles: this.capabilities?.modelProfiles || [],
      connectionStatus: this.connectionStatus, connectionError: this.connectionError,
    };
  }

  automatic() {
    return !this.hasInjectedApi && this.preferences.config().mode === 'local';
  }

  connection(status, error, reconnected = false) {
    if (status === this.connectionStatus && error === this.connectionError && !reconnected) return;
    this.connectionStatus = status;
    this.connectionError = error;
    this.emit({ type: 'connection', config: this.config(), reconnected });
  }

  async ensureConnection(force = false) {
    if (!this.automatic()) return this.context();
    if (this.connecting) return this.connecting;
    if (!force && this.localReady) return this.context();
    if (!this.connecting) {
      const signal = this.lifecycle.signal;
      const reconnected = this.localReady || this.connectionStatus === 'offline';
      this.connection('connecting');
      const attempt = (async () => {
        try {
          const local = await this.launchLocal(this.preferences, { ...this.localOptions, secure: this.secure, signal });
          signal.throwIfAborted();
          const previous = this.preferences.clientConfig();
          if (this.localReady && previous.stateDirectory && local.stateDirectory !== previous.stateDirectory)
            throw Error('LOCAL_SERVICE_STATE_CHANGED');
          await this.preferences.configureLocal(local, signal);
          signal.throwIfAborted();
          if (!this.automatic()) throw Error('CANCELLED');
          const next = this.preferences.clientConfig();
          if (previous.baseURL !== next.baseURL || previous.token !== next.token) this.http = undefined;
          this.localReady = true;
          this.connection('online', undefined, reconnected);
          return this.context();
        } catch (error) {
          if (!signal.aborted) {
            this.localReady = false;
            this.connection('offline', errorCode(error));
          }
          throw error;
        }
      })();
      this.connecting = attempt;
      void attempt.finally(() => {
        if (this.connecting === attempt) this.connecting = undefined;
      }).catch(() => {});
    }
    return this.connecting;
  }

  async checkLocal() {
    if (!this.automatic() || this.closing || this.connecting || this.checkingLocal) return;
    this.checkingLocal = true;
    const { api, signal } = this.context();
    try {
      if (!this.localReady) await this.ensureConnection();
      else {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(2500)]);
        await api.json('/readyz', { signal: deadline });
      }
    } catch (error) {
      if (!signal.aborted && this.localReady && recoverableConnectionErrors.has(errorCode(error)))
        await this.ensureConnection(true);
    } finally {
      this.checkingLocal = false;
    }
  }

  startConnectionMonitor() {
    if (this.connectionTimer) return;
    const check = () => { void this.checkLocal().catch(() => {}); };
    this.connectionTimer = setInterval(check, 5000);
    this.connectionTimer.unref();
    check();
  }

  async recoverConnection(api, signal, error) {
    if (!this.automatic() || signal.aborted || !recoverableConnectionErrors.has(errorCode(error))) throw error;
    const current = this.context().api;
    if (current !== api && this.localReady) return current;
    return (await this.ensureConnection(true)).api;
  }

  async saveSettings(options) {
    const mode = this.preferences.config().mode;
    const previous = this.preferences.clientConfig();
    await this.preferences.save(options);
    const next = this.preferences.clientConfig();
    if (mode !== this.preferences.config().mode || previous.baseURL !== next.baseURL || previous.token !== next.token) {
      this.lifecycle.abort(Error('CANCELLED'));
      this.lifecycle = new AbortController();
      this.watchers.clear();
      this.pendingSubmissions.clear();
      this.http = undefined;
      this.capabilities = null;
      this.connecting = undefined;
      this.localReady = false;
      this.connection('idle');
    }
    return this.config();
  }

  assertLocalHost() {
    if (!this.preferences.config().local) throw Error('REMOTE_HOST_SETUP');
  }

  startEmulator() {
    this.assertLocalHost();
    return this.emulator.start();
  }

  async diagnoseService() {
    const { api, signal: lifecycle } = this.context();
    const signal = AbortSignal.any([lifecycle, AbortSignal.timeout(8000)]);
    const probes = [['HTTP 服务', '/healthz'], ['运行受理', '/readyz'], ['访问令牌与驱动', '/api/capabilities']];
    const checks = await Promise.all(probes.map(async ([label, path]) => {
      try {
        const result = await api.json(path, { signal });
        const rows = [{ label, status: result.status || 'ok' }];
        if (path === '/api/capabilities') {
          this.capabilities = result;
          for (const driver of result.drivers) rows.push({
            label: driver.platform, status: driver.available ? 'ok' : driver.code || 'TOOL_NOT_FOUND',
          });
        }
        return rows;
      } catch (error) {
        return [{ label, status: errorCode(error) }];
      }
    }));
    return checks.flat();
  }

  async devices() {
    let context = await this.ensureConnection();
    const read = ({ api, signal }) => Promise.all([
      listItems(api, '/api/devices', { query: { refresh: 'true' }, signal }), api.json('/api/capabilities', { signal }),
    ]);
    let rows, capabilities;
    try {
      [rows, capabilities] = await read(context);
    } catch (error) {
      if (!this.automatic() || context.signal.aborted || !recoverableConnectionErrors.has(errorCode(error))) {
        if (!context.signal.aborted) this.connection('offline', errorCode(error));
        throw error;
      }
      context = await this.ensureConnection(true);
      try {
        [rows, capabilities] = await read(context);
      } catch (retryError) {
        if (!context.signal.aborted) this.connection('offline', errorCode(retryError));
        throw retryError;
      }
    }
    this.capabilities = capabilities;
    this.connection('online');
    const unavailable = capabilities.drivers.filter((driver) => !driver.available);
    return {
      devices: rows.map((row) => ({ ...row, model: row.name, available: row.state === 'available' })),
      unavailable: unavailable.map((driver) => driver.platform),
      scanErrors: Object.fromEntries(unavailable.map((driver) => [driver.platform, driver.code || 'TOOL_NOT_FOUND'])),
      androidSetup: this.preferences.config().local ? androidSetupStatus(androidToolchain()) : null,
      modelProfiles: capabilities.modelProfiles,
    };
  }

  async library(id) {
    const { api, signal } = this.context();
    const rows = await listItems(api, '/api/conversations', { query: { deviceId: id }, signal });
    return rows.map(chatOverview);
  }

  async conversation(id, chatId) {
    const { api, signal } = this.context();
    const path = conversationPath(chatId);
    const response = await api.request(path, { signal });
    const revision = response.headers.get('etag');
    if (!revision) throw Error('API_INVALID_RESPONSE');
    const chat = await response.json();
    if (chat.deviceId !== id) throw Error('UNKNOWN_CONVERSATION');
    const messages = await listItems(api, path + '/messages', { signal });
    const turns = new Map();
    for (const { turn, role, runId, content, createdAt, replyRequested } of messages) {
      if (turn > chat.lastTurn) break;
      const item = turns.get(turn) || { runId, started: createdAt };
      if (role === 'user') item.user = content;
      else Object.assign(item, { assistant: content, replyRequested, ended: createdAt });
      turns.set(turn, item);
    }
    const items = [...turns.values()];
    for (let index = 0; index < items.length; index += 8) {
      await Promise.all(items.slice(index, index + 8).map(async (turn) => {
        try {
          const run = turn.runId && await api.getRun(turn.runId, signal);
          if (!run) return;
          const events = await this.events(api, run.id, signal);
          const view = runView(run, events, { user: turn.user });
          Object.assign(turn, {
            ...view, runId: run.id,
            assistant: view.result?.answer ?? turn.assistant,
            replyRequested: view.result?.replyRequested ?? turn.replyRequested,
          });
        } catch (error) {
          if (error.status !== 404 && error.status !== 410) throw error;
        } finally {
          turn.status ??= turn.replyRequested ? 'needs_review' : turn.assistant ? 'succeeded' : 'interrupted';
        }
      }));
    }
    return {
      ...chatOverview(chat), turns: items.filter((turn) => turn.user !== undefined),
      recordingId: chat.recordedStepCount ? chat.id : undefined,
      revision,
    };
  }

  async conversationTag(api, signal, id, deviceId) {
    const response = await api.request(conversationPath(id), { signal });
    const etag = response.headers.get('etag');
    const value = await response.json();
    if (!etag) throw Error('API_INVALID_RESPONSE');
    if (value.deviceId !== deviceId) throw Error('UNKNOWN_CONVERSATION');
    return etag;
  }

  scriptLibrary() {
    const { api, signal } = this.context();
    return new ScriptLibrary(api, signal);
  }

  scripts(includeArchived = false) {
    return this.scriptLibrary().list(includeArchived);
  }

  async importScript(title, text) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 8 * 1024 * 1024) throw Error('INVALID_FILE');
    return (await this.scriptLibrary().create({ source: 'document', title, script: JSON.parse(text) })).id;
  }

  async saveRecording(conversationId, title) {
    return (await this.scriptLibrary().create({ source: 'conversationRecording', conversationId, title })).id;
  }

  async continueRecording(deviceId, sourceScriptId, sourceScriptETag) {
    const { api, signal } = this.context();
    return api.json('/api/conversations', { method: 'POST', signal, body: { deviceId, sourceScriptId, sourceScriptETag } });
  }

  scriptInfo(id) {
    return this.scriptLibrary().entry(id);
  }

  renameScript(id, title, revision) {
    return this.scriptLibrary().patch(id, { title }, revision);
  }

  removeScript(id, revision) {
    return this.scriptLibrary().patch(id, { archived: true }, revision);
  }

  restoreRecording(id, revision) {
    return this.scriptLibrary().patch(id, { archived: false }, revision);
  }

  exportScript(id) {
    return this.scriptLibrary().export(id);
  }

  async submit(api, signal, body) {
    // If the network loses an accepted reply, the next attempt must reuse its request and key.
    const fingerprint = JSON.stringify({ ...body, input: { ...body.input, conversationETag: undefined } });
    const pending = this.pendingSubmissions.get(fingerprint) || { body, idempotencyKey: randomUUID() };
    this.pendingSubmissions.set(fingerprint, pending);
    for (let attempt = 0; ; attempt++) {
      try {
        const run = await api.submitRun(pending.body, { signal, idempotencyKey: pending.idempotencyKey });
        if (!signal.aborted) this.pendingSubmissions.delete(fingerprint);
        return run;
      } catch (error) {
        if (signal.aborted) throw error;
        if (!attempt && this.automatic() && recoverableConnectionErrors.has(errorCode(error))) {
          api = await this.recoverConnection(api, signal, error);
          continue;
        }
        if (!['API_TIMEOUT', 'API_UNREACHABLE'].includes(errorCode(error))) {
          this.pendingSubmissions.delete(fingerprint);
          throw error;
        }
        if (attempt) throw Error('RUN_SUBMISSION_UNCONFIRMED');
        await wait(250, undefined, { signal });
      }
    }
  }

  async invoke(api, signal, body) {
    const submitted = await this.submit(api, signal, body);
    signal.throwIfAborted();
    api = this.context().api;
    const run = await api.waitRun(submitted.id, { signal }).catch(async (error) => {
      const recovered = await this.recoverConnection(api, signal, error);
      return recovered.waitRun(submitted.id, { signal });
    });
    const reviewableStep = body.kind === 'step' && (run.reason === 'ACTION_OUTCOME_UNKNOWN' ||
      (body.input.step.action === 'tap' &&
        ((run.status === 'cancelled' && run.reason === 'STALE_OBSERVATION') ||
         (run.status === 'needs_review' && ['COMMENT_PANEL_STILL_OPEN', 'COMMENT_CLOSE_UNCONFIRMED'].includes(run.reason)))));
    if (run.status !== 'succeeded' && !reviewableStep) throw Error(run.reason || 'RUN_FAILED');
    return run;
  }

  async frame(api, signal, run, artifact, metadata) {
    if (!artifact || artifact.mediaType !== 'image/png') throw Error('SCREENSHOT_UNAVAILABLE');
    const path = runPath(run.id) + '/artifacts/' + encodeURIComponent(artifact.id);
    const response = await api.request(path, { headers: { Accept: 'image/png' }, signal });
    if (!response.headers.get('content-type')?.startsWith('image/png')) throw Error('API_INVALID_RESPONSE');
    const image = Buffer.from(await response.arrayBuffer());
    const geometry = { width: metadata?.actionWidth, height: metadata?.actionHeight };
    return {
      ...metadata,
      observedAt: metadata?.observedAt || artifact.observedAt || artifact.createdAt,
      image: 'data:image/png;base64,' + image.toString('base64'),
      controls: (metadata?.controls || []).filter((control) => !control.secret && !isScreenContainer(geometry, control)).map((control) => ({
        ...control, id: control.id || '',
      })),
      controlsChangedDuringCapture: metadata?.stable === false,
      observationId: metadata?.stable ? metadata.observationId : undefined,
    };
  }

  async capture(api, signal, id) {
    const run = await this.invoke(api, signal, { deviceId: id, kind: 'capture', input: {} });
    if (run.result?.kind !== 'capture') throw Error('API_INVALID_RESPONSE');
    const artifact = run.artifacts.find((value) => value.kind === 'screenshot');
    signal.throwIfAborted();
    return this.frame(this.context().api, signal, run, artifact, run.result);
  }

  async refresh(id) {
    const { api, signal } = this.context();
    const frame = await this.capture(api, signal, id);
    const unconfirmed = await listItems(this.context().api, devicePath(id) + '/pending-actions', { signal }).catch((error) => {
      if (error.status === 403) return undefined;
      throw error;
    });
    return { frame, unconfirmed };
  }

  async probe(id) {
    const { api, signal } = this.context();
    const run = await this.invoke(api, signal, { deviceId: id, kind: 'diagnose', input: {} });
    return { ...run.result, unconfirmed: run.result?.pendingActions || [] };
  }

  acknowledgeAction(id, actionId, observationId) {
    const { api, signal } = this.context();
    return api.json(devicePath(id) + '/pending-actions/' + encodeURIComponent(actionId) + '/ack', {
      method: 'POST', body: { observationId, outcome: 'accepted_current_state' }, signal,
    });
  }

  async action(id, step, observationId, conversationId, revision) {
    const { api, signal } = this.context();
    const input = { step, observationId };
    if (conversationId) {
      input.conversationId = conversationId;
      input.conversationETag = revision ?? await this.conversationTag(api, signal, conversationId, id);
    }
    let run;
    try {
      run = await this.invoke(api, signal, { deviceId: id, kind: 'step', input, preview: true });
    } catch (error) {
      const reason = errorCode(error);
      if (reason === 'PENDING_ACTION_REVIEW_REQUIRED') run = { status: 'needs_review', reason, artifacts: [] };
      else if (step.action === 'tap' && reason === 'STALE_OBSERVATION') {
        // An expired observation can be rejected before a run is created.
        run = { status: 'cancelled', reason, artifacts: [] };
      } else throw error;
    }
    const { frame, captureError, ...receipt } = run.result ?? { action: step.action };
    const result = { ...receipt, status: run.status, ...(run.reason && { reason: run.reason }) };
    try {
      if (['ACTION_OUTCOME_UNKNOWN', 'PENDING_ACTION_REVIEW_REQUIRED'].includes(run.reason))
        return { result, ...await this.refresh(id) };
      if (captureError) return { result, captureError };
      return { result, frame: frame
        ? await this.frame(api, signal, run, run.artifacts.findLast(a => a.kind === 'screenshot'), frame)
        : await this.capture(api, signal, id) };
    } catch (error) {
      return { result, captureError: errorCode(error) };
    }
  }

  async events(api, id, signal, after = 0) {
    const events = [];
    let next = after;
    try {
      for (;;) {
        const page = await api.json(runPath(id) + '/events?limit=200&after=' + next, { signal });
        events.push(...page.items.filter((event) => event.sequence > next));
        if (!page.nextAfter) return events;
        next = page.nextAfter;
      }
    } catch (error) {
      if (error.status === 410) return events;
      throw error;
    }
  }

  async history(id, scriptsOnly = false) {
    const { api, signal } = this.context();
    const runs = (await listItems(api, '/api/runs', { query: { deviceId: id }, signal })).filter(visibleRun);
    const active = runs.find((run) => ['running', 'starting', 'cancelling'].includes(run.status)) ||
      runs.find((run) => run.status === 'queued');
    const current = active ? this.watch(api, signal, active) : undefined;
    const recent = runs.filter((run) => run.id !== active?.id && (!scriptsOnly || run.kind !== 'chat')).slice(0, 30);
    const history = await Promise.all(recent.map(async (summary) => {
      try {
        const [run, events] = await Promise.all([
          api.getRun(summary.id, signal), this.events(api, summary.id, signal),
        ]);
        return runView(run, events);
      } catch (error) {
        if (error.status !== 404 && error.status !== 410) throw error;
        return runView(summary);
      }
    }));
    return { history, current };
  }

  async start(id, kind, choice) {
    const { api, signal } = this.context();
    let input, display;
    if (kind === 'chat') {
      const message = typeof choice?.message === 'string' && choice.message.trim();
      if (!message || message.length > 2000) throw Error('INVALID_MESSAGE');
      const config = this.config();
      input = { message, useImages: config.useImages, modelProfile: config.model || undefined };
      if (choice.chatId) {
        input.conversationId = choice.chatId;
        input.conversationETag = choice.revision ?? await this.conversationTag(api, signal, choice.chatId, id);
      }
      display = { user: message, title: message.slice(0, 64) };
    } else if (kind === 'script') {
      const scriptId = typeof choice === 'string' ? choice : choice?.id;
      if (!scriptId) throw Error('UNKNOWN_SCRIPT');
      input = { scriptId };
      display = { title: typeof choice?.title === 'string' ? choice.title : undefined };
    } else throw Error('UNKNOWN_TASK');
    const maxTimeout = this.capabilities?.limits?.maximumTimeoutMs;
    const run = await this.submit(api, signal, { deviceId: id, kind, input, preview: true,
      ...(kind === 'chat' && maxTimeout ? { timeoutMs: Math.min(10 * 60_000, maxTimeout) } : {}) });
    this.watch(api, signal, run, display);
    return run.id;
  }

  async stop(id, runId) {
    const { api, signal } = this.context();
    const active = this.watchers.get(runId);
    if (!active || active.run.deviceId !== id) throw Error('RUN_NOT_ACTIVE');
    return api.cancelRun(runId, signal).catch(async (error) => {
      const recovered = await this.recoverConnection(api, signal, error);
      return recovered.cancelRun(runId, signal);
    });
  }

  watch(api, signal, run, display) {
    const old = this.watchers.get(run.id);
    if (old) return runView(old.run, old.events, old.display);
    const entry = { run, events: [], last: 0, display, renderedArtifact: undefined };
    this.watchers.set(run.id, entry);
    const announce = () => {
      const record = runView(entry.run, entry.events, entry.display);
      if (!signal.aborted) this.emit({ type: 'run', device: run.deviceId, record });
      return record;
    };
    const record = announce();
    entry.done = this.follow(api, signal, entry, announce).finally(() => {
      if (this.watchers.get(run.id) === entry) this.watchers.delete(run.id);
    });
    return record;
  }

  async preview(api, signal, entry, artifact) {
    if (artifact?.kind !== 'screenshot') return;
    const final = terminalRunStatus(entry.run.status) ? entry.run.result?.frame : undefined;
    const metadata = final && final.observedAt === artifact.observedAt ? final : undefined;
    const version = metadata ? artifact.id + '/capture' : artifact.id;
    if (entry.renderedArtifact === version) return;
    entry.renderedArtifact = version;
    const { id, deviceId } = entry.run;
    try {
      const frame = await this.frame(api, signal, entry.run, artifact, metadata);
      if (!signal.aborted) this.emit({ type: 'frame', device: deviceId, runId: id, frame });
    } catch (error) {
      if (!signal.aborted) this.emit({ type: 'frameError', device: deviceId, runId: id, error: errorCode(error) });
    }
  }

  async follow(api, signal, entry, announce) {
    const { id, deviceId } = entry.run;
    let disconnected = false;
    while (!signal.aborted) {
      try {
        api = this.context().api;
        const backlog = await this.events(api, id, signal, entry.last);
        for (const event of backlog) {
          entry.last = event.sequence;
          entry.events.push(event);
        }
        entry.run = await api.getRun(id, signal);
        disconnected = false;
        if (terminalRunStatus(entry.run.status)) {
          await this.preview(api, signal, entry, entry.run.artifacts.findLast((value) => value.kind === 'screenshot'));
          announce();
          return;
        }
        announce();
        const recovered = backlog.findLast((event) => event.type === 'artifact.available' && event.data.kind === 'screenshot');
        await this.preview(api, signal, entry, recovered?.data);
        for await (const event of api.events(id, { signal, after: entry.last })) {
          if (event.sequence <= entry.last) continue;
          entry.last = event.sequence;
          entry.events.push(event);
          if (event.type === 'run.status') {
            if (terminalRunStatus(event.data.status)) break;
            entry.run = { ...entry.run, ...event.data };
          }
          if (event.type === 'artifact.available') await this.preview(api, signal, entry, event.data);
          if (event.type !== 'artifact.available') announce();
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error.status === 410) {
          entry.last = (await api.getRun(id, signal).catch(() => entry.run)).lastEventId;
        } else {
          if (!disconnected) this.emit({ type: 'runConnectionError', device: deviceId, runId: id, error: errorCode(error) });
          disconnected = true;
          if (this.automatic() && recoverableConnectionErrors.has(errorCode(error))) {
            await this.recoverConnection(api, signal, error).catch(() => {});
          } else if ([401, 403, 404].includes(error.status)) return;
        }
      }
      await wait(400, undefined, { signal }).catch(() => {});
    }
  }

  async shutdown() {
    this.closing = true;
    clearInterval(this.connectionTimer);
    this.lifecycle.abort(Error('CANCELLED'));
    const observers = Array.from(this.watchers.values(), (run) => run.done);
    await Promise.allSettled([this.emulator.close({ keepRunning: true }), ...observers]);
  }
}
