import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../src/errors.js';
import { OperationService } from '../../src/operations/service.js';
import { OperationStore } from '../../src/operations/store.js';
import { ChannelProfileService, createChannelProvider, mergeBranding, type ProviderChannel } from '../../src/youtube/channel-profile.js';
import { YouTubeClient } from '../../src/youtube/client.js';
import { preflightUpdateChannelSchema } from '../../src/mcp/schemas.js';
import { testYouTubeApi } from '../helpers/youtube-api.js';

const directories: string[] = [];
const creator = { id: 'creator-a', purpose: 'creator' as const, channelId: 'UC-mine' };
afterEach(async () => { await Promise.all(directories.splice(0).map((d) => rm(d, { force: true, recursive: true }))); });

const branding = () => ({
  channel: {
    title: 'Mine', description: 'Old description', keywords: 'a b', country: 'TH', defaultLanguage: 'en',
    unsubscribedTrailer: 'trailer1', moderateComments: true, showRelatedChannels: true,
  },
  image: { bannerExternalUrl: 'https://yt3.example/banner' },
});

async function setup(options: { channel?: () => ProviderChannel | undefined; verify?: () => Promise<unknown> } = {}, profile = creator, operations?: OperationService) {
  const stateDir = await mkdtemp(join(tmpdir(), 'youtube-mcp-channel-'));
  directories.push(stateDir);
  let channel: ProviderChannel | undefined = { id: 'UC-mine', brandingSettings: branding() };
  const provider = {
    getChannel: vi.fn(async () => (options.channel ? options.channel() : channel)),
    updateBranding: vi.fn(async (input: { id: string }) => ({ id: input.id })),
  };
  const ops = operations ?? new OperationService(new OperationStore(stateDir), () => new Date('2026-10-28T00:00:00.000Z'));
  const service = new ChannelProfileService(ops, provider, profile, { verifyPrincipal: options.verify ?? (async () => creator) });
  const approve = (approvalId: string) => ops.approve({ approvalId, confirm: true, profileId: profile.id, channelId: profile.channelId });
  return { service, provider, ops, approve, setChannel: (next: ProviderChannel) => { channel = next; } };
}

describe('channel profile update', () => {
  it('requires at least one field', () => {
    expect(preflightUpdateChannelSchema.safeParse({}).success).toBe(false);
    expect(preflightUpdateChannelSchema.safeParse({ description: '' }).success).toBe(true);
    expect(preflightUpdateChannelSchema.safeParse({ country: 'THA' }).success).toBe(false);
    expect(preflightUpdateChannelSchema.safeParse({ description: 'x'.repeat(1001) }).success).toBe(false);
  });

  it('previews current versus desired and refuses a no-op', async () => {
    const { service } = await setup();
    const preview = await service.preflightUpdate({ description: 'New description', country: 'th' });
    expect(preview).toMatchObject({ kind: 'channel.update', targetId: 'UC-mine', state: 'planned' });
    expect(preview.desired).toEqual({ description: 'New description', country: 'TH', current: { description: 'Old description', country: 'TH' } });
    await expect(service.preflightUpdate({ description: 'Old description' })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('sends the FULL brandingSettings so untouched fields are not wiped (read-modify-write)', async () => {
    const { service, provider, approve } = await setup();
    const preview = await service.preflightUpdate({ description: 'New description' });
    await approve(preview.approvalId);
    const receipt = await service.update({ description: 'New description', approvalId: preview.approvalId, confirm: true });
    expect(receipt).toMatchObject({ state: 'succeeded', channelId: 'UC-mine' });
    const sent = provider.updateBranding.mock.calls[0]![0] as { id: string; brandingSettings: ReturnType<typeof branding> };
    expect(sent.id).toBe('UC-mine');
    expect(sent.brandingSettings).toEqual({ ...branding(), channel: { ...branding().channel, description: 'New description' } });
  });

  it('mergeBranding overwrites only the desired fields and does not mutate its input', () => {
    const current = branding();
    const merged = mergeBranding(current, { keywords: 'x y' });
    expect(merged.channel).toEqual({ ...branding().channel, keywords: 'x y' });
    expect(current).toEqual(branding());
    expect(mergeBranding({}, { country: 'US' })).toEqual({ channel: { country: 'US' } });
  });

  it('provider sends part=brandingSettings with the full object through channels.update', async () => {
    const updates: Record<string, unknown>[] = [];
    const api = testYouTubeApi({ channels: {
      list: async () => ({ data: { items: [{ id: 'UC-mine', etag: 'e', brandingSettings: branding() }] } }),
      update: async (request) => { updates.push(request); return { data: { id: 'UC-mine' } }; },
    } });
    const provider = createChannelProvider({ getAccessToken: async () => 't' }, new YouTubeClient({ stateDir: '/tmp/x', diagnostics: () => '' }, { createPublicApi: () => api, createAuthorizedApi: () => api }));
    const current = await provider.getChannel('UC-mine');
    await provider.updateBranding({ id: 'UC-mine', brandingSettings: mergeBranding(current!.brandingSettings, { description: 'd' }) });
    expect(updates).toEqual([{ part: ['brandingSettings'], requestBody: { id: 'UC-mine', brandingSettings: { ...branding(), channel: { ...branding().channel, description: 'd' } } } }]);
  });

  it('rejects an unapproved, mismatched or wrong-profile execution without calling YouTube', async () => {
    const { service, provider, approve, ops } = await setup();
    const preview = await service.preflightUpdate({ description: 'New description' });
    await expect(service.update({ description: 'New description', approvalId: preview.approvalId, confirm: true })).rejects.toMatchObject({ code: 'approval_required' });
    await approve(preview.approvalId);
    await expect(service.update({ description: 'Different', approvalId: preview.approvalId, confirm: true })).rejects.toMatchObject({ code: 'approval_required' });
    await expect(service.update({ description: 'New description', approvalId: preview.approvalId })).rejects.toMatchObject({ code: 'approval_required' });
    const other = new ChannelProfileService(ops, provider, { ...creator, id: 'creator-b', channelId: 'UC-other' }, { verifyPrincipal: async () => creator });
    await expect(other.update({ description: 'New description', approvalId: preview.approvalId, confirm: true })).rejects.toMatchObject({ code: 'profile_mismatch' });
    expect(provider.updateBranding).not.toHaveBeenCalled();
  });

  it('fails with stale_preview when the channel changed after preflight, and the approval stays usable by nobody else', async () => {
    const { service, provider, approve, setChannel } = await setup();
    const preview = await service.preflightUpdate({ description: 'New description' });
    await approve(preview.approvalId);
    const changed = branding(); changed.channel.keywords = 'edited elsewhere';
    setChannel({ id: 'UC-mine', brandingSettings: changed });
    await expect(service.update({ description: 'New description', approvalId: preview.approvalId, confirm: true })).rejects.toMatchObject({ code: 'stale_preview' });
    expect(provider.updateBranding).not.toHaveBeenCalled();
  });

  it('refuses a channel that is not the selected creator channel', async () => {
    const { service } = await setup({ verify: async () => { throw new AppError('ownership_required', 'no', 'no', false); } });
    await expect(service.preflightUpdate({ description: 'x' })).rejects.toMatchObject({ code: 'ownership_required' });
    const mismatch = await setup({ channel: () => ({ id: 'UC-someone-else', brandingSettings: branding() }) });
    await expect(mismatch.service.preflightUpdate({ description: 'x' })).rejects.toMatchObject({ code: 'ownership_required' });
  });

  it('settles failed on a definitive rejection and reports an unknown outcome otherwise', async () => {
    const rejected = await setup();
    rejected.provider.updateBranding.mockRejectedValueOnce(Object.assign(new Error('bad'), { status: 400 }));
    let preview = await rejected.service.preflightUpdate({ description: 'n' });
    await rejected.approve(preview.approvalId);
    await expect(rejected.service.update({ description: 'n', approvalId: preview.approvalId, confirm: true })).rejects.toMatchObject({ code: 'provider_error', status: 400 });

    const unknown = await setup();
    unknown.provider.updateBranding.mockRejectedValueOnce(new Error('socket hang up'));
    preview = await unknown.service.preflightUpdate({ description: 'n' });
    await unknown.approve(preview.approvalId);
    await expect(unknown.service.update({ description: 'n', approvalId: preview.approvalId, confirm: true })).rejects.toMatchObject({ code: 'provider_outcome_unknown' });
  });
});
