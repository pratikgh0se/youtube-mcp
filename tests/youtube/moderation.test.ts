import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../src/errors.js';
import { OperationService } from '../../src/operations/service.js';
import { OperationStore } from '../../src/operations/store.js';
import { createModerationProvider, ModerationService } from '../../src/youtube/moderation.js';
import { preflightSetCommentModerationStatusSchema } from '../../src/mcp/schemas.js';
import { YouTubeClient, type YouTubeDataApi } from '../../src/youtube/client.js';
import type { AppConfig } from '../../src/types.js';

const directories: string[] = [];
const creator = { id: 'creator-a', purpose: 'creator' as const, channelId: 'creator-channel' };

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function service(
  overrides: Record<string, unknown> = {},
  verifyPrincipal: () => Promise<unknown> = async () => creator,
) {
  const stateDir = await mkdtemp(join(tmpdir(), 'youtube-mcp-moderation-'));
  directories.push(stateDir);
  const provider = {
    getComment: vi.fn(async (commentId: string) => ({
      id: commentId,
      channelId: 'creator-channel',
      authorChannelId: 'creator-channel',
      moderationStatus: 'heldForReview',
      etag: 'comment-etag',
      text: 'Needs review',
    })),
    reply: vi.fn(async () => ({ id: 'reply-1' })),
    setStatus: vi.fn(async () => undefined),
    deleteComment: vi.fn(async () => undefined),
    ...overrides,
  };
  const operations = new OperationService(new OperationStore(stateDir), () => new Date('2026-08-18T01:00:00.000Z'));
  return {
    moderation: new ModerationService(operations, provider, creator, { verifyPrincipal }),
    operations,
    provider,
  };
}

async function approve(moderation: ModerationService, approvalId: string) {
  await moderation.approve({ approvalId, confirm: true });
}

describe('ModerationService', () => {
  it('verifies the OAuth principal channel before reading a comment during preflight', async () => {
    const { moderation, provider } = await service({}, async () => {
      throw new AppError('ownership_required', 'Authenticated channel does not match the selected profile.', 'Select the authenticated channel.', false);
    });

    await expect(moderation.preflightDelete({ commentId: 'comment-1' }))
      .rejects.toMatchObject({ code: 'ownership_required' });
    expect(provider.getComment).not.toHaveBeenCalled();
  });

  it('reverifies the OAuth principal after approval and before the execution reread', async () => {
    let principalChecks = 0;
    const { moderation, provider } = await service({}, async () => {
      principalChecks += 1;
      if (principalChecks > 1) throw new AppError('ownership_required', 'Authenticated channel changed.', 'Select the authenticated channel.', false);
      return creator;
    });
    const preview = await moderation.preflightDelete({ commentId: 'comment-1' });
    await approve(moderation, preview.approvalId);
    provider.getComment.mockClear();

    await expect(moderation.delete({ commentId: 'comment-1', approvalId: preview.approvalId, confirm: true }))
      .rejects.toMatchObject({ code: 'ownership_required' });
    expect(provider.getComment).not.toHaveBeenCalled();
    expect(provider.deleteComment).not.toHaveBeenCalled();
  });

  it('rejects execution before rereading provider state when the preview is not approved', async () => {
    const { moderation, provider } = await service();
    const preview = await moderation.preflightDelete({ commentId: 'comment-1' });
    provider.getComment.mockClear();

    await expect(moderation.delete({ commentId: 'comment-1', approvalId: preview.approvalId, confirm: true }))
      .rejects.toMatchObject({ code: 'approval_required' });
    expect(provider.getComment).not.toHaveBeenCalled();
  });

  it('does not moderate with banAuthor unless elevated intent was separately approved', async () => {
    const { moderation, provider } = await service();

    await expect(moderation.preflightSetStatus({ commentId: 'comment-1', moderationStatus: 'rejected', banAuthor: true }))
      .rejects.toMatchObject({ code: 'elevated_confirmation_required' });
    expect(provider.setStatus).not.toHaveBeenCalled();
  });

  it('accepts only writable moderation statuses and limits banAuthor to rejection', async () => {
    const { moderation, provider } = await service();

    await expect(moderation.preflightSetStatus({ commentId: 'comment-1', moderationStatus: 'spam' as never }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(moderation.preflightSetStatus({ commentId: 'comment-1', moderationStatus: 'published', banAuthor: true, elevated: true }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    expect(preflightSetCommentModerationStatusSchema.safeParse({ commentId: 'comment-1', moderationStatus: 'spam' }).success).toBe(false);
    expect(preflightSetCommentModerationStatusSchema.safeParse({ commentId: 'comment-1', moderationStatus: 'published', banAuthor: true, elevated: true }).success).toBe(false);
    expect(provider.setStatus).not.toHaveBeenCalled();
  });

  it('rejects a partial reply response without claiming success', async () => {
    const { moderation, provider, operations } = await service({ reply: vi.fn(async () => ({})) });
    const preview = await moderation.preflightReply({ commentId: 'comment-1', text: 'Thank you.' });
    await approve(moderation, preview.approvalId);

    await expect(moderation.reply({ commentId: 'comment-1', text: 'Thank you.', approvalId: preview.approvalId, confirm: true }))
      .rejects.toMatchObject({
        code: 'provider_outcome_unknown', retryable: false, operationId: preview.approvalId,
        reconciliation: { tool: 'youtube_find_comment_reply', arguments: { parentId: 'comment-1', text: 'Thank you.' } },
      });
    expect(provider.reply).toHaveBeenCalledWith({ parentId: 'comment-1', text: 'Thank you.' });
    await expect(operations.reconcile({ profileId: creator.id, channelId: creator.channelId, operationId: preview.approvalId }))
      .resolves.toMatchObject({ state: 'unknown' });
  });

  it('deletes only a freshly read comment belonging to the selected creator channel', async () => {
    const { moderation, provider } = await service();
    const preview = await moderation.preflightDelete({ commentId: 'comment-1' });
    await approve(moderation, preview.approvalId);

    await expect(moderation.delete({ commentId: 'comment-1', approvalId: preview.approvalId, confirm: true }))
      .resolves.toMatchObject({ operationId: preview.approvalId, state: 'succeeded', commentId: 'comment-1', deleted: true, reconciliation: { tool: 'youtube_get_moderation_comment', arguments: { commentId: 'comment-1' } } });
    expect(provider.deleteComment).toHaveBeenCalledWith({ commentId: 'comment-1' });
  });

  it('executes an approved comment deletion after an MCP restart', async () => {
    const { moderation, operations, provider } = await service();
    const preview = await moderation.preflightDelete({ commentId: 'comment-1' });
    await approve(moderation, preview.approvalId);
    const restarted = new ModerationService(operations, provider, creator, { verifyPrincipal: async () => creator });

    await expect(restarted.delete({ commentId: 'comment-1', approvalId: preview.approvalId, confirm: true }))
      .resolves.toMatchObject({ operationId: preview.approvalId, state: 'succeeded', commentId: 'comment-1', deleted: true });
  });

  it('requires the selected creator channel to be the comment author before deletion', async () => {
    const { moderation, provider } = await service({
      getComment: vi.fn(async () => ({
        id: 'comment-1',
        channelId: 'creator-channel',
        authorChannelId: 'viewer-channel',
        moderationStatus: 'heldForReview',
        text: 'Viewer comment on this channel',
      })),
    });

    await expect(moderation.preflightDelete({ commentId: 'comment-1' }))
      .rejects.toMatchObject({ code: 'ownership_required' });
    expect(provider.deleteComment).not.toHaveBeenCalled();
  });

  it('returns the exact authored-comment target summary before deletion', async () => {
    const { moderation } = await service();

    const preview = await moderation.preflightDelete({ commentId: 'comment-1' });

    expect(preview.desired).toEqual({
      commentId: 'comment-1',
      target: {
        id: 'comment-1',
        channelId: 'creator-channel',
        authorChannelId: 'creator-channel',
        moderationStatus: 'heldForReview',
        etag: 'comment-etag',
        text: 'Needs review',
      },
    });
  });

  it('uses the exact immutable comment to reconcile an ambiguous status mutation', async () => {
    const { moderation } = await service();

    const preview = await moderation.preflightSetStatus({ commentId: 'comment-1', moderationStatus: 'published' });

    expect(preview.reconciliation).toEqual({
      tool: 'youtube_get_moderation_comment',
      arguments: { commentId: 'comment-1' },
    });
  });

  it('rejects comment actions outside the selected creator channel before any mutation', async () => {
    const { moderation, provider } = await service({ getComment: vi.fn(async () => ({ id: 'comment-1', channelId: 'other-channel', authorChannelId: 'other-channel', text: 'Elsewhere' })) });

    await expect(moderation.preflightDelete({ commentId: 'comment-1' })).rejects.toMatchObject({ code: 'ownership_required' });
    expect(provider.deleteComment).not.toHaveBeenCalled();
  });

  it('normalizes authorChannelId from the provider and requests write-capable OAuth', async () => {
    const requestedCapabilities: string[] = [];
    const api = {
      search: { list: async () => ({ data: { items: [] } }) },
      videos: { list: async () => ({ data: { items: [] } }) },
      channels: { list: async () => ({ data: { items: [] } }) },
      commentThreads: { list: async () => ({ data: { items: [] } }) },
      comments: {
        list: async () => ({ data: { items: [{
          id: 'comment-1',
          etag: 'comment-etag',
          snippet: {
            channelId: 'creator-channel',
            authorChannelId: { value: 'author-channel' },
            moderationStatus: 'heldForReview',
            textDisplay: 'Exact comment text',
          },
        }] } }),
        insert: async () => ({ data: {} }),
        setModerationStatus: async () => ({ data: {} }),
        delete: async () => ({ data: {} }),
      },
      videoCategories: { list: async () => ({ data: { items: [] } }) },
      playlists: { list: async () => ({ data: { items: [] } }) },
      playlistItems: { list: async () => ({ data: { items: [] } }) },
      captions: { list: async () => ({ data: { items: [] } }) },
    } as YouTubeDataApi;
    const config: AppConfig = { stateDir: '/tmp/youtube-mcp-tests', diagnostics: () => 'safe' };
    const provider = createModerationProvider(
      { getAccessToken: async (capability) => { if (capability) requestedCapabilities.push(capability); return 'access-token'; } },
      new YouTubeClient(config, { createAuthorizedApi: () => api, createPublicApi: () => api }),
    );

    await expect(provider.getComment('comment-1')).resolves.toEqual({
      id: 'comment-1',
      channelId: 'creator-channel',
      authorChannelId: 'author-channel',
      moderationStatus: 'heldForReview',
      etag: 'comment-etag',
      text: 'Exact comment text',
    });
    expect(requestedCapabilities).toEqual(['youtube.write']);
  });
});
