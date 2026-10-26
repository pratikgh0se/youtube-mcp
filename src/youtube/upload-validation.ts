import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';

import { AppError } from '../errors.js';

const MAX_UPLOAD_SIZE_BYTES = 256 * 1024 * 1024 * 1024;
const MIME_TYPES: Record<string, string> = {
  '.3gpp': 'video/3gpp',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.m4v': 'video/x-m4v',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.webm': 'video/webm',
  '.wmv': 'video/x-ms-wmv',
};

export type UploadValidationInput = {
  filePath: string;
  title: string;
  description?: string;
  privacyStatus: 'private' | 'unlisted' | 'public';
  publishAt?: string;
  expectedFileFingerprint?: string;
};

export type ValidatedUpload = {
  fileSize: number;
  mimeType: string;
  fileFingerprint: string;
  metadataFingerprint: string;
};

export type UploadValidationErrorCode = 'invalid_upload_file' | 'unsupported_upload_media' | 'invalid_upload_metadata' | 'invalid_upload_schedule' | 'upload_source_changed';

export class UploadValidationError extends AppError {
  constructor(code: UploadValidationErrorCode) {
    const details = uploadValidationErrorDetails[code];
    super(code, details.message, details.action, false);
    this.name = 'UploadValidationError';
  }
}

const uploadValidationErrorDetails: Record<UploadValidationErrorCode, { message: string; action: string }> = {
  invalid_upload_file: {
    message: 'The upload source must be a readable, non-empty absolute path to a regular file.',
    action: 'Choose a local video file and preflight the upload again.',
  },
  unsupported_upload_media: {
    message: 'The upload source does not use a supported video file extension.',
    action: 'Choose a supported YouTube video file and preflight again.',
  },
  invalid_upload_metadata: {
    message: 'The upload title or description is outside the supported limits.',
    action: 'Provide a non-empty title of at most 100 characters and a description of at most 5000 characters.',
  },
  invalid_upload_schedule: {
    message: 'The scheduled publish time is invalid for this upload.',
    action: 'Use a future timestamp with private visibility, then preflight again.',
  },
  upload_source_changed: {
    message: 'The upload source changed after it was approved.',
    action: 'Preflight and approve the current file before uploading it.',
  },
};

/** Validates local upload inputs without returning or retaining the source path or bytes. */
export async function validateUploadInput(input: UploadValidationInput): Promise<ValidatedUpload> {
  return withValidatedUpload(input, async (validated) => validated);
}

/** Executes against the same verified descriptor that was fingerprinted, preventing pathname replacement. */
export async function withValidatedUpload<T>(input: UploadValidationInput, action: (validated: ValidatedUpload, fileDescriptor: number) => Promise<T>): Promise<T> {
  if (!isAbsolute(input.filePath)) throw new UploadValidationError('invalid_upload_file');

  let handle: FileHandle;
  try {
    const pathEntry = await lstat(input.filePath);
    if (!pathEntry.isFile() || pathEntry.isSymbolicLink()) throw new UploadValidationError('invalid_upload_file');
    handle = await open(input.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new UploadValidationError('invalid_upload_file');
  }
  try {
    const source = await handle.stat();
    if (!source.isFile() || source.size <= 0 || source.size > MAX_UPLOAD_SIZE_BYTES) throw new UploadValidationError('invalid_upload_file');
    const extension = extname(input.filePath).toLowerCase();
    const mimeType = MIME_TYPES[extension];
    if (!mimeType) throw new UploadValidationError('unsupported_upload_media');

    const title = input.title.trim();
    const description = input.description ?? '';
    if (!title || title.length > 100 || description.length > 5_000) throw new UploadValidationError('invalid_upload_metadata');
    validateSchedule(input.privacyStatus, input.publishAt);

    const fileFingerprint = await fingerprintFile(handle);
    if (input.expectedFileFingerprint && input.expectedFileFingerprint !== fileFingerprint) {
      throw new UploadValidationError('upload_source_changed');
    }

    return await action({
      fileSize: source.size,
      mimeType,
      fileFingerprint,
      metadataFingerprint: fingerprintMetadata({ title, description, privacyStatus: input.privacyStatus, publishAt: input.publishAt }),
    }, handle.fd);
  } finally {
    await handle.close();
  }
}

function validateSchedule(privacyStatus: UploadValidationInput['privacyStatus'], publishAt: string | undefined): void {
  if (!publishAt) return;
  const timestamp = Date.parse(publishAt);
  if (privacyStatus !== 'private' || Number.isNaN(timestamp) || timestamp <= Date.now()) {
    throw new UploadValidationError('invalid_upload_schedule');
  }
}

function fingerprintMetadata(metadata: Record<string, string | undefined>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(metadata)).digest('hex')}`;
}

async function fingerprintFile(handle: FileHandle): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (let position = 0;; position += buffer.length) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    if (bytesRead < buffer.length) break;
  }
  return `sha256:${hash.digest('hex')}`;
}
