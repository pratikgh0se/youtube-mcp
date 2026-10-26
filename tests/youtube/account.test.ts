import { describe, expect, it } from 'vitest';

import { AccountService } from '../../src/youtube/account.js';
import { YouTubeClient, type YouTubeDataApi } from '../../src/youtube/client.js';
import type { AppConfig } from '../../src/types.js';
import { testYouTubeApi } from '../helpers/youtube-api.js';

function config(): AppConfig {
  return {
    apiKey: 'test-api-key',
    stateDir: '/tmp/youtube-mcp-tests',
    diagnostics: () => 'safe diagnostics',
  };
}

function accountApi(commentThreadRequests?: Record<string, unknown>[]): YouTubeDataApi {
  return testYouTubeApi({
    videos: {
      list: async () => ({ data: { items: [] } }),
      rate: async () => ({ data: {} }),
    },
    channels: {
      list: async () => ({
        data: { items: [{ id: 'my-channel', snippet: { title: 'My channel', description: 'My videos' } }] },
      }),
    },
    commentThreads: {
      list: async (request) => {
        commentThreadRequests?.push(request);
        return {
          data: {
            items: [{
              id: 'comment-1',
              snippet: { topLevelComment: { snippet: { authorDisplayName: 'Somchai', textDisplay: 'Great video' } } },
            }],
          },
        };
      },
      insert: async () => ({
        data: {
          id: 'comment-2',
          snippet: { topLevelComment: { snippet: { authorDisplayName: 'Me', textDisplay: 'Thanks!' } } },
        },
      }),
    },
    subscriptions: {
      insert: async () => ({ data: { id: 'sub-1', snippet: { resourceId: { channelId: 'c1' } } } }),
      delete: async () => ({ data: {} }),
      list: async () => ({
        data: { items: [{ id: 'sub-1', snippet: { resourceId: { channelId: 'c1' }, title: 'Thai Food' } }] },
      }),
    },
  });
}

function service(): AccountService {
  return new AccountService(
    { getAccessToken: async () => 'access-token' },
    new YouTubeClient(config(), {
      createAuthorizedApi: () => accountApi(),
      createPublicApi: () => accountApi(),
    }),
  );
}

describe('AccountService', () => {
  it('creates a default authorized client with account operation methods', () => {
    const api = new YouTubeClient(config()).authorized('access-token');

    expect(api).toMatchObject({
      subscriptions: {
        insert: expect.any(Function),
        delete: expect.any(Function),
        list: expect.any(Function),
      },
      videos: { rate: expect.any(Function) },
      commentThreads: { insert: expect.any(Function) },
    });
  });

  it.each(['subscribe', 'unsubscribe', 'rateVideo', 'createComment'] as const)(
    '%s rejects without confirm before provider access',
    async (method) => {
      const account = new AccountService(
        { getAccessToken: async () => Promise.reject(new Error('OAuth provider must not be reached')) },
        new YouTubeClient(config(), {
          createAuthorizedApi: () => {
            throw new Error('YouTube provider must not be reached');
          },
          createPublicApi: () => accountApi(),
        }),
      );

      await expect(account[method]({ channelId: 'c1' } as never)).rejects.toMatchObject({
        code: 'confirmation_required',
        retryable: false,
      });
    },
  );

  it('returns normalized outcomes for confirmed account mutations', async () => {
    const account = service();

    await expect(account.subscribe({ channelId: 'c1', confirm: true })).resolves.toEqual({
      subscriptionId: 'sub-1',
      channelId: 'c1',
    });
    await expect(account.unsubscribe({ subscriptionId: 'sub-1', confirm: true })).resolves.toEqual({
      subscriptionId: 'sub-1',
      unsubscribed: true,
    });
    await expect(account.rateVideo({ videoId: 'video-1', rating: 'like', confirm: true })).resolves.toEqual({
      videoId: 'video-1',
      rating: 'like',
    });
    await expect(account.createComment({ videoId: 'video-1', text: 'Thanks!', confirm: true })).resolves.toEqual({
      id: 'comment-2',
      author: 'Me',
      text: 'Thanks!',
    });
  });

  it('marks a dispatched account mutation as unknown instead of inviting a retry', async () => {
    const provider = accountApi();
    let firstAttempt = true;
    provider.videos.rate = async () => {
      if (firstAttempt) {
        firstAttempt = false;
        throw new Error('provider failure');
      }
      return { data: {} };
    };
    const account = new AccountService(
      { getAccessToken: async () => 'access-token' },
      new YouTubeClient(config(), {
        createAuthorizedApi: () => provider,
        createPublicApi: () => accountApi(),
      }),
    );

    await expect(account.rateVideo({ videoId: 'video-1', rating: 'like', confirm: true })).rejects.toMatchObject({
      code: 'provider_outcome_unknown',
      retryable: false,
    });
  });

  it('returns threads associated with the authenticated channel without claiming their authorship', async () => {
    const commentThreadRequests: Record<string, unknown>[] = [];
    const api = accountApi(commentThreadRequests);
    const account = new AccountService(
      { getAccessToken: async () => 'access-token' },
      new YouTubeClient(config(), {
        createAuthorizedApi: () => api,
        createPublicApi: () => accountApi(),
      }),
    );

    await expect(account.listSubscriptions()).resolves.toEqual([
      { subscriptionId: 'sub-1', channelId: 'c1', title: 'Thai Food' },
    ]);
    await expect(account.myAccount()).resolves.toEqual({
      id: 'my-channel',
      title: 'My channel',
      description: 'My videos',
    });
    await expect(account.listChannelCommentThreads()).resolves.toEqual([
      { id: 'comment-1', author: 'Somchai', text: 'Great video' },
    ]);
    expect(commentThreadRequests).toEqual([{
      part: 'snippet',
      allThreadsRelatedToChannelId: 'my-channel',
      maxResults: undefined,
      textFormat: 'plainText',
    }]);
  });
});
