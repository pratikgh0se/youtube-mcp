import { createHash } from 'node:crypto';

import type { ConnectionProfile, OperationPreview, OperationReceipt } from '../types.js';
import { AppError, providerOutcomeUnknownError, toSafeError } from '../errors.js';
import { OperationService } from '../operations/service.js';
import type { OAuthService } from '../auth/oauth.js';
import { YouTubeClient, type YouTubeDataApi } from './client.js';

type CreatorProfile = ConnectionProfile & { purpose: 'creator'; channelId: string };
type ModerationStatus = 'heldForReview' | 'published' | 'rejected';
export type ReplyInput = { commentId: string; text: string; approvalId?: string; confirm?: boolean };
export type SetModerationStatusInput = { commentId: string; moderationStatus: ModerationStatus; banAuthor?: boolean; elevated?: boolean; approvalId?: string; confirm?: boolean };
export type DeleteCommentInput = { commentId: string; approvalId?: string; confirm?: boolean };
export type ModerationProvider = {
  getComment(commentId: string): Promise<ProviderComment | undefined>;
  reply(input: { parentId: string; text: string }): Promise<{ id?: string }>;
  setStatus(input: { commentId: string; moderationStatus: ModerationStatus; banAuthor?: boolean }): Promise<void>;
  deleteComment(input: { commentId: string }): Promise<void>;
};
export type ProviderComment = {
  id: string;
  channelId: string;
  authorChannelId?: string;
  text: string;
  moderationStatus?: string;
  etag?: string;
};
export class ModerationService {
  constructor(
    private readonly operations: OperationService,
    private readonly provider: ModerationProvider,
    private readonly profile: CreatorProfile,
    private readonly principal: { verifyPrincipal(): Promise<unknown> },
  ) {}

  async preflightReply(input: ReplyInput): Promise<OperationPreview> {
    try {
      await this.principal.verifyPrincipal();
      const comment = await this.ownedComment(input.commentId);
      const desired = { commentId: input.commentId, text: input.text };
      return this.preflight('comment.reply', input.commentId, desired, fingerprint(comment), replyReconciliation(input.commentId, input.text));
    } catch (error) { throw toSafeError(error); }
  }

  async reply(input: ReplyInput & { approvalId: string }): Promise<OperationReceipt & { commentId: string; replyId: string }> {
    try {
      const desired = { commentId: input.commentId, text: input.text };
      await this.requireApproved(input, 'comment.reply', input.commentId, desired);
      await this.principal.verifyPrincipal();
      const comment = await this.ownedComment(input.commentId);
      await this.claim(input, 'comment.reply', input.commentId, desired, fingerprint(comment));
      try {
        const replyId = requiredId((await this.provider.reply({ parentId: input.commentId, text: input.text })).id, 'comment reply');
        return { ...await this.settle(input.approvalId, 'succeeded'), commentId: input.commentId, replyId };
      } catch (error) {
        await this.settle(input.approvalId, 'unknown');
        throw providerOutcomeUnknownError(input.approvalId, replyReconciliation(input.commentId, input.text));
      }
    } catch (error) { throw toSafeError(error); }
  }

  async preflightSetStatus(input: SetModerationStatusInput): Promise<OperationPreview> {
    try {
      requireValidStatus(input);
      requireElevatedIntent(input);
      await this.principal.verifyPrincipal();
      const comment = await this.ownedComment(input.commentId);
      const desired = statusDesired(input);
      return this.preflight('comment.moderation.set', input.commentId, desired, fingerprint(comment), commentReconciliation(input.commentId));
    } catch (error) { throw toSafeError(error); }
  }

  async setStatus(input: SetModerationStatusInput & { approvalId: string }): Promise<OperationReceipt & { commentId: string; moderationStatus: ModerationStatus }> {
    try {
      requireValidStatus(input);
      requireElevatedIntent(input);
      const desired = statusDesired(input);
      await this.requireApproved(input, 'comment.moderation.set', input.commentId, desired);
      await this.principal.verifyPrincipal();
      const comment = await this.ownedComment(input.commentId);
      await this.claim(input, 'comment.moderation.set', input.commentId, desired, fingerprint(comment));
      try {
        await this.provider.setStatus({ commentId: input.commentId, moderationStatus: input.moderationStatus, ...(input.banAuthor ? { banAuthor: true } : {}) });
        return { ...await this.settle(input.approvalId, 'succeeded'), commentId: input.commentId, moderationStatus: input.moderationStatus };
      } catch (error) {
        await this.settle(input.approvalId, 'unknown');
        throw providerOutcomeUnknownError(input.approvalId, commentReconciliation(input.commentId));
      }
    } catch (error) { throw toSafeError(error); }
  }

  async preflightDelete(input: DeleteCommentInput): Promise<OperationPreview> {
    try {
      await this.principal.verifyPrincipal();
      const comment = await this.ownedComment(input.commentId, true);
      const desired = deleteDesired(input.commentId, comment);
      return this.preflight('comment.delete', input.commentId, desired, fingerprint(comment), commentReconciliation(input.commentId));
    } catch (error) { throw toSafeError(error); }
  }

  async delete(input: DeleteCommentInput & { approvalId: string }): Promise<OperationReceipt & { commentId: string; deleted: true }> {
    try {
      await this.requireApproved(input, 'comment.delete', input.commentId);
      await this.principal.verifyPrincipal();
      const comment = await this.ownedComment(input.commentId, true);
      await this.claim(input, 'comment.delete', input.commentId, undefined, fingerprint(comment));
      try {
        await this.provider.deleteComment({ commentId: input.commentId });
        return { ...await this.settle(input.approvalId, 'succeeded'), commentId: input.commentId, deleted: true };
      } catch (error) {
        await this.settle(input.approvalId, 'unknown');
        throw providerOutcomeUnknownError(input.approvalId, commentReconciliation(input.commentId));
      }
    } catch (error) { throw toSafeError(error); }
  }

  async approve(input: { approvalId: string; confirm?: boolean }): Promise<OperationPreview> {
    return this.operations.approve({ ...input, profileId: this.profile.id, channelId: this.profile.channelId });
  }

  private async ownedComment(commentId: string, requireAuthor = false): Promise<ProviderComment> {
    const comment = await this.provider.getComment(commentId);
    if (
      !comment ||
      comment.id !== commentId ||
      comment.channelId !== this.profile.channelId ||
      !comment.text ||
      (requireAuthor && comment.authorChannelId !== this.profile.channelId)
    ) throw ownershipRequiredError();
    return comment;
  }

  private async preflight(
    kind: string,
    targetId: string,
    desired: Record<string, unknown>,
    currentFingerprint: string,
    reconciliation: OperationReceipt['reconciliation'],
  ): Promise<OperationPreview> {
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

function commentReconciliation(commentId: string): OperationReceipt['reconciliation'] {
  return { tool: 'youtube_get_moderation_comment', arguments: { commentId } };
}

function replyReconciliation(parentId: string, text: string): OperationReceipt['reconciliation'] {
  return { tool: 'youtube_find_comment_reply', arguments: { parentId, text } };
}

function deleteDesired(commentId: string, comment: ProviderComment): Record<string, unknown> {
  return {
    commentId,
    target: {
      id: comment.id,
      channelId: comment.channelId,
      ...(comment.authorChannelId ? { authorChannelId: comment.authorChannelId } : {}),
      ...(comment.moderationStatus ? { moderationStatus: comment.moderationStatus } : {}),
      ...(comment.etag ? { etag: comment.etag } : {}),
      text: comment.text,
    },
  };
}

function statusDesired(input: SetModerationStatusInput): Record<string, unknown> { return { commentId: input.commentId, moderationStatus: input.moderationStatus, ...(input.banAuthor ? { banAuthor: true } : {}) }; }
function requireValidStatus(input: SetModerationStatusInput): void {
  if (!['heldForReview', 'published', 'rejected'].includes(input.moderationStatus) || (input.banAuthor === true && input.moderationStatus !== 'rejected')) {
    throw new AppError('invalid_input', 'The moderation status or banAuthor combination is not writable.', 'Use heldForReview, published, or rejected; banAuthor is allowed only with rejected.', false);
  }
}
function requireElevatedIntent(input: SetModerationStatusInput): void { if (input.banAuthor && input.elevated !== true) throw new AppError('elevated_confirmation_required', 'Banning an author needs separate elevated intent.', 'Repeat with elevated: true after reviewing the author-ban consequence.', false); }
function requiredId(value: string | undefined, resource: string): string { if (!value) throw providerError(resource); return value; }
function ownershipRequiredError() { return new AppError('ownership_required', 'This comment is not associated with the selected creator channel.', 'Use an immutable comment ID from the selected channel.', false); }
function approvalRequiredError() { return new AppError('approval_required', 'This operation requires an exact approved preview.', 'Preflight and approve the exact change before executing it.', false); }
function providerError(resource: string) { return new AppError('provider_error', `The YouTube provider returned an incomplete ${resource} result.`, 'Use the reconciliation receipt before attempting another mutation.', true); }
function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(sortValue(value))).digest('hex'); }
function sortValue(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortValue); if (typeof value !== 'object' || value === null) return value; return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sortValue((value as Record<string, unknown>)[key])])); }

export function createModerationProvider(oauth: Pick<OAuthService, 'getAccessToken'>, client: YouTubeClient): ModerationProvider {
  async function api(): Promise<ModerationApi> {
    const candidate = client.authorized(await oauth.getAccessToken('youtube.write'));
    if (!candidate.comments?.list || !candidate.comments.insert || !candidate.comments.setModerationStatus || !candidate.comments.delete) throw providerError('comment API');
    return candidate as ModerationApi;
  }
  return {
    async getComment(commentId) {
      const response = await (await api()).comments.list({ part: ['snippet'], id: [commentId], textFormat: 'plainText' });
      const items = asRecord(response.data)?.items;
      return normalizeComment(Array.isArray(items) ? items[0] : undefined);
    },
    async reply(input) { return idResponse((await (await api()).comments.insert({ part: ['snippet'], requestBody: { snippet: { parentId: input.parentId, textOriginal: input.text } } })).data); },
    async setStatus(input) { await (await api()).comments.setModerationStatus({ id: input.commentId, moderationStatus: input.moderationStatus, ...(input.banAuthor ? { banAuthor: true } : {}) }); },
    async deleteComment(input) { await (await api()).comments.delete({ id: input.commentId }); },
  };
}

type ModerationApi = YouTubeDataApi & { comments: NonNullable<YouTubeDataApi['comments']> };
function normalizeComment(value: unknown): ProviderComment | undefined {
  const record = asRecord(value);
  const snippet = asRecord(record?.snippet);
  const authorChannelId = stringValue(asRecord(snippet?.authorChannelId)?.value);
  const id = stringValue(record?.id);
  const channelId = stringValue(snippet?.channelId);
  const text = stringValue(snippet?.textDisplay) ?? stringValue(snippet?.textOriginal);
  return id && channelId && text ? {
    id,
    channelId,
    ...(authorChannelId ? { authorChannelId } : {}),
    text,
    ...(stringValue(snippet?.moderationStatus) ? { moderationStatus: stringValue(snippet?.moderationStatus) } : {}),
    ...(stringValue(record?.etag) ? { etag: stringValue(record?.etag) } : {}),
  } : undefined;
}
function idResponse(value: unknown): { id?: string } { const id = stringValue(asRecord(value)?.id); return id ? { id } : {}; }
function asRecord(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined; }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined; }
