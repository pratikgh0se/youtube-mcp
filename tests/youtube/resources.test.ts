import { describe, expect, it } from 'vitest';

import { YouTubeClient, type YouTubeDataApi } from '../../src/youtube/client.js';
import { ResourceService } from '../../src/youtube/resources.js';
import type { AppConfig } from '../../src/types.js';

function config(): AppConfig {
  return {
    profileId: 'creator-a',
    stateDir: '/tmp/youtube-mcp-tests',
    diagnostics: () => 'safe diagnostics',
  };
}

function api(): YouTubeDataApi {
  return {
    search: { list: async () => ({ data: { items: [] } }) },
    videos: {
      list: async () => ({
        data: { items: [{ id: 'other-channel-video', snippet: { title: 'Elsewhere', channelId: 'other-channel' } }] },
      }),
    },
    channels: {
      list: async () => ({ data: { items: [{ id: 'creator-channel', snippet: { title: 'Creator' } }] } }),
    },
    commentThreads: { list: async () => ({ data: { items: [] } }) },
    comments: {
      list: async () => ({ data: { items: [] } }),
      insert: async () => ({ data: {} }),
      setModerationStatus: async () => ({ data: {} }),
      delete: async () => ({ data: {} }),
    },
    videoCategories: { list: async () => ({ data: { items: [] } }) },
    playlists: { list: async () => ({ data: { items: [] } }) },
    playlistItems: { list: async () => ({ data: { items: [] } }) },
    captions: { list: async () => ({ data: { items: [] } }) },
  };
}

function ownedApi(
  requests: Record<string, unknown>[],
  playlistOwnerChannel = 'creator-channel',
  authenticatedChannelId = 'creator-channel',
): YouTubeDataApi {
  return {
    search: { list: async () => ({ data: { items: [] } }) },
    videos: {
      list: async (request) => {
        requests.push({ resource: 'videos', ...request });
        return {
          data: {
            items: [{
              id: 'owned-video',
              etag: 'video-etag',
              snippet: { title: 'Owned video', channelId: 'creator-channel', description: 'Kept compact' },
              status: { privacyStatus: 'private' },
              processingDetails: { processingStatus: 'succeeded' },
            }],
            nextPageToken: 'video-next',
          },
        };
      },
    },
    channels: {
      list: async (request) => {
        requests.push({ resource: 'channels', ...request });
        if (request.mine === true) return { data: { items: [{ id: authenticatedChannelId }] } };
        return { data: { items: [{ id: 'creator-channel', contentDetails: { relatedPlaylists: { uploads: 'uploads-playlist' } } }] } };
      },
    },
    commentThreads: {
      list: async (request) => {
        requests.push({ resource: 'commentThreads', ...request });
        return {
          data: {
            items: [{
              id: 'thread-1',
              etag: 'thread-etag',
              snippet: {
                channelId: 'creator-channel',
                videoId: 'owned-video',
                totalReplyCount: 1,
                topLevelComment: {
                  id: 'comment-1',
                  snippet: { authorDisplayName: 'Viewer', textDisplay: 'Great work', publishedAt: '2026-08-18T01:00:00Z', moderationStatus: 'heldForReview' },
                },
              },
              replies: { comments: [{ id: 'reply-1', snippet: { authorDisplayName: 'Creator', textDisplay: 'Thanks' } }] },
            }],
            nextPageToken: 'comment-next',
          },
        };
      },
    },
    comments: {
      list: async (request) => {
        requests.push({ resource: 'comments', ...request });
        if (Array.isArray(request.id)) {
          return { data: { items: [{
            id: request.id[0],
            etag: 'comment-etag',
            snippet: {
              channelId: 'creator-channel',
              authorChannelId: { value: 'viewer-channel' },
              authorDisplayName: 'Viewer',
              textDisplay: 'Great work',
              moderationStatus: 'heldForReview',
            },
          }] } };
        }
        if (request.pageToken === 'reply-next') {
          return { data: { items: [{
            id: 'reply-match',
            snippet: {
              channelId: 'creator-channel', parentId: 'comment-1', authorChannelId: { value: 'creator-channel' },
              authorDisplayName: 'Creator', textDisplay: 'Thank you.',
            },
          }] } };
        }
        return { data: {
          items: [{
            id: 'reply-other',
            snippet: {
              channelId: 'creator-channel', parentId: 'comment-1', authorChannelId: { value: 'creator-channel' },
              authorDisplayName: 'Creator', textDisplay: 'Different reply',
            },
          }],
          nextPageToken: 'reply-next',
        } };
      },
      insert: async () => ({ data: {} }),
      setModerationStatus: async () => ({ data: {} }),
      delete: async () => ({ data: {} }),
    },
    videoCategories: {
      list: async (request) => {
        requests.push({ resource: 'videoCategories', ...request });
        return { data: { items: [{ id: '22', snippet: { title: 'People & Blogs' } }], nextPageToken: 'category-next' } };
      },
    },
    playlists: {
      list: async (request) => {
        requests.push({ resource: 'playlists', ...request });
        if (Array.isArray(request.id) && request.id[0] === 'playlist-1') return { data: { items: [{ id: 'playlist-1', snippet: { title: 'Series', channelId: playlistOwnerChannel } }] } };
        return { data: { items: [{ id: 'playlist-1', etag: 'playlist-etag', snippet: { title: 'Series', channelId: 'creator-channel' }, status: { privacyStatus: 'private' } }], nextPageToken: 'playlist-next' } };
      },
    },
    playlistItems: {
      list: async (request) => {
        requests.push({ resource: 'playlistItems', ...request });
        return { data: { items: [{ id: 'playlist-item-1', etag: 'item-etag', snippet: { playlistId: 'playlist-1', position: 0, title: 'Episode', channelId: 'creator-channel', resourceId: { videoId: 'owned-video' } } }], nextPageToken: 'item-next' } };
      },
    },
    captions: {
      list: async (request) => {
        requests.push({ resource: 'captions', ...request });
        return { data: { items: [{ id: 'caption-1', etag: 'caption-etag', snippet: { videoId: 'owned-video', language: 'en', name: 'English', trackKind: 'standard', status: 'serving', isDraft: false } }] } };
      },
    },
  };
}

function resources(requests: Record<string, unknown>[], playlistOwnerChannel?: string, authenticatedChannelId?: string) {
  return new ResourceService(
    { getAccessToken: async () => 'access-token' },
    new YouTubeClient(config(), { createAuthorizedApi: () => ownedApi(requests, playlistOwnerChannel, authenticatedChannelId), createPublicApi: () => ownedApi(requests, playlistOwnerChannel, authenticatedChannelId) }),
    { id: 'creator-a', purpose: 'creator', channelId: 'creator-channel' },
    () => new Date('2026-08-18T02:00:00.000Z'),
  );
}

describe('ResourceService', () => {
  it('rejects a video not owned by the selected creator profile', async () => {
    const resources = new ResourceService(
      { getAccessToken: async () => 'access-token' },
      new YouTubeClient(config(), { createAuthorizedApi: api, createPublicApi: api }),
      { id: 'creator-a', purpose: 'creator', channelId: 'creator-channel' },
    );

    await expect(resources.getOwnedVideo('other-channel-video')).rejects.toMatchObject({ code: 'ownership_required' });
  });

  it('lists owned videos through the authenticated uploads playlist with freshness and expiry', async () => {
    const requests: Record<string, unknown>[] = [];

    await expect(resources(requests).listOwnedVideos({ maxResults: 2, pageToken: 'previous-page' })).resolves.toEqual({
      items: [{
        id: 'owned-video', title: 'Episode', channelId: 'creator-channel', etag: 'item-etag',
      }],
      profile: { id: 'creator-a', purpose: 'creator', channelId: 'creator-channel' },
      fetchedAt: '2026-08-18T02:00:00.000Z',
      nextPageToken: 'item-next',
      expiresAt: '2026-08-18T02:15:00.000Z',
    });
    expect(requests).toContainEqual({ resource: 'channels', part: 'contentDetails', id: 'creator-channel' });
    expect(requests).toContainEqual({ resource: 'channels', part: 'id', mine: true });
    expect(requests).toContainEqual({ resource: 'playlistItems', part: ['snippet', 'contentDetails'], playlistId: 'uploads-playlist', maxResults: 2, pageToken: 'previous-page' });
  });

  it('lists categories by region without unsupported paging and reports expiry', async () => {
    const requests: Record<string, unknown>[] = [];
    const service = resources(requests);

    await expect(service.listVideoCategories({ regionCode: 'TH' })).resolves.toMatchObject({
      items: [{ id: '22', title: 'People & Blogs' }], profile: { channelId: 'creator-channel' }, fetchedAt: '2026-08-18T02:00:00.000Z', expiresAt: '2026-08-18T02:15:00.000Z',
    });
    expect(requests).toContainEqual({ resource: 'videoCategories', part: ['snippet'], regionCode: 'TH' });
  });

  it('lists creator playlists as fresh paged resources', async () => {
    const requests: Record<string, unknown>[] = [];
    const service = resources(requests);

    await expect(service.listPlaylists({ maxResults: 1, pageToken: 'playlist-page' })).resolves.toMatchObject({
      items: [{ id: 'playlist-1', title: 'Series', channelId: 'creator-channel', privacyStatus: 'private', etag: 'playlist-etag' }], nextPageToken: 'playlist-next', profile: { channelId: 'creator-channel' }, expiresAt: '2026-08-18T02:15:00.000Z',
    });
    expect(requests).toContainEqual({ resource: 'playlists', part: ['snippet', 'status'], mine: true, maxResults: 1, pageToken: 'playlist-page' });
  });

  it('reads one exact owned playlist for metadata reconciliation', async () => {
    const requests: Record<string, unknown>[] = [];
    const service = resources(requests);

    await expect(service.getPlaylist('playlist-1')).resolves.toMatchObject({
      item: { id: 'playlist-1', title: 'Series', channelId: 'creator-channel' },
      profile: { id: 'creator-a', channelId: 'creator-channel' },
      expiresAt: '2026-08-18T02:15:00.000Z',
    });
    expect(requests).toContainEqual({ resource: 'playlists', part: ['snippet', 'status'], id: ['playlist-1'] });
  });

  it('returns an absent owned playlist as a reconcilable null result', async () => {
    const requests: Record<string, unknown>[] = [];
    const client = ownedApi(requests);
    client.playlists.list = async (request) => {
      requests.push({ resource: 'playlists', ...request });
      return { data: { items: [] } };
    };
    const service = new ResourceService(
      { getAccessToken: async () => 'access-token' },
      new YouTubeClient(config(), { createAuthorizedApi: () => client, createPublicApi: () => client }),
      { id: 'creator-a', purpose: 'creator', channelId: 'creator-channel' },
      () => new Date('2026-08-18T02:00:00.000Z'),
    );

    await expect(service.getPlaylist('deleted-playlist')).resolves.toMatchObject({ item: null, profile: { channelId: 'creator-channel' } });
  });

  it('lists playlist items, moderation threads with replies, and caption tracks', async () => {
    const requests: Record<string, unknown>[] = [];
    const service = resources(requests);

    await expect(service.listPlaylistItems({ playlistId: 'playlist-1', maxResults: 1, pageToken: 'item-page' })).resolves.toMatchObject({
      items: [{ id: 'playlist-item-1', playlistId: 'playlist-1', videoId: 'owned-video', position: 0, etag: 'item-etag' }], nextPageToken: 'item-next', profile: { channelId: 'creator-channel' }, expiresAt: '2026-08-18T02:15:00.000Z',
    });
    await expect(service.listModerationComments({ moderationStatus: 'heldForReview', maxResults: 1, pageToken: 'comment-page' })).resolves.toMatchObject({
      items: [{ id: 'comment-1', commentId: 'comment-1', threadId: 'thread-1', moderationStatus: 'heldForReview', channelId: 'creator-channel', videoId: 'owned-video', replies: [{ id: 'reply-1', author: 'Creator', text: 'Thanks' }] }], nextPageToken: 'comment-next', profile: { channelId: 'creator-channel' }, expiresAt: '2026-08-18T02:15:00.000Z',
    });
    await expect(service.listCaptionTracks({ videoId: 'owned-video' })).resolves.toMatchObject({
      items: [{ id: 'caption-1', videoId: 'owned-video', language: 'en', status: 'serving', etag: 'caption-etag' }], profile: { channelId: 'creator-channel' }, fetchedAt: '2026-08-18T02:00:00.000Z', expiresAt: '2026-08-18T02:15:00.000Z',
    });
    expect(requests).toContainEqual({ resource: 'playlists', part: ['snippet', 'status'], id: ['playlist-1'] });
    expect(requests).toContainEqual({ resource: 'playlistItems', part: ['snippet'], playlistId: 'playlist-1', maxResults: 1, pageToken: 'item-page' });
    expect(requests).toContainEqual({ resource: 'commentThreads', part: 'snippet,replies', allThreadsRelatedToChannelId: 'creator-channel', moderationStatus: 'heldForReview', maxResults: 1, pageToken: 'comment-page', textFormat: 'plainText' });
    expect(requests).toContainEqual({ resource: 'captions', part: ['snippet'], videoId: 'owned-video' });
  });

  it('reads an immutable moderation comment and exhaustively finds an exact authored reply', async () => {
    const requests: Record<string, unknown>[] = [];
    const service = resources(requests);

    await expect(service.getModerationComment('comment-1')).resolves.toMatchObject({
      item: {
        id: 'comment-1', channelId: 'creator-channel', authorChannelId: 'viewer-channel', author: 'Viewer',
        text: 'Great work', moderationStatus: 'heldForReview', etag: 'comment-etag',
      },
      profile: { id: 'creator-a', channelId: 'creator-channel' },
    });
    await expect(service.findCommentReply({ parentId: 'comment-1', text: 'Thank you.' })).resolves.toMatchObject({
      parentId: 'comment-1', text: 'Thank you.', complete: true,
      matches: [{ id: 'reply-match', parentId: 'comment-1', authorChannelId: 'creator-channel', text: 'Thank you.' }],
    });
    expect(requests).toContainEqual({ resource: 'comments', part: ['snippet'], id: ['comment-1'], textFormat: 'plainText' });
    expect(requests).toContainEqual({ resource: 'comments', part: ['snippet'], parentId: 'comment-1', maxResults: 100, textFormat: 'plainText' });
    expect(requests).toContainEqual({ resource: 'comments', part: ['snippet'], parentId: 'comment-1', maxResults: 100, pageToken: 'reply-next', textFormat: 'plainText' });
  });

  it('rejects an unowned empty playlist before listing its items', async () => {
    const requests: Record<string, unknown>[] = [];

    await expect(resources(requests, 'other-channel').listPlaylistItems({ playlistId: 'playlist-1' })).rejects.toMatchObject({ code: 'ownership_required' });
    expect(requests.some((request) => request.resource === 'playlistItems')).toBe(false);
  });

  it('rejects an incomplete creator profile before requesting OAuth', async () => {
    const service = new ResourceService(
      { getAccessToken: async () => Promise.reject(new Error('OAuth must not be requested')) },
      new YouTubeClient(config(), { createAuthorizedApi: api, createPublicApi: api }),
      { id: 'creator-a', purpose: 'creator' },
    );

    await expect(service.listPlaylists()).rejects.toMatchObject({ code: 'channel_required' });
  });

  it('rejects every creator read when the authenticated channel differs from the selected channel', async () => {
    const requests: Record<string, unknown>[] = [];

    await expect(resources(requests, undefined, 'different-channel').listPlaylists()).rejects.toMatchObject({ code: 'ownership_required' });
    expect(requests).toEqual([{ resource: 'channels', part: 'id', mine: true }]);
  });
});
