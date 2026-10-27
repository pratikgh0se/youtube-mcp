import { chmod, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';
import { openDatabase } from '../sqlite/open-database.js';

import type { ConnectionProfile, OperationReconciliation, OperationState } from '../types.js';
import { AppError } from '../errors.js';

export type StoredOperation = {
  approvalId: string;
  profile: ConnectionProfile;
  kind: string;
  targetId: string;
  desired: Record<string, unknown>;
  desiredFingerprint: string;
  currentFingerprint: string;
  expiresAt: string;
  state: OperationState;
  reconciliation?: OperationReconciliation;
};

export type OperationStoreOptions = {
  lockWaitMs?: number;
  staleLockMs?: number;
  retryDelayMs?: number;
  now?: () => Date;
};

export class OperationStore {
  constructor(
    private readonly stateDir: string,
    private readonly options: OperationStoreOptions = {},
  ) {}

  async create(operation: StoredOperation): Promise<StoredOperation> {
    const profileId = safeProfileId(operation.profile.id);
    return this.withProfileLock(profileId, async () => {
      const records = await this.read(profileId);
      const saved = sanitizeOperation(operation);
      records.push(saved);
      await this.write(profileId, records);
      return saved;
    });
  }

  async get(profileId: string, approvalId: string): Promise<StoredOperation | undefined> {
    return (await this.read(safeProfileId(profileId))).find((record) => record.approvalId === approvalId);
  }

  async find(approvalId: string): Promise<StoredOperation | undefined> {
    const profilesDirectory = join(this.stateDir, 'profiles');
    try {
      const profileEntries = await readdir(profilesDirectory, { withFileTypes: true });
      for (const entry of profileEntries) {
        if (!entry.isDirectory()) continue;
        const record = await this.get(entry.name, approvalId);
        if (record) return record;
      }
      return undefined;
    } catch (error) {
      if (isMissingFileError(error)) return undefined;
      throw error;
    }
  }

  async update(profileId: string, approvalId: string, changes: Partial<StoredOperation>): Promise<StoredOperation | undefined> {
    const scopedProfileId = safeProfileId(profileId);
    return this.withProfileLock(scopedProfileId, async () => {
      const records = await this.read(scopedProfileId);
      const index = records.findIndex((record) => record.approvalId === approvalId);
      if (index < 0) return undefined;
      const updated = sanitizeOperation({ ...records[index], ...changes, approvalId: records[index].approvalId, profile: records[index].profile });
      records[index] = updated;
      await this.write(scopedProfileId, records);
      return updated;
    });
  }

  async claim(profileId: string, approvalId: string): Promise<StoredOperation | undefined> {
    const scopedProfileId = safeProfileId(profileId);
    return this.withProfileLock(scopedProfileId, async () => {
      const records = await this.read(scopedProfileId);
      const index = records.findIndex((record) => record.approvalId === approvalId);
      if (index < 0 || records[index].state !== 'approved') return undefined;
      const claimed = sanitizeOperation({ ...records[index], state: 'running' });
      records[index] = claimed;
      await this.write(scopedProfileId, records);
      return claimed;
    });
  }

  async approve(profileId: string, approvalId: string): Promise<StoredOperation | undefined> {
    const scopedProfileId = safeProfileId(profileId);
    return this.withProfileLock(scopedProfileId, async () => {
      const records = await this.read(scopedProfileId);
      const index = records.findIndex((record) => record.approvalId === approvalId);
      if (index < 0 || records[index].state !== 'planned') return undefined;
      const approved = sanitizeOperation({ ...records[index], state: 'approved' });
      records[index] = approved;
      await this.write(scopedProfileId, records);
      return approved;
    });
  }

  async pruneExpired(now: Date): Promise<void> {
    const profilesDirectory = join(this.stateDir, 'profiles');
    try {
      const profileEntries = await readdir(profilesDirectory, { withFileTypes: true });
      await Promise.all(profileEntries.filter((entry) => entry.isDirectory()).map(async (entry) => {
        await this.withProfileLock(entry.name, async () => {
          const records = await this.read(entry.name);
          const retained = records.filter((record) => record.state !== 'planned' || new Date(record.expiresAt).getTime() > now.getTime());
          if (retained.length !== records.length) await this.write(entry.name, retained);
        });
      }));
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }

  private async read(profileId: string): Promise<StoredOperation[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath(profileId), 'utf8'));
      return Array.isArray(parsed) ? parsed as StoredOperation[] : [];
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw error;
    }
  }

  private async write(profileId: string, records: StoredOperation[]): Promise<void> {
    const directory = this.profileDirectory(profileId);
    const temporaryPath = join(directory, `.operations.${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await writeFile(temporaryPath, JSON.stringify(records.map(sanitizeOperation)), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, this.filePath(profileId));
    await chmod(this.filePath(profileId), 0o600);
  }

  private profileDirectory(profileId: string): string {
    return join(this.stateDir, 'profiles', safeProfileId(profileId));
  }

  private filePath(profileId: string): string {
    return join(this.profileDirectory(profileId), 'operations.json');
  }

  private async withProfileLock<T>(profileId: string, action: () => Promise<T>): Promise<T> {
    const directory = this.profileDirectory(profileId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const lock = await acquireLease(this.stateDir, profileId, this.options);
    try {
      return await action();
    } finally {
      await lock.release();
    }
  }
}

async function acquireLease(stateDir: string, profileId: string, options: OperationStoreOptions): Promise<{ release(): Promise<void> }> {
  const waitMs = options.lockWaitMs ?? 2_000;
  const staleMs = options.staleLockMs ?? 30_000;
  const retryMs = options.retryDelayMs ?? 5;
  const deadline = Date.now() + waitMs;
  const clock = () => (options.now ?? (() => new Date()))().getTime();
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const databasePath = join(stateDir, 'operation-locks.sqlite');
  const database = openDatabase(databasePath);
  await chmod(databasePath, 0o600);
  database.pragma(`busy_timeout = ${Math.max(1, Math.min(waitMs, 100))}`);
  database.exec('CREATE TABLE IF NOT EXISTS operation_locks (profile_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL, owner_pid INTEGER NOT NULL DEFAULT -1)');
  const columns = database.pragma('table_info(operation_locks)') as Array<{ name?: string }>;
  if (!columns.some((column) => column.name === 'owner_pid')) {
    database.exec('ALTER TABLE operation_locks ADD COLUMN owner_pid INTEGER NOT NULL DEFAULT -1');
  }
  const token = randomUUID();
  const insert = database.prepare('INSERT OR IGNORE INTO operation_locks (profile_id, token, expires_at, owner_pid) VALUES (?, ?, ?, ?)');
  const readLease = database.prepare('SELECT token, expires_at AS expiresAt, owner_pid AS ownerPid FROM operation_locks WHERE profile_id = ?');
  const steal = database.prepare(`
    UPDATE operation_locks SET token = ?, expires_at = ?, owner_pid = ?
    WHERE profile_id = ? AND token = ? AND expires_at <= ?
  `);
  for (;;) {
    try {
      const now = clock();
      if (insert.run(profileId, token, now + staleMs, process.pid).changes === 1) {
        return activeLease(database, profileId, token);
      }
      const current = readLease.get(profileId) as { token: string; expiresAt: number; ownerPid: number } | undefined;
      if (
        current &&
        current.expiresAt <= now &&
        !isProcessAlive(current.ownerPid) &&
        steal.run(token, now + staleMs, process.pid, profileId, current.token, now).changes === 1
      ) {
        return activeLease(database, profileId, token);
      }
    } catch (error) {
      if (!isSqliteBusyError(error)) {
        database.close();
        throw error;
      }
    }
    if (Date.now() >= deadline) {
      database.close();
      throw operationStoreBusyError();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
  }
}

function activeLease(
  database: Database.Database,
  profileId: string,
  token: string,
): { release(): Promise<void> } {
  const release = database.prepare('DELETE FROM operation_locks WHERE profile_id = ? AND token = ?');
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      let releaseError: unknown;
      try {
        if (release.run(profileId, token).changes !== 1) releaseError = operationStoreLeaseLostError();
      } finally {
        database.close();
      }
      if (releaseError) throw releaseError;
    },
  };
}

function operationStoreBusyError(): AppError {
  return new AppError(
    'operation_store_busy',
    'Another local operation is updating this profile.',
    'Wait briefly, then retry the preflight or approval step.',
    true,
  );
}

function operationStoreLeaseLostError(): AppError {
  return new AppError(
    'operation_store_lease_lost',
    'The local operation-store lease was lost before the update completed.',
    'Reconcile the operation state before attempting another mutation.',
    false,
  );
}

function isSqliteBusyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    ['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(String((error as { code?: unknown }).code));
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sanitizeOperation(operation: StoredOperation): StoredOperation {
  return {
    approvalId: operation.approvalId,
    profile: {
      id: safeProfileId(operation.profile.id),
      purpose: operation.profile.purpose,
      ...(operation.profile.channelId ? { channelId: operation.profile.channelId } : {}),
    },
    kind: operation.kind,
    targetId: operation.targetId,
    desired: redactSensitiveData(operation.desired),
    desiredFingerprint: operation.desiredFingerprint,
    currentFingerprint: operation.currentFingerprint,
    expiresAt: operation.expiresAt,
    state: operation.state,
    ...(operation.reconciliation ? { reconciliation: {
      tool: operation.reconciliation.tool,
      arguments: redactStringRecord(operation.reconciliation.arguments),
    } } : {}),
  };
}

function redactSensitiveData(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (isSensitiveKey(key)) return [];
    if (Array.isArray(item)) return [[key, item.map((entry) => typeof entry === 'object' && entry !== null ? redactSensitiveData(entry as Record<string, unknown>) : entry)]];
    if (typeof item === 'object' && item !== null) return [[key, redactSensitiveData(item as Record<string, unknown>)]];
    return [[key, item]];
  }));
}

function redactStringRecord(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !isSensitiveKey(key)));
}

function isSensitiveKey(key: string): boolean {
  return /(token|secret|authorization|password|cookie|bytes|path)/i.test(key) && key !== 'containsSyntheticMedia';
}

function safeProfileId(profileId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(profileId)) throw new Error('invalid profile ID');
  return profileId;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EEXIST';
}
