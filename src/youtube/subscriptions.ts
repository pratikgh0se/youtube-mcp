import { createHash } from 'node:crypto';

import type { ConnectionProfile, OperationPreview, OperationReceipt } from '../types.js';
import { AppError, isDefinitiveRejection, toSafeError } from '../errors.js';
import { OperationService } from '../operations/service.js';
import type { OAuthService } from '../auth/oauth.js';
import { YouTubeClient, type YouTubeDataApi } from './client.js';

type CreatorProfile = ConnectionProfile & { purpose: 'creator'; channelId: string };

export const unsubscribeUnitCost = 50;
const kind = 'subscription.remove_many';

export type ProviderSubscription = { subscriptionId: string; subscriberChannelId: string; channelId: string; title: string };
export type SubscriptionProvider = {
  /** Channel of the authenticated OAuth account (the subscriber). */
  getAuthenticatedChannelId(): Promise<string | undefined>;
  /** Returns only subscriptions that exist; unknown IDs are simply absent. */
  getSubscriptions(subscriptionIds: string[]): Promise<ProviderSubscription[]>;
  deleteSubscription(subscriptionId: string): Promise<void>;
};

export type UnsubscribeManyItem = {
  subscriptionId: string;
  status: 'removed' | 'already_gone' | 'failed' | 'not_attempted';
  channelId?: string;
  title?: string;
  error?: { code: string; message: string; status?: number; reason?: string };
};
export type UnsubscribeManyResult = OperationReceipt & {
  results: UnsubscribeManyItem[];
  summary: { requested: number; removed: number; alreadyGone: number; failed: number; notAttempted: number };
  complete: boolean;
  stoppedEarly?: { reason: 'quotaExceeded'; message: string };
  approximateQuotaUnitsUsed: number;
};

export class SubscriptionCurationService {
  constructor(
    private readonly operations: OperationService,
    private readonly provider: SubscriptionProvider,
    private readonly profile: CreatorProfile,
  ) {}

  async preflightUnsubscribeMany(input: { subscriptionIds: string[] }): Promise<OperationPreview> {
    try {
      const ids = normalizeIds(input.subscriptionIds);
      const snapshot = await this.snapshot(ids);
      const toRemove = snapshot.entries.filter((entry) => entry.status === 'subscribed');
      return this.operations.preflight({
        profile: this.profile,
        kind,
        targetId: targetOf(ids),
        desired: {
          subscriptionIds: ids,
          subscriberChannelId: snapshot.subscriberChannelId,
          channels: snapshot.entries.map(({ subscriptionId, channelId, title, status }) => ({ subscriptionId, status, ...(channelId ? { channelId } : {}), ...(title ? { title } : {}) })),
          toRemove: toRemove.length,
          alreadyGone: snapshot.entries.length - toRemove.length,
          approximateQuotaUnits: toRemove.length * unsubscribeUnitCost,
        },
        currentFingerprint: fingerprint(snapshot),
        reconciliation: reconciliation(),
      });
    } catch (error) { throw toSafeError(error); }
  }

  async unsubscribeMany(input: { subscriptionIds: string[]; approvalId: string; confirm?: boolean }): Promise<UnsubscribeManyResult> {
    try {
      const ids = normalizeIds(input.subscriptionIds);
      const preview = await this.operations.requireApproved({ ...input, profileId: this.profile.id, channelId: this.profile.channelId });
      const approvedIds = Array.isArray(preview.desired.subscriptionIds) ? preview.desired.subscriptionIds : [];
      if (preview.kind !== kind || preview.targetId !== targetOf(ids) || JSON.stringify(approvedIds) !== JSON.stringify(ids)) {
        throw new AppError('approval_required', 'This operation requires an exact approved preview.', 'Preflight and approve the exact subscription list before executing it.', false);
      }
      const snapshot = await this.snapshot(ids);
      const receipt = await this.operations.claim({ ...input, currentFingerprint: fingerprint(snapshot), profileId: this.profile.id, channelId: this.profile.channelId });

      const results: UnsubscribeManyItem[] = [];
      let stoppedEarly: UnsubscribeManyResult['stoppedEarly'];
      let unknownOutcome = false;
      let attempts = 0;
      for (const entry of snapshot.entries) {
        const identity = { subscriptionId: entry.subscriptionId, ...(entry.channelId ? { channelId: entry.channelId } : {}), ...(entry.title ? { title: entry.title } : {}) };
        if (stoppedEarly) { results.push({ ...identity, status: 'not_attempted' }); continue; }
        if (entry.status === 'gone') { results.push({ ...identity, status: 'already_gone' }); continue; }
        attempts += 1;
        try {
          await this.provider.deleteSubscription(entry.subscriptionId);
          results.push({ ...identity, status: 'removed' });
        } catch (error) {
          const safe = toSafeError(error);
          if (safe.status === 404 || safe.reason === 'subscriptionNotFound') {
            results.push({ ...identity, status: 'already_gone' });
          } else if (safe.code === 'quota_exhausted') {
            stoppedEarly = { reason: 'quotaExceeded', message: 'YouTube quota ran out mid-run. Remaining subscriptions were not attempted; preflight again after the quota resets.' };
            results.push({ ...identity, status: 'not_attempted', error: errorOf(safe) });
          } else {
            if (!isDefinitiveRejection(error)) unknownOutcome = true;
            results.push({ ...identity, status: 'failed', error: errorOf(safe) });
          }
        }
      }
      const summary = {
        requested: ids.length,
        removed: count(results, 'removed'),
        alreadyGone: count(results, 'already_gone'),
        failed: count(results, 'failed'),
        notAttempted: count(results, 'not_attempted'),
      };
      const complete = summary.failed === 0 && summary.notAttempted === 0;
      const state = complete ? 'succeeded' : unknownOutcome ? 'unknown' : 'failed';
      const settled = await this.operations.settle({ operationId: receipt.operationId, profileId: this.profile.id, channelId: this.profile.channelId, state });
      return {
        ...settled,
        results,
        summary,
        complete,
        ...(stoppedEarly ? { stoppedEarly } : {}),
        approximateQuotaUnitsUsed: attempts * unsubscribeUnitCost,
      };
    } catch (error) { throw toSafeError(error); }
  }

  private async snapshot(ids: string[]): Promise<{ subscriberChannelId: string; entries: Array<{ subscriptionId: string; status: 'subscribed' | 'gone'; channelId?: string; title?: string }> }> {
    const subscriberChannelId = await this.provider.getAuthenticatedChannelId();
    if (!subscriberChannelId) {
      throw new AppError('channel_required', 'The authorized account has no YouTube channel, so its subscriptions cannot be verified.', 'Run youtube-auth with the account that owns the subscriptions.', false);
    }
    const found = new Map((await this.provider.getSubscriptions(ids)).map((subscription) => [subscription.subscriptionId, subscription]));
    const foreign = ids.filter((id) => found.has(id) && found.get(id)!.subscriberChannelId !== subscriberChannelId);
    if (foreign.length > 0) {
      throw new AppError('ownership_required', `Subscription(s) ${foreign.join(', ')} do not belong to the authenticated account.`, 'Use subscriptionIds from youtube_list_subscriptions for the authorized account.', false);
    }
    return {
      subscriberChannelId,
      entries: ids.map((subscriptionId) => {
        const subscription = found.get(subscriptionId);
        return subscription
          ? { subscriptionId, status: 'subscribed' as const, channelId: subscription.channelId, title: subscription.title }
          : { subscriptionId, status: 'gone' as const };
      }),
    };
  }
}

function normalizeIds(ids: string[]): string[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0 || unique.length > 100) {
    throw new AppError('invalid_input', 'Provide between 1 and 100 distinct subscription IDs.', 'Split the list into batches of at most 100.', false);
  }
  return unique;
}

function errorOf(safe: AppError): NonNullable<UnsubscribeManyItem['error']> {
  return { code: safe.code, message: safe.message, ...(safe.status !== undefined ? { status: safe.status } : {}), ...(safe.reason !== undefined ? { reason: safe.reason } : {}) };
}
function count(results: UnsubscribeManyItem[], status: UnsubscribeManyItem['status']): number { return results.filter((item) => item.status === status).length; }
function targetOf(ids: string[]): string { return `subscriptions:${fingerprint(ids).slice(0, 16)}`; }
function reconciliation() { return { tool: 'youtube_list_subscriptions', arguments: {} }; }
function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function asRecord(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined; }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined; }

export function createSubscriptionProvider(oauth: Pick<OAuthService, 'getAccessToken'>, client: YouTubeClient): SubscriptionProvider {
  async function reader() {
    const api = client.authorized(await oauth.getAccessToken('youtube.read'));
    if (!api.subscriptions) throw new AppError('provider_error', 'The YouTube provider did not return a valid subscriptions API.', 'Try again.', true);
    return api as YouTubeDataApi & { subscriptions: NonNullable<YouTubeDataApi['subscriptions']> };
  }
  return {
    async getAuthenticatedChannelId() {
      const response = await (await reader()).channels.list({ part: 'id', mine: true });
      return stringValue(asRecord(response.data.items?.[0])?.id);
    },
    async getSubscriptions(ids) {
      const api = await reader();
      const out: ProviderSubscription[] = [];
      for (let index = 0; index < ids.length; index += 50) {
        const chunk = ids.slice(index, index + 50);
        const response = await api.subscriptions.list({ part: 'snippet', id: chunk.join(','), maxResults: 50 });
        for (const raw of response.data.items ?? []) {
          const item = asRecord(raw);
          const snippet = asRecord(item?.snippet);
          const subscriptionId = stringValue(item?.id);
          const subscriberChannelId = stringValue(snippet?.channelId);
          const channelId = stringValue(asRecord(snippet?.resourceId)?.channelId);
          if (subscriptionId && subscriberChannelId && channelId) out.push({ subscriptionId, subscriberChannelId, channelId, title: stringValue(snippet?.title) ?? channelId });
        }
      }
      return out;
    },
    async deleteSubscription(subscriptionId) {
      const api = client.authorized(await oauth.getAccessToken('youtube.write'));
      if (!api.subscriptions) throw new AppError('provider_error', 'The YouTube provider did not return a valid subscriptions API.', 'Try again.', true);
      await api.subscriptions.delete({ id: subscriptionId });
    },
  };
}
