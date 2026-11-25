import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Platform } from './host.js';
import { maxScriptSteps } from './script.js';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message = code) {
    super(message);
  }
}

export type Principal = { subject: string; tokenId?: string };
export type Grant = Principal & { permissions: string[]; devices: string[] };
type Json = Record<string, unknown>;
type Conversation = {
  id: string; owner: string; device_id: string; platform: Platform; title: string;
  created_at: string; updated_at: string; revision: number; last_turn: number; active_run: string | null;
};
type Script = {
  id: string; owner: string | null; source: 'builtin' | 'user'; title: string; archived: number;
  created_at: string; updated_at: string; revision: number; document: string; platforms: string; step_count: number;
};
type Token = {
  id: string; subject: string; digest: string; permissions: string; devices: string;
};
type Message = {
  id: string; sequence: number; turn: number; role: 'user' | 'assistant'; content: string;
  created_at: string; run_id: string; reply_requested: number | null;
};

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const timestamp = () => new Date().toISOString();
const contentTag = (value: string) => '"' + hash(value) + '"';
const resourceTag = (value: { id: string; revision: number }) => '"' + value.id + '-' + value.revision + '"';
const builtinScripts = [
  ['145ff830-1c70-40f8-9373-e840e047d239', 'settings-bluetooth', '蓝牙导航'],
  ['aafae2cd-e08b-46be-a005-9125b9e9b1e8', 'settings-search', '设置搜索'],
] as const;
const platforms = ['android', 'harmony', 'ios'];

export const permissions = new Set([
  '*', 'devices:read', 'devices:reconcile', 'devices:diagnose',
  'runs:read', 'runs:submit', 'runs:cancel', 'artifacts:read',
  'scripts:read', 'scripts:write', 'conversations:read', 'conversations:write',
]);

export function hasPermission(principal: Grant, permission: string) {
  return principal.permissions.includes('*') || principal.permissions.includes(permission);
}

export function canUseDevice(principal: Grant, id: string) {
  return principal.devices.includes('*') || principal.devices.includes(id);
}

export function requirePermission(principal: Grant, permission: string) {
  if (!hasPermission(principal, permission)) throw new ApiError(403, 'FORBIDDEN');
}

export function requireDevice(principal: Grant, id: string) {
  if (!canUseDevice(principal, id)) throw new ApiError(404, 'DEVICE_NOT_FOUND');
}

function requireOwner(grant: Grant, owner: string | null, code: string) {
  if (owner !== null && owner !== grant.subject && !grant.permissions.includes('*'))
    throw new ApiError(404, code);
}

function requireMatch(actual: string, expected: string | undefined) {
  if (!expected) throw new ApiError(428, 'PRECONDITION_REQUIRED');
  if (expected !== actual) throw new ApiError(412, 'PRECONDITION_FAILED');
}

export class ApiData {
  readonly db: DatabaseSync;
  readonly artifactDir: string;
  private readonly bootstrapDigest?: string;

  constructor(directory: string, bootstrapToken?: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.artifactDir = join(directory, 'artifacts');
    mkdirSync(this.artifactDir, { recursive: true, mode: 0o700 });
    this.bootstrapDigest = bootstrapToken ? hash(bootstrapToken) : undefined;
    this.db = new DatabaseSync(join(directory, 'service.sqlite'));
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY, subject TEXT NOT NULL, digest TEXT UNIQUE NOT NULL,
        permissions TEXT NOT NULL, devices TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS api_scripts (
        id TEXT PRIMARY KEY, owner TEXT, source TEXT NOT NULL, title TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1, document TEXT NOT NULL, platforms TEXT NOT NULL,
        step_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_conversations (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, device_id TEXT NOT NULL, platform TEXT NOT NULL,
        title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1, last_turn INTEGER NOT NULL DEFAULT 0, active_run TEXT
      );
      CREATE TABLE IF NOT EXISTS api_turns (
        conversation_id TEXT NOT NULL REFERENCES api_conversations(id) ON DELETE CASCADE,
        turn INTEGER NOT NULL, run_id TEXT NOT NULL UNIQUE, status TEXT,
        PRIMARY KEY(conversation_id, turn)
      );
      CREATE TABLE IF NOT EXISTS api_messages (
        conversation_id TEXT NOT NULL REFERENCES api_conversations(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL, id TEXT NOT NULL, turn INTEGER NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, created_at TEXT NOT NULL, run_id TEXT NOT NULL, reply_requested INTEGER,
        PRIMARY KEY(conversation_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS api_conversation_steps (
        conversation_id TEXT NOT NULL REFERENCES api_conversations(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL, turn INTEGER NOT NULL, document TEXT NOT NULL,
        PRIMARY KEY(conversation_id, sequence)
      );
    `);
  }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  seedScripts() {
    this.transaction(() => {
      const insert = this.db.prepare(`INSERT INTO api_scripts
        (id, source, title, created_at, updated_at, document, platforms, step_count)
        VALUES (?, 'builtin', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, document=excluded.document,
          platforms=excluded.platforms, step_count=excluded.step_count, updated_at=excluded.updated_at,
          revision=api_scripts.revision+1
        WHERE api_scripts.document!=excluded.document OR api_scripts.title!=excluded.title`);
      const now = timestamp();
      for (const [id, file, title] of builtinScripts) {
        const script = JSON.parse(readFileSync(new URL('../examples/' + file + '.json', import.meta.url), 'utf8'));
        insert.run(id, title, now, now, JSON.stringify(script), JSON.stringify(platforms), script.steps.length);
      }
    });
  }

  issueToken(subject: string, access: string[], devices: string[]) {
    if (!/^[\w.@-]{1,100}$/.test(subject) || subject === 'local-admin') throw new ApiError(400, 'INVALID_SUBJECT');
    if (!access.length || access.some((scope) => !permissions.has(scope)))
      throw new ApiError(400, 'INVALID_PERMISSION');
    if (!devices.length || devices.some((id) => id !== '*' && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)))
      throw new ApiError(400, 'INVALID_DEVICE_ID');
    const id = randomUUID(), token = 'omu_' + randomBytes(32).toString('base64url');
    this.db.prepare(`INSERT INTO api_tokens (id,subject,digest,permissions,devices,created_at)
       VALUES (?,?,?,?,?,?)`).run(id, subject, hash(token), JSON.stringify(access), JSON.stringify(devices), timestamp());
    return { id, subject, token, permissions: access, devices };
  }

  revokeToken(id: string) {
    if (!this.db.prepare('UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?')
      .run(timestamp(), id).changes) throw new ApiError(404, 'TOKEN_NOT_FOUND');
  }

  private grant(row: Token | undefined): Grant | undefined {
    return row && { subject: row.subject, tokenId: row.id, permissions: JSON.parse(row.permissions), devices: JSON.parse(row.devices) };
  }

  private bootstrapGrant(): Grant {
    return { subject: 'local-admin', tokenId: 'bootstrap:' + this.bootstrapDigest, permissions: ['*'], devices: ['*'] };
  }

  authenticate(authorization: string | undefined) {
    const token = /^Bearer ([!-~]+)$/i.exec(authorization ?? '')?.[1];
    if (!token || token.length > 512) throw new ApiError(401, 'UNAUTHORIZED');
    const digest = hash(token);
    if (this.bootstrapDigest &&
        timingSafeEqual(Buffer.from(this.bootstrapDigest, 'hex'), Buffer.from(digest, 'hex')))
      return this.bootstrapGrant();
    const grant = this.grant(this.db.prepare('SELECT * FROM api_tokens WHERE digest = ? AND revoked_at IS NULL')
      .get(digest) as Token | undefined);
    if (!grant) throw new ApiError(401, 'UNAUTHORIZED');
    return grant;
  }

  currentGrant(principal: Principal): Grant | undefined {
    if (this.bootstrapDigest && principal.subject === 'local-admin' &&
        principal.tokenId === 'bootstrap:' + this.bootstrapDigest) return this.bootstrapGrant();
    if (!principal.tokenId) return;
    return this.grant(this.db.prepare('SELECT * FROM api_tokens WHERE id = ? AND subject = ? AND revoked_at IS NULL')
      .get(principal.tokenId, principal.subject) as Token | undefined);
  }

  private scriptRow(grant: Grant, id: string): Script {
    const item = this.db.prepare('SELECT * FROM api_scripts WHERE id = ?').get(id) as Script | undefined;
    if (!item) throw new ApiError(404, 'SCRIPT_NOT_FOUND');
    requireOwner(grant, item.owner, 'SCRIPT_NOT_FOUND');
    return item;
  }

  private scriptSummary(item: Script) {
    return {
      id: item.id, title: item.title, source: item.source, archived: item.archived === 1,
      stepCount: item.step_count, platforms: JSON.parse(item.platforms),
      createdAt: item.created_at, updatedAt: item.updated_at,
    };
  }

  listScripts(grant: Grant, includeArchived: boolean) {
    return (this.db.prepare('SELECT * FROM api_scripts ORDER BY created_at DESC, id DESC').all() as Script[])
      .filter((item) => (includeArchived || !item.archived) &&
        (item.owner === null || item.owner === grant.subject || grant.permissions.includes('*')))
      .map((item) => this.scriptSummary(item));
  }

  createScript(grant: Grant, title: string, document: { steps: unknown[] }, supported: Platform[]) {
    const id = randomUUID(), now = timestamp();
    this.db.prepare(`INSERT INTO api_scripts
      (id,owner,source,title,created_at,updated_at,document,platforms,step_count)
      VALUES (?,?,'user',?,?,?,?,?,?)`)
      .run(id, grant.subject, title, now, now, JSON.stringify(document), JSON.stringify(supported), document.steps.length);
    return this.getScript(grant, id);
  }

  getScript(grant: Grant, id: string) {
    const item = this.scriptRow(grant, id);
    return { summary: this.scriptSummary(item), etag: resourceTag(item) };
  }

  getScriptContent(grant: Grant, id: string, etag?: string) {
    const item = this.scriptRow(grant, id);
    const tag = contentTag(item.document);
    if (etag !== undefined) requireMatch(tag, etag);
    return { document: JSON.parse(item.document), etag: tag };
  }

  updateScript(grant: Grant, id: string, etag: string | undefined,
    change: { title?: string; script?: { steps: unknown[] }; archived?: boolean }, supported?: Platform[]) {
    return this.transaction(() => {
      const item = this.scriptRow(grant, id);
      if (item.source === 'builtin') throw new ApiError(409, 'BUILTIN_SCRIPT');
      requireMatch(resourceTag(item), etag);
      this.db.prepare(`UPDATE api_scripts SET title=?,archived=?,document=?,platforms=?,step_count=?,
          updated_at=?,revision=revision+1 WHERE id=?`)
        .run(change.title ?? item.title, change.archived === undefined ? item.archived : Number(change.archived),
          change.script ? JSON.stringify(change.script) : item.document,
          supported ? JSON.stringify(supported) : item.platforms,
          change.script?.steps.length ?? item.step_count, timestamp(), id);
      return this.getScript(grant, id);
    });
  }

  deleteScript(grant: Grant, id: string, etag: string | undefined) {
    this.transaction(() => {
      const item = this.scriptRow(grant, id);
      if (item.source === 'builtin') throw new ApiError(409, 'BUILTIN_SCRIPT');
      requireMatch(resourceTag(item), etag);
      this.db.prepare('DELETE FROM api_scripts WHERE id = ?').run(id);
    });
  }

  private conversationRow(grant: Grant, id: string) {
    const item = this.db.prepare('SELECT * FROM api_conversations WHERE id = ?').get(id) as Conversation | undefined;
    if (!item || !canUseDevice(grant, item.device_id)) throw new ApiError(404, 'CONVERSATION_NOT_FOUND');
    requireOwner(grant, item.owner, 'CONVERSATION_NOT_FOUND');
    return item;
  }

  private conversationSummary(item: Conversation) {
    const { messages, steps } = this.db.prepare(
      `SELECT (SELECT COUNT(*) FROM api_messages WHERE conversation_id = ?) AS messages,
          (SELECT COUNT(*) FROM api_conversation_steps WHERE conversation_id = ?) AS steps`,
    ).get(item.id, item.id) as { messages: number; steps: number };
    return {
      id: item.id, deviceId: item.device_id, title: item.title, createdAt: item.created_at,
      updatedAt: item.updated_at, lastTurn: item.last_turn, messageCount: messages,
      recordedStepCount: steps, activeRunId: item.active_run ?? undefined,
    };
  }

  listConversations(grant: Grant, deviceId?: string) {
    return (this.db.prepare('SELECT * FROM api_conversations ORDER BY created_at DESC, id DESC').all() as Conversation[])
      .filter((item) => (!deviceId || item.device_id === deviceId) && canUseDevice(grant, item.device_id) &&
        (item.owner === grant.subject || grant.permissions.includes('*')))
      .map((item) => this.conversationSummary(item));
  }

  createConversation(grant: Grant, device: { id: string; platform: Platform }, title = '') {
    requireDevice(grant, device.id);
    const id = randomUUID(), now = timestamp();
    this.db.prepare(`INSERT INTO api_conversations (id,owner,device_id,platform,title,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(id, grant.subject, device.id, device.platform, title, now, now);
    return this.getConversation(grant, id);
  }

  getConversation(grant: Grant, id: string) {
    const item = this.conversationRow(grant, id);
    return { summary: this.conversationSummary(item), etag: resourceTag(item) };
  }

  renameConversation(grant: Grant, id: string, etag: string | undefined, title: string) {
    return this.transaction(() => {
      const item = this.conversationRow(grant, id);
      requireMatch(resourceTag(item), etag);
      if (item.active_run) throw new ApiError(409, 'CONVERSATION_BUSY');
      this.db.prepare('UPDATE api_conversations SET title=?,updated_at=?,revision=revision+1 WHERE id=?')
        .run(title, timestamp(), id);
      return this.getConversation(grant, id);
    });
  }

  deleteConversation(grant: Grant, id: string, etag: string | undefined) {
    this.transaction(() => {
      const item = this.conversationRow(grant, id);
      requireMatch(resourceTag(item), etag);
      if (item.active_run) throw new ApiError(409, 'CONVERSATION_BUSY');
      this.db.prepare('DELETE FROM api_conversations WHERE id = ?').run(id);
    });
  }

  listMessages(grant: Grant, id: string) {
    this.conversationRow(grant, id);
    return (this.db.prepare('SELECT * FROM api_messages WHERE conversation_id = ? ORDER BY sequence').all(id) as Message[])
      .map((item) => ({
        id: item.id, sequence: item.sequence, turn: item.turn, role: item.role, content: item.content,
        createdAt: item.created_at, runId: item.run_id,
        replyRequested: item.reply_requested === null ? undefined : item.reply_requested === 1,
      }));
  }

  private insertMessage(id: string, turn: number, runId: string, role: 'user' | 'assistant',
    content: string, replyRequested?: boolean) {
    const { next } = this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM api_messages WHERE conversation_id = ?')
      .get(id) as { next: number };
    this.db.prepare('INSERT INTO api_messages VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, next, randomUUID(), turn, role, content, timestamp(), runId, replyRequested === undefined ? null : Number(replyRequested));
    return next;
  }

  beginConversation(grant: Grant, request: { kind: string; input: Json },
    device: { id: string; platform: Platform }, runId: string) {
    requirePermission(grant, 'conversations:write');
    const message = request.kind === 'chat' ? String(request.input.message).trim() : undefined;
    const requestId = request.input.conversationId as string | undefined;
    if (request.kind === 'chat' && !message) throw new ApiError(422, 'INVALID_MESSAGE');
    if (!requestId && request.kind !== 'chat') throw new ApiError(422, 'INVALID_CONVERSATION');
    const id = requestId ?? this.createConversation(grant, device, message?.slice(0, 64)).summary.id;
    const item = this.conversationRow(grant, id);
    if (item.device_id !== device.id) throw new ApiError(409, 'CONVERSATION_DEVICE_MISMATCH');
    if (requestId) requireMatch(resourceTag(item), request.input.conversationETag as string | undefined);
    if (item.active_run) throw new ApiError(409, 'CONVERSATION_BUSY');
    const turn = item.last_turn + 1;
    this.db.prepare('INSERT INTO api_turns (conversation_id,turn,run_id) VALUES (?,?,?)').run(id, turn, runId);
    this.db.prepare(`UPDATE api_conversations SET last_turn=?,active_run=?,updated_at=?,revision=revision+1 WHERE id=?`)
      .run(turn, runId, timestamp(), id);
    if (message) this.insertMessage(id, turn, runId, 'user', message);
    const dialogue = new Map<number, { user: string; assistant?: string }>();
    for (const item of this.listMessages(grant, id).slice(-16)) {
      if (item.turn === turn) continue;
      if (item.role === 'user') dialogue.set(item.turn, { user: item.content });
      else {
        const entry = dialogue.get(item.turn);
        if (entry) entry.assistant = item.content;
      }
    }
    const { count } = this.db.prepare('SELECT COUNT(*) AS count FROM api_conversation_steps WHERE conversation_id = ?')
      .get(id) as { count: number };
    return { id, turn, dialogue: [...dialogue.values()], remainingSteps: maxScriptSteps - count };
  }

  recordConversationStep(change: { id: string; turn: number; runId: string; step: unknown }) {
    const item = this.db.prepare('SELECT active_run FROM api_conversations WHERE id = ?').get(change.id) as
      { active_run: string | null } | undefined;
    if (item?.active_run !== change.runId) throw new ApiError(409, 'CONVERSATION_BUSY');
    const { next } = this.db.prepare(`SELECT COALESCE(MAX(sequence),0)+1 AS next
      FROM api_conversation_steps WHERE conversation_id = ?`).get(change.id) as { next: number };
    if (next > maxScriptSteps) throw new ApiError(409, 'RECORDING_FULL');
    this.db.prepare('INSERT INTO api_conversation_steps VALUES (?,?,?,?)')
      .run(change.id, next, change.turn, JSON.stringify(change.step));
    this.db.prepare('UPDATE api_conversations SET updated_at=?,revision=revision+1 WHERE id=?')
      .run(timestamp(), change.id);
  }

  completeConversation(change: { id: string; turn: number; runId: string; status: string; answer?: string; replyRequested?: boolean }) {
    const updated = this.db.prepare(`UPDATE api_conversations SET active_run=NULL,updated_at=?,revision=revision+1
      WHERE id=? AND active_run=?`).run(timestamp(), change.id, change.runId);
    if (!updated.changes) return;
    this.db.prepare('UPDATE api_turns SET status=? WHERE conversation_id=? AND turn=? AND run_id=?')
      .run(change.status, change.id, change.turn, change.runId);
    if (change.answer) return this.insertMessage(change.id, change.turn, change.runId, 'assistant',
      change.answer, change.replyRequested);
  }

  conversationRecording(grant: Grant, id: string, throughTurn?: number) {
    const item = this.conversationRow(grant, id);
    const { turn } = this.db.prepare(`SELECT MAX(turn) AS turn FROM api_turns
      WHERE conversation_id=? AND status IS NOT NULL`).get(id) as { turn: number | null };
    if (throughTurn !== undefined && (turn === null || throughTurn > turn))
      throw new ApiError(422, 'TURN_NOT_COMPLETED');
    const rows = this.db.prepare(`SELECT document FROM api_conversation_steps
      WHERE conversation_id=? AND turn<=? ORDER BY sequence`).all(id, throughTurn ?? turn ?? 0) as { document: string }[];
    if (!rows.length) throw new ApiError(404, 'RECORDING_NOT_FOUND');
    return { platform: item.platform, steps: rows.map((row) => JSON.parse(row.document)) };
  }

  close() {
    this.db.close();
  }
}
