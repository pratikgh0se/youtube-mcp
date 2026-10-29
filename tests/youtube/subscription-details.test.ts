import { describe, expect, it } from 'vitest';

import { AccountService } from '../../src/youtube/account.js';
import { YouTubeClient, type YouTubeDataApi } from '../../src/youtube/client.js';
import { listSubscriptionsSchema } from '../../src/mcp/schemas.js';
import { testYouTubeApi } from '../helpers/youtube-api.js';

function account(api: YouTubeDataApi) {
  return new AccountService(
    { getAccessToken: async () => 't' },
    new YouTubeClient({ stateDir: '/tmp/x', diagnostics: () => '' }, { createPublicApi: () => api, createAuthorizedApi: () => api }),
    { getOwnedVideo: async () => ({}) as never },
  );
}

function api(log: Array<[string, Record<string, unknown>]>, overrides: { playlistItems?: YouTubeDataApi['playlistItems'] } = {}) {
  return testYouTubeApi({
    videos: { list: async () => ({ data: { items: [] } }), rate: async () => ({ data: {} }) },
    commentThreads: { list: async () => ({ data: { items: [] } }), insert: async () => ({ data: {} }) },
    subscriptions: {
      insert: async () => ({ data: {} }), delete: async () => ({ data: {} }),
      list: async (request) => {
        log.push(['subscriptions', request]);
        return { data: { nextPageToken: 'next', items: [
          { id: 's1', snippet: { title: 'One', resourceId: { channelId: 'c1' } } },
          { id: 's2', snippet: { title: 'Two', resourceId: { channelId: 'c2' } } },
        ] } };
      },
    },
    channels: { list: async (request) => {
      log.push(['channels', request]);
      return { data: { items: [
        { id: 'c1', statistics: { subscriberCount: '1200', videoCount: '40' }, contentDetails: { relatedPlaylists: { uploads: 'u1' } } },
        { id: 'c2', statistics: { hiddenSubscriberCount: true, videoCount: '0' }, contentDetails: { relatedPlaylists: { uploads: 'u2' } } },
      ] } };
    } },
    playlistItems: overrides.playlistItems ?? { list: async (request) => {
      log.push(['playlistItems', request as Record<string, unknown>]);
      if (request.playlistId === 'u2') throw Object.assign(new Error('nf'), { status: 404 });
      return { data: { items: [{ contentDetails: { videoId: 'v', videoPublishedAt: '2026-10-01T00:00:00Z' } }] } };
    } },
  });
}

describe('youtube_list_subscriptions details', () => {
  it('keeps the legacy list contract and schema', async () => {
    expect(listSubscriptionsSchema.safeParse({ maxResults: 5 }).success).toBe(true);
    expect(listSubscriptionsSchema.safeParse({}).success).toBe(true);
    const log: Array<[string, Record<string, unknown>]> = [];
    await expect(account(api(log)).listSubscriptions(2)).resolves.toEqual([
      { subscriptionId: 's1', channelId: 'c1', title: 'One' }, { subscriptionId: 's2', channelId: 'c2', title: 'Two' },
    ]);
  });

  it('without details makes one call and paginates', async () => {
    const log: Array<[string, Record<string, unknown>]> = [];
    const page = await account(api(log)).listSubscriptionsPage({ maxResults: 2, pageToken: 'p' });
    expect(log).toEqual([['subscriptions', { part: 'snippet', mine: true, maxResults: 2, pageToken: 'p' }]]);
    expect(page).toMatchObject({ nextPageToken: 'next', context: { quotaUnits: 1 } });
    expect(page.items[0]).toEqual({ subscriptionId: 's1', channelId: 'c1', title: 'One' });
  });

  it('with details batches channels.list, reads each uploads playlist and counts quota', async () => {
    const log: Array<[string, Record<string, unknown>]> = [];
    const page = await account(api(log)).listSubscriptionsPage({ details: true });
    expect(log.map(([name]) => name)).toEqual(['subscriptions', 'channels', 'playlistItems', 'playlistItems']);
    expect(log[1]![1]).toMatchObject({ part: 'statistics,contentDetails', id: 'c1,c2' });
    expect(log[2]![1]).toMatchObject({ playlistId: 'u1', maxResults: 1 });
    expect(page.items).toEqual([
      { subscriptionId: 's1', channelId: 'c1', title: 'One', subscriberCount: 1200, videoCount: 40, lastUploadAt: '2026-10-01T00:00:00Z' },
      { subscriptionId: 's2', channelId: 'c2', title: 'Two', subscriberCountHidden: true, videoCount: 0 },
    ]);
    expect(page.context.quotaUnits).toBe(1 + 1 + 2);
  });

  it('surfaces quota exhaustion instead of silently dropping details', async () => {
    const quota = Object.assign(new Error('quota'), { code: 403, errors: [{ reason: 'quotaExceeded' }] });
    const log: Array<[string, Record<string, unknown>]> = [];
    await expect(account(api(log, { playlistItems: { list: async () => { throw quota; } } })).listSubscriptionsPage({ details: true }))
      .rejects.toMatchObject({ code: 'quota_exhausted' });
  });
});
