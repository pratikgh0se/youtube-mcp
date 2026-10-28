import { createHash } from 'node:crypto';

import type { ConnectionProfile, OperationPreview, OperationReceipt } from '../types.js';
import { AppError, isDefinitiveRejection, providerOutcomeUnknownError, toSafeError } from '../errors.js';
import { OperationService } from '../operations/service.js';
import type { OAuthService } from '../auth/oauth.js';
import { YouTubeClient, type YouTubeDataApi } from './client.js';

type CreatorProfile = ConnectionProfile & { purpose: 'creator'; channelId: string };

export type ChannelFields = { description?: string; keywords?: string; country?: string; defaultLanguage?: string };
export type UpdateChannelInput = ChannelFields & { approvalId?: string; confirm?: boolean };
type BrandingSettings = Record<string, unknown> & { channel?: Record<string, unknown> };
export type ProviderChannel = { id: string; etag?: string; title?: string; brandingSettings: BrandingSettings };
export type ChannelProvider = {
  getChannel(channelId: string): Promise<ProviderChannel | undefined>;
  /** Sends the COMPLETE brandingSettings object; channels.update replaces the whole part. */
  updateBranding(input: { id: string; brandingSettings: BrandingSettings }): Promise<{ id?: string }>;
};

const editable = ['description', 'keywords', 'country', 'defaultLanguage'] as const;
const kind = 'channel.update';

export class ChannelProfileService {
  constructor(
    private readonly operations: OperationService,
    private readonly provider: ChannelProvider,
    private readonly profile: CreatorProfile,
    private readonly principal: { verifyPrincipal(): Promise<unknown> },
  ) {}

  async preflightUpdate(input: ChannelFields): Promise<OperationPreview> {
    try {
      const desired = desiredOf(input);
      await this.principal.verifyPrincipal();
      const current = await this.ownedChannel();
      const before = currentFields(current);
      const changed = Object.keys(desired).filter((key) => before[key as keyof ChannelFields] !== desired[key as keyof ChannelFields]);
      if (changed.length === 0) {
        throw new AppError('invalid_input', 'The requested channel fields already match the current channel.', 'Nothing to update; change at least one field.', false);
      }
      return this.operations.preflight({
        profile: this.profile,
        kind,
        targetId: this.profile.channelId,
        // current is shown next to desired so the human sees exactly what changes.
        desired: { ...desired, current: Object.fromEntries(Object.keys(desired).map((key) => [key, before[key as keyof ChannelFields] ?? null])) },
        currentFingerprint: fingerprint(current.brandingSettings),
        reconciliation: reconciliation(),
      });
    } catch (error) { throw toSafeError(error); }
  }

  async update(input: UpdateChannelInput & { approvalId: string }): Promise<OperationReceipt & { channelId: string }> {
    try {
      const desired = desiredOf(input);
      const preview = await this.operations.requireApproved({ ...input, profileId: this.profile.id, channelId: this.profile.channelId });
      if (preview.kind !== kind || preview.targetId !== this.profile.channelId || !sameFields(preview.desired, desired)) {
        throw new AppError('approval_required', 'This operation requires an exact approved preview.', 'Preflight and approve the exact change before executing it.', false);
      }
      await this.principal.verifyPrincipal();
      // claim() below compares the preflight-time fingerprint of brandingSettings with a fresh read: a changed channel is stale_preview.
      const current = await this.ownedChannel();
      await this.operations.claim({ ...input, currentFingerprint: fingerprint(current.brandingSettings), profileId: this.profile.id, channelId: this.profile.channelId });
      try {
        const response = await this.provider.updateBranding({ id: this.profile.channelId, brandingSettings: mergeBranding(current.brandingSettings, desired) });
        if (response.id && response.id !== this.profile.channelId) throw providerError();
        return { ...await this.settle(input.approvalId, 'succeeded'), channelId: this.profile.channelId };
      } catch (error) {
        const definitive = isDefinitiveRejection(error);
        await this.settle(input.approvalId, definitive ? 'failed' : 'unknown');
        throw definitive ? toSafeError(error) : providerOutcomeUnknownError(input.approvalId, reconciliation());
      }
    } catch (error) { throw toSafeError(error); }
  }

  private async ownedChannel(): Promise<ProviderChannel> {
    const channel = await this.provider.getChannel(this.profile.channelId);
    if (!channel || channel.id !== this.profile.channelId) {
      throw new AppError('ownership_required', 'This channel is not the selected creator channel.', 'Select the owning creator profile.', false);
    }
    // channels.update replaces the whole brandingSettings part, so an update built from an empty or partial read would wipe the channel's settings.
    const brandingChannel = asRecord(channel.brandingSettings.channel);
    if (!channel.title || !brandingChannel || Object.keys(brandingChannel).length === 0) {
      throw new AppError('provider_error', 'YouTube returned incomplete channel settings.', 'YouTube returned incomplete channel settings; nothing was changed. Try again later.', true);
    }
    return channel;
  }

  private settle(operationId: string, state: 'succeeded' | 'failed' | 'unknown'): Promise<OperationReceipt> {
    return this.operations.settle({ operationId, profileId: this.profile.id, channelId: this.profile.channelId, state });
  }
}

/**
 * channels.update replaces the whole brandingSettings part: any writable field left out of brandingSettings.channel
 * (keywords, country, unsubscribedTrailer, featuredChannelsUrls, ...) is cleared. So the request is the current object,
 * deep-cloned, with ONLY the desired channel fields overwritten.
 */
export function mergeBranding(current: BrandingSettings, desired: ChannelFields): BrandingSettings {
  const merged = structuredClone(current);
  merged.channel = { ...(merged.channel ?? {}), ...desired };
  return merged;
}

function desiredOf(input: ChannelFields): ChannelFields {
  const desired: ChannelFields = {};
  for (const key of editable) {
    const value = input[key];
    if (value !== undefined) desired[key] = key === 'country' ? value.toUpperCase() : value;
  }
  if (Object.keys(desired).length === 0) {
    throw new AppError('invalid_input', 'A channel update needs at least one changed field.', 'Provide description, keywords, country, or defaultLanguage.', false);
  }
  return desired;
}

function currentFields(channel: ProviderChannel): ChannelFields {
  const branding = channel.brandingSettings.channel ?? {};
  const fields: ChannelFields = {};
  for (const key of editable) {
    if (typeof branding[key] === 'string') fields[key] = branding[key];
  }
  return fields;
}

function sameFields(previewDesired: Record<string, unknown>, desired: ChannelFields): boolean {
  return editable.every((key) => previewDesired[key] === desired[key]);
}

function reconciliation() { return { tool: 'youtube_my_account', arguments: {} }; }
function providerError() { return new AppError('provider_error', 'The YouTube provider returned an incomplete channel result.', 'Re-read the channel before attempting another mutation.', true); }
function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(sortValue(value))).digest('hex'); }
function sortValue(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortValue); if (typeof value !== 'object' || value === null) return value; return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sortValue((value as Record<string, unknown>)[key])])); }
function asRecord(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined; }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined; }

export function createChannelProvider(oauth: Pick<OAuthService, 'getAccessToken'>, client: YouTubeClient): ChannelProvider {
  type ChannelApi = YouTubeDataApi & { channels: YouTubeDataApi['channels'] & { update: NonNullable<YouTubeDataApi['channels']['update']> } };
  async function api(): Promise<ChannelApi> {
    const candidate = client.authorized(await oauth.getAccessToken('youtube.write'));
    if (!candidate.channels.update) throw providerError();
    return candidate as ChannelApi;
  }
  return {
    async getChannel(channelId) {
      const response = await (await api()).channels.list({ part: 'snippet,brandingSettings', id: channelId });
      const record = asRecord(response.data.items?.[0]);
      const id = stringValue(record?.id);
      const branding = asRecord(record?.brandingSettings);
      const title = stringValue(asRecord(record?.snippet)?.title);
      return id ? { id, ...(title ? { title } : {}), ...(stringValue(record?.etag) ? { etag: stringValue(record?.etag)! } : {}), brandingSettings: (branding ?? {}) as BrandingSettings } : undefined;
    },
    async updateBranding(input) {
      const response = await (await api()).channels.update({ part: ['brandingSettings'], requestBody: { id: input.id, brandingSettings: input.brandingSettings } });
      const id = stringValue(asRecord(response.data)?.id);
      return id ? { id } : {};
    },
  };
}
