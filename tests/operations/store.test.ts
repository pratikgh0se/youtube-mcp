import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../../src/sqlite/open-database.js';

import { OperationStore } from '../../src/operations/store.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'youtube-mcp-operations-'));
  directories.push(directory);
  return directory;
}

describe('OperationStore', () => {
  it('does not unlink a replacement lock when the original owner releases', async () => {
    const stateDir = await stateDirectory();
    const store = new OperationStore(stateDir);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = withInternalProfileLock(store, 'creator-a', () => gate);
    await waitForLease(stateDir, 'creator-a');

    const database = lockDatabase(stateDir);
    database.prepare('UPDATE operation_locks SET token = ?, expires_at = ? WHERE profile_id = ?')
      .run('replacement-owner', Date.now() + 60_000, 'creator-a');
    release();
    await expect(held).rejects.toMatchObject({ code: 'operation_store_lease_lost' });

    expect(database.prepare('SELECT token FROM operation_locks WHERE profile_id = ?').get('creator-a'))
      .toEqual({ token: 'replacement-owner' });
    database.close();
  });

  it('does not represent lock ownership with an unlinkable filesystem pathname', async () => {
    const stateDir = await stateDirectory();
    const store = new OperationStore(stateDir);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = withInternalProfileLock(store, 'creator-a', () => gate);
    await waitForLease(stateDir, 'creator-a');

    await expect(stat(join(stateDir, 'profiles', 'creator-a', '.operations.lock')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    release();
    await held;
  });

  it('does not steal an expired lease from a live owner after a long event-loop pause', async () => {
    const stateDir = await stateDirectory();
    const first = new OperationStore(stateDir, { lockWaitMs: 200, staleLockMs: 30, retryDelayMs: 1 });
    const second = new OperationStore(stateDir, { lockWaitMs: 50, staleLockMs: 30, retryDelayMs: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = withInternalProfileLock(first, 'creator-a', () => gate);
    await waitForLease(stateDir, 'creator-a');
    await new Promise((resolve) => setTimeout(resolve, 45));

    const competing = second.create({
      approvalId: 'must-not-steal',
      profile: { id: 'creator-a', purpose: 'creator', channelId: 'channel-a' },
      kind: 'video.update', targetId: 'video-a', desiredFingerprint: 'd1', currentFingerprint: 'c1',
      expiresAt: '2026-08-18T01:05:00.000Z', state: 'planned', desired: {},
    });
    await expect(competing).rejects.toMatchObject({ code: 'operation_store_busy' });
    release();
    await held;
  });

  it('claims only records that were explicitly approved', async () => {
    const store = new OperationStore(await stateDirectory());
    const profile = { id: 'creator-a', purpose: 'creator' as const, channelId: 'channel-a' };
    await store.create({
      approvalId: 'planned', profile, kind: 'video.update', targetId: 'video-a', desiredFingerprint: 'd1',
      currentFingerprint: 'c1', expiresAt: '2026-08-18T01:05:00.000Z', state: 'planned', desired: {},
    });

    await expect(store.claim(profile.id, 'planned')).resolves.toBeUndefined();
    await expect(store.get(profile.id, 'planned')).resolves.toMatchObject({ state: 'planned' });

    await store.approve(profile.id, 'planned');
    await expect(store.claim(profile.id, 'planned')).resolves.toMatchObject({ state: 'running' });
  });

  it('keeps operation audit records profile-scoped, user-only, and free of OAuth tokens', async () => {
    const stateDir = await stateDirectory();
    const store = new OperationStore(stateDir);

    await store.create({
      approvalId: 'approval-1',
      profile: { id: 'creator-a', purpose: 'creator', channelId: 'channel-a' },
      kind: 'video.update',
      targetId: 'video-a',
      desiredFingerprint: 'desired-fingerprint',
      currentFingerprint: 'current-fingerprint',
      expiresAt: '2026-08-18T01:05:00.000Z',
      state: 'planned',
      desired: { title: 'New title', oauthToken: 'never-store-this' },
    });

    await expect(store.get('creator-b', 'approval-1')).resolves.toBeUndefined();
    await expect(store.get('creator-a', 'approval-1')).resolves.toMatchObject({
      approvalId: 'approval-1',
      profile: { id: 'creator-a', purpose: 'creator', channelId: 'channel-a' },
      desired: { title: 'New title' },
    });

    const file = join(stateDir, 'profiles', 'creator-a', 'operations.json');
    expect((await stat(join(stateDir, 'profiles', 'creator-a'))).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const persisted = await readFile(file, 'utf8');
    expect(persisted).not.toContain('never-store-this');
    expect(persisted).not.toContain('oauthToken');
  });

  it('removes expired planned approvals while retaining completed audit receipts', async () => {
    const store = new OperationStore(await stateDirectory());
    const profile = { id: 'creator-a', purpose: 'creator' as const, channelId: 'channel-a' };

    await store.create({
      approvalId: 'expired', profile, kind: 'video.update', targetId: 'video-a', desiredFingerprint: 'd1',
      currentFingerprint: 'c1', expiresAt: '2026-08-18T01:00:00.000Z', state: 'planned', desired: {},
    });
    await store.create({
      approvalId: 'completed', profile, kind: 'video.update', targetId: 'video-b', desiredFingerprint: 'd2',
      currentFingerprint: 'c2', expiresAt: '2026-08-18T01:00:00.000Z', state: 'succeeded', desired: {},
    });

    await store.pruneExpired(new Date('2026-08-18T01:01:00.000Z'));

    await expect(store.get(profile.id, 'expired')).resolves.toBeUndefined();
    await expect(store.get(profile.id, 'completed')).resolves.toMatchObject({ state: 'succeeded' });
  });

  it('serializes concurrent writes for one profile without losing either audit record', async () => {
    const store = new OperationStore(await stateDirectory());
    const profile = { id: 'creator-a', purpose: 'creator' as const, channelId: 'channel-a' };

    await Promise.all(['one', 'two'].map((approvalId) => store.create({
      approvalId, profile, kind: 'video.update', targetId: approvalId, desiredFingerprint: approvalId,
      currentFingerprint: approvalId, expiresAt: '2026-08-18T01:05:00.000Z', state: 'planned', desired: {},
    })));

    await expect(Promise.all(['one', 'two'].map((approvalId) => store.get(profile.id, approvalId)))).resolves.toEqual([
      expect.objectContaining({ approvalId: 'one' }),
      expect.objectContaining({ approvalId: 'two' }),
    ]);
  });

  it('uses a shared lease so independent stores retain concurrent profile writes and only one can claim', async () => {
    const stateDir = await stateDirectory();
    const first = new OperationStore(stateDir);
    const second = new OperationStore(stateDir);
    const profile = { id: 'creator-a', purpose: 'creator' as const, channelId: 'channel-a' };

    await Promise.all(['one', 'two'].map((approvalId, index) => (index === 0 ? first : second).create({
      approvalId, profile, kind: 'video.update', targetId: approvalId, desiredFingerprint: approvalId,
      currentFingerprint: approvalId, expiresAt: '2026-08-18T01:05:00.000Z', state: 'planned', desired: {},
    })));
    await first.approve(profile.id, 'one');
    const claims = await Promise.all([first.claim(profile.id, 'one'), second.claim(profile.id, 'one')]);

    expect((await first.get(profile.id, 'one'))?.approvalId).toBe('one');
    expect((await first.get(profile.id, 'two'))?.approvalId).toBe('two');
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('recovers a stale operation lock left behind by a terminated process', async () => {
    const stateDir = await stateDirectory();
    seedLease(stateDir, 'creator-a', 'abandoned', Date.now() - 60_000, 2_147_483_647);
    const store = new OperationStore(stateDir, {
      lockWaitMs: 20,
      staleLockMs: 1_000,
      retryDelayMs: 1,
    } as never);
    const creation = store.create({
      approvalId: 'after-crash',
      profile: { id: 'creator-a', purpose: 'creator', channelId: 'channel-a' },
      kind: 'video.update', targetId: 'video-a', desiredFingerprint: 'd1', currentFingerprint: 'c1',
      expiresAt: '2026-08-18T01:05:00.000Z', state: 'planned', desired: {},
    });

    const result = await Promise.race([
      creation.then(() => 'created'),
      new Promise<'manual-timeout'>((resolve) => setTimeout(() => resolve('manual-timeout'), 100)),
    ]);

    expect(result).toBe('created');
    await creation;
  });

  it('bounds the wait for a fresh operation lock instead of hanging forever', async () => {
    const stateDir = await stateDirectory();
    seedLease(stateDir, 'creator-a', 'active', Date.now() + 60_000, process.pid);
    const store = new OperationStore(stateDir, {
      lockWaitMs: 20,
      staleLockMs: 60_000,
      retryDelayMs: 1,
      now: () => new Date(),
    } as never);
    const creation = store.create({
      approvalId: 'while-busy',
      profile: { id: 'creator-a', purpose: 'creator', channelId: 'channel-a' },
      kind: 'video.update', targetId: 'video-a', desiredFingerprint: 'd1', currentFingerprint: 'c1',
      expiresAt: '2026-08-18T01:05:00.000Z', state: 'planned', desired: {},
    });

    const result = await Promise.race([
      creation.then(() => 'created', (error: unknown) => (error as { code?: string }).code ?? 'error'),
      new Promise<'manual-timeout'>((resolve) => setTimeout(() => resolve('manual-timeout'), 100)),
    ]);

    expect(result).toBe('operation_store_busy');
    await creation.catch(() => undefined);
  });

  it('sanitizes every persisted update but preserves synthetic-media safety metadata', async () => {
    const store = new OperationStore(await stateDirectory());
    const profile = { id: 'creator-a', purpose: 'creator' as const, channelId: 'channel-a' };
    await store.create({
      approvalId: 'approval-1', profile, kind: 'video.update', targetId: 'video-a', desiredFingerprint: 'd1',
      currentFingerprint: 'c1', expiresAt: '2026-08-18T01:05:00.000Z', state: 'planned', desired: {},
    });

    await store.update(profile.id, 'approval-1', {
      desired: { containsSyntheticMedia: true, sourcePath: '/private/media.mp4', accessToken: 'never-store' },
      reconciliation: { tool: 'youtube_get_owned_video', arguments: { videoId: 'video-a', authorization: 'never-store' } },
    });

    const saved = await store.get(profile.id, 'approval-1');
    expect(saved).toMatchObject({
      desired: { containsSyntheticMedia: true },
      reconciliation: { tool: 'youtube_get_owned_video', arguments: { videoId: 'video-a' } },
    });
    expect(saved).not.toHaveProperty('desired.sourcePath');
    expect(saved).not.toHaveProperty('desired.accessToken');
    expect(saved).not.toHaveProperty('reconciliation.arguments.authorization');
  });
});

function withInternalProfileLock<T>(store: OperationStore, profileId: string, action: () => Promise<T>): Promise<T> {
  return (store as unknown as { withProfileLock(id: string, callback: () => Promise<T>): Promise<T> })
    .withProfileLock(profileId, action);
}

function lockDatabase(stateDir: string): SqliteDatabase {
  const database = openDatabase(join(stateDir, 'operation-locks.sqlite'));
  database.exec('CREATE TABLE IF NOT EXISTS operation_locks (profile_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL, owner_pid INTEGER NOT NULL)');
  return database;
}

function seedLease(stateDir: string, profileId: string, token: string, expiresAt: number, ownerPid: number): void {
  const database = lockDatabase(stateDir);
  database.prepare('INSERT OR REPLACE INTO operation_locks (profile_id, token, expires_at, owner_pid) VALUES (?, ?, ?, ?)')
    .run(profileId, token, expiresAt, ownerPid);
  database.close();
}

async function waitForLease(stateDir: string, profileId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const database = lockDatabase(stateDir);
      const found = database.prepare('SELECT token FROM operation_locks WHERE profile_id = ?').get(profileId);
      database.close();
      if (found) return;
    } catch {
      // The owner may still be initializing the lock database.
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for the ${profileId} lease`);
}
