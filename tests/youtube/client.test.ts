import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createGoogleClientDependencies,
  YouTubeClient,
  type GoogleApiFactory,
  type YouTubeAnalyticsApi,
  type YouTubeDataApi,
} from '../../src/youtube/client.js';
import type { AppConfig } from '../../src/types.js';
import { testYouTubeApi } from '../helpers/youtube-api.js';

function config(): AppConfig {
  return {
    stateDir: '/tmp/youtube-mcp-tests',
    diagnostics: () => 'safe diagnostics',
  };
}

function dataApi(): YouTubeDataApi {
  return testYouTubeApi();
}

function analyticsApi(): YouTubeAnalyticsApi {
  return { reports: { query: async () => ({ data: {} }) } };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('YouTubeClient Google dependencies', () => {
  it('constructs both authorized Google clients with OAuth credentials, not an API-key string', () => {
    const credentials: Array<{ access_token: string }> = [];
    const dataAuths: unknown[] = [];
    const analyticsAuths: unknown[] = [];
    const factory: GoogleApiFactory = {
      createOAuthClient: () => ({ setCredentials: (value) => credentials.push(value) }),
      createDataApi: (auth) => {
        dataAuths.push(auth);
        return dataApi();
      },
      createAnalyticsApi: (auth) => {
        analyticsAuths.push(auth);
        return analyticsApi();
      },
    };
    const client = new YouTubeClient(config(), createGoogleClientDependencies(factory));

    client.authorized('access-token');
    client.analytics('access-token');

    expect(credentials).toEqual([{ access_token: 'access-token' }, { access_token: 'access-token' }]);
    expect(dataAuths[0]).toEqual({ setCredentials: expect.any(Function) });
    expect(analyticsAuths[0]).toEqual({ setCredentials: expect.any(Function) });
  });

  it('exposes every optional method the providers depend on on the real authorized adapter', () => {
    const api = new YouTubeClient(config()).authorized('access-token');

    expect(api).toMatchObject({
      channels: { list: expect.any(Function), update: expect.any(Function) },
      commentThreads: { insert: expect.any(Function) },
      subscriptions: { insert: expect.any(Function), delete: expect.any(Function), list: expect.any(Function) },
      videos: { rate: expect.any(Function), update: expect.any(Function) },
    });
  });

  it('keeps public API-key construction separate from OAuth construction', () => {
    const dataAuths: unknown[] = [];
    const factory: GoogleApiFactory = {
      createOAuthClient: () => ({ setCredentials: () => undefined }),
      createDataApi: (auth) => {
        dataAuths.push(auth);
        return dataApi();
      },
      createAnalyticsApi: () => analyticsApi(),
    };
    const client = new YouTubeClient({ ...config(), apiKey: 'public-api-key' }, createGoogleClientDependencies(factory));

    client.public();

    expect(dataAuths).toEqual(['public-api-key']);
  });

  it('exposes a narrowly typed resumable adapter for an authorized upload session', async () => {
    const client = new YouTubeClient(config(), {
      createPublicApi: dataApi,
      createAuthorizedApi: dataApi,
      createResumableUpload: (accessToken) => ({
        initialize: async () => ({ status: accessToken === 'access-token' ? 200 : 401, sessionUrl: 'https://upload.youtube.test/session-1' }),
        probe: async () => ({ status: 308, offset: 0 }),
        uploadChunk: async () => ({ status: 200, videoId: 'video-1' }),
        cancel: async () => ({ status: 204 }),
      }),
    });

    await expect(client.resumableUpload('access-token').initialize({
      title: 'Private video', privacyStatus: 'private', fileSize: 1, mimeType: 'video/mp4',
    })).resolves.toEqual({ status: 200, sessionUrl: 'https://upload.youtube.test/session-1' });
  });

  it('treats a headerless 308 probe as an empty resumable session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 308 })));
    const client = new YouTubeClient(config(), { createPublicApi: dataApi, createAuthorizedApi: dataApi });

    await expect(client.resumableUpload('access-token').probe('https://upload.youtube.com/session-1', 100))
      .resolves.toEqual({ status: 308, offset: 0 });
  });
});
