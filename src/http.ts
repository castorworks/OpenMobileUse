import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, mkdirSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { apiDocument, header, matchOperation, operationBody, operationIds, operationParameters } from './api-contract.js';
import { ApiData, ApiError, canUseDevice, hasPermission, requireDevice, requirePermission, type Grant, type Principal } from './api-data.js';
import { modelConfig } from './chat.js';
import { apiStateDirectory, localConnectionFile, localInstanceHeader } from './local-connection.js';
import { detectLocalOllama } from './local-model.js';
import { compileScript } from './run.js';
import { RunService, type RunRequest, type RunServiceOptions } from './run-service.js';
import { readScriptEnvelope } from './script.js';

type Fields = Record<string, string | number | boolean>;
type Delivery = (status: number, body?: unknown, headers?: Record<string, string>) => void;
type RouteContext = {
  request: IncomingMessage;
  response: ServerResponse;
  parameters: Fields;
  body: unknown;
  grant?: Grant;
  send: Delivery;
};
type Handler = (context: RouteContext) => void | Promise<void>;

const defaultHost = '127.0.0.1';
const defaultPort = 18765;
const terminal = new Set(['succeeded', 'needs_review', 'failed', 'cancelled']);
const allPlatforms = ['android', 'harmony', 'ios'] as const;
const statusTitles: Record<number, string> = {
  400: 'Invalid request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not found',
  405: 'Method not allowed', 409: 'Conflict', 410: 'Gone', 412: 'Precondition failed',
  413: 'Payload too large', 415: 'Unsupported media type', 422: 'Invalid operation',
  428: 'Precondition required', 429: 'Limit exceeded', 500: 'Internal error', 503: 'Service unavailable',
};
const localAddress = (host: string) => ['127.0.0.1', '::1', 'localhost'].includes(host);
const sharedStateDir = () => resolve(process.env.OMU_STATE_DIR ?? join(homedir(), '.openmobileuse'));
const apiStateDir = (directory?: string) =>
  directory === undefined ? apiStateDirectory() : resolve(directory);

async function publishConnection(directory: string, url: string, instanceId: string) {
  const file = join(directory, localConnectionFile);
  const temporary = file + '.' + instanceId + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify({ url, instanceId }) + '\n',
      { flag: 'wx', mode: 0o600, flush: true });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function clearConnection(directory: string, instanceId: string) {
  const file = join(directory, localConnectionFile);
  try {
    const current: { instanceId?: string } | null = JSON.parse(await readFile(file, 'utf8'));
    if (current?.instanceId === instanceId) await rm(file, { force: true });
  } catch {
    // A missing or unreadable announcement can be rejected by the client's health check.
  }
}

function paginate<T>(items: T[], fields: Fields, scope: string, key: (item: T) => string, ascending = false) {
  const limit = Number(fields.limit ?? 50);
  let after: string | undefined;
  if (fields.cursor !== undefined) {
    try {
      const [savedScope, savedAfter] = JSON.parse(Buffer.from(String(fields.cursor), 'base64url').toString());
      if (savedScope !== scope || typeof savedAfter !== 'string') throw new Error();
      after = savedAfter;
    } catch {
      throw new ApiError(400, 'INVALID_CURSOR');
    }
  }
  const compare = (a: string, b: string) => (a === b ? 0 : (a < b ? -1 : 1) * (ascending ? 1 : -1));
  const filtered = items.filter((item) => after === undefined || compare(key(item), after) > 0)
    .sort((a, b) => compare(key(a), key(b)));
  const selected = filtered.slice(0, limit);
  return {
    items: selected,
    nextCursor: filtered.length > limit ?
      Buffer.from(JSON.stringify([scope, key(selected[selected.length - 1])])).toString('base64url') : undefined,
  };
}
const newest = (item: { createdAt: string; id: string }) => item.createdAt + '/' + item.id;
const byId = (item: { id: string }) => item.id;

async function checkScript(document: unknown) {
  let script: ReturnType<typeof readScriptEnvelope>;
  try { script = readScriptEnvelope(document); }
  catch (error) { throw new ApiError(422, 'INVALID_SCRIPT', (error as Error).message); }
  const candidates = script.platform ? [script.platform] : allPlatforms;
  const results = await Promise.allSettled(candidates.map((platform) => compileScript(document, platform)));
  const supported = candidates.filter((_, index) => results[index].status === 'fulfilled');
  if (!supported.length) {
    const failure = results.find((result) => result.status === 'rejected');
    const errorCode = failure?.reason?.message;
    throw new ApiError(422, typeof errorCode === 'string' ? errorCode.split(':')[0] : 'INVALID_SCRIPT',
      typeof errorCode === 'string' ? errorCode : 'INVALID_SCRIPT');
  }
  return { document: document as { steps: unknown[] }, supported };
}

function requireRunAccess(data: ApiData, runs: RunService, grant: Grant, id: string) {
  const owner = runs.getRunOwner(id);
  if (owner === undefined || (owner !== grant.subject && !hasPermission(grant, '*')))
    throw new ApiError(404, 'RUN_NOT_FOUND');
  const run = runs.getRun(id);
  if (!canUseDevice(grant, run.deviceId)) throw new ApiError(404, 'RUN_NOT_FOUND');
  // Observe the current permissions for SSE sessions and token revocation.
  if (!data.currentGrant(grant)) throw new ApiError(401, 'UNAUTHORIZED');
  return run;
}

async function streamEvents(data: ApiData, runs: RunService, context: RouteContext, id: string, grant: Grant) {
  const { request, response, parameters } = context;
  let after = Number(parameters['Last-Event-ID'] ?? parameters.after ?? 0);
  if (!Number.isSafeInteger(after) || after < 0) throw new ApiError(400, 'INVALID_PARAMETER', 'Last-Event-ID');
  let batch = runs.events(id, after, 200);
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  response.flushHeaders();
  const controller = new AbortController();
  response.once('close', () => controller.abort());
  let lastHeartbeat = Date.now();
  try {
    while (!controller.signal.aborted) {
      if (!data.currentGrant(grant)) break;
      for (const event of batch.items) {
        after = event.sequence;
        if (event.type === 'artifact.available' && !hasPermission(grant, 'artifacts:read')) continue;
        if (!response.write('id: ' + event.sequence + '\nevent: ' + event.type +
          '\ndata: ' + JSON.stringify(event) + '\n\n')) await once(response, 'drain', { signal: controller.signal });
      }
      const run = runs.getRun(id);
      if (terminal.has(run.status) && after >= run.lastEventId) break;
      if (batch.items.length < 200) {
        if (Date.now() - lastHeartbeat >= 15000) {
          response.write(': keep-alive\n\n');
          lastHeartbeat = Date.now();
        }
        await sleep(250, undefined, { signal: controller.signal });
      }
      batch = runs.events(id, after, 200);
    }
  } catch (error) {
    if (!controller.signal.aborted) response.destroy(error as Error);
  } finally {
    response.end();
    request.resume();
  }
}

export interface ApiServerOptions {
  directory: string;
  lockDirectory?: string;
  host?: string;
  port?: number;
  bootstrapToken?: string;
  tls?: { cert: Buffer; key: Buffer };
  origins?: string[];
  drivers?: RunServiceOptions['drivers'];
  driverOptions?: RunServiceOptions['driverOptions'];
  profiles?: RunServiceOptions['profiles'];
  limits?: RunServiceOptions['limits'];
  announceLocalConnection?: boolean;
  logger?: (record: { method: string; operation?: string; status: number; subject?: string; durationMs: number }) => void;
}

export async function createApiServer(options: ApiServerOptions) {
  const host = options.host ?? defaultHost;
  const instanceId = randomUUID();
  if (!localAddress(host) && !options.tls) throw new ApiError(400, 'HTTPS_REQUIRED');
  const lockDirectory = options.lockDirectory ?? options.directory;
  mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  const instanceLock = new DatabaseSync(join(lockDirectory, 'omu-serve.lock.sqlite'));
  try {
    instanceLock.exec('BEGIN IMMEDIATE');
  } catch (error) {
    instanceLock.close();
    if ((error as { errcode?: number }).errcode === 5) throw new ApiError(409, 'SERVICE_ALREADY_RUNNING');
    throw error;
  }

  let data: ApiData;
  try {
    data = new ApiData(options.directory, options.bootstrapToken);
    data.seedScripts();
  } catch (error) {
    instanceLock.close();
    throw error;
  }
  let draining = false;
  let ready = false;

  const grantFor = (principal: Principal) => {
    const grant = data.currentGrant(principal);
    if (!grant) throw new ApiError(401, 'UNAUTHORIZED');
    return grant;
  };

  function authorizeRun(grant: Grant, request: RunRequest) {
    requirePermission(grant, 'runs:submit');
    requireDevice(grant, request.deviceId);
    const input = request.input as Record<string, unknown>;
    if (request.kind === 'diagnose' || input.includeLayout === true) requirePermission(grant, 'devices:diagnose');
    if (request.kind === 'chat' || input.conversationId) requirePermission(grant, 'conversations:write');
    if (typeof input.scriptId === 'string') requirePermission(grant, 'scripts:read');
  }

  const runs: RunService = new RunService({
    data,
    artifactDir: data.artifactDir,
    drivers: options.drivers,
    driverOptions: options.driverOptions,
    profiles: options.profiles,
    limits: options.limits,
    resources: {
      resolveScript(principal, id, etag) {
        const grant = grantFor(principal);
        requirePermission(grant, 'scripts:read');
        return data.getScriptContent(grant, id, etag).document;
      },
      scriptTitle(principal, id) {
        return data.getScript(grantFor(principal), id).summary.title;
      },
      beginConversation(principal, request, runId) {
        return data.beginConversation(grantFor(principal), request, runs.getDevice(request.deviceId), runId);
      },
      recordConversationStep(change) {
        data.recordConversationStep(change);
      },
      completeConversation(change) {
        return data.completeConversation(change);
      },
    },
    authorized(principal, request) {
      try {
        authorizeRun(grantFor(principal), request);
        return true;
      } catch {
        return false;
      }
    },
  });

  const handlers: Record<string, Handler> = {
    health: ({ send }) => send(200, { status: 'ok' }, { [localInstanceHeader]: instanceId }),
    readiness: ({ send }) => {
      if (!ready || draining) throw new ApiError(503, 'SERVICE_UNAVAILABLE');
      send(200, { status: 'ok' });
    },
    openApiDocument: ({ send }) => send(200, apiDocument),
    getCapabilities: ({ send }) => send(200, runs.capabilities()),
    async listDevices({ grant, parameters, send }) {
      const items = (await runs.listDevices(parameters.refresh === true)).filter((item) => canUseDevice(grant!, item.id));
      send(200, paginate(items, parameters, 'devices', byId, true));
    },
    getDevice({ grant, parameters, send }) {
      const id = String(parameters.deviceId);
      requireDevice(grant!, id);
      send(200, runs.getDevice(id));
    },
    listPendingActions({ grant, parameters, send }) {
      const id = String(parameters.deviceId);
      requireDevice(grant!, id);
      send(200, paginate(runs.listPendingActions(id), parameters, 'pending/' + id, byId, true));
    },
    async acknowledgeAction({ grant, body, parameters, send }) {
      const id = String(parameters.deviceId);
      requireDevice(grant!, id);
      send(200, await runs.acknowledgeAction(id, String(parameters.actionId),
        body as Parameters<RunService['acknowledgeAction']>[2], grant!));
    },
    listTasks: ({ parameters, send }) => send(200, paginate(runs.listTasks(), parameters, 'tasks', byId, true)),
    getTask: ({ parameters, send }) => send(200, runs.getTask(String(parameters.taskId))),
    async createRun({ grant, body, parameters, send }) {
      if (draining) throw new ApiError(503, 'SERVICE_DRAINING');
      const request = body as RunRequest;
      authorizeRun(grant!, request);
      const summary = await runs.submit(request, grant!, String(parameters['Idempotency-Key']));
      send(terminal.has(summary.status) ? 200 : 202, summary, { Location: '/api/runs/' + summary.id });
    },
    listRuns({ grant, parameters, send }) {
      const items = runs.listRuns().filter((item) =>
        canUseDevice(grant!, item.deviceId) && (hasPermission(grant!, '*') || runs.getRunOwner(item.id) === grant!.subject) &&
        (!parameters.deviceId || parameters.deviceId === item.deviceId) && (!parameters.status || parameters.status === item.status));
      send(200, paginate(items, parameters, 'runs/' + (parameters.deviceId ?? '') + '/' + (parameters.status ?? ''), newest));
    },
    getRun({ grant, parameters, send }) {
      const run = requireRunAccess(data, runs, grant!, String(parameters.runId));
      send(200, hasPermission(grant!, 'artifacts:read') ? run : { ...run, artifacts: [] });
    },
    async cancelRun({ grant, parameters, send }) {
      const id = String(parameters.runId);
      requireRunAccess(data, runs, grant!, id);
      const run = await runs.cancelRun(id);
      send(terminal.has(run.status) ? 200 : 202, hasPermission(grant!, 'artifacts:read') ? run : { ...run, artifacts: [] });
    },
    async getRunEvents(context) {
      const { grant, parameters, send, request } = context;
      const id = String(parameters.runId);
      requireRunAccess(data, runs, grant!, id);
      if (header(request, 'accept')?.includes('text/event-stream')) {
        await streamEvents(data, runs, context, id, grant!);
        return;
      }
      const after = Number(parameters.after ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) throw new ApiError(400, 'INVALID_PARAMETER', 'after');
      const page = runs.events(id, after, Number(parameters.limit ?? 50));
      send(200, hasPermission(grant!, 'artifacts:read') ? page : {
        ...page, items: page.items.filter((event) => event.type !== 'artifact.available'),
      });
    },
    async downloadArtifact({ grant, parameters, send }) {
      const runId = String(parameters.runId);
      requireRunAccess(data, runs, grant!, runId);
      const result = await runs.getArtifact(runId, String(parameters.artifactId));
      send(200, result.data, { 'Content-Type': result.mediaType });
    },
    listScripts({ grant, parameters, send }) {
      send(200, paginate(data.listScripts(grant!, parameters.includeArchived === true), parameters,
        'scripts/' + Boolean(parameters.includeArchived), newest));
    },
    async createScript({ grant, body, send }) {
      const input = body as { title: string; source: string; script?: unknown; runId?: string; artifactId?: string;
        conversationId?: string; throughTurn?: number };
      let document = input.script;
      if (input.source === 'runRecording') {
        requirePermission(grant!, 'artifacts:read');
        requireRunAccess(data, runs, grant!, input.runId!);
        const artifact = await runs.getArtifact(input.runId!, input.artifactId!);
        if (artifact.kind !== 'recording') throw new ApiError(422, 'INVALID_RECORDING_ARTIFACT');
        document = JSON.parse(artifact.data.toString('utf8'));
      } else if (input.source === 'conversationRecording') {
        requirePermission(grant!, 'artifacts:read');
        document = data.conversationRecording(grant!, input.conversationId!, input.throughTurn);
      }
      const script = await checkScript(document);
      const result = data.createScript(grant!, input.title, script.document, script.supported);
      send(201, result.summary, { ETag: result.etag, Location: '/api/scripts/' + result.summary.id });
    },
    getScript({ grant, parameters, send }) {
      const result = data.getScript(grant!, String(parameters.scriptId));
      send(200, result.summary, { ETag: result.etag });
    },
    async updateScript({ grant, body, parameters, send }) {
      const change = body as { title?: string; archived?: boolean; script?: { steps: unknown[] } };
      const supported = change.script ? (await checkScript(change.script)).supported : undefined;
      const result = data.updateScript(grant!, String(parameters.scriptId), String(parameters['If-Match']), change, supported);
      send(200, result.summary, { ETag: result.etag });
    },
    deleteScript({ grant, parameters, send }) {
      data.deleteScript(grant!, String(parameters.scriptId), String(parameters['If-Match']));
      send(204);
    },
    downloadScript({ grant, parameters, send }) {
      const result = data.getScriptContent(grant!, String(parameters.scriptId));
      send(200, result.document, { ETag: result.etag });
    },
    listConversations({ grant, parameters, send }) {
      const deviceId = parameters.deviceId === undefined ? undefined : String(parameters.deviceId);
      send(200, paginate(data.listConversations(grant!, deviceId), parameters, 'conversations/' + (deviceId ?? ''), newest));
    },
    createConversation({ grant, body, send }) {
      const input = body as { deviceId: string; title?: string };
      requireDevice(grant!, input.deviceId);
      const result = data.createConversation(grant!, runs.getDevice(input.deviceId), input.title);
      send(201, result.summary, { ETag: result.etag, Location: '/api/conversations/' + result.summary.id });
    },
    getConversation({ grant, parameters, send }) {
      const result = data.getConversation(grant!, String(parameters.conversationId));
      send(200, result.summary, { ETag: result.etag });
    },
    renameConversation({ grant, body, parameters, send }) {
      const result = data.renameConversation(grant!, String(parameters.conversationId), String(parameters['If-Match']),
        (body as { title: string }).title);
      send(200, result.summary, { ETag: result.etag });
    },
    deleteConversation({ grant, parameters, send }) {
      data.deleteConversation(grant!, String(parameters.conversationId), String(parameters['If-Match']));
      send(204);
    },
    listMessages({ grant, parameters, send }) {
      const id = String(parameters.conversationId);
      send(200, paginate(data.listMessages(grant!, id), parameters, 'messages/' + id,
        (item) => String(item.sequence).padStart(16, '0'), true));
    },
    downloadConversationRecording({ grant, parameters, send }) {
      send(200, data.conversationRecording(grant!, String(parameters.conversationId), parameters.throughTurn as number | undefined));
    },
  };

  if (operationIds.some((id) => typeof handlers[id] !== 'function') || Object.keys(handlers).length !== operationIds.length)
    throw new Error('API_CONTRACT_ROUTING_MISMATCH');

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const started = Date.now();
    const method = request.method ?? 'GET';
    let operationId: string | undefined;
    let grant: Grant | undefined;
    const send: Delivery = (status, body, headers = {}) => {
      response.writeHead(status, {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
        ...headers,
      });
      response.end(body === undefined || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    try {
      const origin = header(request, 'origin');
      if (origin) {
        if (!options.origins?.includes(origin)) throw new ApiError(403, 'ORIGIN_FORBIDDEN');
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Expose-Headers', 'ETag, Location, ' + localInstanceHeader);
      }
      const url = new URL(request.url || '/', 'http://localhost');
      const { operation, pathValues, allowed } = matchOperation(url.pathname, method);
      if (method === 'OPTIONS' && origin && allowed.length) {
        send(204, undefined, {
          'Access-Control-Allow-Methods': [...allowed, 'OPTIONS'].join(', '),
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match, Idempotency-Key, Last-Event-ID',
        });
        return;
      }
      if (!operation) {
        if (allowed.length) {
          response.setHeader('Allow', allowed.join(', '));
          throw new ApiError(405, 'METHOD_NOT_ALLOWED');
        }
        throw new ApiError(404, 'NOT_FOUND');
      }
      operationId = operation.operationId;
      if (operation['x-omu-permission']) {
        grant = data.authenticate(header(request, 'authorization'));
        requirePermission(grant, operation['x-omu-permission']);
        if (!ready) throw new ApiError(503, 'SERVICE_UNAVAILABLE');
      }
      const parameters = operationParameters(operation, request, url, pathValues);
      const body = await operationBody(operation, request, runs.capabilities().limits.requestBytes);
      await handlers[operationId]({ request, response, parameters, body, grant, send });
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error as Error);
        return;
      }
      const issue = error as { status?: number; code?: string; message?: string };
      const status = issue.status && issue.status >= 400 && issue.status <= 599 ? issue.status : 500;
      const code = status === 500 ? 'INTERNAL_ERROR' : issue.code ?? 'REQUEST_FAILED';
      const headers: Record<string, string> = { 'Content-Type': 'application/problem+json' };
      if (status === 401) headers['WWW-Authenticate'] = 'Bearer';
      send(status, {
        type: 'about:blank', title: statusTitles[status] ?? 'Request failed', status, code,
        detail: status !== 500 && issue.message !== code ? issue.message : undefined,
      }, headers);
    } finally {
      request.resume();
      options.logger?.({ method, operation: operationId, status: response.statusCode, subject: grant?.subject, durationMs: Date.now() - started });
    }
  };

  const server = options.tls ? httpsServer(options.tls, handle) : httpServer(handle);
  server.requestTimeout = 30_000;
  let announcedUrl: string | undefined;
  try {
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? defaultPort, host, () => {
        server.off('error', reject);
        done();
      });
    });
    await runs.start();
    ready = true;
    const bound = server.address();
    if (options.announceLocalConnection && !options.tls && bound && typeof bound !== 'string' &&
        (bound.address === '127.0.0.1' || bound.address === '::1')) {
      announcedUrl = 'http://' + (bound.address === '::1' ? '[::1]' : bound.address) + ':' + bound.port;
      await publishConnection(options.directory, announcedUrl, instanceId);
    }
  } catch (error) {
    if (server.listening) {
      server.close();
      server.closeAllConnections();
    }
    await runs.close().catch(() => {});
    data.close();
    instanceLock.close();
    throw error;
  }

  let closing: Promise<void> | undefined;
  return {
    server,
    url: announcedUrl ?? (options.tls ? 'https://' : 'http://') + (host.includes(':') ? '[' + host + ']' : host) +
      ':' + (server.address() as { port: number }).port,
    close() {
      return closing ??= (async () => {
        draining = true;
        const stopped = new Promise<void>((done) => server.close(() => done()));
        try {
          await runs.close();
        } finally {
          server.closeAllConnections();
          await stopped;
          if (announcedUrl) await clearConnection(options.directory, instanceId);
          try { data.close(); }
          finally { instanceLock.close(); }
        }
      })();
    },
  };
}

function profilesFromEnvironment() {
  const raw = process.env.OMU_MODEL_PROFILES;
  const profiles: NonNullable<RunServiceOptions['profiles']> = [];
  const privateVariables = new Set(['OMU_API_TOKEN', 'DEEPSEEK_API_KEY', 'OMU_MODEL_PROFILES']);
  const configuredKey = process.env.OMU_MODEL_KEY_ENV;
  if (configuredKey) privateVariables.add(configuredKey);
  try {
    if (raw !== undefined) {
      type Entry = { id: string; baseURL?: string; model?: string; apiKeyEnv?: string; allowsImages?: boolean };
      let entries: unknown;
      try { entries = JSON.parse(raw); }
      catch { throw new ApiError(400, 'INVALID_MODEL_PROFILES'); }
      if (!Array.isArray(entries)) throw new ApiError(400, 'INVALID_MODEL_PROFILES');
      for (const entry of entries as (Entry | null)[]) {
        if (typeof entry?.apiKeyEnv === 'string') privateVariables.add(entry.apiKeyEnv);
      }
      for (const entry of entries as (Entry | null)[]) {
        if (typeof entry?.id !== 'string' || !/^[\w.-]+$/.test(entry.id) ||
            profiles.some((candidate) => candidate.id === entry.id))
          throw new ApiError(400, 'INVALID_MODEL_PROFILE');
        const config = modelConfig(entry);
        if (config.keyEnv) privateVariables.add(config.keyEnv);
        profiles.push({ id: entry.id, allowsImages: entry.allowsImages === true, config });
      }
      return profiles;
    }
    if (process.env.OMU_MODEL_BASE_URL || process.env.OMU_MODEL || process.env.DEEPSEEK_API_KEY || configuredKey) {
      const config = modelConfig({
        baseURL: process.env.OMU_MODEL_BASE_URL, model: process.env.OMU_MODEL, apiKeyEnv: configuredKey,
      });
      if (config.keyEnv) privateVariables.add(config.keyEnv);
      return [{ id: 'default', allowsImages: process.env.OMU_ALLOW_MODEL_IMAGES === 'true', config }];
    }
  } finally {
    for (const name of privateVariables) delete process.env[name];
  }
}

function limitsFromEnvironment(): RunServiceOptions['limits'] {
  const raw = process.env.OMU_API_LIMITS;
  if (!raw) return;
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new ApiError(400, 'INVALID_API_LIMITS'); }
  const keys = new Set([
    'requestBytes', 'queuePerDevice', 'observationTtlMs', 'maximumTimeoutMs', 'defaultTimeoutMs',
    'runRetentionMs', 'eventRetentionMs', 'screenshotRetentionMs',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.entries(value).some(([key, item]) => !keys.has(key) || !Number.isSafeInteger(item) ||
        item < (key === 'queuePerDevice' ? 0 : 1))) throw new ApiError(400, 'INVALID_API_LIMITS');
  const result = value as NonNullable<RunServiceOptions['limits']>;
  if ((result.defaultTimeoutMs ?? 300_000) > (result.maximumTimeoutMs ?? 900_000))
    throw new ApiError(400, 'INVALID_API_LIMITS');
  return result;
}

export async function serveFromArgs(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      host: { type: 'string' }, port: { type: 'string' }, 'state-dir': { type: 'string' },
      'tls-cert': { type: 'string' }, 'tls-key': { type: 'string' },
      'appium-mode': { type: 'string' }, 'appium-url': { type: 'string' },
    },
  });
  const port = Number(values.port ?? process.env.OMU_API_PORT ?? defaultPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ApiError(400, 'INVALID_PORT');
  if (Boolean(values['tls-key']) !== Boolean(values['tls-cert'])) throw new ApiError(400, 'INCOMPLETE_TLS_CONFIGURATION');
  const appiumMode = values['appium-mode'] ?? process.env.OMU_APPIUM_MODE ?? 'managed';
  if (appiumMode !== 'external' && appiumMode !== 'managed') throw new ApiError(400, 'INVALID_APPIUM_MODE');
  const bootstrapToken = process.env.OMU_API_TOKEN;
  let profiles = profilesFromEnvironment();
  if (profiles === undefined) {
    const local = await detectLocalOllama(process.env.OMU_ALLOW_MODEL_IMAGES === 'true');
    profiles = local ? [local] : [];
  }
  const service = await createApiServer({
    directory: apiStateDir(values['state-dir']), lockDirectory: sharedStateDir(),
    host: values.host ?? process.env.OMU_API_HOST, port, bootstrapToken, profiles,
    announceLocalConnection: true,
    driverOptions: { appiumMode, appiumUrl: values['appium-url'] ?? process.env.OMU_APPIUM_URL },
    limits: limitsFromEnvironment(),
    logger: process.env.OMU_API_LOG_REQUESTS === 'true' ? (entry) => console.error(JSON.stringify(entry)) : undefined,
    tls: values['tls-cert'] && values['tls-key'] ?
      { cert: readFileSync(values['tls-cert']), key: readFileSync(values['tls-key']) } : undefined,
    origins: (process.env.OMU_API_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean),
  });
  const stop = () => { void service.close().catch(() => {}); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    console.log(JSON.stringify({ url: service.url }));
    await once(service.server, 'close');
    await service.close();
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

export async function authFromArgs(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      subject: { type: 'string' }, permissions: { type: 'string' }, devices: { type: 'string' },
      'state-dir': { type: 'string' },
    },
    allowPositionals: true,
  });
  if (positionals[0] !== 'token' || !['create', 'revoke'].includes(positionals[1]))
    throw new ApiError(400, 'INVALID_AUTH_COMMAND', 'omu auth token create --subject <id> | omu auth token revoke <tokenId>');
  const data = new ApiData(apiStateDir(values['state-dir']));
  try {
    if (positionals[1] === 'create') {
      if (!values.subject || positionals.length !== 2) throw new ApiError(400, 'INVALID_SUBJECT');
      const list = (value?: string) => [...new Set((value ?? '*').split(',').map((part) => part.trim()))];
      console.log(JSON.stringify(data.issueToken(values.subject, list(values.permissions), list(values.devices))));
    } else {
      if (positionals.length !== 3) throw new ApiError(400, 'INVALID_TOKEN_ID');
      data.revokeToken(positionals[2]);
      console.log(JSON.stringify({ id: positionals[2], revoked: true }));
    }
  } finally {
    data.close();
  }
}
