import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApprovalTool } from '../../src/operations/approval.js';
import { OperationService } from '../../src/operations/service.js';
import { OperationStore } from '../../src/operations/store.js';
import { PlaylistService } from '../../src/youtube/playlists.js';

const directories: string[] = [];
const profileA = { id: 'creator-a', purpose: 'creator' as const, channelId: 'channel-a' };
const profileB = { id: 'creator-b', purpose: 'creator' as const, channelId: 'channel-b' };

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function setup(now: () => Date = () => new Date('2026-08-18T01:00:00.000Z')) {
  const stateDir = await mkdtemp(join(tmpdir(), 'youtube-mcp-approval-'));
  directories.push(stateDir);
  const operations = new OperationService(new OperationStore(stateDir), now);
  return { operations, approveA: createApprovalTool(operations, profileA), approveB: createApprovalTool(operations, profileB) };
}

describe('youtube_approve (createApprovalTool)', () => {
  it.each([
    ['playlist.create', 'new:abc', { title: 'Series', privacyStatus: 'private' }],
    ['video.metadata.update', 'video-1', { snippet: { title: 'New' }, status: { privacyStatus: 'public' } }],
    ['comment.moderation.set', 'comment-1', { moderationStatus: 'rejected', banAuthor: true }],
    ['video.upload', 'upload-1', { title: 'Clip', privacyStatus: 'public' }],
  ])('approves a %s operation and echoes kind, target and desired change', async (kind, targetId, desired) => {
    const { operations, approveA } = await setup();
    const planned = await operations.preflight({ profile: profileA, kind, targetId, desired, currentFingerprint: 'fp' });

    const approved = await approveA.approve({ approvalId: planned.approvalId, confirm: true });

    expect(approved).toMatchObject({ approvalId: planned.approvalId, kind, targetId, desired, desiredFingerprint: planned.desiredFingerprint, state: 'approved' });
  });

  it('requires literal confirm: true', async () => {
    const { operations, approveA } = await setup();
    const planned = await operations.preflight({ profile: profileA, kind: 'playlist.create', targetId: 't', desired: { a: 1 }, currentFingerprint: 'fp' });

    await expect(approveA.approve({ approvalId: planned.approvalId })).rejects.toMatchObject({ code: 'approval_required' });
    await expect(approveA.approve({ approvalId: planned.approvalId, confirm: false })).rejects.toMatchObject({ code: 'approval_required' });
  });

  it('cannot approve an operation planned under another profile or channel', async () => {
    const { operations, approveB } = await setup();
    const planned = await operations.preflight({ profile: profileA, kind: 'playlist.create', targetId: 't', desired: { a: 1 }, currentFingerprint: 'fp' });

    await expect(approveB.approve({ approvalId: planned.approvalId, confirm: true })).rejects.toMatchObject({ code: 'profile_mismatch' });
    // Same profile id but a different channel is also rejected.
    const sameProfileOtherChannel = createApprovalTool(operations, { id: profileA.id, channelId: 'channel-other' });
    await expect(sameProfileOtherChannel.approve({ approvalId: planned.approvalId, confirm: true })).rejects.toMatchObject({ code: 'profile_mismatch' });
  });

  it('is single use', async () => {
    const { operations, approveA } = await setup();
    const planned = await operations.preflight({ profile: profileA, kind: 'comment.delete', targetId: 'c1', desired: {}, currentFingerprint: 'fp' });

    await approveA.approve({ approvalId: planned.approvalId, confirm: true });
    await expect(approveA.approve({ approvalId: planned.approvalId, confirm: true })).rejects.toMatchObject({ code: 'approval_consumed' });
  });

  it('rejects an expired preview', async () => {
    let clock = new Date('2026-08-18T01:00:00.000Z');
    const { operations, approveA } = await setup(() => clock);
    const planned = await operations.preflight({ profile: profileA, kind: 'playlist.create', targetId: 't', desired: { a: 1 }, currentFingerprint: 'fp' });
    clock = new Date('2026-08-18T01:06:00.000Z');

    await expect(approveA.approve({ approvalId: planned.approvalId, confirm: true })).rejects.toMatchObject({ code: 'stale_preview' });
  });

  it('rejects an unknown approval ID', async () => {
    const { approveA } = await setup();
    await expect(approveA.approve({ approvalId: 'does-not-exist', confirm: true })).rejects.toMatchObject({ code: 'profile_mismatch' });
  });

  it('lets a domain execute tool run after youtube_approve, and only once', async () => {
    const { operations, approveA } = await setup();
    const provider = {
      getPlaylist: vi.fn(), getPlaylistItem: vi.fn(), updatePlaylist: vi.fn(), deletePlaylist: vi.fn(), addPlaylistItem: vi.fn(), removePlaylistItem: vi.fn(), reorderPlaylistItem: vi.fn(),
      createPlaylist: vi.fn(async () => ({ id: 'playlist-2' })),
    };
    const playlists = new PlaylistService(operations, provider as never, profileA, { verifyPrincipal: async () => profileA } as never);
    const preview = await playlists.preflightCreate({ title: 'New series' });

    await expect(playlists.create({ title: 'New series', approvalId: preview.approvalId, confirm: true })).rejects.toMatchObject({ code: 'approval_required' });
    await approveA.approve({ approvalId: preview.approvalId, confirm: true });
    await expect(playlists.create({ title: 'New series', approvalId: preview.approvalId, confirm: true })).resolves.toMatchObject({ state: 'succeeded' });
    await expect(playlists.create({ title: 'New series', approvalId: preview.approvalId, confirm: true })).rejects.toMatchObject({ code: 'approval_consumed' });
    expect(provider.createPlaylist).toHaveBeenCalledTimes(1);
  });
});
