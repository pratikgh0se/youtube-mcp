import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export type UploadStatus = 'created' | 'in_progress' | 'unknown' | 'complete' | 'cancelled';

/** The minimum local state needed to probe or resume a resumable upload. */
export type UploadRecord = {
  uploadId: string;
  sessionUrl: string;
  fileSize: number;
  fileFingerprint: string;
  offset: number;
  metadataFingerprint: string;
  createdAt: string;
  lastStatus: UploadStatus;
};

export class UploadStore {
  constructor(private readonly stateDir: string, private readonly scope: { profileId: string; channelId: string }) {}

  async save(record: UploadRecord): Promise<void> {
    validateRecord(record);
    const directory = this.uploadDirectory();
    const temporaryPath = join(directory, `.${record.uploadId}.${randomUUID()}.tmp`);
    const destination = this.filePath(record.uploadId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await writeFile(temporaryPath, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, destination);
    await chmod(destination, 0o600);
  }

  async get(uploadId: string): Promise<UploadRecord | undefined> {
    validateUploadId(uploadId);
    try {
      const record: unknown = JSON.parse(await readFile(this.filePath(uploadId), 'utf8'));
      if (!isUploadRecord(record)) throw new Error('invalid upload record');
      return record;
    } catch (error) {
      if (isMissingFileError(error)) return undefined;
      throw error;
    }
  }

  async updateProgress(uploadId: string, offset: number, lastStatus: UploadStatus): Promise<UploadRecord | undefined> {
    const existing = await this.get(uploadId);
    if (!existing) return undefined;
    if (!Number.isInteger(offset) || offset < 0 || offset > existing.fileSize) throw new Error('invalid upload offset');
    const updated = { ...existing, offset, lastStatus };
    await this.save(updated);
    return updated;
  }

  async remove(uploadId: string): Promise<void> {
    validateUploadId(uploadId);
    await rm(this.filePath(uploadId), { force: true });
  }

  private uploadDirectory(): string {
    return join(this.stateDir, 'profiles', safeScopeId(this.scope.profileId), 'channels', safeScopeId(this.scope.channelId), 'uploads');
  }

  private filePath(uploadId: string): string {
    validateUploadId(uploadId);
    return join(this.uploadDirectory(), `${uploadId}.json`);
  }
}

function safeScopeId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new Error('invalid upload scope');
  return value;
}

function validateRecord(record: UploadRecord): void {
  if (!isUploadRecord(record)) throw new Error('invalid upload record');
}

function isUploadRecord(value: unknown): value is UploadRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<UploadRecord>;
  return typeof record.uploadId === 'string' && isSafeUploadId(record.uploadId) &&
    typeof record.sessionUrl === 'string' && isTrustedSessionUrl(record.sessionUrl) &&
    typeof record.fileSize === 'number' && Number.isSafeInteger(record.fileSize) && record.fileSize >= 0 &&
    typeof record.fileFingerprint === 'string' && record.fileFingerprint.length > 0 &&
    typeof record.offset === 'number' && Number.isSafeInteger(record.offset) && record.offset >= 0 && record.offset <= record.fileSize &&
    typeof record.metadataFingerprint === 'string' && record.metadataFingerprint.length > 0 &&
    typeof record.createdAt === 'string' && !Number.isNaN(Date.parse(record.createdAt)) &&
    (record.lastStatus === 'created' || record.lastStatus === 'in_progress' || record.lastStatus === 'unknown' || record.lastStatus === 'complete' || record.lastStatus === 'cancelled');
}

function isTrustedSessionUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'www.googleapis.com' || url.hostname === 'upload.youtube.com');
  } catch {
    return false;
  }
}

function validateUploadId(uploadId: string): void {
  if (!isSafeUploadId(uploadId)) throw new Error('invalid upload ID');
}

function isSafeUploadId(uploadId: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(uploadId);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
