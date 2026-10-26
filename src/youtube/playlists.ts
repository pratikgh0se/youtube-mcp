import { createHash } from 'node:crypto';

import type { ConnectionProfile, OperationPreview, OperationReceipt } from '../types.js';
import { AppError, providerOutcomeUnknownError, toSafeError } from '../errors.js';
import { OperationService } from '../operations/service.js';
import type { OAuthService } from '../auth/oauth.js';
import { YouTubeClient, type YouTubeDataApi } from './client.js';

type CreatorProfile = ConnectionProfile & { purpose: 'creator'; channelId: string };
type PlaylistPrivacy = 'private' | 'unlisted' | 'public';
export type PlaylistInput = { title?: string; description?: string; privacyStatus?: PlaylistPrivacy; approvalId?: string; confirm?: boolean };
export type CreatePlaylistInput = PlaylistInput & { title: string };
export type UpdatePlaylistInput = PlaylistInput & { playlistId: string };
export type PlaylistItemInput = { playlistId: string; playlistItemId?: string; videoId?: string; position?: number; approvalId?: string; confirm?: boolean };
export type PlaylistProvider = {
  getPlaylist(playlistId: string): Promise<ProviderPlaylist | undefined>;
  getPlaylistItem(playlistItemId: string): Promise<ProviderPlaylistItem | undefined>;
  createPlaylist(input: { title: string; description?: string; privacyStatus: PlaylistPrivacy }): Promise<{ id?: string }>;
  updatePlaylist(input: { id: string; title: string; description?: string; privacyStatus?: string }): Promise<{ id?: string }>;
  deletePlaylist(input: { id: string }): Promise<void>;
  addPlaylistItem(input: { playlistId: string; videoId: string }): Promise<{ id?: string }>;
  removePlaylistItem(input: { id: string }): Promise<void>;
  reorderPlaylistItem(input: { id: string; playlistId: string; videoId: string; position: number }): Promise<{ id?: string }>;
};
export type ProviderPlaylist = { id: string; channelId: string; title: string; description?: string; privacyStatus?: string; etag?: string };
export type ProviderPlaylistItem = { id: string; playlistId: string; videoId: string; position?: number; etag?: string };

export class PlaylistService {
  constructor(
    private readonly operations: OperationService,
    private readonly provider: PlaylistProvider,
    private readonly profile: CreatorProfile,
    private readonly principal: { verifyPrincipal(): Promise<unknown> },
  ) {}

  async preflightCreate(input: CreatePlaylistInput): Promise<OperationPreview> {
    try {
      await this.principal.verifyPrincipal();
      const desired = createDesired(input);
      return this.preflight('playlist.create', `new:${fingerprint(desired)}`, desired, fingerprint(desired), { tool: 'youtube_list_playlists', arguments: {} });
    } catch (error) { throw toSafeError(error); }
  }

  async create(input: CreatePlaylistInput & { approvalId: string }): Promise<OperationReceipt & { playlistId: string }> {
    try {
      const desired = createDesired(input);
      await this.requireApproved(input, 'playlist.create', `new:${fingerprint(desired)}`, desired);
      await this.principal.verifyPrincipal();
      await this.claim(input, 'playlist.create', `new:${fingerprint(desired)}`, desired, fingerprint(desired));
      try {
        const playlistId = requiredId((await this.provider.createPlaylist(desired)).id, 'playlist');
        return { ...await this.settle(input.approvalId, 'succeeded'), playlistId };
      } catch (error) {
        await this.settle(input.approvalId, 'unknown');
        throw providerOutcomeUnknownError(input.approvalId, { tool: 'youtube_list_playlists', arguments: {} });
      }
    } catch (error) { throw toSafeError(error); }
  }

  async preflightUpdate(input: UpdatePlaylistInput): Promise<OperationPreview> {
    try {
      await this.principal.verifyPrincipal();
      const current = await this.ownedPlaylist(input.playlistId);
      const desired = updateDesired(input);
      return this.preflight('playlist.update', input.playlistId, desired, fingerprint(current), playlistMetadataReconciliation(input.playlistId));
    } catch (error) { throw toSafeError(error); }
  }

  async update(input: UpdatePlaylistInput & { approvalId: string }): Promise<OperationReceipt & { playlistId: string }> {
    try {
      const desired = updateDesired(input);
      await this.requireApproved(input, 'playlist.update', input.playlistId, desired);
      await this.principal.verifyPrincipal();
      const current = await this.ownedPlaylist(input.playlistId);
      await this.claim(input, 'playlist.update', input.playlistId, desired, fingerprint(current));
      try {
        const response = await this.provider.updatePlaylist({ id: current.id, ...mergePlaylist(current, desired) });
        if (response.id && response.id !== input.playlistId) throw providerError('playlist');
        return { ...await this.settle(input.approvalId, 'succeeded'), playlistId: input.playlistId };
      } catch (error) {
        await this.settle(input.approvalId, 'unknown');
        throw providerOutcomeUnknownError(input.approvalId, playlistMetadataReconciliation(input.playlistId));
      }
    } catch (error) { throw toSafeError(error); }
  }

  async preflightDelete(input: { playlistId: string }): Promise<OperationPreview> {
    try {
      await this.principal.verifyPrincipal();
      const playlist = await this.ownedPlaylist(input.playlistId);
      const desired = deleteDesired(playlist);
      return this.preflight('playlist.delete', input.playlistId, desired, fingerprint(playlist), playlistMetadataReconciliation(input.playlistId));
    } catch (error) { throw toSafeError(error); }
  }

  async delete(input: { playlistId: string; approvalId: string; confirm?: boolean }): Promise<OperationReceipt & { playlistId: string; deleted: true }> {
    try {
      await this.requireApproved(input, 'playlist.delete', input.playlistId);
      await this.principal.verifyPrincipal();
      const playlist = await this.ownedPlaylist(input.playlistId);
      await this.claim(input, 'playlist.delete', input.playlistId, undefined, fingerprint(playlist));
      try {
        await this.provider.deletePlaylist({ id: input.playlistId });
        return { ...await this.settle(input.approvalId, 'succeeded'), playlistId: input.playlistId, deleted: true };
      } catch (error) {
        await this.settle(input.approvalId, 'unknown');
        throw providerOutcomeUnknownError(input.approvalId, playlistMetadataReconciliation(input.playlistId));
      }
    } catch (error) { throw toSafeError(error); }
  }

  async preflightAdd(input: PlaylistItemInput & { videoId: string }): Promise<OperationPreview> {
    try {
      await this.principal.verifyPrincipal();
      const playlist = await this.ownedPlaylist(input.playlistId);
      const desired = { playlistId: input.playlistId, videoId: input.videoId };
      return this.preflight('playlist.item.add', input.playlistId, desired, fingerprint(playlist), playlistReconciliation(input.playlistId));
    } catch (error) { throw toSafeError(error); }
  }

  async add(input: PlaylistItemInput & { videoId: string; approvalId: string }): Promise<OperationReceipt & { playlistId: string; playlistItemId: string }> {
    try {
      const desired = { playlistId: input.playlistId, videoId: input.videoId };
      await this.requireApproved(input, 'playlist.item.add', input.playlistId, desired);
      await this.principal.verifyPrincipal();
      const playlist = await this.ownedPlaylist(input.playlistId);
      await this.claim(input, 'playlist.item.add', input.playlistId, desired, fingerprint(playlist));
      try {
        const playlistItemId = requiredId((await this.provider.addPlaylistItem(desired)).id, 'playlist item');
        return { ...await this.settle(input.approvalId, 'succeeded'), playlistId: input.playlistId, playlistItemId };
      } catch (error) {
        await this.settle(input.approvalId, 'unknown');
        throw providerOutcomeUnknownError(input.approvalId, playlistReconciliation(input.playlistId));
      }
    } catch (error) { throw toSafeError(error); }
  }

  async preflightRemove(input: PlaylistItemInput & { playlistItemId: string }): Promise<OperationPreview> {
    try {
      await this.principal.verifyPrincipal();
      const item = await this.ownedItem(input.playlistId, input.playlistItemId);
      const desired = removeDesired(input, item);
      return this.preflight('playlist.item.remove', input.playlistItemId, desired, fingerprint(item), playlistReconciliation(input.playlistId));
    } catch (error) { throw toSafeError(error); }
  }

  async remove(input: PlaylistItemInput & { playlistItemId: string; approvalId: string }): Promise<OperationReceipt & { playlistId: string; playlistItemId: string; removed: true }> {
    try {
      await this.requireApproved(input, 'playlist.item.remove', input.playlistItemId);
      await this.principal.verifyPrincipal();
      const item = await this.ownedItem(input.playlistId, input.playlistItemId);
      await this.claim(input, 'playlist.item.remove', input.playlistItemId, undefined, fingerprint(item));
      try {
        await this.provider.removePlaylistItem({ id: input.playlistItemId });
        return { ...await this.settle(input.approvalId, 'succeeded'), playlistId: input.playlistId, playlistItemId: input.playlistItemId, removed: true };
      } catch (error) {
        await this.settle(input.approvalId, 'unknown');
        throw providerOutcomeUnknownError(input.approvalId, playlistReconciliation(input.playlistId));
      }
    } catch (error) { throw toSafeError(error); }
  }

  async preflightReorder(input: PlaylistItemInput & { playlistItemId: string; position: number }): Promise<OperationPreview> {
    try {
      await this.principal.verifyPrincipal();
      const item = await this.ownedItem(input.playlistId, input.playlistItemId);
      const desired = reorderDesired(input);
      return this.preflight('playlist.item.reorder', input.playlistItemId, desired, fingerprint(item), playlistReconciliation(input.playlistId));
    } catch (error) { throw toSafeError(error); }
  }

  async reorder(input: PlaylistItemInput & { playlistItemId: string; position: number; approvalId: string }): Promise<OperationReceipt & { playlistId: string; playlistItemId: string }> {
    try {
      const desired = reorderDesired(input);
      await this.requireApproved(input, 'playlist.item.reorder', input.playlistItemId, desired);
      await this.principal.verifyPrincipal();
      const item = await this.ownedItem(input.playlistId, input.playlistItemId);
      await this.claim(input, 'playlist.item.reorder', input.playlistItemId, desired, fingerprint(item));
      try {
        const response = await this.provider.reorderPlaylistItem({ id: input.playlistItemId, playlistId: input.playlistId, videoId: item.videoId, position: input.position });
        if (response.id && response.id !== input.playlistItemId) throw providerError('playlist item');
        return { ...await this.settle(input.approvalId, 'succeeded'), playlistId: input.playlistId, playlistItemId: input.playlistItemId };
      } catch (error) {
        await this.settle(input.approvalId, 'unknown');
        throw providerOutcomeUnknownError(input.approvalId, playlistReconciliation(input.playlistId));
      }
    } catch (error) { throw toSafeError(error); }
  }

  async approve(input: { approvalId: string; confirm?: boolean }): Promise<OperationPreview> {
    return this.operations.approve({ ...input, profileId: this.profile.id, channelId: this.profile.channelId });
  }

  private async ownedPlaylist(playlistId: string): Promise<ProviderPlaylist> {
    const playlist = await this.provider.getPlaylist(playlistId);
    if (!playlist || playlist.id !== playlistId || playlist.channelId !== this.profile.channelId || !playlist.title) throw ownershipRequiredError();
    return playlist;
  }

  private async ownedItem(playlistId: string, playlistItemId: string): Promise<ProviderPlaylistItem> {
    await this.ownedPlaylist(playlistId);
    const item = await this.provider.getPlaylistItem(playlistItemId);
    if (!item || item.id !== playlistItemId || item.playlistId !== playlistId || !item.videoId) throw ownershipRequiredError();
    return item;
  }

  private async preflight(kind: string, targetId: string, desired: Record<string, unknown>, currentFingerprint: string, reconciliation: OperationReceipt['reconciliation']): Promise<OperationPreview> {
    return this.operations.preflight({ profile: this.profile, kind, targetId, desired, currentFingerprint, reconciliation });
  }

  private async claim(input: { approvalId: string; confirm?: boolean }, kind: string, targetId: string, desired: Record<string, unknown> | undefined, currentFingerprint: string): Promise<void> {
    await this.operations.claim({ ...input, currentFingerprint, profileId: this.profile.id, channelId: this.profile.channelId });
  }

  private async requireApproved(input: { approvalId: string; confirm?: boolean }, kind: string, targetId: string, desired?: Record<string, unknown>): Promise<void> {
    const preview = await this.operations.requireApproved({ ...input, profileId: this.profile.id, channelId: this.profile.channelId });
    this.requireContext(preview, kind, targetId, desired);
  }

  private requireContext(preview: OperationPreview, kind: string, targetId: string, desired?: Record<string, unknown>): void {
    if (preview.kind !== kind || preview.targetId !== targetId || (desired && preview.desiredFingerprint !== fingerprint(desired))) throw approvalRequiredError();
  }

  private settle(operationId: string, state: 'succeeded' | 'unknown'): Promise<OperationReceipt> {
    return this.operations.settle({ operationId, profileId: this.profile.id, channelId: this.profile.channelId, state });
  }
}

function createDesired(input: CreatePlaylistInput): { title: string; description?: string; privacyStatus: PlaylistPrivacy } {
  return { title: input.title, ...(input.description !== undefined ? { description: input.description } : {}), privacyStatus: input.privacyStatus ?? 'private' };
}

function updateDesired(input: UpdatePlaylistInput): Record<string, unknown> {
  const desired = { ...(input.title !== undefined ? { title: input.title } : {}), ...(input.description !== undefined ? { description: input.description } : {}), ...(input.privacyStatus !== undefined ? { privacyStatus: input.privacyStatus } : {}) };
  if (Object.keys(desired).length === 0) throw new AppError('invalid_input', 'A playlist update needs at least one changed field.', 'Provide title, description, or privacyStatus.', false);
  return desired;
}

function deleteDesired(playlist: ProviderPlaylist): Record<string, unknown> {
  return {
    playlistId: playlist.id,
    target: {
      id: playlist.id,
      channelId: playlist.channelId,
      title: playlist.title,
      ...(playlist.etag ? { etag: playlist.etag } : {}),
    },
  };
}

function reorderDesired(input: { playlistId: string; position: number }): { playlistId: string; position: number } {
  if (!Number.isInteger(input.position) || input.position < 0) throw new AppError('invalid_input', 'Playlist position must be a non-negative integer.', 'Provide a valid target position.', false);
  return { playlistId: input.playlistId, position: input.position };
}

function removeDesired(
  input: { playlistId: string; playlistItemId: string },
  item: ProviderPlaylistItem,
): Record<string, unknown> {
  return {
    playlistId: input.playlistId,
    playlistItemId: input.playlistItemId,
    target: {
      id: item.id,
      playlistId: item.playlistId,
      videoId: item.videoId,
      ...(item.position !== undefined ? { position: item.position } : {}),
      ...(item.etag ? { etag: item.etag } : {}),
    },
  };
}

function mergePlaylist(current: ProviderPlaylist, desired: Record<string, unknown>): { title: string; description?: string; privacyStatus?: string } {
  return { title: typeof desired.title === 'string' ? desired.title : current.title, ...(typeof desired.description === 'string' ? { description: desired.description } : current.description !== undefined ? { description: current.description } : {}), ...(typeof desired.privacyStatus === 'string' ? { privacyStatus: desired.privacyStatus } : current.privacyStatus !== undefined ? { privacyStatus: current.privacyStatus } : {}) };
}

function playlistReconciliation(playlistId: string) { return { tool: 'youtube_list_playlist_items', arguments: { playlistId } }; }
function playlistMetadataReconciliation(playlistId: string) { return { tool: 'youtube_get_playlist', arguments: { playlistId } }; }
function requiredId(value: string | undefined, resource: string): string { if (!value) throw providerError(resource); return value; }
function ownershipRequiredError() { return new AppError('ownership_required', 'This resource is not owned by the selected creator channel.', 'Select the owning creator profile or use an owned resource ID.', false); }
function approvalRequiredError() { return new AppError('approval_required', 'This operation requires an exact approved preview.', 'Preflight and approve the exact change before executing it.', false); }
function providerError(resource: string) { return new AppError('provider_error', `The YouTube provider returned an incomplete ${resource} result.`, 'Use the reconciliation receipt before attempting another mutation.', true); }
function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(sortValue(value))).digest('hex'); }
function sortValue(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortValue); if (typeof value !== 'object' || value === null) return value; return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sortValue((value as Record<string, unknown>)[key])])); }

export function createPlaylistProvider(oauth: Pick<OAuthService, 'getAccessToken'>, client: YouTubeClient): PlaylistProvider {
  async function api(): Promise<PlaylistApi> {
    const candidate = client.authorized(await oauth.getAccessToken('youtube.write'));
    if (!candidate.playlists.insert || !candidate.playlists.update || !candidate.playlists.delete || !candidate.playlistItems.insert || !candidate.playlistItems.update || !candidate.playlistItems.delete) throw providerError('playlist API');
    return candidate as PlaylistApi;
  }
  return {
    async getPlaylist(playlistId) {
      const response = await (await api()).playlists.list({ part: ['snippet', 'status'], id: [playlistId] });
      return (response.data.items ?? []).flatMap(normalizePlaylist)[0];
    },
    async getPlaylistItem(playlistItemId) {
      const response = await (await api()).playlistItems.list({ part: ['snippet'], id: [playlistItemId] });
      return (response.data.items ?? []).flatMap(normalizePlaylistItem)[0];
    },
    async createPlaylist(input) { return idResponse((await (await api()).playlists.insert({ part: ['snippet', 'status'], requestBody: { snippet: { title: input.title, ...(input.description !== undefined ? { description: input.description } : {}) }, status: { privacyStatus: input.privacyStatus } } })).data); },
    async updatePlaylist(input) { return idResponse((await (await api()).playlists.update({ part: ['snippet', 'status'], requestBody: { id: input.id, snippet: { title: input.title, ...(input.description !== undefined ? { description: input.description } : {}) }, ...(input.privacyStatus !== undefined ? { status: { privacyStatus: input.privacyStatus } } : {}) } })).data); },
    async deletePlaylist(input) { await (await api()).playlists.delete({ id: input.id }); },
    async addPlaylistItem(input) { return idResponse((await (await api()).playlistItems.insert({ part: ['snippet'], requestBody: { snippet: { playlistId: input.playlistId, resourceId: { kind: 'youtube#video', videoId: input.videoId } } } })).data); },
    async removePlaylistItem(input) { await (await api()).playlistItems.delete({ id: input.id }); },
    async reorderPlaylistItem(input) { return idResponse((await (await api()).playlistItems.update({ part: ['snippet'], requestBody: { id: input.id, snippet: { playlistId: input.playlistId, position: input.position, resourceId: { kind: 'youtube#video', videoId: input.videoId } } } })).data); },
  };
}

type PlaylistApi = YouTubeDataApi & {
  playlists: YouTubeDataApi['playlists'] & { insert: NonNullable<YouTubeDataApi['playlists']['insert']>; update: NonNullable<YouTubeDataApi['playlists']['update']>; delete: NonNullable<YouTubeDataApi['playlists']['delete']> };
  playlistItems: YouTubeDataApi['playlistItems'] & { insert: NonNullable<YouTubeDataApi['playlistItems']['insert']>; update: NonNullable<YouTubeDataApi['playlistItems']['update']>; delete: NonNullable<YouTubeDataApi['playlistItems']['delete']> };
};
function normalizePlaylist(value: unknown): ProviderPlaylist[] { const record = asRecord(value); const snippet = asRecord(record?.snippet); const status = asRecord(record?.status); const id = stringValue(record?.id); const channelId = stringValue(snippet?.channelId); const title = stringValue(snippet?.title); return id && channelId && title ? [{ id, channelId, title, ...optionalString('description', snippet?.description), ...optionalString('privacyStatus', status?.privacyStatus), ...optionalString('etag', record?.etag) }] : []; }
function normalizePlaylistItem(value: unknown): ProviderPlaylistItem[] { const record = asRecord(value); const snippet = asRecord(record?.snippet); const resourceId = asRecord(snippet?.resourceId); const id = stringValue(record?.id); const playlistId = stringValue(snippet?.playlistId); const videoId = stringValue(resourceId?.videoId); return id && playlistId && videoId ? [{ id, playlistId, videoId, ...(typeof snippet?.position === 'number' ? { position: snippet.position } : {}), ...optionalString('etag', record?.etag) }] : []; }
function idResponse(value: unknown): { id?: string } { return { ...(stringValue(asRecord(value)?.id) ? { id: stringValue(asRecord(value)?.id)! } : {}) }; }
function asRecord(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined; }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined; }
function optionalString<Key extends string>(key: Key, value: unknown): Partial<Record<Key, string>> { const normalized = stringValue(value); return normalized ? { [key]: normalized } as Partial<Record<Key, string>> : {}; }
