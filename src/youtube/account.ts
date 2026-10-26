import { confirmationRequiredError, AppError, toSafeError } from '../errors.js';
import type { OAuthCapability, OAuthService } from '../auth/oauth.js';
import type {
  ChannelSummary,
  CommentSummary,
  CreateCommentInput,
  MutationInput,
  RateVideoInput,
  SubscribeInput,
  SubscriptionResult,
  SubscriptionSummary,
  UnsubscribeInput,
  UnsubscribeResult,
  VideoRatingResult,
} from '../types.js';
import { YouTubeClient, type YouTubeDataApi } from './client.js';

type AccountYouTubeApi = YouTubeDataApi & {
  subscriptions: NonNullable<YouTubeDataApi['subscriptions']>;
  videos: YouTubeDataApi['videos'] & {
    rate: NonNullable<YouTubeDataApi['videos']['rate']>;
  };
  commentThreads: YouTubeDataApi['commentThreads'] & {
    insert: NonNullable<YouTubeDataApi['commentThreads']['insert']>;
  };
};

export function requireConfirmation(input: MutationInput): asserts input is MutationInput & { confirm: true } {
  if (input.confirm !== true) {
    throw confirmationRequiredError();
  }
}

export class AccountService {
  constructor(
    private readonly oauth: Pick<OAuthService, 'getAccessToken'>,
    private readonly client: YouTubeClient,
  ) {}

  async subscribe(input: SubscribeInput): Promise<SubscriptionResult> {
    return this.mutate(input, async (api) => {
        const response = await api.subscriptions.insert({
          part: 'snippet',
          requestBody: { snippet: { resourceId: { kind: 'youtube#channel', channelId: input.channelId } } },
        });
        const subscription = normalizeSubscription(response.data)[0];
        if (!subscription) {
          throw invalidProviderResponse('subscription');
        }
        return { subscriptionId: subscription.subscriptionId, channelId: subscription.channelId };
    });
  }

  async unsubscribe(input: UnsubscribeInput): Promise<UnsubscribeResult> {
    return this.mutate(input, async (api) => {
        await api.subscriptions.delete({ id: input.subscriptionId });
        return { subscriptionId: input.subscriptionId, unsubscribed: true };
    });
  }

  async rateVideo(input: RateVideoInput): Promise<VideoRatingResult> {
    return this.mutate(input, async (api) => {
        await api.videos.rate({ id: input.videoId, rating: input.rating });
        return { videoId: input.videoId, rating: input.rating };
    });
  }

  async createComment(input: CreateCommentInput): Promise<CommentSummary> {
    return this.mutate(input, async (api) => {
        const response = await api.commentThreads.insert({
          part: 'snippet',
          requestBody: {
            snippet: {
              videoId: input.videoId,
              topLevelComment: { snippet: { textOriginal: input.text } },
            },
          },
        });
        const comment = normalizeComment(response.data)[0];
        if (!comment) {
          throw invalidProviderResponse('comment');
        }
        return comment;
    });
  }

  async listSubscriptions(maxResults?: number): Promise<SubscriptionSummary[]> {
    try {
      const response = await (await this.authorized()).subscriptions.list({
        part: 'snippet',
        mine: true,
        maxResults,
      });
      return (response.data.items ?? []).flatMap(normalizeSubscription);
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async myAccount(): Promise<ChannelSummary | undefined> {
    try {
      const response = await (await this.authorized()).channels.list({
        part: 'snippet',
        mine: true,
      });
      return (response.data.items ?? []).flatMap(normalizeChannel)[0];
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async listChannelCommentThreads(maxResults?: number): Promise<CommentSummary[]> {
    try {
      const api = await this.authorized();
      const response = await api.channels.list({ part: 'id', mine: true });
      const channelId = (response.data.items ?? []).flatMap(normalizeChannelId)[0];
      if (!channelId) {
        return [];
      }
      const comments = await api.commentThreads.list({
        part: 'snippet',
        allThreadsRelatedToChannelId: channelId,
        maxResults,
        textFormat: 'plainText',
      });
      return (comments.data.items ?? []).flatMap(normalizeComment);
    } catch (error) {
      throw toSafeError(error);
    }
  }

  private async authorized(capability: OAuthCapability = 'youtube.read'): Promise<AccountYouTubeApi> {
    const api = this.client.authorized(await this.oauth.getAccessToken(capability));
    if (!api.subscriptions || !api.videos.rate || !api.commentThreads.insert) {
      throw invalidProviderResponse('account API');
    }
    return api as AccountYouTubeApi;
  }

  private async mutate<T>(input: MutationInput, send: (api: AccountYouTubeApi) => Promise<T>): Promise<T> {
    requireConfirmation(input);
    const api = await this.authorized('youtube.write');
    try {
      return await send(api);
    } catch {
      throw accountMutationOutcomeUnknownError();
    }
  }
}

function normalizeSubscription(value: unknown): SubscriptionSummary[] {
  const candidate = asRecord(value);
  const snippet = asRecord(candidate?.snippet);
  const resourceId = asRecord(snippet?.resourceId);
  const subscriptionId = stringValue(candidate?.id);
  const channelId = stringValue(resourceId?.channelId);
  if (!subscriptionId || !channelId) {
    return [];
  }
  return [{ subscriptionId, channelId, ...optionalString('title', snippet?.title) }];
}

function normalizeChannel(value: unknown): ChannelSummary[] {
  const candidate = asRecord(value);
  const snippet = asRecord(candidate?.snippet);
  const id = stringValue(candidate?.id);
  const title = stringValue(snippet?.title);
  if (!id || !title) {
    return [];
  }
  return [{ id, title, ...optionalString('description', snippet?.description) }];
}

function normalizeChannelId(value: unknown): string[] {
  const id = stringValue(asRecord(value)?.id);
  return id ? [id] : [];
}

function normalizeComment(value: unknown): CommentSummary[] {
  const candidate = asRecord(value);
  const threadSnippet = asRecord(candidate?.snippet);
  const topLevelComment = asRecord(threadSnippet?.topLevelComment);
  const snippet = asRecord(topLevelComment?.snippet);
  const id = stringValue(candidate?.id);
  const author = stringValue(snippet?.authorDisplayName);
  const text = stringValue(snippet?.textDisplay);
  if (!id || !author || !text) {
    return [];
  }
  return [{ id, author, text, ...optionalString('publishedAt', snippet?.publishedAt) }];
}

function invalidProviderResponse(resource: string): AppError {
  return new AppError(
    'provider_error',
    `The YouTube provider did not return a valid ${resource}.`,
    'Try again. If the problem continues, verify the provider configuration.',
    true,
  );
}

function accountMutationOutcomeUnknownError(): AppError {
  return new AppError(
    'provider_outcome_unknown',
    'The account mutation may have completed, but YouTube did not return a confirmable result.',
    'Do not retry automatically. Re-read the relevant YouTube account state before deciding whether another mutation is needed.',
    false,
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalString<Key extends string>(key: Key, value: unknown): Partial<Record<Key, string>> {
  const normalized = stringValue(value);
  return normalized ? { [key]: normalized } as Partial<Record<Key, string>> : {};
}
