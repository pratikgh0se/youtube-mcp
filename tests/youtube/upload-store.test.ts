import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { UploadStore, type UploadRecord } from '../../src/youtube/upload-store.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'youtube-mcp-uploads-'));
  directories.push(directory);
  return directory;
}

function record(overrides: Partial<UploadRecord> = {}): UploadRecord {
  return {
    uploadId: 'upload-123',
    sessionUrl: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=session-123',
    fileSize: 2048,
    fileFingerprint: 'sha256:source-fingerprint',
    offset: 1024,
    metadataFingerprint: 'sha256:metadata-fingerprint',
    createdAt: '2026-08-18T01:00:00.000Z',
    lastStatus: 'in_progress',
    ...overrides,
  };
}

function store(stateDir: string): UploadStore {
  return new UploadStore(stateDir, { profileId: 'creator-a', channelId: 'channel-a' });
}

describe('UploadStore', () => {
  it('isolates resumable records by both selected profile and channel', async () => {
    const stateDir = await stateDirectory();
    const creatorA = new UploadStore(stateDir, { profileId: 'creator-a', channelId: 'channel-a' });
    const creatorB = new UploadStore(stateDir, { profileId: 'creator-b', channelId: 'channel-b' });
    await creatorA.save(record());

    await expect(creatorA.get('upload-123')).resolves.toEqual(record());
    await expect(creatorB.get('upload-123')).resolves.toBeUndefined();
  });

  it('persists only resumable state in an atomic user-only record', async () => {
    const stateDir = await stateDirectory();
    const uploadStore = store(stateDir);

    await uploadStore.save(record());

    await expect(uploadStore.get('upload-123')).resolves.toEqual(record());
    const directory = join(stateDir, 'profiles', 'creator-a', 'channels', 'channel-a', 'uploads');
    const file = join(directory, 'upload-123.json');
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const persisted = await readFile(file, 'utf8');
    expect(persisted).not.toContain('media bytes');
    expect(persisted).not.toContain('oauth');
  });

  it('updates a stored offset and safe provider status without replacing identity fields', async () => {
    const uploadStore = store(await stateDirectory());
    await uploadStore.save(record());

    await expect(uploadStore.updateProgress('upload-123', 2048, 'complete')).resolves.toEqual(record({ offset: 2048, lastStatus: 'complete' }));
  });

  it('returns no record after an upload is removed', async () => {
    const uploadStore = store(await stateDirectory());
    await uploadStore.save(record());

    await uploadStore.remove('upload-123');

    await expect(uploadStore.get('upload-123')).resolves.toBeUndefined();
  });

  it('refuses resumable-session URLs outside Google HTTPS upload hosts', async () => {
    const uploadStore = store(await stateDirectory());

    await expect(uploadStore.save(record({ sessionUrl: 'https://attacker.example/session-1' })))
      .rejects.toThrow('invalid upload record');
  });
});
