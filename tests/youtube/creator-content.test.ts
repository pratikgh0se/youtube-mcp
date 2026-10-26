import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { OperationService } from '../../src/operations/service.js';
import { OperationStore } from '../../src/operations/store.js';
import { createCreatorContentProvider, CreatorContentService } from '../../src/youtube/creator-content.js';
import { YouTubeClient, type YouTubeDataApi } from '../../src/youtube/client.js';
import type { AppConfig } from '../../src/types.js';

const directories: string[] = [];
const creator = { id: 'creator-a', purpose: 'creator' as const, channelId: 'channel-a' };

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'youtube-mcp-creator-content-'));
  directories.push(directory);
  return directory;
}

async function service(overrides: Record<string, unknown> = {}) {
  const stateDir = await temporaryDirectory();
  const provider = {
    getVideo: vi.fn(async () => ({
      id: 'video-1', channelId: 'channel-a', etag: 'video-etag',
      snippet: { title: 'Old', description: 'Old description', tags: ['old'], categoryId: '22', defaultLanguage: 'en' },
      status: { privacyStatus: 'private', containsSyntheticMedia: false },
    })),
    setThumbnail: vi.fn(async () => ({ id: 'video-1' })),
    updateVideo: vi.fn(async () => ({ id: 'video-1' })),
    listCaptions: vi.fn(async () => ([{ id: 'caption-1', videoId: 'video-1', language: 'en', name: 'English', etag: 'caption-etag' }])),
    insertCaption: vi.fn(async () => ({ id: 'caption-2' })),
    updateCaption: vi.fn(async () => ({ id: 'caption-1' })),
    downloadCaption: vi.fn(async () => 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello'),
    deleteCaption: vi.fn(async () => undefined),
    ...overrides,
  };
  const resources = {
    getOwnedVideo: vi.fn(async (videoId: string) => ({
      item: { id: videoId, title: 'Old', channelId: 'channel-a', etag: 'video-etag' },
      profile: creator,
      fetchedAt: '2026-08-18T01:00:00.000Z',
      expiresAt: '2026-08-18T01:15:00.000Z',
    })),
    listCaptionTracks: vi.fn(async () => ({
      items: [{ id: 'caption-1', videoId: 'video-1', language: 'en', name: 'English', etag: 'caption-etag' }],
      profile: creator,
      fetchedAt: '2026-08-18T01:00:00.000Z',
      expiresAt: '2026-08-18T01:15:00.000Z',
    })),
  };
  const operations = new OperationService(new OperationStore(stateDir), () => new Date('2026-08-18T01:00:00.000Z'));
  return {
    content: new CreatorContentService(operations, resources, provider, creator),
    operations,
    provider,
    resources,
  };
}

async function approve(content: CreatorContentService, preview: { approvalId: string }) {
  await content.approve({ approvalId: preview.approvalId, confirm: true });
}

describe('CreatorContentService', () => {
  it('rejects execution before rereading provider state when the preview is not approved', async () => {
    const { content, provider, resources } = await service();
    const preview = await content.preflightMetadataUpdate({ videoId: 'video-1', title: 'New' });
    provider.getVideo.mockClear();
    resources.getOwnedVideo.mockClear();

    await expect(content.updateMetadata({ approvalId: preview.approvalId, videoId: 'video-1', title: 'New', confirm: true }))
      .rejects.toMatchObject({ code: 'approval_required' });
    expect(provider.getVideo).not.toHaveBeenCalled();
    expect(resources.getOwnedVideo).not.toHaveBeenCalled();
  });

  it('merges an approved title update into the current mutable metadata', async () => {
    const { content, provider } = await service();
    const preview = await content.preflightMetadataUpdate({ videoId: 'video-1', title: 'New' });
    await approve(content, preview);

    await expect(content.updateMetadata({ approvalId: preview.approvalId, videoId: 'video-1', title: 'New', confirm: true }))
      .resolves.toMatchObject({ operationId: preview.approvalId, state: 'succeeded', videoId: 'video-1' });
    expect(provider.updateVideo).toHaveBeenCalledWith({
      id: 'video-1',
      snippet: { title: 'New', description: 'Old description', tags: ['old'], categoryId: '22', defaultLanguage: 'en' },
      status: { privacyStatus: 'private', containsSyntheticMedia: false },
    });
  });

  it('executes an approved metadata update after an MCP restart', async () => {
    const { content, operations, provider, resources } = await service();
    const preview = await content.preflightMetadataUpdate({ videoId: 'video-1', title: 'New' });
    await approve(content, preview);
    const restarted = new CreatorContentService(operations, resources, provider, creator);

    await expect(restarted.updateMetadata({ approvalId: preview.approvalId, videoId: 'video-1', title: 'New', confirm: true }))
      .resolves.toMatchObject({ operationId: preview.approvalId, state: 'succeeded', videoId: 'video-1' });
  });

  it('preserves the complete mutable video status including made-for-kids fields', async () => {
    const { content, provider } = await service({
      getVideo: vi.fn(async () => ({
        id: 'video-1', channelId: 'channel-a', etag: 'video-etag',
        snippet: { title: 'Old' },
        status: {
          privacyStatus: 'private', license: 'youtube', embeddable: false,
          publicStatsViewable: false, selfDeclaredMadeForKids: true, containsSyntheticMedia: false,
        },
      })),
    });
    const preview = await content.preflightMetadataUpdate({ videoId: 'video-1', title: 'New' });
    await approve(content, preview);

    await content.updateMetadata({ approvalId: preview.approvalId, videoId: 'video-1', title: 'New', confirm: true });

    expect(provider.updateVideo).toHaveBeenCalledWith(expect.objectContaining({
      status: {
        privacyStatus: 'private', license: 'youtube', embeddable: false,
        publicStatsViewable: false, selfDeclaredMadeForKids: true, containsSyntheticMedia: false,
      },
    }));
  });

  it('applies an elevated self-declared made-for-kids change without dropping other status fields', async () => {
    const { content, provider } = await service({
      getVideo: vi.fn(async () => ({
        id: 'video-1', channelId: 'channel-a', etag: 'video-etag', snippet: { title: 'Old' },
        status: { privacyStatus: 'private', license: 'youtube', embeddable: true, publicStatsViewable: true, selfDeclaredMadeForKids: true },
      })),
    });
    const preview = await content.preflightMetadataUpdate({ videoId: 'video-1', selfDeclaredMadeForKids: false, elevated: true });
    await approve(content, preview);

    await content.updateMetadata({ approvalId: preview.approvalId, videoId: 'video-1', selfDeclaredMadeForKids: false, elevated: true, confirm: true });

    expect(provider.updateVideo).toHaveBeenCalledWith(expect.objectContaining({
      status: { privacyStatus: 'private', license: 'youtube', embeddable: true, publicStatsViewable: true, selfDeclaredMadeForKids: false },
    }));
  });

  it('settles a claimed provider failure as unknown with an exact reconciliation hint', async () => {
    const { content, operations } = await service({ updateVideo: vi.fn(async () => Promise.reject(new Error('connection dropped'))) });
    const preview = await content.preflightMetadataUpdate({ videoId: 'video-1', title: 'New' });
    await approve(content, preview);

    await expect(content.updateMetadata({ approvalId: preview.approvalId, videoId: 'video-1', title: 'New', confirm: true }))
      .rejects.toMatchObject({
        code: 'provider_outcome_unknown', retryable: false, operationId: preview.approvalId,
        reconciliation: { tool: 'youtube_get_owned_video', arguments: { videoId: 'video-1' } },
      });
    await expect(operations.reconcile({ profileId: creator.id, channelId: creator.channelId, operationId: preview.approvalId }))
      .resolves.toMatchObject({ state: 'unknown' });
  });

  it('rejects a metadata write when the reread fingerprint is stale before calling YouTube', async () => {
    const { content, provider } = await service();
    const preview = await content.preflightMetadataUpdate({ videoId: 'video-1', title: 'New' });
    await approve(content, preview);
    provider.getVideo.mockResolvedValueOnce({
      id: 'video-1', channelId: 'channel-a', etag: 'changed-etag',
      snippet: { title: 'Someone else changed this', description: 'Old description', tags: ['old'], categoryId: '22', defaultLanguage: 'en' },
      status: { privacyStatus: 'private', containsSyntheticMedia: false },
    });

    await expect(content.updateMetadata({ approvalId: preview.approvalId, videoId: 'video-1', title: 'New', confirm: true }))
      .rejects.toMatchObject({ code: 'stale_preview' });
    expect(provider.updateVideo).not.toHaveBeenCalled();
  });

  it('requires explicit elevated intent for public, scheduled, and synthetic-media metadata changes', async () => {
    const { content } = await service();

    await expect(content.preflightMetadataUpdate({ videoId: 'video-1', privacyStatus: 'public', publish: true }))
      .rejects.toMatchObject({ code: 'elevated_confirmation_required' });
    await expect(content.preflightMetadataUpdate({ videoId: 'video-1', publishAt: '2026-08-19T01:00:00.000Z' }))
      .rejects.toMatchObject({ code: 'elevated_confirmation_required' });
    await expect(content.preflightMetadataUpdate({ videoId: 'video-1', containsSyntheticMedia: true }))
      .rejects.toMatchObject({ code: 'elevated_confirmation_required' });
  });

  it('requires publish intent as well as elevated intent before public visibility can be previewed', async () => {
    const { content } = await service();

    await expect(content.preflightMetadataUpdate({ videoId: 'video-1', privacyStatus: 'public', elevated: true }))
      .rejects.toMatchObject({ code: 'publish_confirmation_required' });
  });

  it('sets an owned thumbnail only after a confirmed fingerprint-bound preview', async () => {
    const directory = await temporaryDirectory();
    const imagePath = join(directory, 'thumbnail.png');
    await writeFile(imagePath, 'not actually decoded, but local bytes');
    const { content, provider, resources } = await service();
    const preview = await content.preflightThumbnail({ videoId: 'video-1', filePath: imagePath, mimeType: 'image/png' });
    await approve(content, preview);

    await expect(content.setThumbnail({ approvalId: preview.approvalId, videoId: 'video-1', filePath: imagePath, mimeType: 'image/png', confirm: true }))
      .resolves.toMatchObject({ operationId: preview.approvalId, state: 'succeeded', videoId: 'video-1' });
    expect(resources.getOwnedVideo).toHaveBeenCalledWith('video-1');
    expect(provider.setThumbnail).toHaveBeenCalledWith(expect.objectContaining({ videoId: 'video-1', mimeType: 'image/png' }));
  });

  it('uploads the exact thumbnail bytes that were fingerprinted even if the pathname changes', async () => {
    const directory = await temporaryDirectory();
    const imagePath = join(directory, 'thumbnail.png');
    const original = Buffer.from('original thumbnail bytes');
    await writeFile(imagePath, original);
    let uploadedBytes: Uint8Array | undefined;
    const { content } = await service({
      setThumbnail: vi.fn(async (input: unknown) => {
        await writeFile(imagePath, 'replacement thumbnail bytes');
        uploadedBytes = (input as { bytes?: Uint8Array }).bytes;
        return { id: 'video-1' };
      }),
    });
    const preview = await content.preflightThumbnail({ videoId: 'video-1', filePath: imagePath, mimeType: 'image/png' });
    await approve(content, preview);

    await content.setThumbnail({ approvalId: preview.approvalId, videoId: 'video-1', filePath: imagePath, mimeType: 'image/png', confirm: true });

    expect(Buffer.from(uploadedBytes!)).toEqual(original);
    expect(createHash('sha256').update(uploadedBytes!).digest('hex')).toBe(preview.currentFingerprint);
  });

  it('rejects an oversized thumbnail during preflight before any approval or provider call', async () => {
    const directory = await temporaryDirectory();
    const imagePath = join(directory, 'large.jpg');
    await writeFile(imagePath, Buffer.alloc(2_000_001));
    const { content, provider } = await service();

    await expect(content.preflightThumbnail({ videoId: 'video-1', filePath: imagePath, mimeType: 'image/jpeg' }))
      .rejects.toMatchObject({ code: 'invalid_file' });
    expect(provider.setThumbnail).not.toHaveBeenCalled();
  });

  it('rejects a thumbnail MIME type outside the supported local-file contract', async () => {
    const directory = await temporaryDirectory();
    const imagePath = join(directory, 'thumbnail.gif');
    await writeFile(imagePath, 'local image bytes');
    const { content } = await service();

    await expect(content.preflightThumbnail({ videoId: 'video-1', filePath: imagePath, mimeType: 'image/gif' as never }))
      .rejects.toMatchObject({ code: 'invalid_file' });
  });

  it('uploads, updates, downloads, and deletes only caption tracks owned by the selected video', async () => {
    const directory = await temporaryDirectory();
    const captionPath = join(directory, 'captions.vtt');
    const outputPath = join(directory, 'downloaded.vtt');
    await writeFile(captionPath, 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello');
    const { content, provider } = await service();

    const upload = await content.preflightCaptionUpload({ videoId: 'video-1', filePath: captionPath, mimeType: 'text/vtt', language: 'en', name: 'English' });
    await approve(content, upload);
    await expect(content.uploadCaption({ approvalId: upload.approvalId, videoId: 'video-1', filePath: captionPath, mimeType: 'text/vtt', language: 'en', name: 'English', confirm: true }))
      .resolves.toMatchObject({ state: 'succeeded', captionId: 'caption-2' });

    const update = await content.preflightCaptionUpdate({ videoId: 'video-1', captionId: 'caption-1', filePath: captionPath, mimeType: 'text/vtt', language: 'en', name: 'English' });
    await approve(content, update);
    await expect(content.updateCaption({ approvalId: update.approvalId, videoId: 'video-1', captionId: 'caption-1', filePath: captionPath, mimeType: 'text/vtt', language: 'en', name: 'English', confirm: true }))
      .resolves.toMatchObject({ state: 'succeeded', captionId: 'caption-1' });

    const download = await content.preflightCaptionDownload({ videoId: 'video-1', captionId: 'caption-1', outputPath });
    await approve(content, download);
    await expect(content.downloadCaption({ approvalId: download.approvalId, videoId: 'video-1', captionId: 'caption-1', outputPath, confirm: true }))
      .resolves.toMatchObject({ state: 'succeeded', captionId: 'caption-1', downloaded: true });
    await expect(readFile(outputPath, 'utf8')).resolves.toContain('WEBVTT');

    const deletion = await content.preflightCaptionDelete({ videoId: 'video-1', captionId: 'caption-1' });
    await approve(content, deletion);
    await expect(content.deleteCaption({ approvalId: deletion.approvalId, videoId: 'video-1', captionId: 'caption-1', confirm: true }))
      .resolves.toMatchObject({ state: 'succeeded', captionId: 'caption-1', deleted: true });
    expect(provider.insertCaption).toHaveBeenCalledTimes(1);
    expect(provider.updateCaption).toHaveBeenCalledTimes(1);
    expect(provider.deleteCaption).toHaveBeenCalledWith({ captionId: 'caption-1' });
  });

  it('uploads the exact caption bytes that were fingerprinted even if the pathname changes', async () => {
    const directory = await temporaryDirectory();
    const captionPath = join(directory, 'captions.vtt');
    const original = Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\nOriginal');
    await writeFile(captionPath, original);
    let uploadedBytes: Uint8Array | undefined;
    const { content } = await service({
      insertCaption: vi.fn(async (input: unknown) => {
        await writeFile(captionPath, 'WEBVTT\n\nReplacement');
        uploadedBytes = (input as { bytes?: Uint8Array }).bytes;
        return { id: 'caption-2' };
      }),
    });
    const input = { videoId: 'video-1', filePath: captionPath, mimeType: 'text/vtt' as const, language: 'en', name: 'English' };
    const preview = await content.preflightCaptionUpload(input);
    await approve(content, preview);

    await content.uploadCaption({ ...input, approvalId: preview.approvalId, confirm: true });

    expect(Buffer.from(uploadedBytes!)).toEqual(original);
    expect(createHash('sha256').update(uploadedBytes!).digest('hex')).toBe(preview.currentFingerprint);
  });

  it('requires a non-empty caption name for both insert and update previews', async () => {
    const directory = await temporaryDirectory();
    const captionPath = join(directory, 'captions.vtt');
    await writeFile(captionPath, 'WEBVTT');
    const { content, provider } = await service();

    await expect(content.preflightCaptionUpload({ videoId: 'video-1', filePath: captionPath, mimeType: 'text/vtt', language: 'en' } as never))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(content.preflightCaptionUpdate({ videoId: 'video-1', captionId: 'caption-1', filePath: captionPath, mimeType: 'text/vtt', language: 'en' } as never))
      .rejects.toMatchObject({ code: 'invalid_input' });
    expect(provider.insertCaption).not.toHaveBeenCalled();
    expect(provider.updateCaption).not.toHaveBeenCalled();
  });

  it('requests a binary caption download and normalizes ArrayBuffer bytes', async () => {
    let downloadOptions: unknown;
    const api = {
      search: { list: async () => ({ data: { items: [] } }) },
      videos: { list: async () => ({ data: { items: [] } }), update: async () => ({ data: {} }) },
      channels: { list: async () => ({ data: { items: [] } }) },
      commentThreads: { list: async () => ({ data: { items: [] } }) },
      videoCategories: { list: async () => ({ data: { items: [] } }) },
      playlists: { list: async () => ({ data: { items: [] } }) },
      playlistItems: { list: async () => ({ data: { items: [] } }) },
      thumbnails: { set: async () => ({ data: {} }) },
      captions: {
        list: async () => ({ data: { items: [] } }), insert: async () => ({ data: {} }), update: async () => ({ data: {} }), delete: async () => ({ data: {} }),
        download: async (_request: Record<string, unknown>, options?: unknown) => { downloadOptions = options; return { data: new Uint8Array([0, 255, 7]).buffer }; },
      },
    } as YouTubeDataApi;
    const config: AppConfig = { stateDir: '/tmp/youtube-mcp-tests', diagnostics: () => 'safe' };
    const provider = createCreatorContentProvider({ getAccessToken: async () => 'access-token' }, new YouTubeClient(config, { createAuthorizedApi: () => api, createPublicApi: () => api }));

    await expect(provider.downloadCaption({ captionId: 'caption-1', format: 'vtt' })).resolves.toEqual(new Uint8Array([0, 255, 7]));
    expect(downloadOptions).toEqual({ responseType: 'arraybuffer' });
  });

  it('uses the caption update part and request body required for file-only and draft updates', async () => {
    const updateRequests: Array<Record<string, unknown>> = [];
    const api = {
      search: { list: async () => ({ data: { items: [] } }) },
      videos: { list: async () => ({ data: { items: [] } }), update: async () => ({ data: {} }) },
      channels: { list: async () => ({ data: { items: [] } }) },
      commentThreads: { list: async () => ({ data: { items: [] } }) },
      videoCategories: { list: async () => ({ data: { items: [] } }) },
      playlists: { list: async () => ({ data: { items: [] } }) },
      playlistItems: { list: async () => ({ data: { items: [] } }) },
      thumbnails: { set: async () => ({ data: {} }) },
      captions: {
        list: async () => ({ data: { items: [] } }), insert: async () => ({ data: {} }), download: async () => ({ data: '' }), delete: async () => ({ data: {} }),
        update: async (request: Record<string, unknown>) => { updateRequests.push(request); return { data: { id: 'caption-1' } }; },
      },
    } as YouTubeDataApi;
    const config: AppConfig = { stateDir: '/tmp/youtube-mcp-tests', diagnostics: () => 'safe' };
    const provider = createCreatorContentProvider({ getAccessToken: async () => 'access-token' }, new YouTubeClient(config, { createAuthorizedApi: () => api, createPublicApi: () => api }));
    const bytes = new Uint8Array([1, 2, 3]);
    const base = { captionId: 'caption-1', videoId: 'video-1', bytes, mimeType: 'text/vtt' as const, language: 'en', name: 'English' };

    await provider.updateCaption(base as never);
    await provider.updateCaption({ ...base, isDraft: true } as never);

    expect(updateRequests).toEqual([
      { part: ['id'], requestBody: { id: 'caption-1' }, media: { mimeType: 'text/vtt', body: bytes } },
      { part: ['snippet'], requestBody: { id: 'caption-1', snippet: { isDraft: true } }, media: { mimeType: 'text/vtt', body: bytes } },
    ]);
  });

  it('rejects caption changes for IDs absent from the owned video before calling the provider', async () => {
    const directory = await temporaryDirectory();
    const captionPath = join(directory, 'captions.vtt');
    await writeFile(captionPath, 'WEBVTT');
    const { content, provider } = await service();

    await expect(content.preflightCaptionUpdate({ videoId: 'video-1', captionId: 'other-caption', filePath: captionPath, mimeType: 'text/vtt', language: 'en', name: 'English' }))
      .rejects.toMatchObject({ code: 'ownership_required' });
    expect(provider.updateCaption).not.toHaveBeenCalled();
  });

  it('binds a caption download approval to the requested local destination without persisting that path', async () => {
    const directory = await temporaryDirectory();
    const approvedPath = join(directory, 'approved.vtt');
    const changedPath = join(directory, 'changed.vtt');
    const { content, provider } = await service();
    const preview = await content.preflightCaptionDownload({ videoId: 'video-1', captionId: 'caption-1', outputPath: approvedPath });
    await approve(content, preview);

    await expect(content.downloadCaption({ approvalId: preview.approvalId, videoId: 'video-1', captionId: 'caption-1', outputPath: changedPath, confirm: true }))
      .rejects.toMatchObject({ code: 'approval_required' });
    expect(provider.downloadCaption).not.toHaveBeenCalled();
  });

  it('creates a caption download destination exclusively instead of overwriting an existing file', async () => {
    const directory = await temporaryDirectory();
    const outputPath = join(directory, 'existing.vtt');
    await writeFile(outputPath, 'keep this file');
    const { content } = await service();
    const preview = await content.preflightCaptionDownload({ videoId: 'video-1', captionId: 'caption-1', outputPath });
    await approve(content, preview);

    await expect(content.downloadCaption({ approvalId: preview.approvalId, videoId: 'video-1', captionId: 'caption-1', outputPath, confirm: true }))
      .rejects.toMatchObject({ code: 'caption_destination_exists' });
    await expect(readFile(outputPath, 'utf8')).resolves.toBe('keep this file');
  });

  it('does not follow a symbolic link selected as a caption download destination', async () => {
    const directory = await temporaryDirectory();
    const targetPath = join(directory, 'target.vtt');
    const outputPath = join(directory, 'download.vtt');
    await writeFile(targetPath, 'keep the symlink target');
    await symlink(targetPath, outputPath);
    const { content } = await service();
    const preview = await content.preflightCaptionDownload({ videoId: 'video-1', captionId: 'caption-1', outputPath });
    await approve(content, preview);

    await expect(content.downloadCaption({ approvalId: preview.approvalId, videoId: 'video-1', captionId: 'caption-1', outputPath, confirm: true }))
      .rejects.toMatchObject({ code: 'caption_destination_exists' });
    await expect(readFile(targetPath, 'utf8')).resolves.toBe('keep the symlink target');
  });

  it('returns the exact caption target summary before deletion', async () => {
    const { content } = await service();

    const preview = await content.preflightCaptionDelete({ videoId: 'video-1', captionId: 'caption-1' });

    expect(preview.desired).toEqual({
      captionId: 'caption-1',
      videoId: 'video-1',
      target: { captionId: 'caption-1', videoId: 'video-1', language: 'en', name: 'English', etag: 'caption-etag' },
    });
  });
});
