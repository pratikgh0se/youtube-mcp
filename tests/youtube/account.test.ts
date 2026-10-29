import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/errors.js';
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

function ownedVideos(owned = ['video-1']): { getOwnedVideo: (videoId: string) => Promise<never> } {
  return {
    getOwnedVideo: async (videoId: string) => {
      if (!owned.includes(videoId)) throw new AppError('ownership_required', 'not owned', 'use an owned resource', false);
      return {} as never;
    },
  };
}

function service(): AccountService {
  return new AccountService(
    { getAccessToken: async () => 'access-token' },
    new YouTubeClient(config(), {
      createAuthorizedApi: () => accountApi(),
      createPublicApi: () => accountApi(),
    }),
    ownedVideos(),
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
        ownedVideos(),
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

  it('refuses to create a comment on a video the selected channel does not own, before any write', async () => {
    const account = new AccountService(
      { getAccessToken: async () => 'access-token' },
      new YouTubeClient(config(), {
        createAuthorizedApi: () => { throw new Error('YouTube provider must not be reached'); },
        createPublicApi: () => accountApi(),
      }),
      ownedVideos(['video-1']),
    );

    await expect(account.createComment({ videoId: 'someone-elses-video', text: 'Nice!', confirm: true })).rejects.toMatchObject({
      code: 'ownership_required',
      retryable: false,
      action: expect.stringContaining('Replies on your own videos are supported'),
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
      ownedVideos(),
    );

    await expect(account.rateVideo({ videoId: 'video-1', rating: 'like', confirm: true })).rejects.toMatchObject({
      code: 'provider_outcome_unknown',
      retryable: false,
    });
  });

  function failingAccount(mutateApi: (api: YouTubeDataApi) => void): AccountService {
    const provider = accountApi();
    mutateApi(provider);
    return new AccountService(
      { getAccessToken: async () => 'access-token' },
      new YouTubeClient(config(), { createAuthorizedApi: () => provider, createPublicApi: () => accountApi() }),
      ownedVideos(),
    );
  }

  it.each([
    [{ code: 403, errors: [{ reason: 'forbidden' }] }, 403, 'forbidden'],
    [{ response: { status: 404, data: { error: { errors: [{ reason: 'subscriptionNotFound' }] } } } }, 404, 'subscriptionNotFound'],
  ])('surfaces a clean 4xx rejection with status and reason, not provider_outcome_unknown', async (failure, status, reason) => {
    const account = failingAccount((api) => {
      api.videos.rate = async () => { throw failure; };
      api.subscriptions!.insert = async () => { throw failure; };
      api.subscriptions!.delete = async () => { throw failure; };
      api.commentThreads.insert = async () => { throw failure; };
    });
    const expected = { code: 'provider_error', status, reason };
    await expect(account.rateVideo({ videoId: 'video-1', rating: 'like', confirm: true })).rejects.toMatchObject(expected);
    await expect(account.subscribe({ channelId: 'c1', confirm: true })).rejects.toMatchObject(expected);
    await expect(account.unsubscribe({ subscriptionId: 'sub-1', confirm: true })).rejects.toMatchObject(expected);
    await expect(account.createComment({ videoId: 'video-1', text: 'Hi', confirm: true })).rejects.toMatchObject(expected);
  });

  it.each([
    ['a 503', { code: 503, errors: [{ reason: 'backendError' }] }],
    ['a network error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
  ])('keeps %s as provider_outcome_unknown', async (_name, failure) => {
    const account = failingAccount((api) => { api.videos.rate = async () => { throw failure; }; });
    await expect(account.rateVideo({ videoId: 'video-1', rating: 'like', confirm: true })).rejects.toMatchObject({ code: 'provider_outcome_unknown' });
  });

  it('keeps an invalid response after a successful insert as provider_outcome_unknown', async () => {
    const account = failingAccount((api) => { api.commentThreads.insert = async () => ({ data: {} }); });
    await expect(account.createComment({ videoId: 'video-1', text: 'Hi', confirm: true })).rejects.toMatchObject({ code: 'provider_outcome_unknown' });
  });

  it('accepts an inserted comment whose textDisplay is empty by falling back to textOriginal', async () => {
    const account = failingAccount((api) => {
      api.commentThreads.insert = async () => ({ data: { id: 'comment-3', snippet: { topLevelComment: { snippet: { authorDisplayName: 'Me', textDisplay: '', textOriginal: 'Held for review' } } } } });
    });
    await expect(account.createComment({ videoId: 'video-1', text: 'Held for review', confirm: true })).resolves.toEqual({ id: 'comment-3', author: 'Me', text: 'Held for review' });
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
      ownedVideos(),
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
