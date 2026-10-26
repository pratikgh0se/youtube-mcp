import { describe, expect, it } from 'vitest';

import { YouTubeClient, type YouTubeDataApi } from '../../src/youtube/client.js';
import { PublicService } from '../../src/youtube/public.js';
import type { AppConfig } from '../../src/types.js';
import { testYouTubeApi } from '../helpers/youtube-api.js';

function config(): AppConfig {
  return {
    apiKey: 'test-api-key',
    stateDir: '/tmp/youtube-mcp-tests',
    diagnostics: () => 'safe diagnostics',
  };
}

function api(overrides: Partial<YouTubeDataApi> = {}): YouTubeDataApi {
  return testYouTubeApi(overrides);
}

describe('PublicService', () => {
  it('returns compact search summaries and records quota context', async () => {
    const requests: Record<string, unknown>[] = [];
    const service = new PublicService(
      new YouTubeClient(config(), {
        createAuthorizedApi: () => api(),
        createPublicApi: () =>
          api({
            search: {
              list: async (request) => {
                requests.push(request);
                return {
                  data: {
                    items: [
                      {
                        id: { videoId: 'abc' },
                        snippet: {
                          title: 'Pad Thai',
                          channelId: 'channel-1',
                          description: 'Detailed account-secret must not leak',
                          publishedAt: '2026-08-17T00:00:00Z',
                        },
                      },
                    ],
                  },
                };
              },
            },
          }),
      }),
      { fetchTranscript: async () => [] },
    );

    await expect(service.search({ query: 'thai food', maxResults: 2 })).resolves.toEqual({
      items: [
        {
          id: 'abc',
          title: 'Pad Thai',
          channelId: 'channel-1',
          description: 'Detailed account-secret must not leak',
          publishedAt: '2026-08-17T00:00:00Z',
        },
      ],
      context: { quotaUnits: 100, source: 'youtube_data_api' },
    });
    expect(requests).toEqual([{
      part: 'snippet',
      fields: 'items(id/videoId,snippet(title,channelId,description,publishedAt))',
      q: 'thai food',
      maxResults: 2,
      type: 'video',
    }]);
  });

  it('labels an unavailable transcript as best-effort instead of failing public metadata', async () => {
    const service = new PublicService(
      new YouTubeClient(config(), {
        createAuthorizedApi: () => api(),
        createPublicApi: () => api(),
      }),
      { fetchTranscript: async () => Promise.reject(new Error('provider account-secret')) },
    );

    await expect(service.getTranscript({ videoId: 'abc' })).resolves.toEqual({
      available: false,
      source: 'best_effort',
    });
  });

  it('returns a compact video record with video quota context', async () => {
    const requests: Record<string, unknown>[] = [];
    const service = new PublicService(
      new YouTubeClient(config(), {
        createAuthorizedApi: () => api(),
        createPublicApi: () =>
          api({
            videos: {
              list: async (request) => {
                requests.push(request);
                return { data: { items: [{ id: 'abc', snippet: { title: 'Pad Thai', channelId: 'channel-1' } }] } };
              },
            },
          }),
      }),
      { fetchTranscript: async () => [] },
    );

    await expect(service.getVideo({ videoId: 'abc' })).resolves.toEqual({
      items: [{ id: 'abc', title: 'Pad Thai', channelId: 'channel-1' }],
      context: { quotaUnits: 1, source: 'youtube_data_api' },
    });
    expect(requests).toEqual([{
      part: 'snippet',
      fields: 'items(id,snippet(title,channelId,description,publishedAt))',
      id: 'abc',
    }]);
  });

  it('returns a compact channel record with channel quota context', async () => {
    const requests: Record<string, unknown>[] = [];
    const service = new PublicService(
      new YouTubeClient(config(), {
        createAuthorizedApi: () => api(),
        createPublicApi: () =>
          api({
            channels: {
              list: async (request) => {
                requests.push(request);
                return { data: { items: [{ id: 'channel-1', snippet: { title: 'Thai Food Channel', description: 'Recipes' } }] } };
              },
            },
          }),
      }),
      { fetchTranscript: async () => [] },
    );

    await expect(service.getChannel({ channelId: 'channel-1' })).resolves.toEqual({
      items: [{ id: 'channel-1', title: 'Thai Food Channel', description: 'Recipes' }],
      context: { quotaUnits: 1, source: 'youtube_data_api' },
    });
    expect(requests).toEqual([{
      part: 'snippet',
      fields: 'items(id,snippet(title,description))',
      id: 'channel-1',
    }]);
  });

  it('returns compact top-level comments with comment quota context', async () => {
    const requests: Record<string, unknown>[] = [];
    const service = new PublicService(
      new YouTubeClient(config(), {
        createAuthorizedApi: () => api(),
        createPublicApi: () =>
          api({
            commentThreads: {
              list: async (request) => {
                requests.push(request);
                return {
                  data: {
                    items: [
                      {
                        id: 'comment-1',
                        snippet: {
                          topLevelComment: {
                            snippet: { authorDisplayName: 'Somchai', textDisplay: 'Looks delicious' },
                          },
                        },
                      },
                    ],
                  },
                };
              },
            },
          }),
      }),
      { fetchTranscript: async () => [] },
    );

    await expect(service.getComments({ videoId: 'abc', maxResults: 1 })).resolves.toEqual({
      items: [{ id: 'comment-1', author: 'Somchai', text: 'Looks delicious' }],
      context: { quotaUnits: 1, source: 'youtube_data_api' },
    });
    expect(requests).toEqual([{
      part: 'snippet',
      fields: 'items(id,snippet/topLevelComment/snippet(authorDisplayName,textDisplay,publishedAt))',
      videoId: 'abc',
      maxResults: 1,
      textFormat: 'plainText',
    }]);
  });

  it('returns a safe quota error when the Google boundary reports quota exhaustion', async () => {
    const service = new PublicService(
      new YouTubeClient(config(), {
        createAuthorizedApi: () => api(),
        createPublicApi: () =>
          api({
            search: {
              list: async () => Promise.reject({ response: { data: { error: { code: 403, errors: [{ reason: 'quotaExceeded' }] } } } }),
            },
          }),
      }),
      { fetchTranscript: async () => [] },
    );

    await expect(service.search({ query: 'thai food' })).rejects.toMatchObject({
      code: 'quota_exhausted',
      retryable: false,
    });
  });
});
