import { AppError, toSafeError } from '../errors.js';
import type { OAuthService } from '../auth/oauth.js';
import type {
  CaptionTrack,
  CommentSummary,
  ConnectionProfile,
  ModerationComment,
  OwnedVideo,
  Page,
  PlaylistItemSummary,
  PlaylistSummary,
  VideoCategory,
} from '../types.js';
import { YouTubeClient } from './client.js';
import { retryWhileMissing } from './read-after-write.js';

export type OwnedResource = {
  item: OwnedVideo;
  profile: ConnectionProfile & { channelId: string };
  fetchedAt: string;
  expiresAt: string;
};

export type OwnedPlaylistResource = {
  item: PlaylistSummary | null;
  profile: ConnectionProfile & { channelId: string };
  fetchedAt: string;
  expiresAt: string;
};

export type ModerationCommentDetail = {
  id: string;
  channelId: string;
  text: string;
  author?: string;
  authorChannelId?: string;
  parentId?: string;
  moderationStatus?: string;
  etag?: string;
};

export type ModerationCommentResource = {
  item: ModerationCommentDetail | null;
  profile: ConnectionProfile & { channelId: string };
  fetchedAt: string;
  expiresAt: string;
};

export type CommentReplySearchResource = {
  parentId: string;
  text: string;
  matches: ModerationCommentDetail[];
  complete: true;
  profile: ConnectionProfile & { channelId: string };
  fetchedAt: string;
  expiresAt: string;
};

export type PageInput = { maxResults?: number; pageToken?: string };
export type PlaylistItemsInput = PageInput & { playlistId: string };
export type ModerationCommentsInput = PageInput & { moderationStatus?: 'heldForReview' | 'likelySpam' | 'published' };
export type CaptionTracksInput = { videoId: string };
export type VideoCategoriesInput = { regionCode?: string; id?: string };
type CreatorProfile = ConnectionProfile & { channelId: string };
const freshnessMs = 15 * 60_000;

export class ResourceService {
  constructor(
    private readonly oauth: Pick<OAuthService, 'getAccessToken'>,
    private readonly client: YouTubeClient,
    private readonly profile: ConnectionProfile,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Verifies that the selected channel is the channel represented by the OAuth principal. */
  async verifyPrincipal(): Promise<CreatorProfile> {
    try {
      return await this.selectedProfile();
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async getOwnedVideo(videoId: string): Promise<OwnedResource> {
    try {
      const profile = await this.selectedProfile();
      const api = await this.authorized();
      const video = await retryWhileMissing(async () => {
        const response = await api.videos.list({
          part: 'snippet,status,processingDetails',
          id: videoId,
        });
        return (response.data.items ?? []).flatMap(normalizeOwnedVideo)[0];
      });
      if (!video || video.channelId !== profile.channelId) throw ownershipRequiredError();
      return { item: video, profile, ...freshness(this.now()) };
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async listOwnedVideos(input: PageInput = {}): Promise<Page<OwnedVideo>> {
    try {
      const profile = await this.selectedProfile();
      const uploadsPlaylistId = await this.uploadsPlaylistId(profile);
      const response = await (await this.authorized()).playlistItems.list({
        part: ['snippet', 'contentDetails'],
        playlistId: uploadsPlaylistId,
        ...pageRequest(input),
      });
      return pageOf(profile, response.data, normalizeUploadVideo, this.now);
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async listVideoCategories(input: VideoCategoriesInput): Promise<Page<VideoCategory>> {
    try {
      const profile = await this.selectedProfile();
      if (Boolean(input.regionCode) === Boolean(input.id) || (input.regionCode && !/^[A-Z]{2}$/i.test(input.regionCode))) throw invalidCategoryInputError();
      const response = await (await this.authorized()).videoCategories.list({
        part: ['snippet'],
        ...(input.regionCode ? { regionCode: input.regionCode } : {}),
        ...(input.id ? { id: [input.id] } : {}),
      });
      return pageOf(profile, { items: response.data.items }, normalizeVideoCategory, this.now);
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async listPlaylists(input: PageInput = {}): Promise<Page<PlaylistSummary>> {
    try {
      const profile = await this.selectedProfile();
      const response = await (await this.authorized()).playlists.list({ part: ['snippet', 'status'], mine: true, ...pageRequest(input) });
      return pageOf(profile, response.data, normalizePlaylist, this.now);
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async getPlaylist(playlistId: string): Promise<OwnedPlaylistResource> {
    try {
      const profile = await this.selectedProfile();
      const item = await this.readOwnedPlaylist(playlistId, profile);
      return { item: item ?? null, profile, ...freshness(this.now()) };
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async listPlaylistItems(input: PlaylistItemsInput): Promise<Page<PlaylistItemSummary>> {
    try {
      const profile = await this.selectedProfile();
      await this.requiredOwnedPlaylist(input.playlistId, profile);
      const response = await (await this.authorized()).playlistItems.list({
        part: ['snippet'],
        playlistId: input.playlistId,
        ...pageRequest(input),
      });
      return pageOf(profile, response.data, normalizePlaylistItem, this.now);
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async listModerationComments(input: ModerationCommentsInput = {}): Promise<Page<ModerationComment>> {
    try {
      const profile = await this.selectedProfile();
      const response = await (await this.authorized('youtube.write')).commentThreads.list({
        part: 'snippet,replies',
        allThreadsRelatedToChannelId: profile.channelId,
        moderationStatus: input.moderationStatus,
        ...pageRequest(input),
        textFormat: 'plainText',
      });
      return pageOf(profile, response.data, normalizeModerationComment, this.now);
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async getModerationComment(commentId: string): Promise<ModerationCommentResource> {
    try {
      const profile = await this.selectedProfile();
      const item = await this.readModerationComment(commentId);
      if (item && item.channelId !== profile.channelId) throw ownershipRequiredError();
      return { item: item ?? null, profile, ...freshness(this.now()) };
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async findCommentReply(input: { parentId: string; text: string }): Promise<CommentReplySearchResource> {
    try {
      const profile = await this.selectedProfile();
      const parent = await retryWhileMissing(() => this.readModerationComment(input.parentId));
      if (!parent || parent.channelId !== profile.channelId) throw ownershipRequiredError();
      const api = await this.commentApi();
      const matches: ModerationCommentDetail[] = [];
      const seenTokens = new Set<string>();
      let pageToken: string | undefined;
      for (let page = 0; page < 100; page += 1) {
        const response = await api.list({
          part: ['snippet'],
          parentId: input.parentId,
          maxResults: 100,
          ...(pageToken ? { pageToken } : {}),
          textFormat: 'plainText',
        });
        const data = asRecord(response.data);
        const items = Array.isArray(data?.items) ? data.items.flatMap(normalizeModerationCommentDetail) : [];
        matches.push(...items.filter((item) =>
          item.parentId === input.parentId &&
          item.authorChannelId === profile.channelId &&
          item.text === input.text));
        const nextPageToken = stringValue(data?.nextPageToken);
        if (!nextPageToken) return { parentId: input.parentId, text: input.text, matches, complete: true, profile, ...freshness(this.now()) };
        if (seenTokens.has(nextPageToken)) throw incompleteReplySearchError();
        seenTokens.add(nextPageToken);
        pageToken = nextPageToken;
      }
      throw incompleteReplySearchError();
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async listCaptionTracks(input: CaptionTracksInput): Promise<Page<CaptionTrack>> {
    try {
      const owned = await this.getOwnedVideo(input.videoId);
      const response = await (await this.authorized('youtube.write')).captions.list({ part: ['snippet'], videoId: input.videoId });
      return pageOf(owned.profile, response.data, normalizeCaptionTrack, this.now);
    } catch (error) {
      throw toSafeError(error);
    }
  }

  private async selectedProfile(): Promise<CreatorProfile> {
    if (!this.profile.id || this.profile.purpose !== 'creator') {
      throw new AppError('invalid_profile', 'A selected creator profile is required.', 'Select a creator profile and try again.', false);
    }
    if (!this.profile.channelId) {
      throw new AppError('channel_required', 'The selected creator profile has no authorized channel.', 'Authorize the intended creator channel and try again.', false);
    }
    const profile = this.profile as CreatorProfile;
    const response = await (await this.authorized()).channels.list({ part: 'id', mine: true });
    const authenticatedChannelId = stringValue(asRecord(response.data.items?.[0])?.id);
    if (!authenticatedChannelId || authenticatedChannelId !== profile.channelId) throw ownershipRequiredError();
    return profile;
  }

  private async uploadsPlaylistId(profile: CreatorProfile): Promise<string> {
    const response = await (await this.authorized()).channels.list({ part: 'contentDetails', id: profile.channelId });
    const contentDetails = asRecord(asRecord(response.data.items?.[0])?.contentDetails);
    const relatedPlaylists = asRecord(contentDetails?.relatedPlaylists);
    const uploadsPlaylistId = stringValue(relatedPlaylists?.uploads);
    if (!uploadsPlaylistId) throw ownershipRequiredError();
    return uploadsPlaylistId;
  }

  private async readOwnedPlaylist(playlistId: string, profile: CreatorProfile): Promise<PlaylistSummary | undefined> {
    const response = await (await this.authorized()).playlists.list({ part: ['snippet', 'status'], id: [playlistId] });
    const playlist = (response.data.items ?? []).flatMap(normalizePlaylist)[0];
    if (!playlist) return undefined;
    if (playlist.id !== playlistId || playlist.channelId !== profile.channelId) throw ownershipRequiredError();
    return playlist;
  }

  private async requiredOwnedPlaylist(playlistId: string, profile: CreatorProfile): Promise<PlaylistSummary> {
    const playlist = await this.readOwnedPlaylist(playlistId, profile);
    if (!playlist) throw ownershipRequiredError();
    return playlist;
  }

  private async readModerationComment(commentId: string): Promise<ModerationCommentDetail | undefined> {
    const response = await (await this.commentApi()).list({ part: ['snippet'], id: [commentId], textFormat: 'plainText' });
    const data = asRecord(response.data);
    return Array.isArray(data?.items) ? data.items.flatMap(normalizeModerationCommentDetail)[0] : undefined;
  }

  private async commentApi() {
    const api = await this.authorized('youtube.write');
    if (!api.comments?.list) throw moderationReadUnavailableError();
    return api.comments;
  }

  private async authorized(capability: 'youtube.read' | 'youtube.write' = 'youtube.read') {
    return this.client.authorized(await this.oauth.getAccessToken(capability));
  }
}

function pageRequest(input: PageInput): Record<string, string | number | undefined> {
  return { maxResults: input.maxResults, pageToken: input.pageToken };
}

function pageOf<T>(
  profile: ConnectionProfile & { channelId: string },
  data: { items?: unknown[] | null; nextPageToken?: string | null },
  normalize: (item: unknown) => T[],
  now: () => Date,
): Page<T> {
  const nextPageToken = stringValue(data.nextPageToken);
  return {
    items: (data.items ?? []).flatMap(normalize),
    profile,
    ...freshness(now()),
    ...(nextPageToken ? { nextPageToken } : {}),
  };
}

function freshness(now: Date): { fetchedAt: string; expiresAt: string } {
  return { fetchedAt: now.toISOString(), expiresAt: new Date(now.getTime() + freshnessMs).toISOString() };
}

function normalizeOwnedVideo(value: unknown): OwnedVideo[] {
  const candidate = asRecord(value);
  const snippet = asRecord(candidate?.snippet);
  const status = asRecord(candidate?.status);
  const processingDetails = asRecord(candidate?.processingDetails);
  const id = stringValue(candidate?.id);
  const title = stringValue(snippet?.title);
  const channelId = stringValue(snippet?.channelId);
  if (!id || !title || !channelId) return [];
  return [{
    id,
    title,
    channelId,
    ...optionalString('description', snippet?.description),
    ...optionalString('publishedAt', snippet?.publishedAt),
    ...optionalString('privacyStatus', status?.privacyStatus),
    ...optionalString('publishAt', status?.publishAt),
    ...optionalString('processingStatus', processingDetails?.processingStatus),
    ...optionalString('etag', candidate?.etag),
  }];
}

function normalizeUploadVideo(value: unknown): OwnedVideo[] {
  const candidate = asRecord(value);
  const snippet = asRecord(candidate?.snippet);
  const resourceId = asRecord(snippet?.resourceId);
  const id = stringValue(resourceId?.videoId);
  const title = stringValue(snippet?.title);
  const channelId = stringValue(snippet?.channelId);
  if (!id || !title || !channelId) return [];
  return [{
    id,
    title,
    channelId,
    ...optionalString('publishedAt', asRecord(candidate?.contentDetails)?.videoPublishedAt),
    ...optionalString('etag', candidate?.etag),
  }];
}

function normalizeVideoCategory(value: unknown): VideoCategory[] {
  const candidate = asRecord(value);
  const snippet = asRecord(candidate?.snippet);
  const id = stringValue(candidate?.id);
  const title = stringValue(snippet?.title);
  return id && title ? [{ id, title }] : [];
}

function normalizePlaylist(value: unknown): PlaylistSummary[] {
  const candidate = asRecord(value);
  const snippet = asRecord(candidate?.snippet);
  const status = asRecord(candidate?.status);
  const id = stringValue(candidate?.id);
  const title = stringValue(snippet?.title);
  const channelId = stringValue(snippet?.channelId);
  if (!id || !title || !channelId) return [];
  return [{
    id,
    title,
    channelId,
    ...optionalString('description', snippet?.description),
    ...optionalString('privacyStatus', status?.privacyStatus),
    ...optionalString('etag', candidate?.etag),
  }];
}

function normalizePlaylistItem(value: unknown): PlaylistItemSummary[] {
  const candidate = asRecord(value);
  const snippet = asRecord(candidate?.snippet);
  const resourceId = asRecord(snippet?.resourceId);
  const id = stringValue(candidate?.id);
  const playlistId = stringValue(snippet?.playlistId);
  const videoId = stringValue(resourceId?.videoId);
  const title = stringValue(snippet?.title);
  const channelId = stringValue(snippet?.channelId);
  if (!id || !playlistId || !videoId || !title || !channelId) return [];
  return [{
    id,
    playlistId,
    videoId,
    title,
    channelId,
    ...optionalNumber('position', snippet?.position),
    ...optionalString('etag', candidate?.etag),
  }];
}

function normalizeModerationComment(value: unknown): ModerationComment[] {
  const candidate = asRecord(value);
  const threadSnippet = asRecord(candidate?.snippet);
  const topLevelComment = asRecord(threadSnippet?.topLevelComment);
  const comment = normalizeComment(topLevelComment)[0];
  const threadId = stringValue(candidate?.id);
  const channelId = stringValue(threadSnippet?.channelId);
  if (!comment || !threadId || !channelId) return [];
  const replies = asRecord(candidate?.replies);
  const replyItems = Array.isArray(replies?.comments) ? replies.comments.flatMap(normalizeComment) : [];
  return [{
    ...comment,
    commentId: comment.id,
    threadId,
    channelId,
    ...optionalString('videoId', threadSnippet?.videoId),
    replies: replyItems,
    ...optionalString('moderationStatus', asRecord(topLevelComment?.snippet)?.moderationStatus),
    ...optionalString('etag', candidate?.etag),
  }];
}

function invalidCategoryInputError(): AppError {
  return new AppError(
    'invalid_input',
    'A category regionCode or ID is required.',
    'Provide regionCode or id and try again.',
    false,
  );
}

function normalizeComment(value: unknown): CommentSummary[] {
  const candidate = asRecord(value);
  const snippet = asRecord(candidate?.snippet);
  const id = stringValue(candidate?.id);
  const author = stringValue(snippet?.authorDisplayName);
  const text = stringValue(snippet?.textDisplay);
  if (!id || !author || !text) return [];
  return [{ id, author, text, ...optionalString('publishedAt', snippet?.publishedAt) }];
}

function normalizeModerationCommentDetail(value: unknown): ModerationCommentDetail[] {
  const candidate = asRecord(value);
  const snippet = asRecord(candidate?.snippet);
  const id = stringValue(candidate?.id);
  const channelId = stringValue(snippet?.channelId);
  const text = stringValue(snippet?.textDisplay) ?? stringValue(snippet?.textOriginal);
  if (!id || !channelId || !text) return [];
  return [{
    id,
    channelId,
    text,
    ...optionalString('author', snippet?.authorDisplayName),
    ...optionalString('authorChannelId', asRecord(snippet?.authorChannelId)?.value),
    ...optionalString('parentId', snippet?.parentId),
    ...optionalString('moderationStatus', snippet?.moderationStatus),
    ...optionalString('etag', candidate?.etag),
  }];
}

function normalizeCaptionTrack(value: unknown): CaptionTrack[] {
  const candidate = asRecord(value);
  const snippet = asRecord(candidate?.snippet);
  const id = stringValue(candidate?.id);
  const videoId = stringValue(snippet?.videoId);
  const language = stringValue(snippet?.language);
  if (!id || !videoId || !language) return [];
  return [{
    id,
    videoId,
    language,
    ...optionalString('name', snippet?.name),
    ...optionalString('trackKind', snippet?.trackKind),
    ...optionalString('status', snippet?.status),
    ...(typeof snippet?.isDraft === 'boolean' ? { isDraft: snippet.isDraft } : {}),
    ...optionalString('etag', candidate?.etag),
  }];
}

function ownershipRequiredError(): AppError {
  return new AppError(
    'ownership_required',
    'This resource is not owned by the selected creator channel.',
    'Select the owning creator profile or use an owned resource ID.',
    false,
  );
}

function moderationReadUnavailableError(): AppError {
  return new AppError('provider_error', 'The YouTube comment read API is unavailable.', 'Retry the exact moderation reconciliation read.', true);
}

function incompleteReplySearchError(): AppError {
  return new AppError('provider_error', 'The exact comment-reply search could not exhaust provider pages.', 'Retry youtube_find_comment_reply before repeating the mutation.', true);
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

function optionalNumber<Key extends string>(key: Key, value: unknown): Partial<Record<Key, number>> {
  return typeof value === 'number' && Number.isFinite(value) ? { [key]: value } as Partial<Record<Key, number>> : {};
}
