import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export const defaultApiURL = 'http://127.0.0.1:18765';
export type RunKind = 'capture' | 'diagnose' | 'step' | 'script' | 'chat' | 'agent';
export type RunStatus =
  | 'queued' | 'starting' | 'running' | 'cancelling'
  | 'succeeded' | 'needs_review' | 'failed' | 'cancelled';
export type RunSummary = {
  id: string;
  deviceId: string;
  kind: RunKind;
  title?: string;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  lastEventId: number;
  conversationId?: string;
};
export type Artifact = {
  id: string;
  kind: 'screenshot' | 'layout' | 'recording' | 'report';
  mediaType: string;
  url: string;
  observedAt?: string;
  observationId?: string;
};
export type Run = RunSummary & {
  result?: { kind: RunKind } & Record<string, unknown>;
  reason?: string;
  cleanupError?: string;
  artifacts: Artifact[];
};
export type RunEvent = {
  sequence: number;
  type: string;
  at: string;
  data: Record<string, unknown>;
};
export type RunRequest = {
  deviceId: string;
  kind: RunKind;
  input: Record<string, unknown>;
  onBusy?: 'reject' | 'queue';
  startWithinMs?: number;
  timeoutMs?: number;
  preview?: boolean;
};
type RequestOptions = {
  method?: string;
  body?: unknown;
  headers?: HeadersInit;
  signal?: AbortSignal;
};
type EventOptions = { after?: number; signal?: AbortSignal };

export function terminalRunStatus(status: RunStatus) {
  return status === 'succeeded' || status === 'needs_review' ||
    status === 'failed' || status === 'cancelled';
}

export class ApiError extends Error {
  constructor(readonly code: string, readonly status: number, readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ApiError';
  }
}

export function isTransientApiError(error: unknown) {
  return error instanceof ApiError &&
    (['API_UNREACHABLE', 'API_TIMEOUT'].includes(error.code) || [502, 503, 504].includes(error.status));
}

export function apiURL(value = defaultApiURL) {
  let base: URL;
  try {
    base = new URL(value);
  } catch {
    throw new ApiError('API_INVALID_URL', 0);
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
  if (
    (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) ||
    base.username || base.password || base.search || base.hash
  ) {
    throw new ApiError('API_INVALID_URL', 0, 'Use HTTPS or loopback HTTP');
  }
  base.pathname = base.pathname.replace(/\/?$/, '/');
  return base;
}

export class ApiClient {
  private readonly base: URL;
  private readonly token: string;
  private readonly fetch: typeof fetch;

  constructor(options: { baseURL?: string; token: string; fetch?: typeof fetch }) {
    if (/[^!-~]/.test(options.token)) throw new ApiError('API_TOKEN_INVALID', 0);
    this.base = apiURL(options.baseURL);
    this.token = options.token;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  private url(path: string) {
    const url = path.startsWith('/api/') || path === '/api' || path.startsWith('/openapi.') ||
      path.startsWith('/healthz') || path.startsWith('/readyz')
      ? new URL(path.slice(1), this.base)
      : new URL(path, this.base);
    if (url.origin !== this.base.origin || url.username || url.password || url.hash)
      throw new ApiError('API_INVALID_URL', 0);
    return url;
  }

  async request(path: string, options: RequestOptions = {}) {
    const url = this.url(path);
    const headers = new Headers(options.headers);
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');
    if (this.token) headers.set('Authorization', 'Bearer ' + this.token);
    else {
      headers.delete('Authorization');
      if (!['healthz', 'readyz', 'openapi.json'].some((name) => url.pathname === this.base.pathname + name))
        throw new ApiError('API_TOKEN_REQUIRED', 0);
    }
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const stream = headers.get('Accept') === 'text/event-stream';
    const timeout = stream ? undefined : AbortSignal.timeout(30000);
    const signal = options.signal && timeout
      ? AbortSignal.any([options.signal, timeout])
      : options.signal ?? timeout;
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: options.method ?? 'GET',
        body,
        headers,
        redirect: 'error',
        signal,
      });
    } catch {
      options.signal?.throwIfAborted();
      throw new ApiError(timeout?.aborted ? 'API_TIMEOUT' : 'API_UNREACHABLE', 0);
    }
    if (!response.ok) {
      const problem = await response.json().catch(() => ({}));
      const code = typeof problem?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(problem.code)
        ? problem.code
        : 'API_HTTP_ERROR';
      throw new ApiError(code, response.status, typeof problem?.detail === 'string' ? problem.detail : undefined);
    }
    return response;
  }

  async json<T>(path: string, options?: RequestOptions): Promise<T> {
    const response = await this.request(path, options);
    try {
      return await response.json() as T;
    } catch {
      options?.signal?.throwIfAborted();
      throw new ApiError('API_INVALID_RESPONSE', response.status);
    }
  }

  submitRun(input: RunRequest, options: { idempotencyKey?: string; signal?: AbortSignal } = {}) {
    return this.json<RunSummary>('/api/runs', {
      method: 'POST',
      body: input,
      headers: { 'Idempotency-Key': options.idempotencyKey ?? randomUUID() },
      signal: options.signal,
    });
  }

  getRun(id: string, signal?: AbortSignal) {
    return this.json<Run>('/api/runs/' + encodeURIComponent(id), { signal });
  }

  cancelRun(id: string, signal?: AbortSignal) {
    return this.json<Run>('/api/runs/' + encodeURIComponent(id) + '/cancel', { method: 'POST', signal });
  }

  async waitRun(id: string, options: { signal?: AbortSignal; onRun?: (run: Run) => unknown; intervalMs?: number } = {}) {
    let retries = 0;
    for (;;) {
      let run: Run;
      try {
        run = await this.getRun(id, options.signal);
      } catch (error) {
        if (!isTransientApiError(error) || retries === 3) throw error;
        await sleep(250 * 2 ** retries++, undefined, { signal: options.signal });
        continue;
      }
      retries = 0;
      await options.onRun?.(run);
      if (terminalRunStatus(run.status)) return run;
      await sleep(options.intervalMs ?? 250, undefined, { signal: options.signal });
    }
  }

  async *events(id: string, { after = 0, signal }: EventOptions = {}): AsyncGenerator<RunEvent> {
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (after) headers['Last-Event-ID'] = String(after);
    const response = await this.request('/api/runs/' + encodeURIComponent(id) + '/events', { headers, signal });
    if (!response.headers.get('Content-Type')?.startsWith('text/event-stream')) {
      await response.body?.cancel().catch(() => {});
      throw new ApiError('API_INVALID_RESPONSE', response.status);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ApiError('API_INVALID_RESPONSE', response.status);
    const decoder = new TextDecoder();
    let chunk = '';
    let sequence: string | undefined;
    let data: string[] = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        chunk += decoder.decode(value, { stream: !done });
        for (let newline = chunk.search(/[\r\n]/); newline !== -1; newline = chunk.search(/[\r\n]/)) {
          const carriage = chunk[newline] === '\r';
          if (carriage && newline === chunk.length - 1 && !done) break;
          const line = chunk.slice(0, newline);
          chunk = chunk.slice(newline + (carriage && chunk[newline + 1] === '\n' ? 2 : 1));
          if (!line) {
            if (data.length) {
              let event: RunEvent;
              try {
                event = JSON.parse(data.join('\n'));
              } catch {
                throw new ApiError('API_INVALID_RESPONSE', response.status);
              }
              if (!Number.isSafeInteger(event?.sequence) || String(event.sequence) !== sequence)
                throw new ApiError('API_INVALID_RESPONSE', response.status);
              if (event.sequence > after) {
                after = event.sequence;
                yield event;
              }
            }
            data = [];
            sequence = undefined;
          } else if (line.startsWith('data:')) {
            data.push(line.slice(5).replace(/^ /, ''));
          } else if (line.startsWith('id:')) {
            sequence = line.slice(3).replace(/^ /, '');
          }
        }
        if (done) return;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
