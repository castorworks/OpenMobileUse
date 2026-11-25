import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { bluetoothTask } from './agent.js';
import { bluetoothDefinition } from './bluetooth-task.js';
import { chatClient, type modelConfig } from './chat.js';
import { conversationTimeLimitMs, runConversation } from './conversation.js';
import { commentCloseState, commentCloseTarget, CommentCloseUnverified, type CommentCloseProof, type CommentVideo } from './comment-panel.js';
import { connectionError, diagnose } from './doctor.js';
import type { Platform, Target } from './host.js';
import { captureView } from './inspect.js';
import { reason } from './observation.js';
import { recordStep, type RecordedStep } from './recording.js';
import { compileScript, executeRound, type Progress } from './run.js';
import { compileStep, maxScriptSteps, object } from './script.js';
import { acknowledgePending, pending, withDevice, type Dispatch, type PendingDispatch } from './session.js';
import {
  NativeServiceDrivers, servicePlatforms,
  type ConnectedTarget, type DriverStatus, type NativeDriverOptions, type OwnedDriverSession,
  type ServiceDevice, type ServiceDrivers,
} from './service-drivers.js';
import {
  executeStep, guardObservation, matchingControls, observationId, resolveControl, screenAvailable,
  uniqueSelector, type View,
} from './steps.js';
import { parseTask } from './task.js';

const kinds = ['capture', 'diagnose', 'step', 'script', 'chat', 'agent'] as const;
export type RunKind = typeof kinds[number];
export type RunStatus = 'queued' | 'starting' | 'running' | 'cancelling' |
  'succeeded' | 'needs_review' | 'failed' | 'cancelled';
type TerminalStatus = Extract<RunStatus, 'succeeded' | 'needs_review' | 'failed' | 'cancelled'>;
const terminal = (status: RunStatus): status is TerminalStatus =>
  ['succeeded', 'needs_review', 'failed', 'cancelled'].includes(status);
const active = "('queued','starting','running','cancelling')";
const clock = () => new Date().toISOString();
const day = 24 * 60 * 60 * 1000;

export type RunRequest = {
  deviceId: string;
  kind: RunKind;
  input: Record<string, unknown>;
  onBusy?: 'reject' | 'queue';
  startWithinMs?: number;
  timeoutMs?: number;
  preview?: boolean;
};
export type ServicePrincipal = { subject: string; tokenId?: string };
type ConversationLink = {
  id: string;
  turn: number;
  dialogue: { user: string; assistant?: string; reason?: string }[];
  remainingSteps?: number;
};
export interface RunResources {
  resolveScript?(principal: ServicePrincipal, id: string, etag?: string): unknown;
  scriptTitle?(principal: ServicePrincipal, id: string): string;
  beginConversation?(principal: ServicePrincipal, request: RunRequest, runId: string): ConversationLink;
  recordConversationStep?(item: { id: string; turn: number; runId: string; step: RecordedStep }): void;
  completeConversation?(item: {
    id: string; turn: number; runId: string; status: TerminalStatus;
    answer?: string; reason?: string; replyRequested?: boolean;
  }): number | undefined;
}
export interface RunData {
  db: DatabaseSync;
  transaction<T>(work: () => T): T;
}
export type ModelProfile = { id: string; allowsImages?: boolean; config: ReturnType<typeof modelConfig> };
export interface RunServiceOptions {
  data: RunData;
  artifactDir: string;
  drivers?: ServiceDrivers;
  driverOptions?: NativeDriverOptions;
  profiles?: ModelProfile[];
  resources?: RunResources;
  authorized?(principal: ServicePrincipal, request: RunRequest): boolean | void;
  limits?: Partial<{
    requestBytes: number; queuePerDevice: number; observationTtlMs: number;
    maximumTimeoutMs: number; defaultTimeoutMs: number;
    runRetentionMs: number; eventRetentionMs: number; screenshotRetentionMs: number;
  }>;
}
export class ServiceError extends Error {
  constructor(readonly status: number, readonly code: string, detail?: string) {
    super(detail ? code + ': ' + detail : code);
  }
}

type DeviceRow = { id: string; platform: Platform; hardware?: string | null };
type RouteRow = {
  deviceId: string; platform: Platform; alias: string; native: string;
  present: number; conflict: number; seenAt: string;
};
type RunRow = {
  id: string; owner: string; deviceId: string; kind: RunKind; status: RunStatus;
  title: string | null;
  principal: string; request: string; job: string;
  createdAt: string; startedAt: string | null; deadlineAt: string | null;
  finishedAt: string | null; cancelRequestedAt: string | null;
  queueUntil: number | null; lastEventId: number;
  conversationId: string | null; result: string | null; reason: string | null; cleanupError: string | null;
};
type EventType = 'run.status' | 'run.progress' | 'step.result' | 'message.completed' | 'artifact.available';
type RunEvent = { sequence: number; type: EventType; at: string; data: Record<string, unknown> };
type ArtifactKind = 'screenshot' | 'layout' | 'recording' | 'report';
type MediaType = 'image/png' | 'application/json' | 'application/xml';
type Artifact = {
  id: string; kind: ArtifactKind; mediaType: MediaType; url: string; createdAt: string;
  expiresAt?: string; observationId?: string; observedAt?: string; partial?: boolean;
};
type ArtifactRow = { metadata: string; file: string };
type SavedObservation = { deviceId: string; at: number; expires: number; before: string; view: string };
type Job = {
  script?: unknown;
  task?: unknown;
  modelProfile?: string;
  conversation?: ConversationLink;
};
type Result = {
  status: TerminalStatus; reason?: string; result?: Record<string, unknown>;
  cleanupError?: string;
};
type PendingRecord = PendingDispatch & { id: string; target: Target };
type Acknowledgement = {
  id: string; acknowledgedAt: string; outcome: 'applied' | 'not_applied' | 'accepted_current_state';
};

function json<T>(value: string): T {
  return JSON.parse(value) as T;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) {
    return '{' + Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function digest(value: unknown) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function pendingId(deviceId: string, alias: string, runId: string, sequence: number) {
  const hash = digest([deviceId, alias, runId, sequence]);
  return hash.slice(0, 8) + '-' + hash.slice(8, 12) + '-4' + hash.slice(13, 16) +
    '-8' + hash.slice(17, 20) + '-' + hash.slice(20, 32);
}

function deviceConnection(target?: Target): 'usb' | 'network' | 'emulator' | 'unknown' {
  switch (target?.connection?.toLowerCase()) {
    case 'usb': return 'usb';
    case 'tcp':
    case 'network': return 'network';
    case 'emulator': return 'emulator';
    default: return 'unknown';
  }
}

function connectionPriority(target: Target) {
  const connection = deviceConnection(target);
  return connection === 'usb' ? 0 : connection === 'network' ? 1 : 2;
}

function roundReport(value: Awaited<ReturnType<typeof executeRound>>) {
  const { status } = value;
  return {
    status,
    steps: 'steps' in value ? value.steps : undefined,
    failedStep: 'failedStep' in value ? value.failedStep : undefined,
    reason: 'reason' in value ? value.reason : undefined,
    evidence: 'evidence' in value ? value.evidence : undefined,
  };
}

export class RunService {
  private readonly db: DatabaseSync;
  private readonly tx: RunData['transaction'];
  private readonly artifactDir: string;
  private readonly drivers: ServiceDrivers;
  private readonly profiles: ModelProfile[];
  private readonly resources: RunResources;
  private readonly authorized?: RunServiceOptions['authorized'];
  private readonly limits: Required<NonNullable<RunServiceOptions['limits']>>;
  private readonly activeRuns = new Map<string, { id: string; controller: AbortController; done: Promise<void> }>();
  private readonly failedDriverCleanup = new Set<string>();
  private readonly commentOrigins = new Map<string, CommentVideo>();
  private readonly driverStatus = new Map<Platform, DriverStatus>();
  private hostLock?: DatabaseSync;
  private refresh?: Promise<void>;
  private interval?: NodeJS.Timeout;
  private retention?: Promise<void>;
  private ready = false;
  private draining = false;
  private discovered = false;

  constructor(options: RunServiceOptions) {
    this.db = options.data.db;
    this.tx = options.data.transaction.bind(options.data);
    this.artifactDir = options.artifactDir;
    this.profiles = options.profiles?.slice() ?? [];
    this.drivers = options.drivers ?? new NativeServiceDrivers({
      ...options.driverOptions,
      secretKeys: [
        ...options.driverOptions?.secretKeys ?? [],
        ...this.profiles.flatMap((profile) => profile.config.keyEnv ? [profile.config.keyEnv] : []),
      ],
    });
    this.resources = options.resources ?? {};
    this.authorized = options.authorized;
    this.limits = {
      requestBytes: 8 * 1024 * 1024,
      queuePerDevice: 10,
      observationTtlMs: 60_000,
      maximumTimeoutMs: 900_000,
      defaultTimeoutMs: 300_000,
      runRetentionMs: 30 * day,
      eventRetentionMs: 7 * day,
      screenshotRetentionMs: day,
      ...options.limits,
    };
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS service_devices (
        id TEXT PRIMARY KEY, platform TEXT NOT NULL, hardware TEXT, UNIQUE(platform, hardware)
      );
      CREATE TABLE IF NOT EXISTS service_routes (
        deviceId TEXT NOT NULL REFERENCES service_devices(id), platform TEXT NOT NULL, alias TEXT NOT NULL,
        native TEXT NOT NULL, present INTEGER NOT NULL, conflict INTEGER NOT NULL, seenAt TEXT NOT NULL,
        PRIMARY KEY (platform, alias)
      );
      CREATE INDEX IF NOT EXISTS service_routes_device ON service_routes(deviceId);
      CREATE TABLE IF NOT EXISTS service_runs (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, deviceId TEXT NOT NULL REFERENCES service_devices(id),
        kind TEXT NOT NULL, status TEXT NOT NULL, title TEXT, principal TEXT NOT NULL, request TEXT NOT NULL, job TEXT NOT NULL,
        createdAt TEXT NOT NULL, startedAt TEXT, finishedAt TEXT, deadlineAt TEXT, cancelRequestedAt TEXT,
        queueUntil INTEGER, lastEventId INTEGER NOT NULL DEFAULT 0, conversationId TEXT, result TEXT,
        reason TEXT, cleanupError TEXT
      );
      CREATE INDEX IF NOT EXISTS service_runs_device ON service_runs(deviceId, status);
      CREATE TABLE IF NOT EXISTS service_idempotency (
        subject TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, runId TEXT NOT NULL REFERENCES service_runs(id),
        PRIMARY KEY (subject, key)
      );
      CREATE TABLE IF NOT EXISTS service_events (
        runId TEXT NOT NULL REFERENCES service_runs(id), sequence INTEGER NOT NULL, type TEXT NOT NULL,
        at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (runId, sequence)
      );
      CREATE TABLE IF NOT EXISTS service_confirmed_steps (
        runId TEXT NOT NULL REFERENCES service_runs(id), sequence INTEGER NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY (runId, sequence)
      );
      CREATE TABLE IF NOT EXISTS service_artifacts (
        runId TEXT NOT NULL REFERENCES service_runs(id), id TEXT NOT NULL, metadata TEXT NOT NULL,
        file TEXT NOT NULL, PRIMARY KEY (runId, id)
      );
      CREATE TABLE IF NOT EXISTS service_observations (
        id TEXT PRIMARY KEY, deviceId TEXT NOT NULL REFERENCES service_devices(id), at INTEGER NOT NULL,
        expires INTEGER NOT NULL, before TEXT NOT NULL, view TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS service_owned_sessions (
        runId TEXT PRIMARY KEY, deviceId TEXT NOT NULL REFERENCES service_devices(id),
        descriptor TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS service_acknowledgements (
        id TEXT PRIMARY KEY, deviceId TEXT NOT NULL REFERENCES service_devices(id), principal TEXT NOT NULL,
        observationId TEXT NOT NULL, body TEXT NOT NULL
      );
    `);
  }

  async start() {
    if (this.ready) return;
    await mkdir(this.artifactDir, { recursive: true, mode: 0o700 });
    const shared = process.env.OMU_STATE_DIR || join(homedir(), '.openmobileuse');
    await mkdir(shared, { recursive: true, mode: 0o700 });
    this.hostLock = new DatabaseSync(join(shared, 'host-run.lock.sqlite'));
    try {
      this.hostLock.exec('BEGIN IMMEDIATE');
    } catch {
      this.hostLock.close();
      this.hostLock = undefined;
      throw new ServiceError(503, 'HOST_SERVICE_BUSY');
    }
    try {
      await this.restore();
      this.ready = true;
      await this.scan();
      this.schedule();
      this.interval = setInterval(() => {
        this.schedule();
        this.retention ??= this.prune().catch(() => {}).finally(() => { this.retention = undefined; });
      }, 1000);
      this.interval.unref();
    } catch (error) {
      this.hostLock.close();
      this.hostLock = undefined;
      this.ready = false;
      throw error;
    }
  }

  async close() {
    this.draining = true;
    clearInterval(this.interval);
    for (const { id, controller } of this.activeRuns.values()) {
      if (!controller.signal.aborted) {
        this.cancelRun(id);
        controller.abort(Error('CANCELLED'));
      }
    }
    await Promise.allSettled([...this.activeRuns.values()].map(({ done }) => done));
    await Promise.allSettled([this.refresh, this.retention]);
    await this.drivers.close();
    this.hostLock?.close();
    this.hostLock = undefined;
    this.ready = false;
  }

  capabilities() {
    const { requestBytes, queuePerDevice, observationTtlMs, maximumTimeoutMs, defaultTimeoutMs } = this.limits;
    return {
      kinds: [...kinds],
      drivers: servicePlatforms.map((platform) => this.driverStatus.get(platform) ??
        { platform, available: false, code: 'DISCOVERY_PENDING' }),
      modelProfiles: this.profiles.map(({ id, allowsImages }) => ({ id, allowsImages: allowsImages === true })),
      limits: { requestBytes, queuePerDevice, observationTtlMs, maximumTimeoutMs, defaultTimeoutMs },
    };
  }

  private scan() {
    this.refresh ??= this.discover().finally(() => { this.refresh = undefined; });
    return this.refresh;
  }

  private async discover() {
    const snapshots = await Promise.all(servicePlatforms.map(async (platform) => {
      const [targets, status] = await Promise.allSettled([
        this.drivers.discover(platform), this.drivers.status(platform),
      ]);
      return { platform, targets, status };
    }));
    this.tx(() => {
      for (const { platform, targets, status } of snapshots) {
        this.driverStatus.set(platform, status.status === 'fulfilled' ? status.value :
          { platform, available: false, code: 'DRIVER_UNAVAILABLE' });
        this.db.prepare('UPDATE service_routes SET present = 0 WHERE platform = ?').run(platform);
        if (targets.status !== 'fulfilled') continue;
        const usb = targets.value.filter((target) => target.available && deviceConnection(target) === 'usb');
        for (const target of targets.value.slice().sort((a, b) => connectionPriority(a) - connectionPriority(b))) {
          const prior = this.db.prepare(`
            SELECT r.deviceId,r.conflict,d.hardware FROM service_routes r
            JOIN service_devices d ON d.id=r.deviceId WHERE r.platform = ? AND r.alias = ?
          `).get(platform, target.id);
          const existing = prior?.deviceId as string | undefined;
          const match = target.hardwareKey ? this.db.prepare(
            'SELECT id FROM service_devices WHERE platform = ? AND hardware = ?',
          ).get(platform, target.hardwareKey)?.id as string | undefined : undefined;
          const id = existing ?? match ?? randomUUID();
          const unresolvedNetwork = deviceConnection(target) === 'network' &&
            ((prior?.conflict === 1 && !target.hardwareKey) ||
              usb.some((other) => !target.hardwareKey || !other.hardwareKey));
          const identityChanged = !!target.hardwareKey && !!prior?.hardware && prior.hardware !== target.hardwareKey;
          const conflict = unresolvedNetwork || identityChanged || (!!existing && !!match && existing !== match);
          if (!existing && !match) {
            this.db.prepare('INSERT INTO service_devices (id,platform,hardware) VALUES (?,?,?)')
              .run(id, platform, target.hardwareKey ?? null);
          } else if (existing && !match && target.hardwareKey) {
            this.db.prepare('UPDATE service_devices SET hardware = COALESCE(hardware, ?) WHERE id = ?')
              .run(target.hardwareKey, id);
          }
          this.db.prepare(`
            INSERT INTO service_routes (deviceId,platform,alias,native,present,conflict,seenAt)
              VALUES (?,?,?,?,1,?,?)
            ON CONFLICT(platform,alias) DO UPDATE SET native=excluded.native,present=1,
              conflict=excluded.conflict,seenAt=excluded.seenAt
          `).run(id, platform, target.id, JSON.stringify(target), Number(conflict), clock());
        }
      }
    });
    this.discovered = true;
  }

  async listDevices(refresh = false) {
    if (refresh || !this.discovered) await this.scan();
    const rows = this.db.prepare('SELECT id FROM service_devices ORDER BY id').all();
    return rows.map(({ id }) => this.getDevice(String(id)));
  }

  private deviceRow(id: string) {
    const row = this.db.prepare('SELECT * FROM service_devices WHERE id = ?').get(id);
    if (!row) throw new ServiceError(404, 'UNKNOWN_DEVICE');
    return row as unknown as DeviceRow;
  }

  private routes(id: string) {
    return this.db.prepare('SELECT * FROM service_routes WHERE deviceId = ?').all(id)
      .map((row) => row as unknown as RouteRow)
      .sort((a, b) => b.present - a.present || a.conflict - b.conflict ||
        Number(json<Target>(b.native).available) - Number(json<Target>(a.native).available) ||
        connectionPriority(json<Target>(a.native)) - connectionPriority(json<Target>(b.native)) ||
        a.alias.localeCompare(b.alias));
  }

  getDevice(id: string) {
    const row = this.deviceRow(id);
    const route = this.routes(id)[0];
    const target = route ? json<Target>(route.native) : undefined;
    const driver = this.driverStatus.get(row.platform);
    let state: 'available' | 'offline' | 'unauthorized' | 'driver_unavailable' | 'conflict' = 'offline';
    let errorCode: string | undefined;
    if (route?.present && route.conflict) state = 'conflict';
    else if (driver?.available === false || this.failedDriverCleanup.has(id)) {
      state = 'driver_unavailable';
      errorCode = this.failedDriverCleanup.has(id) ? 'DEVICE_SESSION_CLOSE_FAILED' : driver?.code;
    } else if (route?.present && target?.available) state = 'available';
    else if (route?.present && target && connectionError(target) === 'AUTHORIZATION_REQUIRED') state = 'unauthorized';
    return {
      id, platform: row.platform, name: target?.model.trim() || row.platform,
      state, connection: deviceConnection(target),
      busy: !!this.db.prepare(`SELECT 1 FROM service_runs WHERE deviceId = ? AND status IN ${active} LIMIT 1`).get(id),
      needsReview: this.pendingRecords(id).length > 0,
      lastSeenAt: route?.seenAt,
      errorCode,
    };
  }

  listTasks() {
    return [{ id: bluetoothTask, goal: bluetoothDefinition.goal, platforms: [...servicePlatforms] }];
  }

  getTask(id: string) {
    const task = this.listTasks().find((entry) => entry.id === id);
    if (!task) throw new ServiceError(404, 'UNKNOWN_TASK');
    return task;
  }

  private pendingRecords(id: string): PendingRecord[] {
    const running = this.activeRuns.get(id);
    const inflight = running && !terminal(this.runRow(running.id).status) ? running.id : undefined;
    return this.routes(id).flatMap((route) => {
      const target = json<Target>(route.native);
      return pending(target).filter((entry) => entry.runId !== inflight).map((entry) => ({
        ...entry, id: pendingId(id, route.alias, entry.runId, entry.seq), target,
      }));
    });
  }

  listPendingActions(id: string) {
    this.deviceRow(id);
    return this.pendingRecords(id).map((entry) => ({
      id: entry.id, deviceId: id, runId: entry.runId,
      sequence: entry.seq, action: entry.kind, dispatchedAt: entry.time,
    })).sort((a, b) => a.dispatchedAt.localeCompare(b.dispatchedAt) || a.id.localeCompare(b.id));
  }

  private transport(id: string): Target {
    const platform = this.deviceRow(id).platform;
    const selected = this.routes(id)[0];
    const target = selected ? json<Target>(selected.native) : { id, platform, model: platform, available: false };
    return { ...target, available: target.available && selected?.present === 1 && !selected.conflict };
  }

  private withLocks<T>(id: string, target: Target, runId: string, work: (dispatch: Dispatch) => Promise<T>) {
    const targets = this.routes(id).map((route) => json<Target>(route.native))
      .filter((alias) => alias.id !== target.id)
      .concat(target)
      .sort((a, b) => a.id.localeCompare(b.id));
    const lock = (index: number, selected?: Dispatch): Promise<T> => {
      if (index === targets.length) return work(selected!);
      const alias = targets[index];
      return withDevice(alias, runId, (dispatch) =>
        lock(index + 1, alias.id === target.id ? dispatch : selected));
    };
    return lock(0);
  }

  private observation(id: string, deviceId: string, after?: number, allowGesture = false): SavedObservation {
    const row = this.db.prepare('SELECT * FROM service_observations WHERE id = ?').get(id) as
      unknown as SavedObservation | undefined;
    if (!row || id.startsWith('reconcile-') || (id.startsWith('gesture-') && !allowGesture) ||
        row.deviceId !== deviceId || row.expires <= Date.now() ||
        (after !== undefined && row.at <= after)) {
      throw new ServiceError(409, 'STALE_OBSERVATION');
    }
    return row;
  }

  async acknowledgeAction(
    deviceId: string, actionId: string,
    input: { observationId: string; outcome: Acknowledgement['outcome'] },
    principal: ServicePrincipal,
  ) {
    this.deviceRow(deviceId);
    const accepted = this.db.prepare(
      'SELECT observationId, body FROM service_acknowledgements WHERE id = ? AND deviceId = ?',
    ).get(actionId, deviceId);
    const recorded = accepted ? json<Acknowledgement>(String(accepted.body)) : undefined;
    if (recorded && (accepted?.observationId !== input.observationId || input.outcome !== recorded.outcome))
      throw new ServiceError(409, 'ACKNOWLEDGEMENT_CONFLICT');
    const found = this.pendingRecords(deviceId).find((entry) => entry.id === actionId);
    if (!found) {
      if (recorded) return recorded;
      throw new ServiceError(404, 'UNKNOWN_PENDING_ACTION');
    }
    const target = this.transport(deviceId);
    if (!target.available) throw new ServiceError(409, connectionError(target));
    const leaseId = randomUUID();
    try {
      return await this.withLocks(deviceId, target, leaseId, async (dispatch) => {
        const exact = this.pendingRecords(deviceId).find((entry) => entry.id === actionId);
        if (!exact) {
          const previous = this.db.prepare(
            'SELECT observationId,body FROM service_acknowledgements WHERE id = ? AND deviceId = ?',
          ).get(actionId, deviceId);
          if (previous) {
            const value = json<Acknowledgement>(String(previous.body));
            if (value.outcome === input.outcome && previous.observationId === input.observationId) return value;
            throw new ServiceError(409, 'ACKNOWLEDGEMENT_CONFLICT');
          }
          throw new ServiceError(404, 'UNKNOWN_PENDING_ACTION');
        }
        if (recorded) {
          acknowledgePending(exact.target, exact.runId, exact.seq);
          return recorded;
        }
        const saved = this.observation(input.observationId, deviceId, Date.parse(exact.time));
        const signal = AbortSignal.timeout(this.limits.defaultTimeoutMs);
        const opened = await this.drivers.open(target, dispatch, 'foreground', signal);
        try {
          this.rememberDriverSession(leaseId, deviceId, opened.owned);
          const live = await opened.device.snapshot();
          const captured = json<View>(saved.view);
          if (observationId(deviceId, live) !== observationId(deviceId, captured))
            throw new ServiceError(409, 'STALE_OBSERVATION');
          this.observation(input.observationId, deviceId, Date.parse(exact.time));
        } finally {
          await this.closeDriverSession(leaseId, deviceId, opened);
        }
        return this.recordAcknowledgement(deviceId, exact, input.observationId, input.outcome, principal.subject);
      });
    } catch (error) {
      if (reason(error) === 'DEVICE_BUSY') throw new ServiceError(409, 'DEVICE_BUSY');
      throw error;
    }
  }

  private recordAcknowledgement(deviceId: string, action: PendingRecord, observationId: string,
    outcome: Acknowledgement['outcome'], subject: string) {
    const value = { id: action.id, acknowledgedAt: clock(), outcome };
    this.db.prepare(`
      INSERT OR IGNORE INTO service_acknowledgements(id,deviceId,principal,observationId,body)
      VALUES(?,?,?,?,?)
    `).run(action.id, deviceId, subject, observationId, JSON.stringify(value));
    acknowledgePending(action.target, action.runId, action.seq);
    return value;
  }

  private runRow(id: string) {
    const row = this.db.prepare('SELECT * FROM service_runs WHERE id = ?').get(id);
    if (!row) throw new ServiceError(404, 'UNKNOWN_RUN');
    return row as unknown as RunRow;
  }

  private summary(row: RunRow) {
    return {
      id: row.id, deviceId: row.deviceId, kind: row.kind, status: row.status,
      title: row.title ?? undefined,
      createdAt: row.createdAt, startedAt: row.startedAt ?? undefined,
      deadlineAt: row.deadlineAt ?? undefined, finishedAt: row.finishedAt ?? undefined,
      cancelRequestedAt: row.cancelRequestedAt ?? undefined,
      conversationId: row.conversationId ?? undefined, lastEventId: row.lastEventId,
    };
  }

  getRunOwner(id: string): string | undefined {
    const value = this.db.prepare('SELECT owner FROM service_runs WHERE id = ?').get(id)?.owner;
    return typeof value === 'string' ? value : undefined;
  }

  getRun(id: string) {
    const row = this.runRow(id);
    const artifacts = this.db.prepare('SELECT metadata FROM service_artifacts WHERE runId = ? ORDER BY rowid')
      .all(id).map((item) => json<Artifact>(String(item.metadata)));
    return {
      ...this.summary(row),
      result: row.result ? json<Record<string, unknown>>(row.result) : undefined,
      reason: row.reason ?? undefined, cleanupError: row.cleanupError ?? undefined, artifacts,
    };
  }

  listRuns() {
    return this.db.prepare('SELECT * FROM service_runs ORDER BY createdAt DESC, id DESC').all()
      .map((row) => this.summary(row as unknown as RunRow));
  }

  events(id: string, after = 0, limit = 50) {
    const run = this.runRow(id);
    const first = this.db.prepare('SELECT MIN(sequence) AS first FROM service_events WHERE runId = ?')
      .get(id)?.first;
    if (after < (typeof first === 'number' ? first - 1 : run.lastEventId))
      throw new ServiceError(410, 'EVENT_CURSOR_EXPIRED');
    const page = this.db.prepare(`
      SELECT sequence,type,at,data FROM service_events WHERE runId = ? AND sequence > ?
      ORDER BY sequence LIMIT ?
    `).all(id, after, limit + 1);
    const items: RunEvent[] = page.slice(0, limit).map((item) => ({
      sequence: Number(item.sequence), type: item.type as EventType,
      at: String(item.at), data: json<Record<string, unknown>>(String(item.data)),
    }));
    return { items, lastEventId: run.lastEventId, nextAfter: page.length > limit ? items.at(-1)?.sequence : undefined };
  }

  private event(id: string, type: EventType, data: Record<string, unknown>) {
    const next = Number(this.db.prepare(
      'UPDATE service_runs SET lastEventId = lastEventId + 1 WHERE id = ? RETURNING lastEventId',
    ).get(id)?.lastEventId);
    this.db.prepare('INSERT INTO service_events(runId,sequence,type,at,data) VALUES(?,?,?,?,?)')
      .run(id, next, type, clock(), JSON.stringify(data));
  }

  private profile(name?: string) {
    const profile = name ? this.profiles.find(({ id }) => id === name) : this.profiles[0];
    if (!profile) throw new ServiceError(422, 'MODEL_PROFILE_UNAVAILABLE');
    return profile;
  }

  private checkAuthorization(principal: ServicePrincipal, request: RunRequest) {
    if (this.authorized?.(principal, request) === false) throw new ServiceError(403, 'FORBIDDEN');
  }

  private existingRequest(principal: ServicePrincipal, key: string, checksum: string) {
    const existing = this.db.prepare('SELECT runId,digest FROM service_idempotency WHERE subject = ? AND key = ?')
      .get(principal.subject, key);
    if (!existing) return;
    if (existing.digest !== checksum) throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT');
    return this.summary(this.runRow(String(existing.runId)));
  }

  private scriptBody(request: RunRequest, principal: ServicePrincipal) {
    if (typeof request.input.scriptId !== 'string') return request.input.script;
    if (!this.resources.resolveScript) throw new ServiceError(404, 'UNKNOWN_SCRIPT');
    return this.resources.resolveScript(principal, request.input.scriptId,
      typeof request.input.scriptETag === 'string' ? request.input.scriptETag : undefined);
  }

  private async prepare(request: RunRequest, principal: ServicePrincipal, platform: Platform): Promise<Job> {
    const { input, kind } = request;
    if (kind === 'script') {
      const script = this.scriptBody(request, principal);
      try { await compileScript(script, platform); }
      catch (error) { throw new ServiceError(422, reason(error), (error as Error).message); }
      return { script };
    }
    if (kind === 'step') {
      try {
        const { step, observation } = await compileStep(input.step, platform);
        if (observation) throw Error('INVALID_STEP');
        if ((step.kind === 'swipe' || (step.kind === 'tap' && 'point' in step)) &&
            typeof input.observationId !== 'string') throw Error('OBSERVATION_REQUIRED');
      } catch (error) {
        throw new ServiceError(422, reason(error));
      }
      if (typeof input.observationId === 'string') {
        const action = object(input.step) && input.step.action;
        this.observation(input.observationId, request.deviceId, undefined, action === 'tap' || action === 'swipe');
      }
      return {};
    }
    if (kind === 'capture' || kind === 'diagnose') return {};
    const profile = this.profile(typeof input.modelProfile === 'string' ? input.modelProfile : undefined);
    if (input.useImages === true && !profile.allowsImages) throw new ServiceError(403, 'MODEL_IMAGES_FORBIDDEN');
    if (kind === 'chat') {
      if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 2000)
        throw new ServiceError(422, 'INVALID_MESSAGE');
      return { modelProfile: profile.id };
    }
    if (typeof input.taskId === 'string') {
      this.getTask(input.taskId);
      if (input.useImages === true) throw new ServiceError(422, 'TASK_HAS_NO_VISUAL_ACTIONS');
      return { modelProfile: profile.id };
    }
    try {
      const task = await parseTask(input.task, platform);
      if (input.useImages === true && !task.actions.some((action) => action.visual))
        throw Error('TASK_HAS_NO_VISUAL_ACTIONS');
    } catch (error) {
      throw new ServiceError(422, reason(error));
    }
    return { task: input.task, modelProfile: profile.id };
  }

  async submit(request: RunRequest, principal: ServicePrincipal, idempotencyKey: string) {
    if (!this.ready || this.draining) throw new ServiceError(503, 'SERVICE_UNAVAILABLE');
    this.checkAuthorization(principal, request);
    const checksum = digest(request);
    const replay = this.existingRequest(principal, idempotencyKey, checksum);
    if (replay) return replay;
    const { deviceId, kind, input } = request;
    const device = this.getDevice(deviceId);
    if (kind !== 'diagnose' && device.state !== 'available')
      throw new ServiceError(409, device.errorCode ?? connectionError(this.transport(deviceId)));
    if (!['capture', 'diagnose'].includes(kind) && device.needsReview)
      throw new ServiceError(409, 'PENDING_ACTION_REVIEW_REQUIRED');
    if (request.timeoutMs && request.timeoutMs > this.limits.maximumTimeoutMs)
      throw new ServiceError(422, 'RUN_TIMEOUT_LIMIT');
    const job = await this.prepare(request, principal, device.platform);
    // The HTTP contract validates the shape. The service repeats the checks that can change during prepare.
    const accepted = this.tx(() => {
      this.checkAuthorization(principal, request);
      const prior = this.existingRequest(principal, idempotencyKey, checksum);
      if (prior) return prior;
      if (this.draining) throw new ServiceError(503, 'SERVICE_UNAVAILABLE');
      const count = Number(this.db.prepare(
        `SELECT COUNT(*) AS n FROM service_runs WHERE deviceId = ? AND status IN ${active}`,
      ).get(deviceId)?.n);
      if (request.onBusy !== 'queue' && count > 0) throw new ServiceError(409, 'DEVICE_BUSY');
      if (request.onBusy === 'queue' && count > this.limits.queuePerDevice)
        throw new ServiceError(429, 'DEVICE_QUEUE_FULL');
      if (!['capture', 'diagnose'].includes(kind) && this.pendingRecords(deviceId).length)
        throw new ServiceError(409, 'PENDING_ACTION_REVIEW_REQUIRED');
      if (kind === 'script' && typeof input.scriptId === 'string' &&
          digest(this.scriptBody(request, principal)) !== digest(job.script))
        throw new ServiceError(412, 'SCRIPT_CHANGED');
      const id = randomUUID();
      if (kind === 'chat' || (kind === 'step' && typeof input.conversationId === 'string')) {
        if (!this.resources.beginConversation) throw new ServiceError(503, 'CONVERSATION_STORAGE_UNAVAILABLE');
        job.conversation = this.resources.beginConversation(principal, request, id);
        if ((kind === 'step' || input.record !== false) && job.conversation.remainingSteps === 0)
          throw new ServiceError(422, 'RECORDING_FULL');
      }
      const queued = request.onBusy === 'queue';
      const queueUntil = queued ? Date.now() + (request.startWithinMs ?? 0) : null;
      let title: string | undefined;
      if (kind === 'chat') title = String(input.message).trim().slice(0, 64);
      else if (kind === 'script' && typeof input.scriptId === 'string')
        title = this.resources.scriptTitle?.(principal, input.scriptId);
      this.db.prepare(`
        INSERT INTO service_runs(id,owner,deviceId,kind,status,title,principal,request,job,createdAt,queueUntil,conversationId)
        VALUES(?,?,?,?,'queued',?,?,?,?,?,?,?)
      `).run(id, principal.subject, deviceId, kind, title ?? null, JSON.stringify(principal), JSON.stringify(request),
        JSON.stringify(job), clock(), queueUntil, job.conversation?.id ?? null);
      this.db.prepare('INSERT INTO service_idempotency(subject,key,digest,runId) VALUES(?,?,?,?)')
        .run(principal.subject, idempotencyKey, checksum, id);
      this.event(id, 'run.status', { status: 'queued' });
      return this.summary(this.runRow(id));
    });
    setImmediate(() => this.schedule());
    return accepted;
  }

  cancelRun(id: string) {
    this.tx(() => {
      const row = this.runRow(id);
      if (terminal(row.status) || row.status === 'cancelling') return;
      const when = clock();
      this.db.prepare('UPDATE service_runs SET cancelRequestedAt = ? WHERE id = ?').run(when, id);
      if (row.status === 'queued') {
        this.finishInTransaction(row, { status: 'cancelled', reason: 'CANCELLED' });
        return;
      }
      this.db.prepare("UPDATE service_runs SET status = 'cancelling' WHERE id = ?").run(id);
      this.event(id, 'run.status', { status: 'cancelling' });
    });
    const run = this.getRun(id);
    if (run.status === 'cancelling') {
      const running = this.activeRuns.get(run.deviceId);
      if (running?.id === id && !running.controller.signal.aborted)
        running.controller.abort(Error('CANCELLED'));
    }
    setImmediate(() => this.schedule());
    return run;
  }

  private schedule() {
    if (!this.ready || this.draining) return;
    for (const running of this.activeRuns.values()) {
      const run = this.runRow(running.id);
      if (terminal(run.status) || running.controller.signal.aborted) continue;
      try {
        this.checkAuthorization(json<ServicePrincipal>(run.principal), json<RunRequest>(run.request));
      } catch {
        this.cancelRun(run.id);
      }
    }
    const rows = this.db.prepare(`
      SELECT * FROM service_runs WHERE status = 'queued'
      ORDER BY createdAt ASC, rowid ASC
    `).all();
    for (const raw of rows) {
      const row = raw as unknown as RunRow;
      if (row.queueUntil !== null && row.queueUntil <= Date.now()) {
        this.finish(row, { status: 'failed', reason: 'QUEUE_TIMEOUT' });
        continue;
      }
      if (this.activeRuns.has(row.deviceId)) continue;
      const controller = new AbortController();
      const done = Promise.resolve().then(() => this.process(row, controller)).catch((error) => {
        const current = this.runRow(row.id);
        if (!terminal(current.status)) this.finish(current, { status: 'failed', reason: reason(error) });
      }).finally(() => {
        this.activeRuns.delete(row.deviceId);
        this.schedule();
      });
      this.activeRuns.set(row.deviceId, { id: row.id, controller, done });
    }
  }

  private async process(row: RunRow, controller: AbortController) {
    const request = json<RunRequest>(row.request);
    const principal = json<ServicePrincipal>(row.principal);
    const job = json<Job>(row.job);
    const signal = controller.signal;
    if (terminal(this.runRow(row.id).status)) return;
    let expiry: NodeJS.Timeout | undefined;
    let started = false;
    let result: Result;
    try {
      this.checkAuthorization(principal, request);
      await this.scan();
      signal.throwIfAborted();
      if (row.queueUntil !== null && row.queueUntil <= Date.now()) throw Error('QUEUE_TIMEOUT');
      const target = this.transport(row.deviceId);
      if (request.kind === 'diagnose' && !target.available) {
        this.setStatus(row.id, 'running');
        result = this.offlineDiagnosis(row, target);
      } else {
        if (!target.available) throw Error(connectionError(target));
        if (this.failedDriverCleanup.has(row.deviceId)) throw Error('DEVICE_SESSION_CLOSE_FAILED');
        for (;;) {
          try {
            result = await this.withLocks(row.deviceId, target, row.id, async (dispatch) => {
              signal.throwIfAborted();
              this.checkAuthorization(principal, request);
              if (!['capture', 'diagnose'].includes(request.kind) && this.pendingRecords(row.deviceId).length)
                throw Error('PENDING_ACTION_REVIEW_REQUIRED');
              const timeout = request.timeoutMs ?? this.limits.defaultTimeoutMs;
              const deadline = new Date(Date.now() + timeout).toISOString();
              this.setStatus(row.id, 'starting', deadline);
              started = true;
              expiry = setTimeout(() => {
                if (signal.aborted) return;
                this.tx(() => {
                  this.db.prepare("UPDATE service_runs SET status='cancelling' WHERE id=?").run(row.id);
                  this.event(row.id, 'run.status', { status: 'cancelling', reason: 'RUN_TIMEOUT' });
                });
                controller.abort(Error('RUN_TIMEOUT'));
              }, timeout);
              expiry.unref();
              return this.openAndExecute(row, request, job, principal, target, dispatch, signal);
            });
            break;
          } catch (error) {
            if (started || reason(error) !== 'DEVICE_BUSY' || row.queueUntil === null) throw error;
            if (row.queueUntil <= Date.now()) throw Error('QUEUE_TIMEOUT');
            await sleep(Math.min(200, row.queueUntil - Date.now()), undefined, { signal });
          }
        }
      }
    } catch (error) {
      const code = reason(error);
      result = this.failed(signal, code === 'DEVICE_ERROR' ? diagnose(error) : code);
    } finally {
      clearTimeout(expiry);
    }
    if (signal.aborted && result.reason !== 'ACTION_OUTCOME_UNKNOWN') {
      result = { ...result, ...this.failed(signal, result.reason), cleanupError: result.cleanupError };
    }
    if (!terminal(this.runRow(row.id).status)) await this.publishAndFinish(row, result);
  }

  private setStatus(id: string, status: 'starting' | 'running', deadline?: string) {
    this.tx(() => {
      this.db.prepare(`
        UPDATE service_runs SET status = ?, startedAt = COALESCE(startedAt,?),
          deadlineAt = COALESCE(deadlineAt,?) WHERE id = ?
      `).run(status, clock(), deadline ?? null, id);
      this.event(id, 'run.status', { status });
    });
  }

  private failed(signal: AbortSignal, code = 'DEVICE_ERROR'): Result {
    if (code === 'ACTION_OUTCOME_UNKNOWN') return { status: 'failed', reason: code };
    if (signal.aborted) {
      const abortCode = reason(signal.reason);
      if (abortCode === 'CANCELLED') return { status: 'cancelled', reason: abortCode };
      return { status: 'failed', reason: abortCode };
    }
    return { status: 'failed', reason: code };
  }

  private offlineDiagnosis(row: RunRow, target: Target): Result {
    return {
      status: 'succeeded',
      result: {
        kind: 'diagnose', controllable: false, pendingActions: this.listPendingActions(row.deviceId),
        probes: [{ stage: 'connection', ok: false, error: connectionError(target) }],
      },
    };
  }

  private rememberDriverSession(id: string, deviceId: string, owned?: OwnedDriverSession) {
    if (owned) {
      this.db.prepare('INSERT INTO service_owned_sessions(runId,deviceId,descriptor) VALUES(?,?,?)')
        .run(id, deviceId, JSON.stringify(owned));
    }
  }

  private async closeDriverSession(
    id: string, deviceId: string, opened: Awaited<ReturnType<ServiceDrivers['open']>>,
  ) {
    try {
      await opened.close();
      if (opened.owned) this.db.prepare('DELETE FROM service_owned_sessions WHERE runId = ?').run(id);
    } catch {
      this.failedDriverCleanup.add(deviceId);
      throw Error('DEVICE_SESSION_CLOSE_FAILED');
    }
  }

  private async openAndExecute(
    row: RunRow, request: RunRequest, job: Job, principal: ServicePrincipal,
    target: Target, dispatch: Dispatch, signal: AbortSignal,
  ): Promise<Result> {
    const check = () => {
      signal.throwIfAborted();
      try {
        this.checkAuthorization(principal, request);
      } catch (error) {
        this.cancelRun(row.id);
        signal.throwIfAborted();
        throw error;
      }
    };
    const guardedDispatch: Dispatch = (kind, perform, verify) => {
      check();
      return dispatch(kind, perform, verify && (() => {
        check();
        return verify();
      }));
    };
    const script = request.kind === 'script' ? await compileScript(job.script, target.platform) : undefined;
    const task = job.task ? await parseTask(job.task, target.platform) : undefined;
    const mode = script?.mode ?? (request.kind === 'agent' && !task ? 'settings' : 'foreground');
    let opened: Awaited<ReturnType<ServiceDrivers['open']>> | undefined;
    let stage = 'session';
    const probes: Record<string, unknown>[] = [{ stage: 'connection', ok: true }];
    let result: Result;
    let cleanupError: string | undefined;
    try {
      check();
      if (request.kind === 'diagnose' && this.drivers.toolchain) {
        stage = 'toolchain';
        const information = await this.drivers.toolchain(target, signal);
        probes.push({ stage, ok: true, detail: [information.driver, information.version, information.appium].filter(Boolean).join(' ') });
        stage = 'session';
      }
      opened = await this.drivers.open(target, guardedDispatch, mode, signal,
        request.kind === 'chat' ? conversationTimeLimitMs / 1000 + 30 : undefined);
      if (target.platform === 'android') opened.device.commentOrigin = this.commentOrigins.get(row.deviceId);
      this.rememberDriverSession(row.id, row.deviceId, opened.owned);
      check();
      probes.push({ stage, ok: true });
      this.setStatus(row.id, 'running');
      stage = 'observation';
      if (request.kind === 'diagnose') {
        await opened.device.snapshot();
        probes.push({ stage, ok: true });
        result = { status: 'succeeded', result: {
          kind: 'diagnose', controllable: true, probes, pendingActions: this.listPendingActions(row.deviceId),
        } };
      } else {
        result = await this.execute(row, request, job, target.platform, opened.device, check, signal, script, task);
      }
    } catch (error) {
      const code = reason(error);
      if (request.kind === 'diagnose' && !signal.aborted) {
        probes.push({ stage, ok: false, error: code === 'DEVICE_ERROR' ? diagnose(error) : code });
        result = { status: 'succeeded', result: {
          kind: 'diagnose', controllable: false, probes, pendingActions: this.listPendingActions(row.deviceId),
        } };
      } else {
        result = this.failed(signal, code === 'DEVICE_ERROR' ? diagnose(error) : code);
      }
    } finally {
      if (opened) {
        if (target.platform === 'android') {
          if (opened.device.commentOrigin) this.commentOrigins.set(row.deviceId, opened.device.commentOrigin);
          else this.commentOrigins.delete(row.deviceId);
        }
        try {
          await this.closeDriverSession(row.id, row.deviceId, opened);
        } catch {
          cleanupError = 'DEVICE_SESSION_CLOSE_FAILED';
        }
      }
    }
    if (cleanupError && request.kind === 'diagnose' && result.result) {
      probes.push({ stage: 'cleanup', ok: false, error: cleanupError });
      result.result.controllable = false;
    }
    return { ...result, cleanupError };
  }

  private async execute(
    row: RunRow, request: RunRequest, job: Job, platform: Platform, device: ServiceDevice,
    check: () => void, signal: AbortSignal,
    script?: Awaited<ReturnType<typeof compileScript>>, task?: Awaited<ReturnType<typeof parseTask>>,
  ): Promise<Result> {
    if (request.kind === 'capture') return this.capture(row, request, device, signal);
    const progress: Progress = ({ name, status, phase }) => {
      this.tx(() => this.event(row.id, 'run.progress', { name, status, phase }));
    };
    let lastFrame = 0;
    const preview = request.preview ? async (captured?: Buffer) => {
      if (signal.aborted || Date.now() - lastFrame < 500) return;
      lastFrame = Date.now();
      try {
        check();
        await this.saveArtifact(row.id, 'screenshot', 'image/png', captured ?? await device.screenshot());
      } catch (error) {
        progress({ kind: 'evidence', name: 'preview', status: reason(error) });
      }
    } : undefined;
    const input = request.input;
    if (request.kind === 'step') {
      return this.step(row, request, job, platform, device, signal);
    }
    const profile = job.modelProfile ? this.profile(job.modelProfile) : undefined;
    const model = profile && chatClient(request.kind === 'chat'
      ? { ...profile.config, requestTimeoutMs: 15_000, maxRetries: 5 } : profile.config,
      fetch, undefined, signal, request.kind === 'chat');
    const decide: typeof model = model && ((...args) => {
      check();
      return model(...args);
    });
    if (request.kind === 'chat') {
      const conversation = job.conversation!;
      let confirmed = 0;
      const capture = input.record !== false;
      let lastView: View | undefined;
      const watched = preview ? {
        snapshot: async () => (lastView = await device.snapshot()),
        screenshot: device.screenshot.bind(device), foregroundApp: device.foregroundApp.bind(device),
        perform: (...args: Parameters<ServiceDevice['perform']>) => { lastView = undefined; return device.perform(...args); },
        launch: (...args: Parameters<ServiceDevice['launch']>) => { lastView = undefined; return device.launch(...args); },
        back: () => { lastView = undefined; return device.back(); },
        goHome: device.goHome && ((signal?: AbortSignal) => { lastView = undefined; return device.goHome!(signal); }),
      } : device;
      const chat = await runConversation(
        watched, platform + ':' + row.deviceId, platform, [...conversation.dialogue, { user: String(input.message) }],
        decide!, signal,
        async (step) => {
          if (!capture) return;
          this.confirm(row, job, step);
          confirmed++;
        },
        (name, status) => progress({ kind: 'action', name, status }),
        () => !capture || confirmed < (conversation.remainingSteps ?? maxScriptSteps),
        (message) => this.tx(() => this.event(row.id, 'run.progress', { name: 'activity', message })),
        input.useImages === true,
        preview,
      );
      return {
        status: chat.status === 'succeeded' ? 'succeeded' : chat.status === 'needs_review' ? 'needs_review' : 'failed',
        reason: chat.reason,
        result: {
          kind: 'chat', conversationId: conversation.id, turn: conversation.turn,
          answer: chat.answer, replyRequested: chat.replyRequested,
          modelCalls: chat.modelCalls, confirmedStepCount: confirmed,
          ...(preview && !signal.aborted ? await this.frameResult(row, request, device, signal,
            chat.status === 'succeeded' ? lastView : undefined) : {}),
        },
      };
    }

    const rounds: ReturnType<typeof roundReport>[] = [];
    const repeat = Number(input.repeat ?? 1);
    if (preview) {
      // Each recorded native operation shares the active session and device lock with the run.
      const watch = <A extends unknown[], R>(operation: (...args: A) => Promise<R>) => async (...args: A) => {
        const result = await operation(...args);
        await preview();
        return result;
      };
      device = {
        snapshot: device.snapshot.bind(device), screenshot: device.screenshot.bind(device),
        foregroundApp: device.foregroundApp.bind(device), observe: device.observe.bind(device),
        close: device.close.bind(device), launch: watch(device.launch.bind(device)),
        perform: watch(device.perform.bind(device)), back: watch(device.back.bind(device)),
        goHome: device.goHome && watch(device.goHome.bind(device)),
        move: watch(device.move.bind(device)),
      };
    }
    for (let index = 0; index < repeat; index++) {
      check();
      const result = roundReport(await executeRound(
        device, platform + ':' + row.deviceId, { script, task, decide, vision: input.useImages === true }, signal, progress,
      ));
      this.tx(() => {
        for (const item of result.steps ?? []) this.event(row.id, 'step.result', item);
      });
      rounds.push(result);
      if (result.status !== 'succeeded')
        return { status: result.status === 'needs_review' ? 'needs_review' : 'failed',
          reason: result.reason, result: { kind: request.kind, rounds } };
    }
    return { status: 'succeeded', result: { kind: request.kind, rounds } };
  }

  private async step(
    row: RunRow, request: RunRequest, job: Job, platform: Platform,
    device: ServiceDevice, signal: AbortSignal,
  ): Promise<Result> {
    const input = request.input;
    const { step } = await compileStep(input.step, platform);
    const identity = platform + ':' + row.deviceId;
    const raw = input.step as Record<string, unknown> & { action: string };
    let guard: ((view: View) => void) | undefined;
    if (typeof input.observationId === 'string') {
      const id = input.observationId;
      const gesture = step.kind === 'tap' || step.kind === 'swipe';
      const observed = this.observation(id, row.deviceId, undefined, gesture);
      const reference = json<View & { commentOrigin?: CommentVideo }>(observed.view);
      if (platform === 'android' && !device.commentOrigin) device.commentOrigin = reference.commentOrigin;
      const validate = guardObservation(identity, reference, step, screenAvailable);
      const closeAt = (view: View) => step.kind === 'tap' && commentCloseTarget(view, step,
        'selector' in step ? matchingControls(view, step.selector)[0] : undefined);
      const expectedClose = platform === 'android' && closeAt(reference);
      guard = (view) => {
        this.observation(id, row.deviceId, undefined, gesture);
        if (gesture) validate(json<View>(observed.before));
        validate(view);
        if (expectedClose && !closeAt(view)) throw Error('STALE_OBSERVATION');
      };
    }
    let recorded: RecordedStep | undefined;
    const capture = (view: View) => {
      screenAvailable(view);
      guard?.(view);
      if (!job.conversation || step.kind === 'waitFor') return;
      const node = 'selector' in step && step.selector ? resolveControl(view, step.selector, step.kind === 'input') : undefined;
      const selector = node && raw.id === undefined && raw.label === undefined ? uniqueSelector(view, node) : undefined;
      if (node && raw.id === undefined && raw.label === undefined && !selector) throw Error('RECORDING_TARGET_UNAVAILABLE');
      recorded = recordStep(view, { ...raw, ...selector }, node);
    };
    const started = performance.now();
    let frame: { frame?: Record<string, unknown>; captureError?: string } | undefined;
    try {
      let proof: CommentCloseProof | undefined;
      const result = await executeStep(device, identity, step, capture, signal,
        step.kind === 'tap' ? { commentClosed: value => { proof = value; } } : screenAvailable);
      if (job.conversation && step.kind === 'waitFor') {
        const view = await device.snapshot();
        screenAvailable(view);
        const hits = matchingControls(view, step.selector);
        if (hits.length !== (step.state === 'visible' ? 1 : 0)) throw Error('STALE_OBSERVATION');
        recorded = recordStep(view, raw, hits[0]);
      }
      if (request.preview && proof) {
        const verified = proof;
        let displayed: View | undefined;
        frame = await this.frameResult(row, request, device, signal, verified.view, view => { displayed = view; });
        if (displayed) {
          const state = commentCloseState(displayed, verified.view, verified.close, verified.original);
          if (state !== 'closed') throw new CommentCloseUnverified(state === 'open', displayed);
        }
      }
      if (recorded) this.confirm(row, job, recorded);
      this.tx(() => this.event(row.id, 'step.result', {
        index: 1, action: result.action, status: 'succeeded',
        durationMs: Math.round(performance.now() - started),
      }));
      return {
        status: 'succeeded',
        result: {
          kind: 'step', action: result.action, observationId: input.observationId,
          foregroundApp: 'foregroundApp' in result ? result.foregroundApp : undefined,
          foregroundVerified: 'foregroundVerified' in result ? result.foregroundVerified : undefined,
          inputVerified: 'inputVerified' in result ? result.inputVerified : undefined,
          ...('commentPanelClosed' in result && result.commentPanelClosed
            ? { commentPanelClosed: true, tapPoint: result.tapPoint } : {}),
          ...(frame ?? (request.preview ? await this.frameResult(row, request, device, signal) : {})),
          conversationId: job.conversation?.id, turn: job.conversation?.turn,
        },
      };
    } catch (error) {
      const final = this.failed(signal, reason(error));
      if (!signal.aborted && (error instanceof CommentCloseUnverified ||
          (step.kind === 'tap' && reason(error) === 'STALE_OBSERVATION'))) {
        if (reason(error) === 'STALE_OBSERVATION' && typeof input.observationId === 'string')
          this.db.prepare('DELETE FROM service_observations WHERE id=? AND deviceId=?').run(input.observationId, row.deviceId);
        final.status = error instanceof CommentCloseUnverified ? 'needs_review' : 'cancelled';
        final.result = { kind: 'step', action: step.kind, observationId: input.observationId,
          ...(frame ?? (request.preview ? await this.frameResult(row, request, device, signal,
            error instanceof CommentCloseUnverified ? error.view : undefined) : {})) };
      }
      this.tx(() => this.event(row.id, 'step.result', {
        index: 1, action: step.kind, status: final.status, error: final.reason,
        durationMs: Math.round(performance.now() - started),
      }));
      return final;
    }
  }

  private confirm(row: RunRow, job: Job, step: RecordedStep) {
    try {
      this.tx(() => {
        this.db.prepare(`
          INSERT INTO service_confirmed_steps (runId,sequence,body)
          SELECT ?,COALESCE(MAX(sequence),0)+1,? FROM service_confirmed_steps WHERE runId = ?
        `).run(row.id, JSON.stringify(step), row.id);
        if (job.conversation) {
          this.resources.recordConversationStep?.({
            id: job.conversation.id, turn: job.conversation.turn, runId: row.id, step,
          });
        }
      });
    } catch {
      throw Error('RECORDING_WRITE_FAILED');
    }
  }

  private async frameResult(row: RunRow, request: RunRequest, device: ServiceDevice, signal: AbortSignal,
    initialView?: View, onView?: (view: View) => void) {
    try {
      return { frame: (await this.capture(row, request, device, signal, initialView, onView)).result };
    } catch (error) {
      signal.throwIfAborted();
      return { captureError: reason(error) };
    }
  }

  private async capture(row: RunRow, request: RunRequest, device: ServiceDevice, signal: AbortSignal,
    initialView?: View, onView?: (view: View) => void): Promise<Result> {
    signal.throwIfAborted();
    const captured = await captureView(device, row.deviceId, initialView);
    signal.throwIfAborted();
    const { metadata, view, before, image, layout } = captured;
    onView?.(view);
    const stable = !metadata.controlsChangedDuringCapture;
    const token = stable ? randomUUID() : undefined;
    const gestureToken = !stable && this.deviceRow(row.deviceId).platform === 'android' ? 'gesture-' + randomUUID() : undefined;
    const reconcile = request.kind === 'capture' && request.input.reconcilePendingActions === true &&
      before.windowIdentity === view.windowIdentity;
    const evidence = token ?? gestureToken ?? (reconcile ? 'reconcile-' + randomUUID() : undefined);
    const stripLayout = (observed: View) => JSON.stringify({ ...observed, layout: undefined, commentOrigin: device.commentOrigin });
    const observedAt = Date.parse(metadata.observedAt);
    const expires = observedAt + this.limits.observationTtlMs;
    await this.saveArtifact(row.id, 'screenshot', 'image/png', image, {
      observationId: token, observedAt: metadata.observedAt,
    }, evidence ? () => {
      this.db.prepare('INSERT INTO service_observations(id,deviceId,at,expires,before,view) VALUES(?,?,?,?,?,?)')
        .run(evidence, row.deviceId, observedAt, expires, stripLayout(before), stripLayout(view));
    } : undefined);
    if (reconcile && evidence && expires > Date.now()) {
      signal.throwIfAborted();
      this.checkAuthorization(json<ServicePrincipal>(row.principal), request);
      // Capture verified the same foreground window and display geometry around the screenshot.
      for (const action of this.pendingRecords(row.deviceId)) {
        if (Date.parse(action.time) < observedAt)
          this.recordAcknowledgement(row.deviceId, action, evidence, 'accepted_current_state', row.owner);
      }
    }
    if (request.input.includeLayout === true) {
      const xml = typeof layout === 'string';
      await this.saveArtifact(row.id, 'layout', xml ? 'application/xml' : 'application/json',
        xml ? layout : JSON.stringify(layout ?? null), { observedAt: metadata.observedAt });
    }
    const controls = view.controls.map((control) => {
      const selector = control.card && !control.secret ? uniqueSelector(view, control) : undefined;
      return {
        id: control.secret ? undefined : control.id, role: control.role,
        labels: control.secret ? [] : control.labels, bounds: control.bounds,
        enabled: control.enabled, editable: control.editable && !control.secret,
        focused: control.focused, secret: control.secret, clickable: control.clickable,
        checked: control.secret ? undefined : control.checked,
        value: control.secret ? undefined : control.value, navigation: control.navigation,
        cardSelector: selector?.within ? selector : undefined,
      };
    });
    return {
      status: 'succeeded',
      result: {
        kind: 'capture', observedAt: metadata.observedAt, stable, observationId: token, gestureObservationId: gestureToken,
        width: metadata.width, height: metadata.height, rotation: metadata.rotation,
        actionWidth: metadata.actionWidth, actionHeight: metadata.actionHeight, app: metadata.app, controls,
      },
    };
  }

  private async saveArtifact(
    runId: string, kind: ArtifactKind, mediaType: MediaType, data: Buffer | string,
    fields: Pick<Artifact, 'partial' | 'observationId' | 'observedAt'> = {},
    attach?: () => void,
  ) {
    const artifact = await this.writeArtifact(runId, kind, mediaType, data, fields);
    try {
      this.tx(() => {
        this.publishArtifact(runId, artifact);
        attach?.();
      });
    } catch (error) {
      await rm(join(this.artifactDir, artifact.id), { force: true }).catch(() => {});
      throw error;
    }
    return artifact;
  }

  private async writeArtifact(
    runId: string, kind: ArtifactKind, mediaType: MediaType, data: Buffer | string,
    fields: Pick<Artifact, 'partial' | 'observationId' | 'observedAt'> = {},
  ): Promise<Artifact> {
    const id = randomUUID();
    const createdAt = clock();
    const metadata: Artifact = {
      id, kind, mediaType, createdAt, url: '/api/runs/' + runId + '/artifacts/' + id,
      expiresAt: kind === 'screenshot' || kind === 'layout'
        ? new Date(Date.now() + this.limits.screenshotRetentionMs).toISOString() : undefined,
      ...fields,
    };
    const file = join(this.artifactDir, id);
    const temporary = file + '.tmp';
    try {
      await writeFile(temporary, data, { mode: 0o600, flag: 'wx', flush: true });
      await rename(temporary, file);
    } catch (error) {
      await Promise.allSettled([rm(temporary, { force: true }), rm(file, { force: true })]);
      throw error;
    }
    return metadata;
  }

  private publishArtifact(runId: string, artifact: Artifact) {
    this.db.prepare('INSERT INTO service_artifacts(runId,id,metadata,file) VALUES(?,?,?,?)')
      .run(runId, artifact.id, JSON.stringify(artifact), artifact.id);
    this.event(runId, 'artifact.available', artifact);
  }

  async getArtifact(runId: string, artifactId: string) {
    this.runRow(runId);
    const row = this.db.prepare('SELECT metadata,file FROM service_artifacts WHERE runId = ? AND id = ?')
      .get(runId, artifactId) as unknown as ArtifactRow | undefined;
    if (!row) throw new ServiceError(404, 'UNKNOWN_ARTIFACT');
    const artifact = json<Artifact>(row.metadata);
    if (artifact.expiresAt && Date.parse(artifact.expiresAt) <= Date.now())
      throw new ServiceError(410, 'ARTIFACT_EXPIRED');
    const data = await readFile(join(this.artifactDir, row.file)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ServiceError(410, 'ARTIFACT_EXPIRED');
      throw error;
    });
    return { ...artifact, data };
  }

  private async publishAndFinish(row: RunRow, result: Result) {
    const steps = this.db.prepare('SELECT body FROM service_confirmed_steps WHERE runId = ? ORDER BY sequence')
      .all(row.id).map((item) => json<RecordedStep>(String(item.body)));
    const hasRecording = this.db.prepare(`
      SELECT 1 FROM service_artifacts WHERE runId = ? AND json_extract(metadata,'$.kind') = 'recording'
    `).get(row.id);
    let recording: Artifact | undefined;
    if (steps.length && !hasRecording) {
      try {
        const platform = this.deviceRow(row.deviceId).platform;
        recording = await this.writeArtifact(row.id, 'recording', 'application/json',
          JSON.stringify({ platform, steps }) + '\n');
      } catch {
        if (result.reason !== 'ACTION_OUTCOME_UNKNOWN')
          result = { ...result, status: 'failed', reason: 'RECORDING_WRITE_FAILED' };
      }
    }
    try {
      this.tx(() => {
        const current = this.runRow(row.id);
        if (current.cancelRequestedAt && result.status !== 'failed')
          result = { ...result, status: 'cancelled', reason: 'CANCELLED' };
        if (recording) this.publishArtifact(row.id, { ...recording, partial: result.status !== 'succeeded' });
        this.finishInTransaction(row, result);
      });
    } catch (error) {
      if (recording) await rm(join(this.artifactDir, recording.id), { force: true }).catch(() => {});
      throw error;
    }
  }

  private finish(row: RunRow, result: Result) {
    this.tx(() => this.finishInTransaction(row, result));
  }

  private finishInTransaction(row: RunRow, result: Result) {
    if (terminal(this.runRow(row.id).status)) return;
    this.db.prepare(`
      UPDATE service_runs SET status=?,finishedAt=?,result=?,reason=?,cleanupError=? WHERE id=?
    `).run(result.status, clock(), result.result ? JSON.stringify(result.result) : null,
      result.reason ?? null, result.cleanupError ?? null, row.id);
    const conversation = json<Job>(row.job).conversation;
    if (conversation) {
      const answer = result.result?.answer;
      const sequence = this.resources.completeConversation?.({
        id: conversation.id, turn: conversation.turn, runId: row.id, status: result.status,
        answer: typeof answer === 'string' ? answer : undefined,
        reason: result.reason,
        replyRequested: result.result?.replyRequested === true,
      });
      if (sequence !== undefined)
        this.event(row.id, 'message.completed', { conversationId: conversation.id, sequence });
    }
    this.event(row.id, 'run.status', { status: result.status, reason: result.reason });
  }

  private async restore() {
    const sessions = this.db.prepare('SELECT * FROM service_owned_sessions').all();
    for (const owner of sessions) {
      try {
        if (!this.drivers.recover) throw Error('DRIVER_RECOVERY_UNAVAILABLE');
        await this.drivers.recover(json<OwnedDriverSession>(String(owner.descriptor)));
        this.db.prepare('DELETE FROM service_owned_sessions WHERE runId = ?').run(String(owner.runId));
      } catch {
        this.failedDriverCleanup.add(String(owner.deviceId));
      }
    }
    const acknowledged = this.db.prepare('SELECT DISTINCT deviceId FROM service_acknowledgements').all();
    const audit = this.db.prepare('SELECT 1 FROM service_acknowledgements WHERE id = ? AND deviceId = ?');
    for (const { deviceId } of acknowledged) {
      for (const item of this.pendingRecords(String(deviceId))) {
        if (!audit.get(item.id, deviceId)) continue;
        await withDevice(item.target, randomUUID(), async () => {
          acknowledgePending(item.target, item.runId, item.seq);
        }).catch(() => {});
      }
    }
    const unknown = this.db.prepare("SELECT * FROM service_runs WHERE status IN ('starting','running','cancelling')").all();
    for (const raw of unknown) {
      const row = raw as unknown as RunRow;
      const unconfirmed = this.pendingRecords(row.deviceId).some((action) => action.runId === row.id);
      await this.publishAndFinish(row, {
        status: 'failed', reason: unconfirmed ? 'ACTION_OUTCOME_UNKNOWN' : 'RUN_INTERRUPTED',
      });
    }
    const keep = new Set(this.db.prepare('SELECT file FROM service_artifacts').all().map(({ file }) => String(file)));
    await Promise.allSettled((await readdir(this.artifactDir)).filter(
      (name) => /^[a-f0-9-]{36}(?:\.tmp)?$/.test(name) && !keep.has(name),
    ).map((name) => rm(join(this.artifactDir, name), { force: true })));
  }

  private async prune() {
    const now = Date.now();
    this.db.prepare('DELETE FROM service_observations WHERE expires <= ?').run(now);
    const eventAge = new Date(now - this.limits.eventRetentionMs).toISOString();
    this.db.prepare(`
      DELETE FROM service_events WHERE at < ? AND runId IN (SELECT id FROM service_runs WHERE status NOT IN ${active})
    `).run(eventAge);
    const artifacts = this.db.prepare(`
      SELECT file FROM service_artifacts WHERE json_extract(metadata,'$.expiresAt') < ?
    `).all(new Date(now).toISOString());
    for (const { file } of artifacts) await rm(join(this.artifactDir, String(file)), { force: true });
    const old = this.db.prepare(`
      SELECT id,deviceId FROM service_runs WHERE status NOT IN ${active} AND finishedAt < ?
    `).all(new Date(now - this.limits.runRetentionMs).toISOString());
    for (const { id, deviceId } of old) {
      if (this.activeRuns.get(String(deviceId))?.id === id ||
          this.pendingRecords(String(deviceId)).some((entry) => entry.runId === id) ||
          this.db.prepare('SELECT 1 FROM service_owned_sessions WHERE runId = ?').get(id)) continue;
      const files = this.db.prepare('SELECT file FROM service_artifacts WHERE runId = ?').all(id);
      this.tx(() => {
        for (const table of ['service_events', 'service_confirmed_steps', 'service_artifacts', 'service_idempotency'])
          this.db.prepare('DELETE FROM ' + table + ' WHERE runId = ?').run(id);
        this.db.prepare('DELETE FROM service_runs WHERE id = ?').run(id);
      });
      for (const { file } of files) await rm(join(this.artifactDir, String(file)), { force: true });
    }
  }
}
