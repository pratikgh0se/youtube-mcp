import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { OperationService } from '../../src/operations/service.js';
import { OperationStore } from '../../src/operations/store.js';
import { AppError } from '../../src/errors.js';
import { setReadAfterWriteSleep } from '../../src/youtube/read-after-write.js';
import { createPlaylistProvider, PlaylistService } from '../../src/youtube/playlists.js';
import { YouTubeClient, type YouTubeDataApi } from '../../src/youtube/client.js';
import type { AppConfig } from '../../src/types.js';

const directories: string[] = [];
const creator = { id: 'creator-a', purpose: 'creator' as const, channelId: 'creator-channel' };

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function service(overrides: Record<string, unknown> = {}, verifyPrincipal: () => Promise<unknown> = async () => creator) {
  const stateDir = await mkdtemp(join(tmpdir(), 'youtube-mcp-playlists-'));
  directories.push(stateDir);
  const provider = {
    getPlaylist: vi.fn(async (playlistId: string) => ({ id: playlistId, channelId: 'creator-channel', etag: 'playlist-etag', title: 'Series', description: 'Episodes', privacyStatus: 'private' as const })),
    getPlaylistItem: vi.fn(async (playlistItemId: string) => ({ id: playlistItemId, playlistId: 'playlist-1', videoId: 'video-1', position: 0, etag: 'item-etag' })),
    createPlaylist: vi.fn(async () => ({ id: 'playlist-2' })),
    updatePlaylist: vi.fn(async () => ({ id: 'playlist-1' })),
    deletePlaylist: vi.fn(async () => undefined),
    addPlaylistItem: vi.fn(async () => ({ id: 'playlist-item-2' })),
    removePlaylistItem: vi.fn(async () => undefined),
    reorderPlaylistItem: vi.fn(async () => ({ id: 'playlist-item-1' })),
    ...overrides,
  };
  const operations = new OperationService(new OperationStore(stateDir), () => new Date('2026-08-18T01:00:00.000Z'));
  return {
    playlists: new PlaylistService(operations, provider, creator, { verifyPrincipal }),
    operations,
    provider,
  };
}

async function approve(playlists: PlaylistService, approvalId: string) {
  await playlists.approve({ approvalId, confirm: true });
}

describe('PlaylistService', () => {
  it('revalidates the OAuth principal channel after approval before creating a playlist', async () => {
    let principalChecks = 0;
    const { playlists, provider } = await service({}, async () => {
      principalChecks += 1;
      if (principalChecks > 1) throw new AppError('ownership_required', 'Authenticated channel changed.', 'Select the authenticated channel.', false);
      return creator;
    });
    const preview = await playlists.preflightCreate({ title: 'New series' });
    await approve(playlists, preview.approvalId);

    await expect(playlists.create({ title: 'New series', approvalId: preview.approvalId, confirm: true }))
      .rejects.toMatchObject({ code: 'ownership_required' });
    expect(provider.createPlaylist).not.toHaveBeenCalled();
  });

  it('rejects execution before rereading provider state when the preview is not approved', async () => {
    const { playlists, provider } = await service();
    const preview = await playlists.preflightUpdate({ playlistId: 'playlist-1', title: 'Updated' });
    provider.getPlaylist.mockClear();

    await expect(playlists.update({ playlistId: 'playlist-1', title: 'Updated', approvalId: preview.approvalId, confirm: true }))
      .rejects.toMatchObject({ code: 'approval_required' });
    expect(provider.getPlaylist).not.toHaveBeenCalled();
  });

  it('creates a private playlist by default only after an exact confirmed preview', async () => {
    const { playlists, provider } = await service();
    const preview = await playlists.preflightCreate({ title: 'New series' });
    expect(preview.desired).toMatchObject({ title: 'New series', privacyStatus: 'private' });
    await approve(playlists, preview.approvalId);

    await expect(playlists.create({ title: 'New series', approvalId: preview.approvalId, confirm: true }))
      .resolves.toMatchObject({ operationId: preview.approvalId, state: 'succeeded', playlistId: 'playlist-2', reconciliation: { tool: 'youtube_list_playlists' } });
    expect(provider.createPlaylist).toHaveBeenCalledWith({ title: 'New series', privacyStatus: 'private' });
  });

  it('returns the operation and reconciliation hint after an ambiguous create failure', async () => {
    const { playlists, operations } = await service({ createPlaylist: vi.fn(async () => Promise.reject(new Error('connection dropped'))) });
    const preview = await playlists.preflightCreate({ title: 'New series' });
    await approve(playlists, preview.approvalId);

    await expect(playlists.create({ title: 'New series', approvalId: preview.approvalId, confirm: true }))
      .rejects.toMatchObject({
        code: 'provider_outcome_unknown', retryable: false, operationId: preview.approvalId,
        reconciliation: { tool: 'youtube_list_playlists', arguments: {} },
      });
    await expect(operations.reconcile({ profileId: creator.id, channelId: creator.channelId, operationId: preview.approvalId }))
      .resolves.toMatchObject({ state: 'unknown' });
  });

  it('reorders only an item freshly confirmed to belong to the immutable playlist target', async () => {
    const { playlists, provider } = await service();
    const preview = await playlists.preflightReorder({ playlistId: 'playlist-1', playlistItemId: 'playlist-item-1', position: 3 });
    await approve(playlists, preview.approvalId);

    await expect(playlists.reorder({ playlistId: 'playlist-1', playlistItemId: 'playlist-item-1', position: 3, approvalId: preview.approvalId, confirm: true }))
      .resolves.toMatchObject({ state: 'succeeded', playlistId: 'playlist-1', playlistItemId: 'playlist-item-1', reconciliation: { tool: 'youtube_list_playlist_items', arguments: { playlistId: 'playlist-1' } } });
    expect(provider.reorderPlaylistItem).toHaveBeenCalledWith({ id: 'playlist-item-1', playlistId: 'playlist-1', videoId: 'video-1', position: 3 });
  });

  it('sends the required video resource ID in the playlistItems.update payload', async () => {
    let updateRequest: Record<string, unknown> | undefined;
    const api = {
      search: { list: async () => ({ data: { items: [] } }) },
      videos: { list: async () => ({ data: { items: [] } }) },
      channels: { list: async () => ({ data: { items: [] } }) },
      commentThreads: { list: async () => ({ data: { items: [] } }) },
      videoCategories: { list: async () => ({ data: { items: [] } }) },
      playlists: { list: async () => ({ data: { items: [] } }), insert: async () => ({ data: {} }), update: async () => ({ data: {} }), delete: async () => ({ data: {} }) },
      playlistItems: {
        list: async () => ({ data: { items: [] } }), insert: async () => ({ data: {} }), delete: async () => ({ data: {} }),
        update: async (request: Record<string, unknown>) => { updateRequest = request; return { data: { id: 'playlist-item-1' } }; },
      },
      captions: { list: async () => ({ data: { items: [] } }) },
    } as YouTubeDataApi;
    const config: AppConfig = { stateDir: '/tmp/youtube-mcp-tests', diagnostics: () => 'safe' };
    const provider = createPlaylistProvider({ getAccessToken: async () => 'access-token' }, new YouTubeClient(config, { createAuthorizedApi: () => api, createPublicApi: () => api }));

    await provider.reorderPlaylistItem({ id: 'playlist-item-1', playlistId: 'playlist-1', videoId: 'video-1', position: 3 });

    expect(updateRequest).toMatchObject({
      part: ['snippet'],
      requestBody: { id: 'playlist-item-1', snippet: { playlistId: 'playlist-1', position: 3, resourceId: { kind: 'youtube#video', videoId: 'video-1' } } },
    });
  });

  it('rejects a stale playlist update before calling the provider', async () => {
    const { playlists, provider } = await service();
    const preview = await playlists.preflightUpdate({ playlistId: 'playlist-1', title: 'Updated' });
    await approve(playlists, preview.approvalId);
    provider.getPlaylist.mockResolvedValueOnce({ id: 'playlist-1', channelId: 'creator-channel', etag: 'changed-etag', title: 'Someone else changed this', description: 'Episodes', privacyStatus: 'private' });

    await expect(playlists.update({ playlistId: 'playlist-1', title: 'Updated', approvalId: preview.approvalId, confirm: true }))
      .rejects.toMatchObject({ code: 'stale_preview' });
    expect(provider.updatePlaylist).not.toHaveBeenCalled();
  });

  it('reconciles playlist metadata updates through an exact playlist read', async () => {
    const { playlists } = await service();

    const preview = await playlists.preflightUpdate({ playlistId: 'playlist-1', title: 'Updated' });

    expect(preview.reconciliation).toEqual({ tool: 'youtube_get_playlist', arguments: { playlistId: 'playlist-1' } });
  });

  it('deletes only a freshly owned playlist after its exact preview is approved', async () => {
    const { playlists, provider } = await service();
    const preview = await playlists.preflightDelete({ playlistId: 'playlist-1' });
    expect(preview).toMatchObject({
      kind: 'playlist.delete',
      targetId: 'playlist-1',
      desired: { playlistId: 'playlist-1', target: { id: 'playlist-1', channelId: 'creator-channel', title: 'Series', etag: 'playlist-etag' } },
      reconciliation: { tool: 'youtube_get_playlist', arguments: { playlistId: 'playlist-1' } },
    });
    await approve(playlists, preview.approvalId);

    await expect(playlists.delete({ playlistId: 'playlist-1', approvalId: preview.approvalId, confirm: true }))
      .resolves.toMatchObject({ state: 'succeeded', playlistId: 'playlist-1', deleted: true });
    expect(provider.deletePlaylist).toHaveBeenCalledWith({ id: 'playlist-1' });
  });

  it('executes an approved deletion after an MCP restart', async () => {
    const { playlists, operations, provider } = await service();
    const preview = await playlists.preflightDelete({ playlistId: 'playlist-1' });
    await approve(playlists, preview.approvalId);
    const restarted = new PlaylistService(operations, provider, creator, { verifyPrincipal: async () => creator });

    await expect(restarted.delete({ playlistId: 'playlist-1', approvalId: preview.approvalId, confirm: true }))
      .resolves.toMatchObject({ state: 'succeeded', playlistId: 'playlist-1', deleted: true });
  });

  it('returns the exact immutable playlist-item target summary before removal', async () => {
    const { playlists } = await service();

    const preview = await playlists.preflightRemove({ playlistId: 'playlist-1', playlistItemId: 'playlist-item-1' });

    expect(preview.desired).toEqual({
      playlistId: 'playlist-1',
      playlistItemId: 'playlist-item-1',
      target: { id: 'playlist-item-1', playlistId: 'playlist-1', videoId: 'video-1', position: 0, etag: 'item-etag' },
    });
  });

  it('rejects removal when the immutable playlist item no longer belongs to the selected playlist', async () => {
    const { playlists, provider } = await service({ getPlaylistItem: vi.fn(async () => ({ id: 'playlist-item-1', playlistId: 'other-playlist', videoId: 'video-1', position: 0 })) });

    await expect(playlists.preflightRemove({ playlistId: 'playlist-1', playlistItemId: 'playlist-item-1' }))
      .rejects.toMatchObject({ code: 'ownership_required' });
    expect(provider.removePlaylistItem).not.toHaveBeenCalled();
  });

  it('retries a not-found-yet playlist with bounded backoff, then succeeds', async () => {
    const delays: number[] = [];
    setReadAfterWriteSleep(async (ms) => { delays.push(ms); });
    try {
      let calls = 0;
      const { playlists } = await service({ getPlaylist: vi.fn(async (playlistId: string) => (++calls < 3 ? undefined : { id: playlistId, channelId: 'creator-channel', title: 'Series', privacyStatus: 'private' as const })) });

      await expect(playlists.preflightUpdate({ playlistId: 'playlist-1', title: 'Updated' })).resolves.toMatchObject({ kind: 'playlist.update' });
      expect(calls).toBe(3);
      expect(delays).toEqual([500, 1000]);
    } finally {
      setReadAfterWriteSleep(async () => undefined);
    }
  });

  it('gives up after four retries when the playlist never appears', async () => {
    const delays: number[] = [];
    setReadAfterWriteSleep(async (ms) => { delays.push(ms); });
    try {
      const getPlaylist = vi.fn(async () => undefined);
      const { playlists } = await service({ getPlaylist });

      await expect(playlists.preflightUpdate({ playlistId: 'playlist-1', title: 'Updated' })).rejects.toMatchObject({ code: 'ownership_required' });
      expect(getPlaylist).toHaveBeenCalledTimes(5);
      expect(delays).toEqual([500, 1000, 2000, 4000]);
    } finally {
      setReadAfterWriteSleep(async () => undefined);
    }
  });

  it('does not retry when the playlist exists but belongs to another channel', async () => {
    const getPlaylist = vi.fn(async (playlistId: string) => ({ id: playlistId, channelId: 'someone-else', title: 'Series', privacyStatus: 'private' as const }));
    const { playlists } = await service({ getPlaylist });

    await expect(playlists.preflightUpdate({ playlistId: 'playlist-1', title: 'Updated' })).rejects.toMatchObject({ code: 'ownership_required' });
    expect(getPlaylist).toHaveBeenCalledTimes(1);
  });

  it('reports a clean Google 4xx rejection with its reason instead of outcome-unknown', async () => {
    const rejection = Object.assign(new Error('forbidden'), { code: 403, errors: [{ reason: 'forbidden' }] });
    const { playlists } = await service({ createPlaylist: vi.fn(async () => { throw rejection; }) });
    const preview = await playlists.preflightCreate({ title: 'New series' });
    await approve(playlists, preview.approvalId);

    await expect(playlists.create({ title: 'New series', approvalId: preview.approvalId, confirm: true }))
      .rejects.toMatchObject({ code: 'provider_error', status: 403, reason: 'forbidden' });
  });

  it('keeps provider_outcome_unknown when the write fails without any Google response', async () => {
    const { playlists } = await service({ createPlaylist: vi.fn(async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); }) });
    const preview = await playlists.preflightCreate({ title: 'New series' });
    await approve(playlists, preview.approvalId);

    await expect(playlists.create({ title: 'New series', approvalId: preview.approvalId, confirm: true }))
      .rejects.toMatchObject({ code: 'provider_outcome_unknown' });
  });
});
