import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import { createMcpServer, type McpDependencies } from '../../src/mcp/server.js';
import { parseHttpPort, runHttp, type RunningHttpServer } from '../../src/transports/http.js';

const runningServers: RunningHttpServer[] = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.close()));
});

async function listOverInMemoryServer(): Promise<string[]> {
  const server = createMcpServer(fakeDependencies());
  const client = new Client({ name: 'stdio-parity-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    return (await client.listTools()).tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
    await server.close();
  }
}

async function listOverHttpServer(): Promise<string[]> {
  const httpServer = await runHttp(() => createMcpServer(fakeDependencies()), { port: 0 });
  runningServers.push(httpServer);
  const client = new Client({ name: 'http-parity-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(httpServer.url)));

  try {
    return (await client.listTools()).tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
  }
}

describe('runHttp', () => {
  it('advertises the same tool names as the local MCP server', async () => {
    await expect(listOverHttpServer()).resolves.toEqual(await listOverInMemoryServer());
  });

  it('binds to loopback by default instead of an externally reachable interface', async () => {
    const httpServer = await runHttp(() => createMcpServer(fakeDependencies()), { port: 0 });
    runningServers.push(httpServer);

    expect(httpServer.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it('rejects unsupported Streamable HTTP methods with an explicit POST allowance', async () => {
    const httpServer = await runHttp(() => createMcpServer(fakeDependencies()), { port: 0 });
    runningServers.push(httpServer);

    const response = await fetch(httpServer.url);

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('defaults the HTTP port and rejects invalid PORT values before binding', () => {
    expect(parseHttpPort(undefined)).toBe(3000);
    expect(() => parseHttpPort('3000.5')).toThrow('PORT must be an integer from 1 to 65535.');
    expect(() => parseHttpPort('0')).toThrow('PORT must be an integer from 1 to 65535.');
    expect(() => parseHttpPort('65536')).toThrow('PORT must be an integer from 1 to 65535.');
  });
});

function fakeDependencies(): McpDependencies {
  return {
    auth: { status: async () => ({ configured: true, authorized: true, scopes: [], scopeReadiness: { ready: true, required: [], missing: [] } }) },
    public: {
      search: async () => ({ items: [], context: { quotaUnits: 100, source: 'youtube_data_api' as const } }),
      getVideo: async () => ({ items: [], context: { quotaUnits: 1, source: 'youtube_data_api' as const } }),
      getChannel: async () => ({ items: [], context: { quotaUnits: 1, source: 'youtube_data_api' as const } }),
      getComments: async () => ({ items: [], context: { quotaUnits: 1, source: 'youtube_data_api' as const } }),
      getTranscript: async () => ({ available: false, source: 'best_effort' as const }),
    },
    account: {
      myAccount: async () => ({ id: 'channel-1', title: 'Example channel' }),
      listSubscriptions: async () => [],
      listChannelCommentThreads: async () => [],
      subscribe: async ({ channelId }) => ({ subscriptionId: 'subscription-1', channelId }),
      unsubscribe: async ({ subscriptionId }) => ({ subscriptionId, unsubscribed: true }),
      rateVideo: async ({ videoId, rating }) => ({ videoId, rating }),
      createComment: async () => ({ id: 'comment-1', author: 'Example', text: 'Example comment' }),
    },
    creator: {
      overview: async () => ({ views: 0, estimatedMinutesWatched: 0, averageViewDuration: 0, likes: 0, comments: 0, subscribersGained: 0, subscribersLost: 0 }),
      topVideos: async () => [],
      retention: async () => [],
    },
    resources: {
      listOwnedVideos: async () => ({ items: [], profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'channel-1' }, fetchedAt: '2026-08-18T02:00:00.000Z', expiresAt: '2026-08-18T02:15:00.000Z' }),
      getOwnedVideo: async () => ({ item: { id: 'video-1', title: 'Owned', channelId: 'channel-1' }, profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'channel-1' }, fetchedAt: '2026-08-18T02:00:00.000Z', expiresAt: '2026-08-18T02:15:00.000Z' }),
      listVideoCategories: async () => ({ items: [], profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'channel-1' }, fetchedAt: '2026-08-18T02:00:00.000Z', expiresAt: '2026-08-18T02:15:00.000Z' }),
      listPlaylists: async () => ({ items: [], profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'channel-1' }, fetchedAt: '2026-08-18T02:00:00.000Z', expiresAt: '2026-08-18T02:15:00.000Z' }),
      getPlaylist: async () => ({ item: null, profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'channel-1' }, fetchedAt: '2026-08-18T02:00:00.000Z', expiresAt: '2026-08-18T02:15:00.000Z' }),
      listPlaylistItems: async () => ({ items: [], profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'channel-1' }, fetchedAt: '2026-08-18T02:00:00.000Z', expiresAt: '2026-08-18T02:15:00.000Z' }),
      listModerationComments: async () => ({ items: [], profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'channel-1' }, fetchedAt: '2026-08-18T02:00:00.000Z', expiresAt: '2026-08-18T02:15:00.000Z' }),
      getModerationComment: async () => ({ item: { id: 'comment-1', channelId: 'channel-1', text: 'Owned' }, profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'channel-1' }, fetchedAt: '2026-08-18T02:00:00.000Z', expiresAt: '2026-08-18T02:15:00.000Z' }),
      findCommentReply: async () => ({ parentId: 'comment-1', text: 'Owned', matches: [], complete: true as const, profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'channel-1' }, fetchedAt: '2026-08-18T02:00:00.000Z', expiresAt: '2026-08-18T02:15:00.000Z' }),
      listCaptionTracks: async () => ({ items: [], profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'channel-1' }, fetchedAt: '2026-08-18T02:00:00.000Z', expiresAt: '2026-08-18T02:15:00.000Z' }),
    },
    uploads: {
      preflight: async () => preview('video.upload'), preflightResume: async () => preview('video.upload.resume'), preflightCancel: async () => preview('video.upload.cancel'), approve: async () => preview('video.upload', 'approved'),
      upload: async () => ({ uploadId: 'upload-1', state: 'complete' as const, videoId: 'video-1' }), resume: async () => ({ uploadId: 'upload-1', state: 'in_progress' as const, offset: 0 }), getStatus: async () => ({ uploadId: 'upload-1', state: 'in_progress' as const, offset: 0 }), cancel: async () => ({ uploadId: 'upload-1', state: 'cancelled' as const }),
    } as McpDependencies['uploads'],
    content: {
      approve: async () => preview('video.metadata.update', 'approved'), preflightArchiveVideo: async () => preview('video.archive'), archiveVideo: async () => ({ ...receipt('videoId', 'video-1'), privacyStatus: 'private' as const, scheduled: false as const }), preflightMetadataUpdate: async () => preview('video.metadata.update'), updateMetadata: async () => receipt('videoId', 'video-1'), preflightThumbnail: async () => preview('video.thumbnail.set'), setThumbnail: async () => receipt('videoId', 'video-1'),
      preflightCaptionUpload: async () => preview('caption.upload'), uploadCaption: async () => receipt('captionId', 'caption-1'), preflightCaptionUpdate: async () => preview('caption.update'), updateCaption: async () => receipt('captionId', 'caption-1'), preflightCaptionDownload: async () => preview('caption.download'), downloadCaption: async () => ({ ...receipt('captionId', 'caption-1'), downloaded: true as const }), preflightCaptionDelete: async () => preview('caption.delete'), deleteCaption: async () => ({ ...receipt('captionId', 'caption-1'), deleted: true as const }),
    } as unknown as McpDependencies['content'],
    playlists: {
      approve: async () => preview('playlist.create', 'approved'), preflightCreate: async () => preview('playlist.create'), create: async () => receipt('playlistId', 'playlist-1'), preflightUpdate: async () => preview('playlist.update'), update: async () => receipt('playlistId', 'playlist-1'), preflightDelete: async () => preview('playlist.delete'), delete: async () => ({ ...receipt('playlistId', 'playlist-1'), deleted: true as const }), preflightAdd: async () => preview('playlist.item.add'), add: async () => receipt('playlistItemId', 'item-1'), preflightRemove: async () => preview('playlist.item.remove'), remove: async () => ({ ...receipt('playlistItemId', 'item-1'), removed: true as const }), preflightReorder: async () => preview('playlist.item.reorder'), reorder: async () => receipt('playlistItemId', 'item-1'),
    } as unknown as McpDependencies['playlists'],
    moderation: {
      approve: async () => preview('comment.delete', 'approved'), preflightReply: async () => preview('comment.reply'), reply: async () => receipt('replyId', 'reply-1'), preflightSetStatus: async () => preview('comment.status'), setStatus: async () => receipt('commentId', 'comment-1'), preflightDelete: async () => preview('comment.delete'), delete: async () => ({ ...receipt('commentId', 'comment-1'), deleted: true as const }),
    } as unknown as McpDependencies['moderation'],
    curation: { savePolicy: (input) => ({ profileId: 'consumer-a', ...input }), saveCandidate: (input) => ({ profileId: 'consumer-a', ...input }), propose: ({ minutes }) => ({ queueId: 'queue-1', profileId: 'consumer-a', source: 'local_self_report' as const, estimatedMinutes: minutes, items: [], state: 'proposed' as const }), reset: async () => ({ profileId: 'consumer-a', deleted: { policies: 0, candidates: 0, queues: 0 } }) } as McpDependencies['curation'],
    importer: { import: async () => ({ imported: 0, skipped: 0 }) },
    insights: {
      profile: () => ({ totalWatchCount: 0, totalActivityCount: 0, searchCount: 0, topChannels: [], topTopics: [], contentTypes: [], byHour: [] }),
      trends: () => ({ increasedTopics: [] }),
    },
  };
}

function preview(kind: string, state: 'planned' | 'approved' = 'planned') {
  return { approvalId: 'approval-1', profile: { id: 'creator-a', purpose: 'creator' as const, channelId: 'channel-1' }, kind, targetId: 'target-1', desired: {}, desiredFingerprint: 'desired', currentFingerprint: 'current', expiresAt: '2026-08-18T03:00:00.000Z', state, reconciliation: { tool: 'youtube_get_operation_status', arguments: { approvalId: 'approval-1' } } };
}

function receipt(key: string, value: string) {
  return { operationId: 'approval-1', state: 'succeeded' as const, reconciliation: { tool: 'youtube_get_operation_status', arguments: { approvalId: 'approval-1' } }, [key]: value };
}
