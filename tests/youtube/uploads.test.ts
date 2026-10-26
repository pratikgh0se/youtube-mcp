import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { OperationService } from '../../src/operations/service.js';
import { OperationStore } from '../../src/operations/store.js';
import { UploadStore } from '../../src/youtube/upload-store.js';
import { UploadService, type ResumableUploadProvider } from '../../src/youtube/uploads.js';

const directories: string[] = [];
const creator = { id: 'creator-a', purpose: 'creator' as const, channelId: 'channel-a' };

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function fixtureVideo(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'youtube-mcp-upload-service-'));
  directories.push(directory);
  const filePath = join(directory, 'video.mp4');
  await writeFile(filePath, 'safe local video bytes');
  return filePath;
}

function provider(overrides: Partial<ResumableUploadProvider> = {}): ResumableUploadProvider {
  return {
    initialize: async () => ({ status: 200, sessionUrl: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=session-1' }),
    probe: async () => ({ status: 308, offset: 0 }),
    uploadChunk: async () => ({ status: 201, videoId: 'video-1' }),
    cancel: async () => ({ status: 204 }),
    ...overrides,
  };
}

async function serviceContext(uploadProvider = provider(), verifyPrincipal: () => Promise<unknown> = async () => creator) {
  const stateDir = await mkdtemp(join(tmpdir(), 'youtube-mcp-upload-state-'));
  directories.push(stateDir);
  const operations = new OperationService(new OperationStore(stateDir), () => new Date('2026-08-18T01:00:00.000Z'));
  const store = new UploadStore(stateDir, { profileId: creator.id, channelId: creator.channelId });
  return {
    uploads: new UploadService(
      operations,
      store,
      uploadProvider,
      creator,
      { verifyPrincipal },
    ),
    operations,
    store,
  };
}

async function service(uploadProvider = provider(), verifyPrincipal: () => Promise<unknown> = async () => creator) {
  return (await serviceContext(uploadProvider, verifyPrincipal)).uploads;
}

describe('UploadService', () => {
  it('persists the generated upload ID in the preflight reconciliation hint', async () => {
    const filePath = await fixtureVideo();
    const uploads = await service();

    const preview = await uploads.preflight({ filePath, title: 'Traceable upload' });

    expect(preview.reconciliation).toEqual({
      tool: 'youtube_get_upload_status',
      arguments: { uploadId: preview.targetId },
    });
  });

  it('keeps an upload outcome unknown when a 2xx response omits the created video ID', async () => {
    const filePath = await fixtureVideo();
    const uploads = await service(provider({ uploadChunk: async () => ({ status: 200 }) }));
    const preview = await uploads.preflight({ filePath, title: 'Incomplete provider response' });
    await uploads.approve({ approvalId: preview.approvalId, confirm: true });

    await expect(uploads.upload({ approvalId: preview.approvalId, filePath, title: 'Incomplete provider response', confirm: true }))
      .resolves.toMatchObject({ state: 'unknown', reconciliation: { arguments: { uploadId: preview.targetId } } });
  });

  it('keeps a probe outcome unknown when a 2xx response omits the created video ID', async () => {
    const filePath = await fixtureVideo();
    let probeComplete = false;
    const uploads = await service(provider({
      uploadChunk: async () => ({ status: 308, offset: 4 }),
      probe: async () => probeComplete ? { status: 200 } : { status: 308, offset: 4 },
    }));
    const preview = await uploads.preflight({ filePath, title: 'Incomplete probe response' });
    await uploads.approve({ approvalId: preview.approvalId, confirm: true });
    const started = await uploads.upload({ approvalId: preview.approvalId, filePath, title: 'Incomplete probe response', confirm: true });
    probeComplete = true;

    await expect(uploads.getStatus({ uploadId: started.uploadId }))
      .resolves.toMatchObject({ state: 'unknown', reconciliation: { arguments: { uploadId: started.uploadId } } });
  });

  it('records a 200 response with a created video ID as a completed upload', async () => {
    const filePath = await fixtureVideo();
    const uploads = await service(provider({ uploadChunk: async () => ({ status: 200, videoId: 'video-complete-200' }) }));
    const preview = await uploads.preflight({ filePath, title: 'Completed response' });
    await uploads.approve({ approvalId: preview.approvalId, confirm: true });

    await expect(uploads.upload({ approvalId: preview.approvalId, filePath, title: 'Completed response', confirm: true }))
      .resolves.toMatchObject({ state: 'complete', videoId: 'video-complete-200' });
  });

  it('starts an approved upload after an MCP restart', async () => {
    const filePath = await fixtureVideo();
    const uploadProvider = provider();
    const context = await serviceContext(uploadProvider);
    const preview = await context.uploads.preflight({ filePath, title: 'Restarted upload' });
    await context.uploads.approve({ approvalId: preview.approvalId, confirm: true });
    const restarted = new UploadService(context.operations, context.store, uploadProvider, creator, { verifyPrincipal: async () => creator });

    await expect(restarted.upload({ approvalId: preview.approvalId, filePath, title: 'Restarted upload', confirm: true }))
      .resolves.toMatchObject({ state: 'complete', videoId: 'video-1' });
  });

  it('validates the local upload file before contacting the OAuth principal or provider', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'youtube-mcp-invalid-upload-'));
    directories.push(directory);
    let principalChecks = 0;
    const uploads = await service(provider(), async () => {
      principalChecks += 1;
      return creator;
    });

    await expect(uploads.preflight({ filePath: join(directory, 'missing.mp4'), title: 'Missing local file' }))
      .rejects.toMatchObject({ code: 'invalid_upload_file' });
    expect(principalChecks).toBe(0);
  });

  it('validates a resumed local upload file before recontacting the OAuth principal', async () => {
    const filePath = await fixtureVideo();
    let principalChecks = 0;
    const uploads = await service(provider({ uploadChunk: async () => ({ status: 308, offset: 4 }) }), async () => {
      principalChecks += 1;
      return creator;
    });
    const start = await uploads.preflight({ filePath, title: 'Resumable local file' });
    await uploads.approve({ approvalId: start.approvalId, confirm: true });
    const pending = await uploads.upload({ approvalId: start.approvalId, filePath, title: 'Resumable local file', confirm: true });
    principalChecks = 0;

    await expect(uploads.preflightResume({ uploadId: pending.uploadId, filePath: `${filePath}.missing`, title: 'Resumable local file' }))
      .rejects.toMatchObject({ code: 'invalid_upload_file' });
    expect(principalChecks).toBe(0);
  });

  it('revalidates the OAuth principal channel after approval before provider upload access', async () => {
    const filePath = await fixtureVideo();
    let principalChecks = 0;
    let initialized = false;
    const uploads = await service(provider({ initialize: async () => {
      initialized = true;
      return { status: 200, sessionUrl: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=session-1' };
    } }), async () => {
      principalChecks += 1;
      if (principalChecks > 1) throw new Error('authenticated channel changed');
      return creator;
    });
    const preview = await uploads.preflight({ filePath, title: 'Private video' });
    await uploads.approve({ approvalId: preview.approvalId, confirm: true });

    await expect(uploads.upload({ approvalId: preview.approvalId, filePath, title: 'Private video', confirm: true }))
      .rejects.toThrow('authenticated channel changed');
    expect(initialized).toBe(false);
  });

  it('requires an approved confirmed private upload before initializing a resumable session', async () => {
    const filePath = await fixtureVideo();
    let initialized = false;
    const uploads = await service(provider({ initialize: async () => {
      initialized = true;
      return { status: 200, sessionUrl: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=session-1' };
    } }));

    const preview = await uploads.preflight({ filePath, title: 'Private video' });

    await expect(uploads.upload({ approvalId: preview.approvalId, filePath, title: 'Private video' }))
      .rejects.toMatchObject({ code: 'approval_required' });
    expect(initialized).toBe(false);

    await uploads.approve({ approvalId: preview.approvalId, confirm: true });
    await expect(uploads.upload({ approvalId: preview.approvalId, filePath, title: 'Private video', confirm: true }))
      .resolves.toMatchObject({ state: 'complete', uploadId: expect.any(String), videoId: 'video-1' });
    expect(initialized).toBe(true);
  });

  it('settles and returns provider success even if persisting local completion progress fails', async () => {
    const filePath = await fixtureVideo();
    const { uploads, operations, store } = await serviceContext();
    const preview = await uploads.preflight({ filePath, title: 'Durably uploaded video' });
    await uploads.approve({ approvalId: preview.approvalId, confirm: true });
    vi.spyOn(store, 'updateProgress').mockRejectedValueOnce(new Error('local completion write failed'));

    await expect(uploads.upload({ approvalId: preview.approvalId, filePath, title: 'Durably uploaded video', confirm: true }))
      .resolves.toMatchObject({ operationId: preview.approvalId, state: 'complete', videoId: 'video-1' });
    await expect(operations.reconcile({ profileId: creator.id, channelId: creator.channelId, operationId: preview.approvalId }))
      .resolves.toMatchObject({ state: 'succeeded' });
  });

  it('requires publish true in both preview and execution for public visibility', async () => {
    const filePath = await fixtureVideo();
    const uploads = await service();

    await expect(uploads.preflight({ filePath, title: 'Public video', privacyStatus: 'public' }))
      .rejects.toMatchObject({ code: 'publish_confirmation_required' });

    const preview = await uploads.preflight({ filePath, title: 'Public video', privacyStatus: 'public', publish: true });
    await uploads.approve({ approvalId: preview.approvalId, confirm: true });
    await expect(uploads.upload({ approvalId: preview.approvalId, filePath, title: 'Public video', privacyStatus: 'public', confirm: true }))
      .rejects.toMatchObject({ code: 'publish_confirmation_required' });
  });

  it('records a 308 response as resumable progress without replaying the source', async () => {
    const filePath = await fixtureVideo();
    let sent = 0;
    const uploads = await service(provider({
      uploadChunk: async () => {
        sent += 1;
        return { status: 308, offset: 10 };
      },
    }));
    const preview = await uploads.preflight({ filePath, title: 'Chunked video' });
    await uploads.approve({ approvalId: preview.approvalId, confirm: true });

    await expect(uploads.upload({ approvalId: preview.approvalId, filePath, title: 'Chunked video', confirm: true }))
      .resolves.toMatchObject({ state: 'in_progress', offset: 10 });
    expect(sent).toBe(1);
  });

  it('streams from the verified file descriptor when the pathname is replaced after approval', async () => {
    const filePath = await fixtureVideo();
    const replacement = `${filePath}.replacement`;
    await writeFile(replacement, 'different');
    let streamedDescriptor: number | undefined;
    const uploads = await service(provider({
      initialize: async () => {
        await rename(replacement, filePath);
        return { status: 200, sessionUrl: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=session-1' };
      },
      uploadChunk: async ({ fileDescriptor }) => {
        streamedDescriptor = fileDescriptor;
        return { status: 201, videoId: 'video-1' };
      },
    }));
    const preview = await uploads.preflight({ filePath, title: 'Bound source video' });
    await uploads.approve({ approvalId: preview.approvalId, confirm: true });

    await uploads.upload({ approvalId: preview.approvalId, filePath, title: 'Bound source video', confirm: true });

    expect(streamedDescriptor).toEqual(expect.any(Number));
  });

  it('returns unknown and a probe hint after a lost chunk response instead of replaying bytes', async () => {
    const filePath = await fixtureVideo();
    const uploads = await service(provider({ uploadChunk: async () => { throw new Error('connection dropped'); } }));
    const preview = await uploads.preflight({ filePath, title: 'Uncertain video' });
    await uploads.approve({ approvalId: preview.approvalId, confirm: true });

    await expect(uploads.upload({ approvalId: preview.approvalId, filePath, title: 'Uncertain video', confirm: true }))
      .resolves.toMatchObject({ operationId: preview.approvalId, state: 'unknown', reconciliation: { tool: 'youtube_get_upload_status' } });
  });

  it('probes an existing session before resume and refuses an expired session without sending bytes', async () => {
    const filePath = await fixtureVideo();
    let sent = false;
    const uploads = await service(provider({
      probe: async () => ({ status: 404 }),
      uploadChunk: async () => {
        sent = true;
        return { status: 308, offset: 4 };
      },
    }));
    const preview = await uploads.preflight({ filePath, title: 'Expired video' });
    await uploads.approve({ approvalId: preview.approvalId, confirm: true });
    const started = await uploads.upload({ approvalId: preview.approvalId, filePath, title: 'Expired video', confirm: true });
    sent = false;
    const resume = await uploads.preflightResume({ uploadId: started.uploadId, filePath, title: 'Expired video' });
    await uploads.approve({ approvalId: resume.approvalId, confirm: true });

    await expect(uploads.resume({ approvalId: resume.approvalId, uploadId: started.uploadId, filePath, title: 'Expired video', confirm: true }))
      .rejects.toMatchObject({
        code: 'upload_session_expired', operationId: resume.approvalId,
        reconciliation: { tool: 'youtube_get_upload_status', arguments: { uploadId: started.uploadId } },
      });
    expect(sent).toBe(false);
  });

  it('returns safe probe status and cancels only after a confirmed approval', async () => {
    const filePath = await fixtureVideo();
    const uploads = await service(provider({
      uploadChunk: async () => ({ status: 308, offset: 4 }),
      probe: async () => ({ status: 308, offset: 4 }),
    }));
    const start = await uploads.preflight({ filePath, title: 'Cancelable video' });
    await uploads.approve({ approvalId: start.approvalId, confirm: true });
    const pending = await uploads.upload({ approvalId: start.approvalId, filePath, title: 'Cancelable video', confirm: true });

    await expect(uploads.getStatus({ uploadId: pending.uploadId })).resolves.toEqual({ uploadId: pending.uploadId, state: 'in_progress', offset: 4 });
    const cancel = await uploads.preflightCancel({ uploadId: pending.uploadId });
    await uploads.approve({ approvalId: cancel.approvalId, confirm: true });
    await expect(uploads.cancel({ approvalId: cancel.approvalId, uploadId: pending.uploadId, confirm: true }))
      .resolves.toMatchObject({ operationId: cancel.approvalId, uploadId: pending.uploadId, state: 'cancelled' });
  });
});
