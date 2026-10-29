import { describe, expect, it } from 'vitest';

import { PublicService } from '../../src/youtube/public.js';
import { YouTubeClient, type YouTubeDataApi } from '../../src/youtube/client.js';
import { searchSchema, trendingSchema, listChannelVideosSchema } from '../../src/mcp/schemas.js';
import { testYouTubeApi } from '../helpers/youtube-api.js';

function service(api: YouTubeDataApi) {
  return new PublicService(
    new YouTubeClient({ apiKey: 'k', stateDir: '/tmp/x', diagnostics: () => '' }, { createPublicApi: () => api, createAuthorizedApi: () => api }),
    { fetchTranscript: async () => [] },
  );
}

describe('search filters', () => {
  it('validates the new optional filters', () => {
    expect(searchSchema.safeParse({ query: 'q' }).success).toBe(true);
    expect(searchSchema.safeParse({ query: 'q', order: 'viewCount', videoDuration: 'long', safeSearch: 'strict', publishedAfter: '2026-01-01T00:00:00Z', regionCode: 'US', relevanceLanguage: 'en', channelId: 'UC1', pageToken: 'p' }).success).toBe(true);
    expect(searchSchema.safeParse({ query: 'q', order: 'popular' }).success).toBe(false);
    expect(searchSchema.safeParse({ query: 'q', publishedAfter: 'yesterday' }).success).toBe(false);
    expect(searchSchema.safeParse({ query: 'q', videoDuration: 'epic' }).success).toBe(false);
    expect(searchSchema.safeParse({ query: 'q', regionCode: 'USA' }).success).toBe(false);
  });

  it('forwards only the provided filters and returns nextPageToken', async () => {
    const requests: Record<string, unknown>[] = [];
    const result = await service(testYouTubeApi({ search: { list: async (request) => {
      requests.push(request);
      return { data: { items: [{ id: { videoId: 'v1' }, snippet: { title: 'T', channelId: 'c1' } }], nextPageToken: 'next' } };
    } } })).search({ query: 'cats', order: 'date', publishedAfter: '2026-01-01T00:00:00Z', videoDuration: 'short', channelId: 'c1', regionCode: 'us', relevanceLanguage: 'en', safeSearch: 'strict', pageToken: 'p1' });
    expect(requests[0]).toMatchObject({ q: 'cats', type: 'video', order: 'date', publishedAfter: '2026-01-01T00:00:00Z', videoDuration: 'short', channelId: 'c1', regionCode: 'US', relevanceLanguage: 'en', safeSearch: 'strict', pageToken: 'p1' });
    expect(requests[0]).not.toHaveProperty('publishedBefore');
    expect(result).toMatchObject({ nextPageToken: 'next', context: { quotaUnits: 100 } });
  });

  it('omits nextPageToken and unset filters for a plain query (backwards compatible)', async () => {
    const requests: Record<string, unknown>[] = [];
    const result = await service(testYouTubeApi({ search: { list: async (request) => { requests.push(request); return { data: { items: [] } }; } } })).search({ query: 'x' });
    expect(Object.keys(requests[0]!).sort()).toEqual(['fields', 'maxResults', 'part', 'q', 'type']);
    expect(result).not.toHaveProperty('nextPageToken');
  });
});

describe('youtube_trending', () => {
  it('defaults to US, calls chart=mostPopular and normalizes statistics to numbers', async () => {
    const requests: Record<string, unknown>[] = [];
    const result = await service(testYouTubeApi({ videos: { list: async (request) => {
      requests.push(request);
      return { data: { nextPageToken: 'n', items: [{
        id: 'v1', snippet: { title: 'Hot', channelId: 'c1', channelTitle: 'Chan', publishedAt: '2026-10-01T00:00:00Z' },
        statistics: { viewCount: '1000', likeCount: '10', commentCount: '2' }, contentDetails: { duration: 'PT5M' },
      }] } };
    } } })).trending({ videoCategoryId: '10', maxResults: 5, pageToken: 'p' });
    expect(requests).toEqual([{ part: 'snippet,statistics,contentDetails', chart: 'mostPopular', regionCode: 'US', maxResults: 5, videoCategoryId: '10', pageToken: 'p' }]);
    expect(result).toEqual({
      items: [{ id: 'v1', title: 'Hot', channelId: 'c1', channelTitle: 'Chan', publishedAt: '2026-10-01T00:00:00Z', viewCount: 1000, likeCount: 10, commentCount: 2, duration: 'PT5M' }],
      context: { quotaUnits: 1, source: 'youtube_data_api' }, nextPageToken: 'n',
    });
  });

  it('validates region and category input', () => {
    expect(trendingSchema.safeParse({ regionCode: 'GB', videoCategoryId: '24', maxResults: 50 }).success).toBe(true);
    expect(trendingSchema.safeParse({ regionCode: 'GBR' }).success).toBe(false);
    expect(trendingSchema.safeParse({ videoCategoryId: 'music' }).success).toBe(false);
    expect(trendingSchema.safeParse({ maxResults: 51 }).success).toBe(false);
  });
});

describe('youtube_list_channel_videos', () => {
  function api(requests: Record<string, Record<string, unknown>[]>) {
    return testYouTubeApi({
      channels: { list: async (request) => {
        (requests.channels ??= []).push(request);
        return { data: { items: [{ id: 'UC1', contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] } };
      } },
      playlistItems: { list: async (request) => {
        (requests.items ??= []).push(request as Record<string, unknown>);
        return { data: { nextPageToken: 'more', items: [{ contentDetails: { videoId: 'v2' } }, { contentDetails: { videoId: 'v1' } }, { contentDetails: { videoId: 'private' } }] } };
      } },
      videos: { list: async (request) => {
        (requests.videos ??= []).push(request);
        return { data: { items: [
          { id: 'v1', snippet: { title: 'One', channelId: 'UC1' }, statistics: { viewCount: '5' }, contentDetails: { duration: 'PT1M' } },
          { id: 'v2', snippet: { title: 'Two', channelId: 'UC1' }, statistics: { viewCount: '9', likeCount: '1' }, contentDetails: { duration: 'PT2M' } },
        ] } };
      } },
    });
  }

  it('resolves an @handle via forHandle, reads the uploads playlist and batches statistics in playlist order', async () => {
    const requests: Record<string, Record<string, unknown>[]> = {};
    const result = await service(api(requests)).listChannelVideos({ channelId: '@YouTube', maxResults: 3, pageToken: 'p' });
    expect(requests.channels).toEqual([{ part: 'contentDetails', forHandle: '@YouTube' }]);
    expect(requests.items).toEqual([{ part: ['contentDetails'], playlistId: 'UU1', maxResults: 3, pageToken: 'p' }]);
    expect(requests.videos).toEqual([{ part: 'snippet,statistics,contentDetails', id: 'v2,v1,private' }]);
    expect(result.items.map((video) => video.id)).toEqual(['v2', 'v1']);
    expect(result).toMatchObject({ channelId: 'UC1', uploadsPlaylistId: 'UU1', nextPageToken: 'more', context: { quotaUnits: 3 } });
  });

  it('looks up a plain channel ID with id= and fails with not_found for an unknown channel', async () => {
    const requests: Record<string, Record<string, unknown>[]> = {};
    await service(api(requests)).listChannelVideos({ channelId: 'UC1' });
    expect(requests.channels).toEqual([{ part: 'contentDetails', id: 'UC1' }]);
    await expect(service(testYouTubeApi()).listChannelVideos({ channelId: '@nobody' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('caps maxResults at 50 in the schema', () => {
    expect(listChannelVideosSchema.safeParse({ channelId: '@YouTube', maxResults: 50 }).success).toBe(true);
    expect(listChannelVideosSchema.safeParse({ channelId: '@YouTube', maxResults: 51 }).success).toBe(false);
    expect(listChannelVideosSchema.safeParse({ channelId: '' }).success).toBe(false);
  });
});
