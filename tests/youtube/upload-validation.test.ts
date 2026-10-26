import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { UploadValidationError, validateUploadInput } from '../../src/youtube/upload-validation.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function fixtureVideo(name = 'video.mp4'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'youtube-mcp-video-'));
  directories.push(directory);
  const file = join(directory, name);
  await writeFile(file, 'safe local video bytes');
  return file;
}

describe('validateUploadInput', () => {
  it('returns safe file facts and stable fingerprints for a private local video', async () => {
    const filePath = await fixtureVideo();

    await expect(validateUploadInput({
      filePath,
      title: 'Bangkok street food',
      description: 'A short local food video.',
      privacyStatus: 'private',
    })).resolves.toEqual(expect.objectContaining({
      fileSize: 22,
      mimeType: 'video/mp4',
      fileFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      metadataFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    }));
  });

  it('rejects a relative path before reading a file', async () => {
    await expect(validateUploadInput({ filePath: 'video.mp4', title: 'Valid', privacyStatus: 'private' }))
      .rejects.toMatchObject({ code: 'invalid_upload_file' } satisfies Partial<UploadValidationError>);
  });

  it('rejects directories and non-video file types', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'youtube-mcp-directory-'));
    directories.push(directory);
    const textFile = join(directory, 'notes.txt');
    await writeFile(textFile, 'not video');

    await expect(validateUploadInput({ filePath: directory, title: 'Valid', privacyStatus: 'private' })).rejects.toMatchObject({ code: 'invalid_upload_file' });
    await expect(validateUploadInput({ filePath: textFile, title: 'Valid', privacyStatus: 'private' })).rejects.toMatchObject({ code: 'unsupported_upload_media' });
  });

  it('rejects unsafe metadata and invalid scheduled publishing', async () => {
    const filePath = await fixtureVideo();

    await expect(validateUploadInput({ filePath, title: '', privacyStatus: 'private' })).rejects.toMatchObject({ code: 'invalid_upload_metadata' });
    await expect(validateUploadInput({ filePath, title: 'Valid', privacyStatus: 'public', publishAt: '2026-08-18T02:00:00.000Z' })).rejects.toMatchObject({ code: 'invalid_upload_schedule' });
  });

  it('detects when source content changes before a resume', async () => {
    const filePath = await fixtureVideo();
    const original = await validateUploadInput({ filePath, title: 'Valid', privacyStatus: 'private' });
    await writeFile(filePath, 'replacement video bytes');

    await expect(validateUploadInput({ filePath, title: 'Valid', privacyStatus: 'private', expectedFileFingerprint: original.fileFingerprint }))
      .rejects.toMatchObject({ code: 'upload_source_changed' });
  });
});
