import { createRequire } from 'node:module';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

import { AppError } from '../errors.js';

type SqliteModule = { DatabaseSync: typeof DatabaseSync };

export type RunResult = { changes: number; lastInsertRowid: number | bigint };

/** Typed view over a prepared statement. `P` is the bound parameter shape (object for named, tuple for positional). */
export type Statement<P = unknown[], R = Record<string, unknown>> = {
  run(...parameters: P extends unknown[] ? P : [P]): RunResult;
  get(...parameters: P extends unknown[] ? P : [P]): R | undefined;
  all(...parameters: P extends unknown[] ? P : [P]): R[];
};

export type TransactionMode = 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE';

export type SqliteDatabase = {
  exec(sql: string): void;
  prepare<P = unknown[], R = Record<string, unknown>>(sql: string): Statement<P, R>;
  /** Runs `action` inside BEGIN/COMMIT, rolling back (and rethrowing) on error. Not re-entrant. */
  transaction<T>(action: () => T, mode?: TransactionMode): T;
  pragma(statement: string): void;
  close(): void;
};

export type OpenDatabaseOptions = {
  /** SQLite busy handler wait in ms (better-sqlite3 used 5000 by default). */
  busyTimeoutMs?: number;
};

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

let cachedModule: SqliteModule | undefined;

function storageUnavailable(reason?: unknown): AppError {
  const detail = reason instanceof Error && reason.message ? ` (${reason.message.split('\n')[0]})` : '';
  return new AppError(
    'storage_unavailable',
    `Local storage is unavailable: this Node.js (${process.version}) has no built-in SQLite support${detail}.`,
    'Use Node.js 22.13 or newer',
    false,
  );
}

/** Loads node:sqlite lazily so the experimental-warning filter can be installed first. */
export function loadSqlite(): SqliteModule {
  if (cachedModule) return cachedModule;
  try {
    const loaded = createRequire(import.meta.url)('node:sqlite') as Partial<SqliteModule>;
    if (typeof loaded.DatabaseSync !== 'function') throw new Error('node:sqlite does not export DatabaseSync');
    cachedModule = loaded as SqliteModule;
    return cachedModule;
  } catch (error) {
    throw storageUnavailable(error);
  }
}

/** Throws storage_unavailable when node:sqlite cannot be loaded. Call at process start. */
export function assertSqliteAvailable(): void {
  loadSqlite();
}

class NodeSqliteDatabase implements SqliteDatabase {
  constructor(private readonly database: DatabaseSync) {}

  exec(sql: string): void {
    this.database.exec(sql);
  }

  pragma(statement: string): void {
    this.database.exec(`PRAGMA ${statement}`);
  }

  prepare<P = unknown[], R = Record<string, unknown>>(sql: string): Statement<P, R> {
    const statement: StatementSync = this.database.prepare(sql);
    return {
      run: (...parameters: unknown[]) => {
        const result = statement.run(...(parameters as never[]));
        return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
      },
      get: (...parameters: unknown[]) => statement.get(...(parameters as never[])) as R | undefined,
      all: (...parameters: unknown[]) => statement.all(...(parameters as never[])) as R[],
    } as Statement<P, R>;
  }

  transaction<T>(action: () => T, mode: TransactionMode = 'IMMEDIATE'): T {
    this.database.exec(`BEGIN ${mode}`);
    let result: T;
    try {
      result = action();
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // The original failure is the useful one; SQLite may already have rolled back.
      }
      throw error;
    }
    try {
      this.database.exec('COMMIT');
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Already rolled back.
      }
      throw error;
    }
    return result;
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}

export function openDatabase(path: string, options: OpenDatabaseOptions = {}): SqliteDatabase {
  const { DatabaseSync: Database } = loadSqlite();
  const database = new Database(path);
  try {
    database.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS))}`);
  } catch (error) {
    database.close();
    throw error;
  }
  return new NodeSqliteDatabase(database);
}

/** SQLITE_BUSY (5) / SQLITE_LOCKED (6), including extended result codes. */
export function isSqliteBusyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; errcode?: unknown };
  if (typeof candidate.code === 'string' && ['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(candidate.code)) return true;
  if (candidate.code === 'ERR_SQLITE_ERROR' && typeof candidate.errcode === 'number') {
    const primary = candidate.errcode & 0xff;
    return primary === 5 || primary === 6;
  }
  return false;
}
