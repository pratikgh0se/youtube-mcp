import { YoutubeTranscript } from 'youtube-transcript';

import { toSafeError } from '../errors.js';
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
        fields: 'items(id/videoId,snippet(title,channelId,description,publishedAt))',
        q: input.query,
        maxResults: input.maxResults,
        type: 'video',
      });
      return withQuota((response.data.items ?? []).flatMap(normalizeSearchVideo), 100);
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
