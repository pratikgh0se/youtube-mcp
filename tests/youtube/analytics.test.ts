import { describe, expect, it } from 'vitest';

import { CreatorAnalyticsService } from '../../src/youtube/analytics.js';
import { YouTubeClient, type YouTubeAnalyticsApi, type YouTubeDataApi } from '../../src/youtube/client.js';
import type { AppConfig } from '../../src/types.js';
import { testYouTubeApi } from '../helpers/youtube-api.js';

const range = { startDate: '2026-01-01', endDate: '2026-01-31' };

function config(): AppConfig {
  return {
    apiKey: 'test-api-key',
    stateDir: '/tmp/youtube-mcp-tests',
    diagnostics: () => 'safe diagnostics',
  };
}

function dataApi(): YouTubeDataApi {
  return testYouTubeApi();
}

function analyticsApi(requests: Record<string, unknown>[]): YouTubeAnalyticsApi {
  return {
    reports: {
      query: async (request) => {
        requests.push(request);
        if (request.ids !== 'channel==MINE') {
          return { data: {} };
        }
        if (request.dimensions === 'video') {
          return {
            data: {
              columnHeaders: [
                { name: 'video' }, { name: 'views' }, { name: 'estimatedMinutesWatched' },
                { name: 'averageViewDuration' }, { name: 'likes' }, { name: 'comments' },
              ],
              rows: [['video-1', 42, 120, 30.5, 3, 2]],
            },
          };
        }
        if (request.dimensions === 'elapsedVideoTimeRatio') {
          return {
            data: {
              columnHeaders: [
                { name: 'elapsedVideoTimeRatio' }, { name: 'audienceWatchRatio' }, { name: 'relativeRetentionPerformance' },
              ],
              rows: [[0.5, 0.8, 0.9]],
            },
          };
        }
        return {
          data: {
            columnHeaders: [
              { name: 'views' }, { name: 'estimatedMinutesWatched' }, { name: 'averageViewDuration' },
              { name: 'likes' }, { name: 'comments' }, { name: 'subscribersGained' }, { name: 'subscribersLost' },
            ],
            rows: [[42, 120, 30.5, 3, 2, 10, 1]],
          },
        };
      },
    },
  };
}

function service(requests: Record<string, unknown>[]): CreatorAnalyticsService {
  return new CreatorAnalyticsService(
    { getAccessToken: async () => 'access-token' },
    new YouTubeClient(config(), {
      createPublicApi: dataApi,
      createAuthorizedApi: dataApi,
      createAuthorizedAnalyticsApi: () => analyticsApi(requests),
    }),
  );
}

describe('CreatorAnalyticsService', () => {
  it('uses channel==MINE and returns views, watch time, and average duration', async () => {
    const requests: Record<string, unknown>[] = [];

    await expect(service(requests).overview(range)).resolves.toEqual({
      views: 42,
      estimatedMinutesWatched: 120,
      averageViewDuration: 30.5,
      likes: 3,
      comments: 2,
      subscribersGained: 10,
      subscribersLost: 1,
    });
    expect(requests).toEqual([{
      ids: 'channel==MINE',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      metrics: 'views,estimatedMinutesWatched,averageViewDuration,likes,comments,subscribersGained,subscribersLost',
    }]);
  });

  it('returns top videos from an owner-scoped report without accepting a channel id', async () => {
    const requests: Record<string, unknown>[] = [];

    await expect(service(requests).topVideos(range, 5)).resolves.toEqual([{
      videoId: 'video-1',
      views: 42,
      estimatedMinutesWatched: 120,
      averageViewDuration: 30.5,
      likes: 3,
      comments: 2,
    }]);
    expect(requests).toEqual([{
      ids: 'channel==MINE',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      dimensions: 'video',
      metrics: 'views,estimatedMinutesWatched,averageViewDuration,likes,comments',
      sort: '-views',
      maxResults: 5,
    }]);
  });

  it('returns owner-scoped video retention points', async () => {
    const requests: Record<string, unknown>[] = [];

    await expect(service(requests).retention('video-1')).resolves.toEqual([{
      elapsedVideoTimeRatio: 0.5,
      audienceWatchRatio: 0.8,
      relativeRetentionPerformance: 0.9,
    }]);
    expect(requests[0]).toMatchObject({
      ids: 'channel==MINE',
      dimensions: 'elapsedVideoTimeRatio',
      filters: 'video==video-1',
      metrics: 'audienceWatchRatio,relativeRetentionPerformance',
    });
  });
});
