import { setTimeout as sleep } from 'node:timers/promises';

const deepseek = 'https://api.deepseek.com';
export function modelConfig(
  options: { baseURL?: string; model?: string; apiKeyEnv?: string },
  env = process.env,
) {
  const base = new URL(options.baseURL ?? deepseek);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.protocol !== 'https:' &&
      !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))
  )
    throw new Error('Model endpoint requires HTTPS or loopback HTTP');
  const baseURL = base.href.replace(/\/$/, '');
  const keyEnv = options.apiKeyEnv ?? (baseURL === deepseek ? 'DEEPSEEK_API_KEY' : undefined);
  if (keyEnv && (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv) || !env[keyEnv]))
    throw new Error('Missing model credential environment variable: ' + keyEnv);
  const model = options.model ?? 'deepseek-flash';
  if (!model.trim()) throw new Error('Empty model ID');
  return { model, baseURL, keyEnv, key: keyEnv ? env[keyEnv] : undefined };
}

type Call = { id: string; type: 'function'; function: { name: string; arguments: string } };
export interface Reply {
  role: 'assistant';
  content: string | null;
  reasoning_content?: string;
  tool_calls: Call[];
}
type Message =
  | Reply
  | { role: 'user' | 'system'; content: string }
  | {
      role: 'user';
      content: ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];
    }
  | { role: 'tool'; content: string; tool_call_id: string };
export interface Tool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<
        string,
        | { type: 'string'; enum?: string[]; maxLength?: number }
        | { type: 'number'; minimum: 0; maximum: 1 }
      >;
      required: string[];
      additionalProperties: false;
    };
  };
}
export type Decide = (
  messages: Message[],
  tools: Tool[],
  deadline: number,
  count: () => void,
) => Promise<Reply>;

// Keep assistant calls, reasoning, and their tool results as one group when pruning.
export function messagesFor(
  system: string,
  history: Message[][],
  current: object,
  tools: Tool[],
  limit: number | { historyBytes: number } = 32000,
) {
  const first: Message = { role: 'system', content: system };
  const last: Message = { role: 'user', content: JSON.stringify(current) };
  const maxBytes =
    typeof limit === 'number'
      ? limit
      : Buffer.byteLength(JSON.stringify([[first, last], tools])) + limit.historyBytes;
  while (true) {
    const messages = [first, ...history.flat(), last];
    if (Buffer.byteLength(JSON.stringify([messages, tools])) <= maxBytes) return messages;
    if (!history.length) throw new Error('CONTEXT_BUDGET');
    history.shift();
  }
}
export type History = Message[][];
export function remember(history: History, observation: object, reply: Reply, results: string[]) {
  history.push([
    { role: 'user', content: JSON.stringify(observation) },
    reply,
    ...reply.tool_calls.map((c, i) => ({
      role: 'tool' as const,
      tool_call_id: c.id,
      content: results[i],
    })),
  ]);
}
function parseReply(
  data: { choices?: { finish_reason?: string; message?: Partial<Reply> }[] } | null,
  allowText: boolean,
): Reply {
  const choice = data?.choices?.[0];
  if (choice?.finish_reason === 'length') throw new Error('MODEL_REPLY_TRUNCATED');
  const msg = choice?.message;
  if (
    allowText &&
    choice?.finish_reason === 'stop' &&
    msg?.role === 'assistant' &&
    !msg.tool_calls?.length &&
    typeof msg.content === 'string' &&
    msg.content.trim()
  )
    return { role: 'assistant', content: msg.content.trim().slice(0, 2000), tool_calls: [] };
  if (
    !msg ||
    msg.role !== 'assistant' ||
    choice.finish_reason !== 'tool_calls' ||
    !Array.isArray(msg.tool_calls) ||
    !msg.tool_calls.length
  )
    throw new Error('MODEL_TOOL_CALL_REQUIRED');
  const ids = new Set<string>();
  for (const c of msg.tool_calls) {
    if (
      c?.type !== 'function' ||
      typeof c.id !== 'string' ||
      !c.id ||
      ids.has(c.id) ||
      typeof c.function?.name !== 'string' ||
      typeof c.function.arguments !== 'string'
    )
      throw new Error('MODEL_INVALID_TOOL_CALL');
    ids.add(c.id);
  }
  return {
    role: 'assistant',
    content: typeof msg.content === 'string' ? msg.content : null,
    ...(typeof msg.reasoning_content === 'string' ? { reasoning_content: msg.reasoning_content } : {}),
    tool_calls: msg.tool_calls,
  };
}
export function chatClient(
  config: ReturnType<typeof modelConfig>,
  transport: typeof fetch = fetch,
  onServedModel?: (model: string) => void,
  cancellation?: AbortSignal,
  allowText = false,
): Decide {
  return async (messages, tools, deadline, count) => {
    const body = JSON.stringify({
      model: config.model,
      messages,
      tools,
      stream: false,
      max_tokens: 1536,
    });
    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('TIME_BUDGET');
      if (cancellation?.aborted) throw new Error('CANCELLED');
      const timeout = AbortSignal.timeout(remaining);
      const signal = cancellation ? AbortSignal.any([timeout, cancellation]) : timeout;
      let res: Response | undefined;
      let payload: string | undefined;
      count();
      try {
        res = await transport(config.baseURL + '/chat/completions', {
          method: 'POST',
          redirect: 'error',
          signal,
          body,
          headers: {
            'Content-Type': 'application/json',
            ...(config.key ? { Authorization: 'Bearer ' + config.key } : {}),
          },
        });
        if (res.ok) payload = await res.text();
        else await res.body?.cancel();
      } catch {
        if (cancellation?.aborted) throw new Error('CANCELLED');
        if (signal.aborted) throw new Error('TIME_BUDGET');
        res = undefined;
      }
      if (payload !== undefined) {
        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          throw new Error('MODEL_INVALID_JSON');
        }
        const reply = parseReply(parsed, allowText);
        if (typeof parsed.model === 'string' && /^[a-zA-Z0-9._:/-]{1,160}$/.test(parsed.model))
          onServedModel?.(parsed.model);
        return reply;
      }
      const retry = !res || [429, 500, 502, 503, 504].includes(res.status);
      if (!retry || attempt >= 2)
        throw new Error(res ? 'MODEL_HTTP_' + res.status : 'MODEL_NETWORK_ERROR');
      const header = res?.headers.get('retry-after');
      let delay = 300 * 2 ** attempt;
      if (header) {
        const ms = /^\d+(\.\d+)?$/.test(header)
          ? Number(header) * 1000
          : Date.parse(header) - Date.now();
        if (Number.isFinite(ms)) delay = Math.max(0, ms);
      }
      if (Date.now() + delay >= deadline) throw new Error('TIME_BUDGET');
      try {
        await sleep(delay, undefined, { signal: cancellation });
      } catch {
        throw new Error('CANCELLED');
      }
    }
  };
}
