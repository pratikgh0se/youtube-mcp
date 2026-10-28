import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/errors.js';
import { createMcpServer, type McpDependencies } from '../../src/mcp/server.js';
import type { UploadStatusResult } from '../../src/youtube/uploads.js';

function playlistPreview(state: 'planned' | 'approved') {
  return { approvalId: 'playlist-approval', profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'creator-channel' }, kind: 'playlist.update', targetId: 'playlist-1', desired: {}, desiredFingerprint: 'desired', currentFingerprint: 'current', expiresAt: '2026-08-18T03:00:00.000Z', state, reconciliation: { tool: 'youtube_list_playlist_items', arguments: { playlistId: 'playlist-1' } } };
}

function playlistReceipt(playlistId: string) {
  return { operationId: 'playlist-approval', state: 'succeeded' as const, reconciliation: { tool: 'youtube_list_playlist_items', arguments: { playlistId } }, playlistId };
}

function moderationPreview(state: 'planned' | 'approved') {
  return { approvalId: 'moderation-approval', profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'creator-channel' }, kind: 'comment.delete', targetId: 'comment-1', desired: {}, desiredFingerprint: 'desired', currentFingerprint: 'current', expiresAt: '2026-08-18T03:00:00.000Z', state, reconciliation: { tool: 'youtube_get_moderation_comment', arguments: { commentId: 'comment-1' } } };
}

function moderationReceipt() {
  return { operationId: 'moderation-approval', state: 'succeeded' as const, reconciliation: { tool: 'youtube_get_moderation_comment', arguments: { commentId: 'comment-1' } } };
}

async function connectedServer(dependencies: McpDependencies) {
  const server = createMcpServer(dependencies);
  const client = new Client({ name: 'youtube-mcp-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

function fakeDependencies(): McpDependencies {
  return {
    auth: { status: async () => ({ configured: true, authorized: true, scopes: ['youtube.readonly'], scopeReadiness: { ready: true, required: [], missing: [] } }) },
    public: {
      search: async ({ query }) => ({ items: [{ id: 'v1', title: query, channelId: 'c1' }], context: { quotaUnits: 100, source: 'youtube_data_api' } }),
      getVideo: async ({ videoId }) => ({ items: [{ id: videoId, title: 'Video', channelId: 'c1' }], context: { quotaUnits: 1, source: 'youtube_data_api' } }),
      getChannel: async ({ channelId }) => ({ items: [{ id: channelId, title: 'Channel' }], context: { quotaUnits: 1, source: 'youtube_data_api' } }),
      getComments: async () => ({ items: [], context: { quotaUnits: 1, source: 'youtube_data_api' } }),
      getTranscript: async () => ({ available: false, source: 'best_effort' }),
    },
    account: {
      myAccount: async () => ({ id: 'c1', title: 'Channel' }),
      listSubscriptions: async () => [],
      listChannelCommentThreads: async () => [],
      subscribe: async ({ channelId }) => ({ subscriptionId: 'sub1', channelId }),
      unsubscribe: async ({ subscriptionId }) => ({ subscriptionId, unsubscribed: true }),
      rateVideo: async ({ videoId, rating }) => ({ videoId, rating }),
      createComment: async () => ({ id: 'comment1', author: 'Me', text: 'Hello' }),
    },
    creator: {
      overview: async () => ({ views: 1, estimatedMinutesWatched: 2, averageViewDuration: 3, likes: 4, comments: 5, subscribersGained: 6, subscribersLost: 7 }),
      topVideos: async () => [],
      retention: async () => [],
    },
    resources: {
      listOwnedVideos: async ({ maxResults, pageToken }: { maxResults?: number; pageToken?: string }) => ({
        items: [{ id: 'owned-video', title: 'Owned', channelId: 'creator-channel' }],
        profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'creator-channel' },
        fetchedAt: '2026-08-18T02:00:00.000Z',
        expiresAt: '2026-08-18T02:15:00.000Z',
        ...(maxResults === 2 && pageToken === 'next-page' ? { nextPageToken: 'after-page' } : {}),
      }),
      getOwnedVideo: async (videoId: string) => ({
        item: { id: videoId, title: 'Owned', channelId: 'creator-channel' },
        profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'creator-channel' },
        fetchedAt: '2026-08-18T02:00:00.000Z',
        expiresAt: '2026-08-18T02:15:00.000Z',
      }),
      listVideoCategories: async () => ({ items: [], profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'creator-channel' }, fetchedAt: '2026-08-18T02:00:00.000Z', expiresAt: '2026-08-18T02:15:00.000Z' }),
      listPlaylists: async () => ({ items: [], profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'creator-channel' }, fetchedAt: '2026-08-18T02:00:00.000Z', expiresAt: '2026-08-18T02:15:00.000Z' }),
      getPlaylist: async (playlistId: string) => ({ item: { id: playlistId, title: 'Series', channelId: 'creator-channel' }, profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'creator-channel' }, fetchedAt: '2026-08-18T02:00:00.000Z', expiresAt: '2026-08-18T02:15:00.000Z' }),
      listPlaylistItems: async () => ({ items: [], profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'creator-channel' }, fetchedAt: '2026-08-18T02:00:00.000Z', expiresAt: '2026-08-18T02:15:00.000Z' }),
      listModerationComments: async () => ({ items: [], profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'creator-channel' }, fetchedAt: '2026-08-18T02:00:00.000Z', expiresAt: '2026-08-18T02:15:00.000Z' }),
      getModerationComment: async (commentId: string) => ({ item: { id: commentId, channelId: 'creator-channel', text: 'Exact comment' }, profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'creator-channel' }, fetchedAt: '2026-08-18T02:00:00.000Z', expiresAt: '2026-08-18T02:15:00.000Z' }),
      findCommentReply: async ({ parentId, text }: { parentId: string; text: string }) => ({ parentId, text, matches: [], complete: true as const, profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'creator-channel' }, fetchedAt: '2026-08-18T02:00:00.000Z', expiresAt: '2026-08-18T02:15:00.000Z' }),
      listCaptionTracks: async () => ({ items: [], profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'creator-channel' }, fetchedAt: '2026-08-18T02:00:00.000Z', expiresAt: '2026-08-18T02:15:00.000Z' }),
    },
    uploads: {
      preflight: async () => ({ approvalId: 'upload-approval', profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'creator-channel' }, kind: 'video.upload', targetId: 'upload-1', desired: {}, desiredFingerprint: 'desired', currentFingerprint: 'source', expiresAt: '2026-08-18T03:00:00.000Z', state: 'planned' as const, reconciliation: { tool: 'youtube_get_upload_status', arguments: { uploadId: 'upload-1' } } }),
      preflightResume: async () => ({ approvalId: 'resume-approval', profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'creator-channel' }, kind: 'video.upload.resume', targetId: 'upload-1', desired: {}, desiredFingerprint: 'desired', currentFingerprint: 'source', expiresAt: '2026-08-18T03:00:00.000Z', state: 'planned' as const, reconciliation: { tool: 'youtube_get_upload_status', arguments: { uploadId: 'upload-1' } } }),
      preflightCancel: async () => ({ approvalId: 'cancel-approval', profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'creator-channel' }, kind: 'video.upload.cancel', targetId: 'upload-1', desired: {}, desiredFingerprint: 'desired', currentFingerprint: 'source', expiresAt: '2026-08-18T03:00:00.000Z', state: 'planned' as const, reconciliation: { tool: 'youtube_get_upload_status', arguments: { uploadId: 'upload-1' } } }),
      upload: async () => ({ uploadId: 'upload-1', state: 'complete', videoId: 'video-1' } satisfies UploadStatusResult),
      resume: async () => ({ uploadId: 'upload-1', state: 'in_progress', offset: 10 } satisfies UploadStatusResult),
      getStatus: async () => ({ uploadId: 'upload-1', state: 'in_progress', offset: 10 } satisfies UploadStatusResult),
      cancel: async () => ({ uploadId: 'upload-1', state: 'cancelled' } satisfies UploadStatusResult),
    },
    content: {
      preflightArchiveVideo: async () => ({ approvalId: 'archive-approval', profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'creator-channel' }, kind: 'video.archive', targetId: 'video-1', desired: {}, desiredFingerprint: 'desired', currentFingerprint: 'current', expiresAt: '2026-08-18T03:00:00.000Z', state: 'planned' as const, reconciliation: { tool: 'youtube_get_owned_video', arguments: { videoId: 'video-1' } } }),
      archiveVideo: async () => ({ operationId: 'archive-approval', state: 'succeeded' as const, videoId: 'video-1', privacyStatus: 'private' as const, scheduled: false as const }),
      preflightMetadataUpdate: async () => ({ approvalId: 'metadata-approval', profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'creator-channel' }, kind: 'video.metadata.update', targetId: 'video-1', desired: { snippet: { title: 'New' } }, desiredFingerprint: 'desired', currentFingerprint: 'current', expiresAt: '2026-08-18T03:00:00.000Z', state: 'planned' as const, reconciliation: { tool: 'youtube_get_owned_video', arguments: { videoId: 'video-1' } } }),
      preflightThumbnail: async () => ({ approvalId: 'thumbnail-approval', profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'creator-channel' }, kind: 'video.thumbnail.set', targetId: 'video-1', desired: {}, desiredFingerprint: 'desired', currentFingerprint: 'current', expiresAt: '2026-08-18T03:00:00.000Z', state: 'planned' as const, reconciliation: { tool: 'youtube_get_owned_video', arguments: { videoId: 'video-1' } } }),
      setThumbnail: async () => ({ operationId: 'thumbnail-approval', state: 'succeeded' as const, videoId: 'video-1' }),
      updateMetadata: async () => ({ operationId: 'metadata-approval', state: 'succeeded' as const, videoId: 'video-1' }),
      preflightCaptionUpload: async () => ({ approvalId: 'caption-upload-approval', profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'creator-channel' }, kind: 'caption.upload', targetId: 'video-1', desired: {}, desiredFingerprint: 'desired', currentFingerprint: 'current', expiresAt: '2026-08-18T03:00:00.000Z', state: 'planned' as const, reconciliation: { tool: 'youtube_list_caption_tracks', arguments: { videoId: 'video-1' } } }),
      uploadCaption: async () => ({ operationId: 'caption-upload-approval', state: 'succeeded' as const, captionId: 'caption-2' }),
      preflightCaptionUpdate: async () => ({ approvalId: 'caption-update-approval', profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'creator-channel' }, kind: 'caption.update', targetId: 'caption-1', desired: {}, desiredFingerprint: 'desired', currentFingerprint: 'current', expiresAt: '2026-08-18T03:00:00.000Z', state: 'planned' as const, reconciliation: { tool: 'youtube_list_caption_tracks', arguments: { videoId: 'video-1' } } }),
      updateCaption: async () => ({ operationId: 'caption-update-approval', state: 'succeeded' as const, captionId: 'caption-1' }),
      downloadCaption: async () => ({ state: 'succeeded' as const, captionId: 'caption-1', downloaded: true as const }),
      preflightCaptionDelete: async () => ({ approvalId: 'caption-delete-approval', profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'creator-channel' }, kind: 'caption.delete', targetId: 'caption-1', desired: {}, desiredFingerprint: 'desired', currentFingerprint: 'current', expiresAt: '2026-08-18T03:00:00.000Z', state: 'planned' as const, reconciliation: { tool: 'youtube_list_caption_tracks', arguments: { videoId: 'video-1' } } }),
      deleteCaption: async () => ({ operationId: 'caption-delete-approval', state: 'succeeded' as const, captionId: 'caption-1', deleted: true as const }),
    },
    playlists: {
      preflightCreate: async () => playlistPreview('planned'), create: async () => playlistReceipt('playlist-2'),
      preflightUpdate: async () => playlistPreview('planned'), update: async () => playlistReceipt('playlist-1'),
      preflightDelete: async () => playlistPreview('planned'), delete: async () => ({ ...playlistReceipt('playlist-1'), deleted: true as const }),
      preflightAdd: async () => playlistPreview('planned'), add: async () => ({ ...playlistReceipt('playlist-1'), playlistItemId: 'playlist-item-2' }),
      preflightRemove: async () => playlistPreview('planned'), remove: async () => ({ ...playlistReceipt('playlist-1'), playlistItemId: 'playlist-item-1', removed: true as const }),
      preflightReorder: async () => playlistPreview('planned'), reorder: async () => ({ ...playlistReceipt('playlist-1'), playlistItemId: 'playlist-item-1' }),
    },
    moderation: {
      preflightReply: async () => moderationPreview('planned'), reply: async () => ({ ...moderationReceipt(), commentId: 'comment-1', replyId: 'reply-1' }),
      preflightSetStatus: async () => moderationPreview('planned'), setStatus: async () => ({ ...moderationReceipt(), commentId: 'comment-1', moderationStatus: 'published' as const }),
      preflightDelete: async () => moderationPreview('planned'), delete: async () => ({ ...moderationReceipt(), commentId: 'comment-1', deleted: true as const }),
    },
    approvals: { approve: async () => moderationPreview('approved') },
    curation: {
      savePolicy: (input) => ({ profileId: 'consumer-a', ...input }),
      saveCandidate: (input) => ({ profileId: 'consumer-a', ...input }),
      propose: ({ minutes }) => ({ queueId: 'queue-1', profileId: 'consumer-a', source: 'local_self_report' as const, estimatedMinutes: minutes, items: [], state: 'proposed' as const }),
      reset: async () => ({ profileId: 'consumer-a', deleted: { policies: 1, candidates: 1, queues: 1 } }),
    },
    importer: { import: async () => ({ imported: 1, skipped: 0 }) },
    insights: {
      profile: () => ({ totalWatchCount: 1, totalActivityCount: 1, searchCount: 0, topChannels: [], topTopics: [], contentTypes: [], byHour: [] }),
      trends: () => ({ increasedTopics: [] }),
    },
  };
}

describe('createMcpServer', () => {
  it('advertises exactly the portable public, account, creator, consumption, and status tools', async () => {
    const { client, server } = await connectedServer(fakeDependencies());

    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name).sort()).toEqual(expect.arrayContaining([
      'youtube_approve',
      'youtube_archive_video',
      'youtube_preflight_archive_video',
      'youtube_auth_status',
      'youtube_cancel_upload',
      'youtube_consumption_profile',
      'youtube_save_curation_policy',
      'youtube_save_curation_candidate',
      'youtube_propose_consumption_queue',
      'youtube_reset_consumption_data',
      'youtube_consumption_trends',
      'youtube_create_comment',
      'youtube_creator_overview',
      'youtube_creator_retention',
      'youtube_creator_top_videos',
      'youtube_delete_caption',
      'youtube_download_caption',
      'youtube_get_channel',
      'youtube_get_comments',
      'youtube_get_moderation_comment',
      'youtube_get_owned_video',
      'youtube_get_playlist',
      'youtube_get_transcript',
      'youtube_get_upload_status',
      'youtube_get_video',
      'youtube_import_takeout',
      'youtube_find_comment_reply',
      'youtube_list_caption_tracks',
      'youtube_list_channel_comment_threads',
      'youtube_list_moderation_comments',
      'youtube_list_owned_videos',
      'youtube_list_playlist_items',
      'youtube_list_playlists',
      'youtube_list_subscriptions',
      'youtube_list_video_categories',
      'youtube_my_account',
      'youtube_preflight_cancel_upload',
      'youtube_preflight_caption_delete',
      'youtube_preflight_caption_update',
      'youtube_preflight_caption_upload',
      'youtube_preflight_resume_upload',
      'youtube_preflight_set_thumbnail',
      'youtube_preflight_update_metadata',
      'youtube_preflight_upload',
      'youtube_rate_video',
      'youtube_resume_upload',
      'youtube_search',
      'youtube_set_thumbnail',
      'youtube_subscribe',
      'youtube_unsubscribe',
      'youtube_update_caption',
      'youtube_update_metadata',
      'youtube_upload_caption',
      'youtube_upload_video',
    ]));
    expect(result.tools.map((tool) => tool.name)).not.toContain('youtube_apply_consumption_queue');
    expect(result.tools.find((tool) => tool.name === 'youtube_subscribe')?.annotations).toMatchObject({ destructiveHint: true });
    expect(result.tools.find((tool) => tool.name === 'youtube_search')?.annotations).toMatchObject({ readOnlyHint: true });
    expect(result.tools.find((tool) => tool.name === 'youtube_search')?.inputSchema).toMatchObject({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    });

    await client.close();
    await server.close();
  });

  it('exposes one youtube_approve tool and a read-only caption download', async () => {
    const { client, server } = await connectedServer(fakeDependencies());
    const tools = (await client.listTools()).tools;
    const names = tools.map((tool) => tool.name);

    expect(names).toContain('youtube_approve');
    for (const removed of ['youtube_approve_upload', 'youtube_approve_playlist', 'youtube_approve_creator_content', 'youtube_approve_moderation', 'youtube_preflight_caption_download']) {
      expect(names).not.toContain(removed);
    }
    expect(tools.find((tool) => tool.name === 'youtube_download_caption')?.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.find((tool) => tool.name === 'youtube_download_caption')?.inputSchema.required).not.toContain('approvalId');
    const approved = await client.callTool({ name: 'youtube_approve', arguments: { approvalId: 'a', confirm: true } });
    expect(approved.isError).not.toBe(true);

    await client.close();
    await server.close();
  });

  it('registers creator packaging tools with approval IDs and strict media input schemas', async () => {
    const { client, server } = await connectedServer(fakeDependencies());

    const tools = await client.listTools();
    const metadata = tools.tools.find((tool) => tool.name === 'youtube_update_metadata');
    const upload = tools.tools.find((tool) => tool.name === 'youtube_upload_caption');
    expect(metadata?.annotations).toMatchObject({ destructiveHint: true });
    expect(metadata?.inputSchema).toMatchObject({ required: expect.arrayContaining(['approvalId', 'videoId']) });
    expect(upload?.inputSchema).toMatchObject({ properties: { mimeType: { enum: expect.arrayContaining(['text/vtt']) } }, required: expect.arrayContaining(['approvalId', 'filePath', 'videoId', 'name']) });

    await client.close();
    await server.close();
  });

  it('registers playlist and moderation writes with immutable targets, approval IDs, and elevated ban intent', async () => {
    const { client, server } = await connectedServer(fakeDependencies());
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'youtube_preflight_create_playlist', 'youtube_create_playlist',
      'youtube_preflight_update_playlist', 'youtube_update_playlist',
      'youtube_preflight_delete_playlist', 'youtube_delete_playlist',
      'youtube_preflight_add_playlist_item', 'youtube_add_playlist_item',
      'youtube_preflight_remove_playlist_item', 'youtube_remove_playlist_item',
      'youtube_preflight_reorder_playlist_item', 'youtube_reorder_playlist_item',
      'youtube_preflight_reply_to_comment', 'youtube_reply_to_comment',
      'youtube_preflight_set_comment_moderation_status', 'youtube_set_comment_moderation_status',
      'youtube_preflight_delete_comment', 'youtube_delete_comment',
    ]));
    const reorder = tools.tools.find((tool) => tool.name === 'youtube_reorder_playlist_item');
    const deletePlaylist = tools.tools.find((tool) => tool.name === 'youtube_delete_playlist');
    const deleteComment = tools.tools.find((tool) => tool.name === 'youtube_delete_comment');
    const moderation = tools.tools.find((tool) => tool.name === 'youtube_set_comment_moderation_status');

    expect(reorder?.annotations).toMatchObject({ destructiveHint: true });
    expect(reorder?.inputSchema).toMatchObject({ required: expect.arrayContaining(['approvalId', 'playlistId', 'playlistItemId', 'position']) });
    expect(deletePlaylist?.inputSchema).toMatchObject({ required: expect.arrayContaining(['approvalId', 'playlistId']) });
    expect(deleteComment?.inputSchema).toMatchObject({ required: expect.arrayContaining(['approvalId', 'commentId']) });
    expect(moderation?.inputSchema).toMatchObject({ properties: { banAuthor: { type: 'boolean' }, elevated: { type: 'boolean' } } });

    await client.close();
    await server.close();
  });

  it('registers the upload lifecycle with explicit approval and confirmation inputs', async () => {
    const { client, server } = await connectedServer(fakeDependencies());

    const tools = await client.listTools();
    const uploadTool = tools.tools.find((tool) => tool.name === 'youtube_upload_video');
    expect(uploadTool?.annotations).toMatchObject({ destructiveHint: true });
    expect(uploadTool?.inputSchema).toMatchObject({
      type: 'object',
      properties: { approvalId: { type: 'string' }, confirm: { type: 'boolean' }, filePath: { type: 'string' } },
      required: expect.arrayContaining(['approvalId', 'filePath']),
    });

    const status = await client.callTool({ name: 'youtube_get_upload_status', arguments: { uploadId: 'upload-1' } });
    expect(status.structuredContent).toEqual({ uploadId: 'upload-1', state: 'in_progress', offset: 10 });

    await client.close();
    await server.close();
  });

  it('registers exact immutable moderation reconciliation reads', async () => {
    const { client, server } = await connectedServer(fakeDependencies());

    const comment = await client.callTool({ name: 'youtube_get_moderation_comment', arguments: { commentId: 'comment-1' } });
    const reply = await client.callTool({ name: 'youtube_find_comment_reply', arguments: { parentId: 'comment-1', text: 'Thank you.' } });

    expect(comment.structuredContent).toMatchObject({ item: { id: 'comment-1', text: 'Exact comment' } });
    expect(reply.structuredContent).toMatchObject({ parentId: 'comment-1', text: 'Thank you.', matches: [], complete: true });
    await client.close();
    await server.close();
  });

  it('returns service data as portable structured content without exposing local history records', async () => {
    const { client, server } = await connectedServer(fakeDependencies());

    const result = await client.callTool({
      name: 'youtube_consumption_profile',
      arguments: { startDate: '2026-01-01', endDate: '2026-01-31' },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      totalWatchCount: 1,
      totalActivityCount: 1,
      searchCount: 0,
      topChannels: [],
      topTopics: [],
      contentTypes: [],
      byHour: [],
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_HISTORY_ENTRY');

    await client.close();
    await server.close();
  });

  it('returns a paginated owned-video inventory through the read-only tool', async () => {
    const { client, server } = await connectedServer(fakeDependencies());

    const result = await client.callTool({
      name: 'youtube_list_owned_videos',
      arguments: { maxResults: 2, pageToken: 'next-page' },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      items: [{ id: 'owned-video', channelId: 'creator-channel' }],
      profile: { id: 'creator-a', channelId: 'creator-channel' },
      fetchedAt: '2026-08-18T02:00:00.000Z',
      nextPageToken: 'after-page',
    });

    await client.close();
    await server.close();
  });

  it('rejects category inputs that select both or neither category scope', async () => {
    const { client, server } = await connectedServer(fakeDependencies());

    const both = await client.callTool({ name: 'youtube_list_video_categories', arguments: { regionCode: 'TH', id: '22' } });
    const malformedRegion = await client.callTool({ name: 'youtube_list_video_categories', arguments: { regionCode: 'THA' } });

    expect(both.isError).toBe(true);
    expect(malformedRegion.isError).toBe(true);

    await client.close();
    await server.close();
  });

  it('routes missing configuration through a safe, tool-visible error', async () => {
    const dependencies = fakeDependencies();
    dependencies.public.search = async () => {
      throw new AppError('api_key_required', 'A YouTube API key is required for public YouTube reads.', 'Set YOUTUBE_API_KEY and try again.', false);
    };
    const { client, server } = await connectedServer(dependencies);

    const result = await client.callTool({ name: 'youtube_search', arguments: { query: 'TypeScript' } });

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('api_key_required'),
    })]));

    await client.close();
    await server.close();
  });

  it('passes confirmation to the account service instead of bypassing its write gate', async () => {
    const dependencies = fakeDependencies();
    let received: unknown;
    dependencies.account.subscribe = async (input) => {
      received = input;
      if (input.confirm !== true) {
        throw new AppError('confirmation_required', 'This action changes your YouTube account.', 'Repeat the call with confirm: true.', false);
      }
      return { subscriptionId: 'sub1', channelId: input.channelId };
    };
    const { client, server } = await connectedServer(dependencies);

    const denied = await client.callTool({ name: 'youtube_subscribe', arguments: { channelId: 'c1' } });
    const confirmed = await client.callTool({ name: 'youtube_subscribe', arguments: { channelId: 'c1', confirm: true } });

    expect(denied).toMatchObject({ isError: true });
    expect(JSON.stringify(denied)).toContain('confirmation_required');
    expect(received).toEqual({ channelId: 'c1', confirm: true });
    expect(confirmed.structuredContent).toEqual({ subscriptionId: 'sub1', channelId: 'c1' });

    await client.close();
    await server.close();
  });
});
