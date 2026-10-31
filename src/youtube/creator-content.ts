import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';

import type { ResourceService } from './resources.js';
import { AppError, isDefinitiveRejection, providerOutcomeUnknownError, toSafeError } from '../errors.js';
import type { OAuthService } from '../auth/oauth.js';
import type { CaptionTrack, ConnectionProfile, OperationPreview, OperationReceipt } from '../types.js';
import { OperationService } from '../operations/service.js';
import { retryWhileMissing } from './read-after-write.js';
import { YouTubeClient, type YouTubeDataApi } from './client.js';

type CreatorProfile = ConnectionProfile & { purpose: 'creator'; channelId: string };
type MetadataFields = {
  title?: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  defaultLanguage?: string;
  privacyStatus?: 'private' | 'unlisted' | 'public';
  publishAt?: string;
  containsSyntheticMedia?: boolean;
  selfDeclaredMadeForKids?: boolean;
};
type MetadataDesired = { snippet: Partial<CreatorVideo['snippet']>; status: Partial<CreatorVideo['status']> };

export type MetadataUpdateInput = MetadataFields & {
  videoId: string;
  publish?: boolean;
  elevated?: boolean;
  approvalId?: string;
  confirm?: boolean;
};
export type ArchiveVideoInput = { videoId: string; approvalId?: string; confirm?: boolean };
export type ThumbnailInput = { videoId: string; filePath: string; mimeType: 'image/jpeg' | 'image/png'; approvalId?: string; confirm?: boolean };
export type CaptionUploadInput = { videoId: string; filePath: string; mimeType: CaptionMimeType; language: string; name: string; isDraft?: boolean; approvalId?: string; confirm?: boolean };
export type CaptionUpdateInput = CaptionUploadInput & { captionId: string };
export type CaptionDownloadInput = { videoId: string; captionId: string; fileName: string; format?: 'srt' | 'ttml' | 'vtt' | 'sbv' };
export type CaptionDeleteInput = { videoId: string; captionId: string; approvalId?: string; confirm?: boolean };
export type CaptionMimeType = 'application/octet-stream' | 'application/ttml+xml' | 'text/plain' | 'text/vtt';

export type CreatorVideo = {
  id: string;
  channelId: string;
  etag?: string;
  snippet: { title: string; description?: string; tags?: string[]; categoryId?: string; defaultLanguage?: string };
  status: {
    privacyStatus?: string;
    publishAt?: string;
    license?: string;
    embeddable?: boolean;
    publicStatsViewable?: boolean;
    selfDeclaredMadeForKids?: boolean;
    containsSyntheticMedia?: boolean;
  };
};

export type CreatorContentProvider = {
  getVideo(input: { videoId: string }): Promise<CreatorVideo | undefined>;
  setThumbnail(input: { videoId: string; bytes: Uint8Array; mimeType: ThumbnailInput['mimeType'] }): Promise<{ id?: string }>;
  updateVideo(input: { id: string; snippet: CreatorVideo['snippet']; status: CreatorVideo['status'] }): Promise<{ id?: string }>;
  listCaptions(input: { videoId: string }): Promise<Array<{ id: string; videoId: string; language: string; name?: string; etag?: string }>>;
  insertCaption(input: { videoId: string; bytes: Uint8Array; mimeType: CaptionMimeType; language: string; name: string; isDraft?: boolean }): Promise<{ id?: string }>;
  updateCaption(input: { captionId: string; bytes: Uint8Array; mimeType: CaptionMimeType; isDraft?: boolean }): Promise<{ id?: string }>;
  downloadCaption(input: { captionId: string; format?: CaptionDownloadInput['format'] }): Promise<string | Uint8Array>;
  deleteCaption(input: { captionId: string }): Promise<void>;
};

type MutatingInput = { approvalId?: string; confirm?: boolean };
const thumbnailMaximumBytes = 2_000_000;
const captionMaximumBytes = 100 * 1024 * 1024;

export class CreatorContentService {
  constructor(
    private readonly operations: OperationService,
    private readonly resources: Pick<ResourceService, 'getOwnedVideo' | 'listCaptionTracks'>,
    private readonly provider: CreatorContentProvider,
    private readonly profile: CreatorProfile,
    private readonly stateDir: string,
  ) {}

  async preflightMetadataUpdate(input: MetadataUpdateInput): Promise<OperationPreview> {
    try {
      requireMetadataFields(input);
      requireElevatedIntent(input);
      const current = await this.currentVideo(input.videoId);
      const desired = metadataDesired(input);
      return this.preflight('video.metadata.update', input.videoId, desired, fingerprint(current), { tool: 'youtube_get_owned_video', arguments: { videoId: input.videoId } });
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async updateMetadata(input: MetadataUpdateInput & { approvalId: string }): Promise<{ operationId: string; state: 'succeeded'; videoId: string }> {
    try {
      requireMetadataFields(input);
      requireElevatedIntent(input);
      const desired = metadataDesired(input);
      await this.requireApproved(input, 'video.metadata.update', input.videoId, desired);
      const current = await this.currentVideo(input.videoId);
      await this.claim(input, 'video.metadata.update', input.videoId, desired, fingerprint(current));
      await this.providerOutcome(input.approvalId, { tool: 'youtube_get_owned_video', arguments: { videoId: input.videoId } }, async () => {
        const response = await this.provider.updateVideo({
          id: current.id,
          snippet: { ...current.snippet, ...desired.snippet },
          status: { ...current.status, ...desired.status },
        });
        if (response.id && response.id !== input.videoId) throw providerError('video');
      });
      await this.operations.settle({ operationId: input.approvalId, profileId: this.profile.id, channelId: this.profile.channelId, state: 'succeeded' });
      return { operationId: input.approvalId, state: 'succeeded', videoId: input.videoId };
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async preflightArchiveVideo(input: ArchiveVideoInput): Promise<OperationPreview> {
    try {
      const current = await this.currentVideo(input.videoId);
      if (isArchived(current)) throw alreadyArchivedError();
      return this.preflight('video.archive', input.videoId, archiveDesired(current), fingerprint(current), { tool: 'youtube_get_owned_video', arguments: { videoId: input.videoId } });
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async archiveVideo(input: ArchiveVideoInput & { approvalId: string }): Promise<{ operationId: string; state: 'succeeded'; videoId: string; privacyStatus: 'private'; scheduled: false }> {
    try {
      await this.requireApproved(input, 'video.archive', input.videoId);
      const current = await this.currentVideo(input.videoId);
      if (isArchived(current)) throw alreadyArchivedError();
      const preview = await this.operations.requireApproved({ approvalId: input.approvalId, confirm: input.confirm, profileId: this.profile.id, channelId: this.profile.channelId });
      this.requireContext(preview, 'video.archive', input.videoId, archiveDesired(current));
      await this.claim(input, 'video.archive', input.videoId, undefined, fingerprint(current));
      await this.providerOutcome(input.approvalId, { tool: 'youtube_get_owned_video', arguments: { videoId: input.videoId } }, async () => {
        const { publishAt: _scheduled, ...status } = current.status;
        const response = await this.provider.updateVideo({ id: current.id, snippet: current.snippet, status: { ...status, privacyStatus: 'private' } });
        if (response.id && response.id !== input.videoId) throw providerError('video');
      });
      await this.operations.settle({ operationId: input.approvalId, profileId: this.profile.id, channelId: this.profile.channelId, state: 'succeeded' });
      return { operationId: input.approvalId, state: 'succeeded', videoId: input.videoId, privacyStatus: 'private', scheduled: false };
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async preflightThumbnail(input: ThumbnailInput): Promise<OperationPreview> {
    try {
      const file = await validateLocalFile(input.filePath, input.mimeType, ['image/jpeg', 'image/png'], thumbnailMaximumBytes);
      await this.requireOwnedVideo(input.videoId);
      return this.preflight('video.thumbnail.set', input.videoId, { mimeType: input.mimeType, fileFingerprint: file.fingerprint }, file.fingerprint, { tool: 'youtube_get_owned_video', arguments: { videoId: input.videoId } });
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async setThumbnail(input: ThumbnailInput & { approvalId: string }): Promise<{ operationId: string; state: 'succeeded'; videoId: string }> {
    try {
      return await withValidatedLocalFile(input.filePath, input.mimeType, ['image/jpeg', 'image/png'], thumbnailMaximumBytes, async (file) => {
        await this.requireApproved(input, 'video.thumbnail.set', input.videoId, { mimeType: input.mimeType, fileFingerprint: file.fingerprint });
        await this.requireOwnedVideo(input.videoId);
        await this.claim(input, 'video.thumbnail.set', input.videoId, { mimeType: input.mimeType, fileFingerprint: file.fingerprint }, file.fingerprint);
        await this.providerOutcome(input.approvalId, { tool: 'youtube_get_owned_video', arguments: { videoId: input.videoId } }, async () => {
          const response = await this.provider.setThumbnail({ videoId: input.videoId, bytes: file.bytes, mimeType: input.mimeType });
          if (response.id && response.id !== input.videoId) throw providerError('thumbnail');
        });
        await this.operations.settle({ operationId: input.approvalId, profileId: this.profile.id, channelId: this.profile.channelId, state: 'succeeded' });
        return { operationId: input.approvalId, state: 'succeeded' as const, videoId: input.videoId };
      });
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async preflightCaptionUpload(input: CaptionUploadInput): Promise<OperationPreview> {
    requireCaptionName(input);
    const file = await this.validateCaptionUpload(input);
    return this.preflight('caption.upload', input.videoId, captionUploadDesired(input, file.fingerprint), file.fingerprint, captionReconciliation(input.videoId));
  }

  async uploadCaption(input: CaptionUploadInput & { approvalId: string }): Promise<{ operationId: string; state: 'succeeded'; captionId: string }> {
    try {
      requireCaptionName(input);
      return await withValidatedLocalFile(input.filePath, input.mimeType, ['application/octet-stream', 'application/ttml+xml', 'text/plain', 'text/vtt'], captionMaximumBytes, async (file) => {
        const desired = captionUploadDesired(input, file.fingerprint);
        await this.requireApproved(input, 'caption.upload', input.videoId, desired);
        await this.requireOwnedVideo(input.videoId);
        await this.claim(input, 'caption.upload', input.videoId, desired, file.fingerprint);
        const captionId = await this.providerOutcome(input.approvalId, captionReconciliation(input.videoId), async () => {
          const response = await this.provider.insertCaption(captionProviderInput(input, file.bytes));
          return requiredId(response.id, 'caption');
        });
        await this.operations.settle({ operationId: input.approvalId, profileId: this.profile.id, channelId: this.profile.channelId, state: 'succeeded' });
        return { operationId: input.approvalId, state: 'succeeded' as const, captionId };
      });
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async preflightCaptionUpdate(input: CaptionUpdateInput): Promise<OperationPreview> {
    requireCaptionName(input);
    const file = await this.validateOwnedCaptionUpload(input);
    return this.preflight('caption.update', input.captionId, captionUpdateDesired(input, file.fingerprint), file.fingerprint, captionReconciliation(input.videoId));
  }

  async updateCaption(input: CaptionUpdateInput & { approvalId: string }): Promise<{ operationId: string; state: 'succeeded'; captionId: string }> {
    try {
      requireCaptionName(input);
      return await withValidatedLocalFile(input.filePath, input.mimeType, ['application/octet-stream', 'application/ttml+xml', 'text/plain', 'text/vtt'], captionMaximumBytes, async (file) => {
        const desired = captionUpdateDesired(input, file.fingerprint);
        await this.requireApproved(input, 'caption.update', input.captionId, desired);
        await this.requireOwnedCaption(input.videoId, input.captionId);
        await this.claim(input, 'caption.update', input.captionId, desired, file.fingerprint);
        const captionId = await this.providerOutcome(input.approvalId, captionReconciliation(input.videoId), async () => {
          const response = await this.provider.updateCaption({ captionId: input.captionId, bytes: file.bytes, mimeType: input.mimeType, ...(input.isDraft !== undefined ? { isDraft: input.isDraft } : {}) });
          const updatedCaptionId = requiredId(response.id, 'caption');
          if (updatedCaptionId !== input.captionId) throw providerError('caption');
          return updatedCaptionId;
        });
        await this.operations.settle({ operationId: input.approvalId, profileId: this.profile.id, channelId: this.profile.channelId, state: 'succeeded' });
        return { operationId: input.approvalId, state: 'succeeded' as const, captionId };
      });
    } catch (error) {
      throw toSafeError(error);
    }
  }

  /** Read-only on YouTube: no preview or approval. Ownership is verified; the file is created exclusively (never overwritten) inside `<state dir>/downloads/`. */
  async downloadCaption(input: CaptionDownloadInput): Promise<{ state: 'succeeded'; captionId: string; downloaded: true; path: string }> {
    try {
      const fileName = sanitizeCaptionFileName(input.fileName, input.format);
      await this.requireOwnedCaption(input.videoId, input.captionId);
      const destination = join(await ensureDownloadsDirectory(this.stateDir), fileName);
      await requireAvailableCaptionDestination(destination);
      const bytes = await this.provider.downloadCaption({ captionId: input.captionId, format: input.format });
      await writeCaptionDestination(destination, bytes);
      return { state: 'succeeded', captionId: input.captionId, downloaded: true, path: destination };
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async preflightCaptionDelete(input: CaptionDeleteInput): Promise<OperationPreview> {
    const caption = await this.requireOwnedCaption(input.videoId, input.captionId);
    return this.preflight('caption.delete', input.captionId, captionDeleteDesired(input, caption), fingerprint(caption), captionReconciliation(input.videoId));
  }

  async deleteCaption(input: CaptionDeleteInput & { approvalId: string }): Promise<{ operationId: string; state: 'succeeded'; captionId: string; deleted: true }> {
    try {
      await this.requireApproved(input, 'caption.delete', input.captionId);
      const caption = await this.requireOwnedCaption(input.videoId, input.captionId);
      await this.claim(input, 'caption.delete', input.captionId, undefined, fingerprint(caption));
      await this.providerOutcome(input.approvalId, captionReconciliation(input.videoId), () => this.provider.deleteCaption({ captionId: input.captionId }));
      await this.operations.settle({ operationId: input.approvalId, profileId: this.profile.id, channelId: this.profile.channelId, state: 'succeeded' });
      return { operationId: input.approvalId, state: 'succeeded', captionId: input.captionId, deleted: true };
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async approve(input: { approvalId: string; confirm?: boolean }): Promise<OperationPreview> {
    return this.operations.approve({ approvalId: input.approvalId, confirm: input.confirm, profileId: this.profile.id, channelId: this.profile.channelId });
  }

  private async preflight(kind: string, targetId: string, desired: Record<string, unknown>, currentFingerprint: string, reconciliation: { tool: string; arguments: Record<string, string> }): Promise<OperationPreview> {
    return this.operations.preflight({ profile: this.profile, kind, targetId, desired, currentFingerprint, reconciliation });
  }

  private async claim(input: MutatingInput & { approvalId: string }, kind: string, targetId: string, desired: Record<string, unknown> | undefined, currentFingerprint: string): Promise<void> {
    await this.operations.claim({ approvalId: input.approvalId, confirm: input.confirm, currentFingerprint, profileId: this.profile.id, channelId: this.profile.channelId });
  }

  private async requireApproved(input: MutatingInput & { approvalId: string }, kind: string, targetId: string, desired?: Record<string, unknown>): Promise<void> {
    const preview = await this.operations.requireApproved({ approvalId: input.approvalId, confirm: input.confirm, profileId: this.profile.id, channelId: this.profile.channelId });
    this.requireContext(preview, kind, targetId, desired);
  }

  private requireContext(preview: OperationPreview, kind: string, targetId: string, desired?: Record<string, unknown>): void {
    if (preview.kind !== kind || preview.targetId !== targetId || (desired && preview.desiredFingerprint !== fingerprint(desired))) throw approvalRequiredError();
  }

  private async providerOutcome<T>(operationId: string, reconciliation: { tool: string; arguments: Record<string, string> }, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      const definitive = isDefinitiveRejection(error);
      await this.operations.settle({ operationId, profileId: this.profile.id, channelId: this.profile.channelId, state: definitive ? 'failed' : 'unknown' });
      throw definitive ? toSafeError(error) : providerOutcomeUnknownError(operationId, reconciliation);
    }
  }

  private async currentVideo(videoId: string): Promise<CreatorVideo> {
    await this.requireOwnedVideo(videoId);
    const current = await retryWhileMissing(() => this.provider.getVideo({ videoId }));
    if (!current || current.id !== videoId || current.channelId !== this.profile.channelId || !current.snippet.title) throw ownershipRequiredError();
    return normalizeVideo(current);
  }

  private async requireOwnedVideo(videoId: string): Promise<void> {
    const owned = await this.resources.getOwnedVideo(videoId);
    if (owned.profile.id !== this.profile.id || owned.profile.channelId !== this.profile.channelId || owned.item.id !== videoId) throw ownershipRequiredError();
  }

  private async requireOwnedCaption(videoId: string, captionId: string): Promise<CaptionTrack> {
    await this.requireOwnedVideo(videoId);
    const caption = await retryWhileMissing(async () => (await this.resources.listCaptionTracks({ videoId })).items.find((candidate) => candidate.id === captionId && candidate.videoId === videoId));
    if (!caption) throw ownershipRequiredError();
    return caption;
  }

  private async validateCaptionUpload(input: CaptionUploadInput): Promise<{ fingerprint: string }> {
    await this.requireOwnedVideo(input.videoId);
    return validateLocalFile(input.filePath, input.mimeType, ['application/octet-stream', 'application/ttml+xml', 'text/plain', 'text/vtt'], captionMaximumBytes);
  }

  private async validateOwnedCaptionUpload(input: CaptionUpdateInput): Promise<{ fingerprint: string }> {
    await this.requireOwnedCaption(input.videoId, input.captionId);
    return validateLocalFile(input.filePath, input.mimeType, ['application/octet-stream', 'application/ttml+xml', 'text/plain', 'text/vtt'], captionMaximumBytes);
  }
}

export function createCreatorContentProvider(
  oauth: Pick<OAuthService, 'getAccessToken'>,
  client: YouTubeClient,
): CreatorContentProvider {
  async function api(): Promise<CreatorContentApi> {
    const candidate = client.authorized(await oauth.getAccessToken('youtube.write'));
    if (!candidate.videos.update || !candidate.thumbnails?.set || !candidate.captions.insert || !candidate.captions.update || !candidate.captions.download || !candidate.captions.delete) throw providerError('creator content API');
    return candidate as CreatorContentApi;
  }
  return {
    async getVideo({ videoId }) {
      const response = await (await api()).videos.list({ part: 'snippet,status', id: videoId });
      return (response.data.items ?? []).flatMap(normalizeProviderVideo)[0];
    },
    async setThumbnail(input) {
      const response = await (await api()).thumbnails.set({ videoId: input.videoId, media: { mimeType: input.mimeType, body: Readable.from(Buffer.from(input.bytes)) } });
      return idResponse(response.data);
    },
    async updateVideo(input) {
      const response = await (await api()).videos.update({ part: ['snippet', 'status'], requestBody: input });
      return idResponse(response.data);
    },
    async listCaptions({ videoId }) {
      const response = await (await api()).captions.list({ part: ['snippet'], videoId });
      return (response.data.items ?? []).flatMap(normalizeProviderCaption);
    },
    async insertCaption(input) {
      const response = await (await api()).captions.insert({ part: ['snippet'], requestBody: { snippet: captionSnippet(input) }, media: { mimeType: input.mimeType, body: Readable.from(Buffer.from(input.bytes)) } });
      return idResponse(response.data);
    },
    async updateCaption(input) {
      const response = await (await api()).captions.update({
        part: [input.isDraft === undefined ? 'id' : 'snippet'],
        requestBody: { id: input.captionId, ...(input.isDraft !== undefined ? { snippet: { isDraft: input.isDraft } } : {}) },
        media: { mimeType: input.mimeType, body: Readable.from(Buffer.from(input.bytes)) },
      });
      return idResponse(response.data);
    },
    async downloadCaption(input) {
      const response = await (await api()).captions.download({ id: input.captionId, ...(input.format ? { tfmt: input.format } : {}) }, { responseType: 'arraybuffer' });
      if (typeof response.data === 'string' || response.data instanceof Uint8Array) return response.data;
      if (response.data instanceof ArrayBuffer) return new Uint8Array(response.data);
      if (ArrayBuffer.isView(response.data)) return new Uint8Array(response.data.buffer, response.data.byteOffset, response.data.byteLength);
      throw providerError('caption download');
    },
    async deleteCaption({ captionId }) { await (await api()).captions.delete({ id: captionId }); },
  };
}

type CreatorContentApi = YouTubeDataApi & {
  videos: YouTubeDataApi['videos'] & { update: NonNullable<YouTubeDataApi['videos']['update']> };
  thumbnails: NonNullable<YouTubeDataApi['thumbnails']>;
  captions: YouTubeDataApi['captions'] & {
    insert: NonNullable<YouTubeDataApi['captions']['insert']>;
    update: NonNullable<YouTubeDataApi['captions']['update']>;
    download: NonNullable<YouTubeDataApi['captions']['download']>;
    delete: NonNullable<YouTubeDataApi['captions']['delete']>;
  };
};

function isArchived(video: CreatorVideo): boolean { return video.status.privacyStatus === 'private' && !video.status.publishAt; }
function archiveDesired(video: CreatorVideo): Record<string, unknown> {
  return {
    videoId: video.id,
    title: video.snippet.title,
    current: { privacyStatus: video.status.privacyStatus ?? 'unknown', ...(video.status.publishAt ? { publishAt: video.status.publishAt } : {}) },
    result: { privacyStatus: 'private', scheduled: false },
    note: 'Reversible: only visibility changes. Make it public or unlisted again with youtube_update_metadata.',
  };
}
function alreadyArchivedError(): AppError { return new AppError('already_archived', 'This video is already private and not scheduled, so there is nothing to archive.', 'No action needed. Use youtube_update_metadata to change its visibility.', false); }

function metadataDesired(input: MetadataUpdateInput): MetadataDesired {
  return {
    snippet: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
      ...(input.defaultLanguage !== undefined ? { defaultLanguage: input.defaultLanguage } : {}),
    },
    status: {
      ...(input.privacyStatus !== undefined ? { privacyStatus: input.privacyStatus } : {}),
      ...(input.publishAt !== undefined ? { publishAt: input.publishAt } : {}),
      ...(input.containsSyntheticMedia !== undefined ? { containsSyntheticMedia: input.containsSyntheticMedia } : {}),
      ...(input.selfDeclaredMadeForKids !== undefined ? { selfDeclaredMadeForKids: input.selfDeclaredMadeForKids } : {}),
    },
  };
}

function captionUploadDesired(input: CaptionUploadInput, fileFingerprint: string): Record<string, unknown> {
  return { videoId: input.videoId, mimeType: input.mimeType, language: input.language, ...(input.name ? { name: input.name } : {}), ...(input.isDraft !== undefined ? { isDraft: input.isDraft } : {}), fileFingerprint };
}

function captionUpdateDesired(input: CaptionUpdateInput, fileFingerprint: string): Record<string, unknown> {
  return { captionId: input.captionId, ...captionUploadDesired(input, fileFingerprint) };
}

function captionDeleteDesired(input: CaptionDeleteInput, caption: CaptionTrack): Record<string, unknown> {
  return {
    videoId: input.videoId,
    captionId: input.captionId,
    target: {
      captionId: caption.id,
      videoId: caption.videoId,
      language: caption.language,
      ...(caption.name ? { name: caption.name } : {}),
      ...(caption.trackKind ? { trackKind: caption.trackKind } : {}),
      ...(caption.status ? { status: caption.status } : {}),
      ...(caption.isDraft !== undefined ? { isDraft: caption.isDraft } : {}),
      ...(caption.etag ? { etag: caption.etag } : {}),
    },
  };
}

function captionProviderInput(input: CaptionUploadInput, bytes: Uint8Array): { videoId: string; bytes: Uint8Array; mimeType: CaptionMimeType; language: string; name: string; isDraft?: boolean } {
  return { videoId: input.videoId, bytes, mimeType: input.mimeType, language: input.language, name: input.name, ...(input.isDraft !== undefined ? { isDraft: input.isDraft } : {}) };
}

function captionSnippet(input: { videoId: string; language: string; name: string; isDraft?: boolean }) {
  return { videoId: input.videoId, language: input.language, name: input.name, ...(input.isDraft !== undefined ? { isDraft: input.isDraft } : {}) };
}

function captionReconciliation(videoId: string) { return { tool: 'youtube_list_caption_tracks', arguments: { videoId } }; }

function requireMetadataFields(input: MetadataUpdateInput): void {
  if (Object.keys(metadataDesired(input).snippet as Record<string, unknown>).length === 0 && Object.keys(metadataDesired(input).status as Record<string, unknown>).length === 0) {
    throw new AppError('invalid_input', 'Choose at least one mutable video metadata field.', 'Provide the exact metadata fields to update.', false);
  }
}

function requireCaptionName(input: { name?: string }): asserts input is { name: string } {
  if (!input.name?.trim()) throw new AppError('invalid_input', 'A caption track name is required.', 'Provide a non-empty caption name.', false);
}

function requireElevatedIntent(input: MetadataUpdateInput): void {
  const elevated = input.privacyStatus === 'public' || input.publishAt !== undefined || input.containsSyntheticMedia !== undefined || input.selfDeclaredMadeForKids !== undefined;
  if (input.privacyStatus === 'public' && input.publish !== true) throw new AppError('publish_confirmation_required', 'Public visibility needs publish: true.', 'Review the target and repeat with publish: true.', false);
  if (elevated && input.elevated !== true) throw new AppError('elevated_confirmation_required', 'Public, scheduled, and synthetic-media changes need elevated: true.', 'Review the exact metadata change and repeat with elevated: true.', false);
}

async function validateLocalFile(filePath: string, mimeType: string, allowedMimeTypes: readonly string[], maximumBytes: number): Promise<{ fingerprint: string }> {
  return withValidatedLocalFile(filePath, mimeType, allowedMimeTypes, maximumBytes, async ({ fingerprint }) => ({ fingerprint }));
}

async function withValidatedLocalFile<T>(
  filePath: string,
  mimeType: string,
  allowedMimeTypes: readonly string[],
  maximumBytes: number,
  action: (file: { fingerprint: string; bytes: Uint8Array }) => Promise<T>,
): Promise<T> {
  if (!allowedMimeTypes.includes(mimeType)) throw invalidFileError();
  let handle: FileHandle;
  try {
    const entry = await lstat(filePath);
    if (!entry.isFile() || entry.isSymbolicLink()) throw invalidFileError();
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw invalidFileError();
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0 || info.size > maximumBytes) throw invalidFileError();
    const bytes = await handle.readFile();
    return await action({ fingerprint: createHash('sha256').update(bytes).digest('hex'), bytes });
  } finally {
    await handle.close();
  }
}

const captionExtensions = ['.srt', '.ttml', '.vtt', '.sbv'];

/**
 * Accepts a bare file name only: no separators, no leading dot. With `format` the extension must equal it;
 * without it (the track's original format, whose type is not known up front) any caption extension is allowed.
 */
export function sanitizeCaptionFileName(name: string, format?: string): string {
  const lower = name.toLowerCase();
  if (!name || name.length > 120 || name !== basename(name) || /[\\/\0]/.test(name) || name.startsWith('.') || !captionExtensions.some((ext) => lower.endsWith(ext)) || name === '..') {
    throw new AppError('invalid_input', 'fileName must be a plain file name ending in .srt, .ttml, .vtt, .sbv, with no directory parts.', 'Pass only a file name such as captions.vtt; files are written to the downloads folder in the state directory.', false);
  }
  if (format && !lower.endsWith(`.${format}`)) {
    throw new AppError('invalid_input', `fileName must end in .${format} to match format "${format}".`, `Rename the file to end in .${format}, or change format to match the extension.`, false);
  }
  return name;
}

/** Creates `<state dir>/downloads` (0700) and returns its real path, refusing a downloads directory that resolves outside the state directory. */
async function ensureDownloadsDirectory(stateDir: string): Promise<string> {
  try {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const downloads = join(stateDir, 'downloads');
    await mkdir(downloads, { recursive: true, mode: 0o700 });
    const realDownloads = await realpath(downloads);
    const expected = join(await realpath(stateDir), 'downloads');
    if (realDownloads !== expected || !(realDownloads + sep).startsWith(expected + sep)) throw invalidCaptionDestinationError();
    return realDownloads;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalidCaptionDestinationError();
  }
}

async function requireAvailableCaptionDestination(outputPath: string): Promise<void> {
  try {
    await lstat(outputPath);
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw invalidCaptionDestinationError();
  }
  throw captionDestinationExistsError();
}

async function writeCaptionDestination(outputPath: string, bytes: string | Uint8Array): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(
      outputPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (isAlreadyExistsError(error) || isSymbolicLinkError(error)) throw captionDestinationExistsError();
    throw invalidCaptionDestinationError();
  }
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
  } catch {
    await handle.close().catch(() => undefined);
    await unlink(outputPath).catch(() => undefined);
    throw invalidCaptionDestinationError();
  }
  await handle.close();
}

function normalizeVideo(video: CreatorVideo): CreatorVideo {
  return {
    id: video.id,
    channelId: video.channelId,
    ...(video.etag ? { etag: video.etag } : {}),
    snippet: { title: video.snippet.title, ...(video.snippet.description !== undefined ? { description: video.snippet.description } : {}), ...(video.snippet.tags ? { tags: [...video.snippet.tags] } : {}), ...(video.snippet.categoryId ? { categoryId: video.snippet.categoryId } : {}), ...(video.snippet.defaultLanguage ? { defaultLanguage: video.snippet.defaultLanguage } : {}) },
    status: {
      ...(video.status.privacyStatus ? { privacyStatus: video.status.privacyStatus } : {}),
      ...(video.status.publishAt ? { publishAt: video.status.publishAt } : {}),
      ...(video.status.license ? { license: video.status.license } : {}),
      ...(video.status.embeddable !== undefined ? { embeddable: video.status.embeddable } : {}),
      ...(video.status.publicStatsViewable !== undefined ? { publicStatsViewable: video.status.publicStatsViewable } : {}),
      ...(video.status.selfDeclaredMadeForKids !== undefined ? { selfDeclaredMadeForKids: video.status.selfDeclaredMadeForKids } : {}),
      ...(video.status.containsSyntheticMedia !== undefined ? { containsSyntheticMedia: video.status.containsSyntheticMedia } : {}),
    },
  };
}

function normalizeProviderVideo(value: unknown): CreatorVideo[] {
  const candidate = record(value); const snippet = record(candidate?.snippet); const status = record(candidate?.status);
  const id = string(candidate?.id); const channelId = string(snippet?.channelId); const title = string(snippet?.title);
  if (!id || !channelId || !title) return [];
  return [normalizeVideo({ id, channelId, ...(string(candidate?.etag) ? { etag: string(candidate?.etag) } : {}), snippet: { title, ...(string(snippet?.description) ? { description: string(snippet?.description) } : {}), ...(strings(snippet?.tags) ? { tags: strings(snippet?.tags)! } : {}), ...(string(snippet?.categoryId) ? { categoryId: string(snippet?.categoryId) } : {}), ...(string(snippet?.defaultLanguage) ? { defaultLanguage: string(snippet?.defaultLanguage) } : {}) }, status: { ...(string(status?.privacyStatus) ? { privacyStatus: string(status?.privacyStatus) } : {}), ...(string(status?.publishAt) ? { publishAt: string(status?.publishAt) } : {}), ...(string(status?.license) ? { license: string(status?.license) } : {}), ...(typeof status?.embeddable === 'boolean' ? { embeddable: status.embeddable } : {}), ...(typeof status?.publicStatsViewable === 'boolean' ? { publicStatsViewable: status.publicStatsViewable } : {}), ...(typeof status?.selfDeclaredMadeForKids === 'boolean' ? { selfDeclaredMadeForKids: status.selfDeclaredMadeForKids } : {}), ...(typeof status?.containsSyntheticMedia === 'boolean' ? { containsSyntheticMedia: status.containsSyntheticMedia } : {}) } })];
}

function normalizeProviderCaption(value: unknown): Array<{ id: string; videoId: string; language: string; name?: string; etag?: string }> {
  const candidate = record(value); const snippet = record(candidate?.snippet); const id = string(candidate?.id); const videoId = string(snippet?.videoId); const language = string(snippet?.language);
  return id && videoId && language ? [{ id, videoId, language, ...(string(snippet?.name) ? { name: string(snippet?.name) } : {}), ...(string(candidate?.etag) ? { etag: string(candidate?.etag) } : {}) }] : [];
}

function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(sort(value))).digest('hex'); }
function sort(value: unknown): unknown { if (Array.isArray(value)) return value.map(sort); if (!value || typeof value !== 'object') return value; return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sort((value as Record<string, unknown>)[key])])); }
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === 'object' ? value as Record<string, unknown> : undefined; }
function string(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined; }
function strings(value: unknown): string[] | undefined { return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined; }
function idResponse(value: unknown): { id?: string } { return string(record(value)?.id) ? { id: string(record(value)?.id) } : {}; }
function requiredId(value: string | undefined, resource: string): string { if (!value) throw providerError(resource); return value; }
function ownershipRequiredError(): AppError { return new AppError('ownership_required', 'This resource is not owned by the selected creator channel.', 'Select the owning creator profile or use an owned resource ID.', false); }
function approvalRequiredError(): AppError { return new AppError('approval_required', 'This operation requires an approved preview.', 'Preflight, approve, and repeat with confirm: true.', false); }
function invalidFileError(): AppError { return new AppError('invalid_file', 'The selected local media file is missing, empty, or exceeds the supported size.', 'Choose a readable supported local file and preflight again.', false); }
function captionDestinationExistsError(): AppError { return new AppError('caption_destination_exists', 'The caption download destination already exists.', 'Choose a new fileName; existing files and symbolic links are never overwritten.', false); }
function invalidCaptionDestinationError(): AppError { return new AppError('invalid_caption_destination', 'The caption download destination could not be created safely.', 'Check that the downloads folder in the state directory is writable and not a symbolic link elsewhere, then retry.', false); }
function providerError(resource: string): AppError { return new AppError('provider_error', `The YouTube provider did not return a valid ${resource}.`, 'Try again. If the problem continues, verify the provider configuration.', true); }
function isMissingFileError(error: unknown): error is NodeJS.ErrnoException { return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException { return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EEXIST'; }
function isSymbolicLinkError(error: unknown): error is NodeJS.ErrnoException { return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ELOOP'; }
