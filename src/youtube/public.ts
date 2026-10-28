import { YoutubeTranscript } from 'youtube-transcript';

import { AppError, toSafeError } from '../errors.js';
import type {
  ChannelSummary,
  CommentSummary,
  SearchInput,
  ToolResult,
  TranscriptResult,
  VideoInput,
  VideoSummary,
} from '../types.js';
import { YouTubeClient } from './client.js';

export type ChannelInput = { channelId: string };
export type TrendingInput = { regionCode?: string; videoCategoryId?: string; maxResults?: number; pageToken?: string };
export type ChannelVideosInput = { channelId: string; maxResults?: number; pageToken?: string };
export type VideoStats = {
  id: string;
  title: string;
  channelId: string;
  channelTitle?: string;
  publishedAt?: string;
  viewCount?: number;
  likeCount?: number;
  commentCount?: number;
  duration?: string;
};
export type CommentsInput = { videoId: string; maxResults?: number };

export type TranscriptFetcher = {
  fetchTranscript(videoId: string): Promise<Array<{ text: string }>>;
};

export class PublicService {
  constructor(
    private readonly client: YouTubeClient,
    private readonly transcriptFetcher: TranscriptFetcher = YoutubeTranscript,
  ) {}

  async search(input: SearchInput): Promise<ToolResult<VideoSummary[]>> {
    try {
      const response = await this.client.public().search.list({
        part: 'snippet',
        fields: 'nextPageToken,items(id/videoId,snippet(title,channelId,description,publishedAt))',
        q: input.query,
        maxResults: input.maxResults,
        type: 'video',
        ...definedOnly({
          order: input.order,
          publishedAfter: input.publishedAfter,
          publishedBefore: input.publishedBefore,
          videoDuration: input.videoDuration,
          channelId: input.channelId,
          regionCode: input.regionCode?.toUpperCase(),
          relevanceLanguage: input.relevanceLanguage,
          safeSearch: input.safeSearch,
          pageToken: input.pageToken,
        }),
      });
      return withPage(withQuota((response.data.items ?? []).flatMap(normalizeSearchVideo), 100), response.data.nextPageToken);
    } catch (error) {
      throw toSafeError(error);
    }
  }

  /** videos.list chart=mostPopular: 1 quota unit. */
  async trending(input: TrendingInput): Promise<ToolResult<VideoStats[]>> {
    try {
      const response = await this.client.public().videos.list({
        part: 'snippet,statistics,contentDetails',
        chart: 'mostPopular',
        regionCode: (input.regionCode ?? 'US').toUpperCase(),
        maxResults: input.maxResults,
        ...definedOnly({ videoCategoryId: input.videoCategoryId, pageToken: input.pageToken }),
      });
      return withPage(withQuota((response.data.items ?? []).flatMap(normalizeVideoStats), 1), response.data.nextPageToken);
    } catch (error) {
      throw toSafeError(error);
    }
  }

  /**
   * Recent uploads of any channel: channels.list (1) + playlistItems.list (1) + videos.list for statistics (1) = 3 quota units.
   * Accepts a channel ID or an @handle (resolved via channels.list forHandle).
   */
  async listChannelVideos(input: ChannelVideosInput): Promise<ToolResult<VideoStats[]> & { channelId: string; uploadsPlaylistId: string }> {
    try {
      const api = this.client.public();
      const handle = input.channelId.startsWith('@');
      const channels = await api.channels.list({
        part: 'contentDetails',
        ...(handle ? { forHandle: input.channelId } : { id: input.channelId }),
      });
      const channel = asRecord(channels.data.items?.[0]);
      const channelId = stringValue(channel?.id);
      const uploadsPlaylistId = stringValue(asRecord(asRecord(channel?.contentDetails)?.relatedPlaylists)?.uploads);
      if (!channelId || !uploadsPlaylistId) {
        throw new AppError('not_found', `No channel or uploads playlist found for ${input.channelId}.`, 'Check the channel ID or @handle.', false);
      }
      const page = await api.playlistItems.list({
        part: ['contentDetails'],
        playlistId: uploadsPlaylistId,
        maxResults: input.maxResults ?? 25,
        ...definedOnly({ pageToken: input.pageToken }),
      });
      const ids = (page.data.items ?? []).flatMap((item) => {
        const videoId = stringValue(asRecord(asRecord(item)?.contentDetails)?.videoId);
        return videoId ? [videoId] : [];
      });
      let items: VideoStats[] = [];
      let quotaUnits = 2;
      if (ids.length > 0) {
        const videos = await api.videos.list({ part: 'snippet,statistics,contentDetails', id: ids.join(',') });
        quotaUnits = 3;
        const byId = new Map((videos.data.items ?? []).flatMap(normalizeVideoStats).map((video) => [video.id, video]));
        items = ids.flatMap((videoId) => byId.get(videoId) ?? []);
      }
      return {
        ...withPage(withQuota(items, quotaUnits), page.data.nextPageToken),
        channelId,
        uploadsPlaylistId,
      };
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async getVideo(input: VideoInput): Promise<ToolResult<VideoSummary[]>> {
    try {
      const response = await this.client.public().videos.list({
        part: 'snippet',
        fields: 'items(id,snippet(title,channelId,description,publishedAt))',
        id: input.videoId,
      });
      return withQuota((response.data.items ?? []).flatMap(normalizeVideo), 1);
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async getChannel(input: ChannelInput): Promise<ToolResult<ChannelSummary[]>> {
    try {
      const response = await this.client.public().channels.list({
        part: 'snippet',
        fields: 'items(id,snippet(title,description))',
        id: input.channelId,
      });
      return withQuota((response.data.items ?? []).flatMap(normalizeChannel), 1);
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async getComments(input: CommentsInput): Promise<ToolResult<CommentSummary[]>> {
    try {
      const response = await this.client.public().commentThreads.list({
        part: 'snippet',
        fields: 'items(id,snippet/topLevelComment/snippet(authorDisplayName,textDisplay,publishedAt))',
        videoId: input.videoId,
        maxResults: input.maxResults,
        textFormat: 'plainText',
      });
      return withQuota((response.data.items ?? []).flatMap(normalizeComment), 1);
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async getTranscript(input: VideoInput): Promise<TranscriptResult> {
    try {
      const entries = await this.transcriptFetcher.fetchTranscript(input.videoId);
      const text = entries.map((entry) => entry.text.trim()).filter(Boolean).join(' ');
      return text ? { available: true, source: 'best_effort', text } : { available: false, source: 'best_effort' };
    } catch {
      return { available: false, source: 'best_effort' };
    }
  }
}

function withQuota<T>(items: T, quotaUnits: number): ToolResult<T> {
  return { items, context: { quotaUnits, source: 'youtube_data_api' } };
}

function withPage<T extends ToolResult<unknown>>(result: T, nextPageToken: string | null | undefined): T {
  return nextPageToken ? { ...result, nextPageToken } : result;
}

function definedOnly<T extends Record<string, unknown>>(values: T): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function normalizeVideoStats(value: unknown): VideoStats[] {
  const candidate = asRecord(value);
  const snippet = asRecord(candidate?.snippet);
  const statistics = asRecord(candidate?.statistics);
  const id = stringValue(candidate?.id);
  const title = stringValue(snippet?.title);
  const channelId = stringValue(snippet?.channelId);
  if (!id || !title || !channelId) {
    return [];
  }
  return [{
    id,
    title,
    channelId,
    ...optionalString('channelTitle', snippet?.channelTitle),
    ...optionalString('publishedAt', snippet?.publishedAt),
    ...optionalCount('viewCount', statistics?.viewCount),
    ...optionalCount('likeCount', statistics?.likeCount),
    ...optionalCount('commentCount', statistics?.commentCount),
    ...optionalString('duration', asRecord(candidate?.contentDetails)?.duration),
  }];
}

function optionalCount<Key extends string>(key: Key, value: unknown): Partial<Record<Key, number>> {
  const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? { [key]: parsed } as Partial<Record<Key, number>> : {};
}

function normalizeSearchVideo(value: unknown): VideoSummary[] {
  const candidate = asRecord(value);
  const id = asRecord(candidate?.id)?.videoId;
  return normalizeVideo({ id, snippet: candidate?.snippet });
}

function normalizeVideo(value: unknown): VideoSummary[] {
  const candidate = asRecord(value);
  const snippet = asRecord(candidate?.snippet);
  const id = stringValue(candidate?.id);
  const title = stringValue(snippet?.title);
  const channelId = stringValue(snippet?.channelId);
  if (!id || !title || !channelId) {
    return [];
  }
  return [{
    id,
    title,
    channelId,
    ...optionalString('description', snippet?.description),
    ...optionalString('publishedAt', snippet?.publishedAt),
  }];
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
