import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../src/errors.js';
import { OperationService } from '../../src/operations/service.js';
import { OperationStore } from '../../src/operations/store.js';
import { createSubscriptionProvider, SubscriptionCurationService, type ProviderSubscription } from '../../src/youtube/subscriptions.js';
import { YouTubeClient } from '../../src/youtube/client.js';
import { preflightUnsubscribeManySchema } from '../../src/mcp/schemas.js';
import { testYouTubeApi } from '../helpers/youtube-api.js';

const directories: string[] = [];
const creator = { id: 'creator-a', purpose: 'creator' as const, channelId: 'UC-mine' };
afterEach(async () => { await Promise.all(directories.splice(0).map((d) => rm(d, { force: true, recursive: true }))); });

const subs: ProviderSubscription[] = [
  { subscriptionId: 's1', subscriberChannelId: 'UC-mine', channelId: 'c1', title: 'Channel One' },
  { subscriptionId: 's2', subscriberChannelId: 'UC-mine', channelId: 'c2', title: 'Channel Two' },
  { subscriptionId: 's3', subscriberChannelId: 'UC-mine', channelId: 'c3', title: 'Channel Three' },
];

async function setup(existing: ProviderSubscription[] = subs) {
  const stateDir = await mkdtemp(join(tmpdir(), 'youtube-mcp-subs-'));
  directories.push(stateDir);
  let current = existing;
  const provider = {
    getAuthenticatedChannelId: vi.fn(async () => 'UC-mine'),
    getSubscriptions: vi.fn(async (ids: string[]) => current.filter((item) => ids.includes(item.subscriptionId))),
    deleteSubscription: vi.fn(async (id: string) => { current = current.filter((item) => item.subscriptionId !== id); }),
  };
  const ops = new OperationService(new OperationStore(stateDir), () => new Date('2026-10-28T00:00:00.000Z'));
  const service = new SubscriptionCurationService(ops, provider, creator, { verifyPrincipal: async () => creator });
  const approve = (approvalId: string, profile = creator) => ops.approve({ approvalId, confirm: true, profileId: profile.id, channelId: profile.channelId });
  return { service, provider, ops, approve, setCurrent: (next: ProviderSubscription[]) => { current = next; } };
}

const ids = ['s1', 's2', 's3'];
const quota = () => Object.assign(new Error('quota'), { code: 403, errors: [{ reason: 'quotaExceeded' }] });

describe('youtube_preflight_unsubscribe_many', () => {
  it('validates 1..100 ids', () => {
    expect(preflightUnsubscribeManySchema.safeParse({ subscriptionIds: [] }).success).toBe(false);
    expect(preflightUnsubscribeManySchema.safeParse({ subscriptionIds: Array.from({ length: 101 }, (_, i) => `s${i}`) }).success).toBe(false);
    expect(preflightUnsubscribeManySchema.safeParse({ subscriptionIds: ['s1'] }).success).toBe(true);
  });

  it('lists every channel title with approximate quota (50 units each) and flags unknown ids as already gone', async () => {
    const { service } = await setup();
    const preview = await service.preflightUnsubscribeMany({ subscriptionIds: ['s1', 's2', 'nope', 's1'] });
    expect(preview.kind).toBe('subscription.remove_many');
    expect(preview.desired).toMatchObject({
      subscriptionIds: ['s1', 's2', 'nope'], toRemove: 2, alreadyGone: 1, approximateQuotaUnits: 100, subscriberChannelId: 'UC-mine',
      channels: [
        { subscriptionId: 's1', status: 'subscribed', channelId: 'c1', title: 'Channel One' },
        { subscriptionId: 's2', status: 'subscribed', channelId: 'c2', title: 'Channel Two' },
        { subscriptionId: 'nope', status: 'gone' },
      ],
    });
  });

  it('refuses subscriptions that belong to another account', async () => {
    const { service } = await setup([...subs, { subscriptionId: 'x', subscriberChannelId: 'UC-other', channelId: 'c9', title: 'Other' }]);
    await expect(service.preflightUnsubscribeMany({ subscriptionIds: ['s1', 'x'] })).rejects.toMatchObject({ code: 'ownership_required' });
  });
});

describe('youtube_unsubscribe_many', () => {
  it('removes every approved subscription sequentially and settles succeeded', async () => {
    const { service, provider, approve } = await setup();
    const preview = await service.preflightUnsubscribeMany({ subscriptionIds: ids });
    await approve(preview.approvalId);
    const result = await service.unsubscribeMany({ subscriptionIds: ids, approvalId: preview.approvalId, confirm: true });
    expect(provider.deleteSubscription.mock.calls.map(([id]) => id)).toEqual(ids);
    expect(result).toMatchObject({ state: 'succeeded', complete: true, summary: { requested: 3, removed: 3, alreadyGone: 0, failed: 0, notAttempted: 0 }, approximateQuotaUnitsUsed: 150 });
    expect(result.results.map((item) => item.status)).toEqual(['removed', 'removed', 'removed']);
  });

  it('rejects missing approval, wrong list, missing confirm and a foreign profile before any delete', async () => {
    const { service, provider, approve, ops } = await setup();
    const preview = await service.preflightUnsubscribeMany({ subscriptionIds: ids });
    await expect(service.unsubscribeMany({ subscriptionIds: ids, approvalId: preview.approvalId, confirm: true })).rejects.toMatchObject({ code: 'approval_required' });
    await approve(preview.approvalId);
    await expect(service.unsubscribeMany({ subscriptionIds: ['s1'], approvalId: preview.approvalId, confirm: true })).rejects.toMatchObject({ code: 'approval_required' });
    await expect(service.unsubscribeMany({ subscriptionIds: ids, approvalId: preview.approvalId })).rejects.toMatchObject({ code: 'approval_required' });
    const other = new SubscriptionCurationService(ops, provider, { ...creator, id: 'creator-b', channelId: 'UC-other' }, { verifyPrincipal: async () => creator });
    await expect(other.unsubscribeMany({ subscriptionIds: ids, approvalId: preview.approvalId, confirm: true })).rejects.toMatchObject({ code: 'profile_mismatch' });
    expect(provider.deleteSubscription).not.toHaveBeenCalled();
  });

  it('fails with stale_preview when the subscriptions changed after preflight', async () => {
    const { service, provider, approve, setCurrent } = await setup();
    const preview = await service.preflightUnsubscribeMany({ subscriptionIds: ids });
    await approve(preview.approvalId);
    setCurrent(subs.slice(0, 2));
    await expect(service.unsubscribeMany({ subscriptionIds: ids, approvalId: preview.approvalId, confirm: true })).rejects.toMatchObject({ code: 'stale_preview' });
    expect(provider.deleteSubscription).not.toHaveBeenCalled();
  });

  it('reports a partial failure per item, continues past it, and is single-use', async () => {
    const { service, provider, approve } = await setup();
    provider.deleteSubscription.mockImplementationOnce(async () => undefined);
    provider.deleteSubscription.mockImplementationOnce(async () => { throw Object.assign(new Error('forbidden'), { status: 403, errors: [{ reason: 'forbidden' }] }); });
    const preview = await service.preflightUnsubscribeMany({ subscriptionIds: ids });
    await approve(preview.approvalId);
    const result = await service.unsubscribeMany({ subscriptionIds: ids, approvalId: preview.approvalId, confirm: true });
    expect(result.results.map((item) => item.status)).toEqual(['removed', 'failed', 'removed']);
    expect(result.results[1]).toMatchObject({ title: 'Channel Two', error: { code: 'provider_error', status: 403, reason: 'forbidden' } });
    expect(result).toMatchObject({ state: 'failed', complete: false, summary: { removed: 2, failed: 1 } });
    await expect(service.unsubscribeMany({ subscriptionIds: ids, approvalId: preview.approvalId, confirm: true })).rejects.toMatchObject({ code: 'approval_consumed' });
  });

  it('treats a 404 mid-run as already_gone', async () => {
    const { service, provider, approve } = await setup();
    provider.deleteSubscription.mockImplementationOnce(async () => { throw Object.assign(new Error('nf'), { status: 404, errors: [{ reason: 'subscriptionNotFound' }] }); });
    const preview = await service.preflightUnsubscribeMany({ subscriptionIds: ['s1', 's2'] });
    await approve(preview.approvalId);
    const result = await service.unsubscribeMany({ subscriptionIds: ['s1', 's2'], approvalId: preview.approvalId, confirm: true });
    expect(result.results.map((item) => item.status)).toEqual(['already_gone', 'removed']);
    expect(result).toMatchObject({ state: 'succeeded', complete: true });
  });

  it('stops early on quotaExceeded with a clear partial report, and a retry only touches what is left', async () => {
    const { service, provider, approve } = await setup();
    let calls = 0;
    const realDelete = provider.deleteSubscription.getMockImplementation()!;
    provider.deleteSubscription.mockImplementation(async (id: string) => {
      calls += 1;
      if (calls === 2) throw quota();
      await realDelete(id);
    });
    const preview = await service.preflightUnsubscribeMany({ subscriptionIds: ids });
    await approve(preview.approvalId);
    const result = await service.unsubscribeMany({ subscriptionIds: ids, approvalId: preview.approvalId, confirm: true });
    expect(provider.deleteSubscription).toHaveBeenCalledTimes(2);
    expect(result.results.map((item) => item.status)).toEqual(['removed', 'not_attempted', 'not_attempted']);
    expect(result.stoppedEarly).toMatchObject({ reason: 'quotaExceeded' });
    expect(result).toMatchObject({ complete: false, state: 'failed', summary: { removed: 1, notAttempted: 2 }, approximateQuotaUnitsUsed: 100 });

    // idempotent retry: a new preflight sees s1 already gone and only removes the rest
    const retry = await service.preflightUnsubscribeMany({ subscriptionIds: ids });
    expect(retry.desired).toMatchObject({ toRemove: 2, alreadyGone: 1 });
    await approve(retry.approvalId);
    const second = await service.unsubscribeMany({ subscriptionIds: ids, approvalId: retry.approvalId, confirm: true });
    expect(second.results.map((item) => item.status)).toEqual(['already_gone', 'removed', 'removed']);
    expect(second.complete).toBe(true);
  });

  it('marks the operation unknown when a failure has no definitive HTTP answer', async () => {
    const { service, provider, approve } = await setup();
    provider.deleteSubscription.mockImplementationOnce(async () => { throw new Error('socket hang up'); });
    const preview = await service.preflightUnsubscribeMany({ subscriptionIds: ['s1'] });
    await approve(preview.approvalId);
    const result = await service.unsubscribeMany({ subscriptionIds: ['s1'], approvalId: preview.approvalId, confirm: true });
    expect(result).toMatchObject({ state: 'unknown', complete: false, summary: { failed: 0, unknown: 1 } });
    expect(result.results[0]).toMatchObject({ status: 'unknown', action: expect.stringContaining('youtube_list_subscriptions') });
  });

  it('refuses when the principal check fails or the OAuth channel is not the selected profile channel (preflight and execute)', async () => {
    const { provider, ops, approve, service } = await setup();
    provider.getAuthenticatedChannelId.mockResolvedValue('UC-someone-else');
    await expect(service.preflightUnsubscribeMany({ subscriptionIds: ids })).rejects.toMatchObject({ code: 'ownership_required' });

    provider.getAuthenticatedChannelId.mockResolvedValue('UC-mine');
    const preview = await service.preflightUnsubscribeMany({ subscriptionIds: ids });
    await approve(preview.approvalId);
    provider.getAuthenticatedChannelId.mockResolvedValue('UC-someone-else');
    await expect(service.unsubscribeMany({ subscriptionIds: ids, approvalId: preview.approvalId, confirm: true })).rejects.toMatchObject({ code: 'ownership_required' });
    expect(provider.deleteSubscription).not.toHaveBeenCalled();

    const denied = new SubscriptionCurationService(ops, provider, creator, { verifyPrincipal: async () => { throw new AppError('ownership_required', 'no', 'no', false); } });
    provider.getAuthenticatedChannelId.mockResolvedValue('UC-mine');
    await expect(denied.preflightUnsubscribeMany({ subscriptionIds: ids })).rejects.toMatchObject({ code: 'ownership_required' });
  });
});

describe('createSubscriptionProvider', () => {
  it('verifies via subscriptions.list id= with the subscriber channel and deletes by id', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const api = testYouTubeApi({
      channels: { list: async (request) => { calls.push(['channels', request]); return { data: { items: [{ id: 'UC-mine' }] } }; } },
      subscriptions: {
        insert: async () => ({ data: {} }),
        delete: async (request) => { calls.push(['delete', request]); return { data: {} }; },
        list: async (request) => { calls.push(['list', request]); return { data: { items: [{ id: 's1', snippet: { channelId: 'UC-mine', title: 'T', resourceId: { channelId: 'c1' } } }] } }; },
      },
    });
    const provider = createSubscriptionProvider({ getAccessToken: async () => 't' }, new YouTubeClient({ stateDir: '/tmp/x', diagnostics: () => '' }, { createPublicApi: () => api, createAuthorizedApi: () => api }));
    await expect(provider.getAuthenticatedChannelId()).resolves.toBe('UC-mine');
    await expect(provider.getSubscriptions(['s1', 's2'])).resolves.toEqual([{ subscriptionId: 's1', subscriberChannelId: 'UC-mine', channelId: 'c1', title: 'T' }]);
    await provider.deleteSubscription('s1');
    expect(calls).toEqual([
      ['channels', { part: 'id', mine: true }],
      ['list', { part: 'snippet', id: 's1,s2', maxResults: 50 }],
      ['delete', { id: 's1' }],
    ]);
  });
});
