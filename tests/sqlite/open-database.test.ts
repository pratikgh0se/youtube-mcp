import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConsumptionStore } from '../../src/consumption/store.js';
import { CurationStore } from '../../src/consumption/curation-store.js';
import { toSafeError } from '../../src/errors.js';
import { OperationStore } from '../../src/operations/store.js';
import { isSqliteBusyError, openDatabase } from '../../src/sqlite/open-database.js';

const directories: string[] = [];
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'youtube-mcp-sqlite-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('openDatabase transaction helper', () => {
  it('commits on success and returns the action result', async () => {
    const database = openDatabase(join(await tempDir(), 't.sqlite'));
    database.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    const result = database.transaction(() => {
      database.prepare('INSERT INTO t (name) VALUES (?)').run('a');
      database.prepare('INSERT INTO t (name) VALUES (@name)').run({ name: 'b' });
      return 'done';
    });
    expect(result).toBe('done');
    expect(database.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 2 });
    database.close();
  });

  it('rolls back and rethrows the original error on failure, leaving the database usable', async () => {
    const database = openDatabase(join(await tempDir(), 't.sqlite'));
    database.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    expect(() => database.transaction(() => {
      database.prepare('INSERT INTO t (name) VALUES (?)').run('a');
      throw new Error('boom');
    })).toThrow('boom');
    expect(database.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 0 });
    // A later transaction must not hit "cannot start a transaction within a transaction".
    database.transaction(() => database.prepare('INSERT INTO t (name) VALUES (?)').run('c'));
    expect(database.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 1 });
    database.close();
  });

  it('applies busy_timeout and reports changes as a number', async () => {
    const database = openDatabase(join(await tempDir(), 't.sqlite'), { busyTimeoutMs: 1234 });
    expect(database.prepare<[], { timeout: number }>('PRAGMA busy_timeout').get()).toEqual({ timeout: 1234 });
    database.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    expect(typeof database.prepare('INSERT INTO t DEFAULT VALUES').run().changes).toBe('number');
    database.close();
  });

  it('detects SQLITE_BUSY from a second connection', async () => {
    const path = join(await tempDir(), 't.sqlite');
    const first = openDatabase(path, { busyTimeoutMs: 0 });
    const second = openDatabase(path, { busyTimeoutMs: 0 });
    first.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    first.exec('BEGIN IMMEDIATE');
    let caught: unknown;
    try { second.exec('BEGIN IMMEDIATE'); } catch (error) { caught = error; }
    expect(isSqliteBusyError(caught)).toBe(true);
    first.exec('ROLLBACK');
    first.close();
    second.close();
  });
});

describe('operation lease under concurrency', () => {
  it('lets exactly one of two simultaneous acquirers hold the lease, then hands it over', async () => {
    const stateDir = await tempDir();
    const options = { lockWaitMs: 40, retryDelayMs: 1 };
    const a = new OperationStore(stateDir, options);
    const b = new OperationStore(stateDir, options);
    type Locker = { withProfileLock<T>(id: string, callback: () => Promise<T>): Promise<T> };
    const lockA = (a as unknown as Locker);
    const lockB = (b as unknown as Locker);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let holders = 0;
    let maxHolders = 0;
    const hold = async () => { holders += 1; maxHolders = Math.max(maxHolders, holders); await gate; holders -= 1; };

    const results = Promise.allSettled([lockA.withProfileLock('p', hold), lockB.withProfileLock('p', hold)]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    release();
    const settled = await results;
    expect(maxHolders).toBe(1);
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'operation_store_busy', retryable: true });

    await expect(lockB.withProfileLock('p', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('existing databases created before the node:sqlite switch', () => {
  it('opens a legacy schema file and keeps its rows', async () => {
    const directory = await tempDir();
    const path = join(directory, 'consumption.sqlite');
    const legacy = openDatabase(path);
    legacy.exec(`
      CREATE TABLE watch_events (source_key TEXT PRIMARY KEY, watched_at TEXT NOT NULL, video_id TEXT, channel_id TEXT, title TEXT NOT NULL, topic TEXT);
      INSERT INTO watch_events VALUES ('k1', '2026-01-05T10:00:00.000Z', 'v1', 'c1', 'Title', 'code');
      CREATE TABLE curation_policies (profile_id TEXT PRIMARY KEY, allowed_sources TEXT NOT NULL);
      INSERT INTO curation_policies VALUES ('p1', '["a"]');
    `);
    legacy.close();

    const store = new ConsumptionStore(path);
    expect(store.hasImportedHistory()).toBe(true);
    expect(store.profile({ startDate: '2026-01-01', endDate: '2026-01-31' })).toMatchObject({ totalActivityCount: 1, totalWatchCount: 1 });

    const curation = new CurationStore(path);
    expect(curation.policy('p1')).toMatchObject({ profileId: 'p1', allowedSources: ['a'], retentionDays: 30 });
    curation.close();
  });
});

describe('storage error mapping', () => {
  it('maps a failed open to storage_unavailable without leaking the path', async () => {
    const path = join(await tempDir(), 'missing-dir', 'secret-name.sqlite');
    let caught: unknown;
    try { openDatabase(path); } catch (error) { caught = error; }
    expect(caught).toBeDefined();
    const safe = toSafeError(caught);
    expect(safe).toMatchObject({ code: 'storage_unavailable', retryable: false });
    expect(JSON.stringify(safe.toJSON())).not.toContain('secret-name');
  });

  it('maps SQLITE_* and ERR_SQLITE_ERROR codes', () => {
    for (const code of ['SQLITE_CANTOPEN', 'ERR_SQLITE_ERROR', 'SQLITE_IOERR']) {
      expect(toSafeError(Object.assign(new Error('unable to open /home/x/db'), { code }))).toMatchObject({ code: 'storage_unavailable' });
    }
  });
});
