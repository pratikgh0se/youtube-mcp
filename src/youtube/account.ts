import { confirmationRequiredError, AppError, isDefinitiveRejection, toSafeError } from '../errors.js';
import type { OAuthCapability, OAuthService } from '../auth/oauth.js';
import type {
  ChannelSummary,
  CommentSummary,
  CreateCommentInput,
  MutationInput,
  QuotaContext,
  RateVideoInput,
  SubscribeInput,
  SubscriptionResult,
  SubscriptionSummary,
  UnsubscribeInput,
  UnsubscribeResult,
  VideoRatingResult,
} from '../types.js';
import { YouTubeClient, type YouTubeDataApi } from './client.js';
import type { ResourceService } from './resources.js';

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
    private readonly resources: Pick<ResourceService, 'getOwnedVideo'>,
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

  /** Posting as the channel is limited to its own videos (spam guard); getOwnedVideo retries while a fresh video is not yet readable. */
  async createComment(input: CreateCommentInput): Promise<CommentSummary> {
    requireConfirmation(input);
    try {
      await this.resources.getOwnedVideo(input.videoId);
    } catch (error) {
      throw toSafeError(error).code === 'ownership_required' ? commentOwnershipRequiredError() : toSafeError(error);
    }
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
        // comments.insert omits authorDisplayName for the authenticated author; the id is the only must-have.
        const comment = normalizeComment(response.data, { author: 'You', text: input.text })[0];
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

  /**
   * Paginated subscription list. Plain: 1 quota unit. With details: +1 channels.list per 50 channels and +1 playlistItems.list per
   * channel (lastUploadAt), i.e. about 1 extra unit per returned channel.
   */
  async listSubscriptionsPage(input: { maxResults?: number; pageToken?: string; details?: boolean } = {}): Promise<{
    items: SubscriptionSummary[];
    nextPageToken?: string;
    context: QuotaContext;
  }> {
    try {
      const api = await this.authorized();
      const response = await api.subscriptions.list({
        part: 'snippet',
        mine: true,
        maxResults: input.maxResults,
        ...(input.pageToken ? { pageToken: input.pageToken } : {}),
      });
      let items = (response.data.items ?? []).flatMap(normalizeSubscription);
      let quotaUnits = 1;
      if (input.details && items.length > 0) {
        const enriched = await enrichSubscriptions(api, items);
        items = enriched.items;
        quotaUnits += enriched.quotaUnits;
      }
      const nextPageToken = response.data.nextPageToken ?? undefined;
      return { items, ...(nextPageToken ? { nextPageToken } : {}), context: { quotaUnits, source: 'youtube_data_api' } };
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
      return (comments.data.items ?? []).flatMap((item) => normalizeComment(item));
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
    } catch (error) {
      throw isDefinitiveRejection(error) ? toSafeError(error) : accountMutationOutcomeUnknownError();
    }
  }
}

async function enrichSubscriptions(api: AccountYouTubeApi, items: SubscriptionSummary[]): Promise<{ items: SubscriptionSummary[]; quotaUnits: number }> {
  let quotaUnits = 0;
  const channels = new Map<string, { subscriberCount?: number; subscriberCountHidden?: boolean; videoCount?: number; uploads?: string }>();
  for (let index = 0; index < items.length; index += 50) {
    const response = await api.channels.list({
      part: 'statistics,contentDetails',
      id: items.slice(index, index + 50).map((item) => item.channelId).join(','),
      maxResults: 50,
    });
    quotaUnits += 1;
    for (const raw of response.data.items ?? []) {
      const channel = asRecord(raw);
      const id = stringValue(channel?.id);
      if (!id) continue;
      const statistics = asRecord(channel?.statistics);
      const hidden = statistics?.hiddenSubscriberCount === true;
      channels.set(id, {
        ...(hidden ? { subscriberCountHidden: true } : countOf('subscriberCount', statistics?.subscriberCount)),
        ...countOf('videoCount', statistics?.videoCount),
        ...optionalString('uploads', asRecord(asRecord(channel?.contentDetails)?.relatedPlaylists)?.uploads),
      });
    }
  }
  const lastUploads = new Map<string, string>();
  for (const [channelId, info] of channels) {
    if (!info.uploads) continue;
    quotaUnits += 1;
    try {
      const response = await api.playlistItems.list({ part: ['contentDetails'], playlistId: info.uploads, maxResults: 1 });
      const publishedAt = stringValue(asRecord(asRecord(response.data.items?.[0])?.contentDetails)?.videoPublishedAt);
      if (publishedAt) lastUploads.set(channelId, publishedAt);
    } catch (error) {
      // Channels with no uploads (or a hidden uploads playlist) answer 404; anything else, notably quota, must surface.
      if (toSafeError(error).code === 'quota_exhausted') throw error;
    }
  }
  return {
    quotaUnits,
    items: items.map((item) => {
      const info = channels.get(item.channelId);
      const lastUploadAt = lastUploads.get(item.channelId);
      return {
        ...item,
        ...(info?.subscriberCount !== undefined ? { subscriberCount: info.subscriberCount } : {}),
        ...(info?.subscriberCountHidden ? { subscriberCountHidden: true } : {}),
        ...(info?.videoCount !== undefined ? { videoCount: info.videoCount } : {}),
        ...(lastUploadAt ? { lastUploadAt } : {}),
      };
    }),
  };
}

function countOf<Key extends string>(key: Key, value: unknown): Partial<Record<Key, number>> {
  const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? { [key]: parsed } as Partial<Record<Key, number>> : {};
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

function normalizeComment(value: unknown, fallback: { author: string; text: string } | undefined = undefined): CommentSummary[] {
  const candidate = asRecord(value);
  const threadSnippet = asRecord(candidate?.snippet);
  const topLevelComment = asRecord(threadSnippet?.topLevelComment);
  const snippet = asRecord(topLevelComment?.snippet);
  const id = stringValue(candidate?.id);
  const author = stringValue(snippet?.authorDisplayName) ?? fallback?.author;
  const text = stringValue(snippet?.textDisplay) ?? stringValue(snippet?.textOriginal) ?? fallback?.text;
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

function commentOwnershipRequiredError(): AppError {
  return new AppError(
    'ownership_required',
    'Comments can only be created on videos owned by the selected creator channel.',
    'Replies on your own videos are supported. Use a video ID from youtube_list_owned_videos; commenting on other channels\' videos is not supported.',
    false,
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
