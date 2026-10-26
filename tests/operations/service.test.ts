import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { OperationService } from '../../src/operations/service.js';
import { OperationStore } from '../../src/operations/store.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function operations(): Promise<OperationService> {
  const stateDir = await mkdtemp(join(tmpdir(), 'youtube-mcp-operation-service-'));
  directories.push(stateDir);
  return new OperationService(new OperationStore(stateDir), () => new Date('2026-08-18T01:00:00.000Z'));
}

const creator = { id: 'creator-a', purpose: 'creator' as const, channelId: 'channel-a' };

describe('OperationService', () => {
  it('rejects execution when the current target differs from the approval', async () => {
    const service = await operations();
    const preview = await service.preflight({
      profile: creator,
      kind: 'video.update', targetId: 'v1', desired: { title: 'New' }, currentFingerprint: 'original',
    });
    await service.approve({ approvalId: preview.approvalId, profileId: creator.id, channelId: creator.channelId, confirm: true });

    await expect(service.execute({
      approvalId: preview.approvalId, profileId: creator.id, channelId: creator.channelId, confirm: true, currentFingerprint: 'changed',
    })).rejects.toMatchObject({ code: 'stale_preview' });
  });

  it('binds an approved execution to its profile, target, desired diff, and reconciliation read', async () => {
    const service = await operations();
    const preview = await service.preflight({
      profile: creator,
      kind: 'video.update', targetId: 'v1', desired: { title: 'New', refreshToken: 'never-return-this' }, currentFingerprint: 'original',
      reconciliation: { tool: 'youtube_get_owned_video', arguments: { videoId: 'v1' } },
    });
    await service.approve({ approvalId: preview.approvalId, profileId: creator.id, channelId: creator.channelId, confirm: true });

    const receipt = await service.execute({
      approvalId: preview.approvalId, profileId: creator.id, channelId: creator.channelId, confirm: true, currentFingerprint: 'original',
    });

    expect(preview).toMatchObject({
      profile: { id: 'creator-a', purpose: 'creator', channelId: 'channel-a' }, targetId: 'v1', desired: { title: 'New' },
    });
    expect(preview).not.toHaveProperty('desired.refreshToken');
    expect(receipt).toEqual({
      operationId: preview.approvalId,
      state: 'succeeded',
      reconciliation: { tool: 'youtube_get_owned_video', arguments: { videoId: 'v1' } },
    });
    await expect(service.reconcile({ profileId: 'creator-a', channelId: 'channel-a', operationId: receipt.operationId })).resolves.toEqual(receipt);
  });

  it.each(['running', 'succeeded', 'failed', 'unknown'] as const)(
    'does not re-approve an operation already in %s state',
    async (state) => {
      const stateDir = await mkdtemp(join(tmpdir(), 'youtube-mcp-operation-approval-'));
      directories.push(stateDir);
      const store = new OperationStore(stateDir);
      const service = new OperationService(store, () => new Date('2026-08-18T01:00:00.000Z'));
      const preview = await service.preflight({ profile: creator, kind: 'video.update', targetId: 'v1', desired: {}, currentFingerprint: 'original' });
      await store.update(creator.id, preview.approvalId, { state });

      await expect(service.approve({ approvalId: preview.approvalId, profileId: creator.id, channelId: creator.channelId, confirm: true }))
        .rejects.toMatchObject({ code: 'approval_consumed' });
    },
  );

  it('requires a selected profile and channel before preflight or execution', async () => {
    const service = await operations();
    await expect(service.preflight({
      profile: { id: 'creator-a', purpose: 'creator' }, kind: 'video.update', targetId: 'v1', desired: {}, currentFingerprint: 'original',
    })).rejects.toMatchObject({ code: 'channel_required' });

    const preview = await service.preflight({ profile: creator, kind: 'video.update', targetId: 'v1', desired: {}, currentFingerprint: 'original' });
    await expect(service.execute({
      approvalId: preview.approvalId, profileId: creator.id, channelId: 'channel-b', confirm: true, currentFingerprint: 'original',
    })).rejects.toMatchObject({ code: 'profile_mismatch' });
  });

  it('atomically consumes an approval so concurrent executions cannot run twice', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'youtube-mcp-operation-single-use-'));
    directories.push(stateDir);
    let executions = 0;
    const service = new OperationService(
      new OperationStore(stateDir),
      () => new Date('2026-08-18T01:00:00.000Z'),
      async () => {
        executions += 1;
        return 'succeeded';
      },
    );
    const preview = await service.preflight({ profile: creator, kind: 'video.update', targetId: 'v1', desired: {}, currentFingerprint: 'original' });
    await service.approve({ approvalId: preview.approvalId, profileId: creator.id, channelId: creator.channelId, confirm: true });
    const input = { approvalId: preview.approvalId, profileId: creator.id, channelId: creator.channelId, confirm: true, currentFingerprint: 'original' };

    const results = await Promise.allSettled([service.execute(input), service.execute(input)]);

    expect(executions).toBe(1);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('persists an unknown terminal receipt when execution throws before a provider response', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'youtube-mcp-operation-unknown-'));
    directories.push(stateDir);
    const service = new OperationService(
      new OperationStore(stateDir),
      () => new Date('2026-08-18T01:00:00.000Z'),
      async () => Promise.reject(new Error('connection dropped')),
    );
    const preview = await service.preflight({ profile: creator, kind: 'video.update', targetId: 'v1', desired: {}, currentFingerprint: 'original' });
    await service.approve({ approvalId: preview.approvalId, profileId: creator.id, channelId: creator.channelId, confirm: true });
    const input = { approvalId: preview.approvalId, profileId: creator.id, channelId: creator.channelId, confirm: true, currentFingerprint: 'original' };

    await expect(service.execute(input)).rejects.toMatchObject({
      code: 'provider_outcome_unknown', retryable: false, operationId: preview.approvalId,
      reconciliation: { tool: 'youtube_get_operation_status', arguments: { approvalId: preview.approvalId } },
    });
    await expect(service.reconcile({ profileId: creator.id, channelId: creator.channelId, operationId: preview.approvalId })).resolves.toMatchObject({ state: 'unknown' });
  });

  it('requires the operation channel again when reconciling a receipt', async () => {
    const service = await operations();
    const preview = await service.preflight({ profile: creator, kind: 'video.update', targetId: 'v1', desired: {}, currentFingerprint: 'original' });

    await expect(service.reconcile({ profileId: creator.id, channelId: 'channel-b', operationId: preview.approvalId }))
      .rejects.toMatchObject({ code: 'profile_mismatch' });
  });

  it('keeps a claimed operation reconcilable as unknown when a caller cannot confirm provider outcome', async () => {
    const service = await operations();
    const preview = await service.preflight({ profile: creator, kind: 'video.upload', targetId: 'upload-1', desired: {}, currentFingerprint: 'source' });
    await service.approve({ approvalId: preview.approvalId, profileId: creator.id, channelId: creator.channelId, confirm: true });

    await service.claim({ approvalId: preview.approvalId, profileId: creator.id, channelId: creator.channelId, confirm: true, currentFingerprint: 'source' });
    await service.settle({ operationId: preview.approvalId, profileId: creator.id, channelId: creator.channelId, state: 'unknown' });

    await expect(service.reconcile({ profileId: creator.id, channelId: creator.channelId, operationId: preview.approvalId }))
      .resolves.toMatchObject({ state: 'unknown' });
  });
});
