import { createHash, randomUUID } from 'node:crypto';

import { AppError } from '../errors.js';
import type { OperationPreview, OperationReconciliation } from '../types.js';
import type { OperationService } from '../operations/service.js';
import { UploadStore, type UploadRecord, type UploadStatus } from './upload-store.js';
import { validateUploadInput, withValidatedUpload, type UploadValidationInput, type ValidatedUpload } from './upload-validation.js';

type CreatorProfile = { id: string; purpose: 'creator'; channelId: string };

export type UploadRequest = Omit<UploadValidationInput, 'privacyStatus'> & {
  privacyStatus?: 'private' | 'unlisted' | 'public';
  publish?: boolean;
};

export type ApprovedUploadRequest = UploadRequest & {
  approvalId: string;
  confirm?: boolean;
};

export type UploadStatusResult = {
  uploadId: string;
  operationId?: string;
  state: UploadStatus | 'expired';
  offset?: number;
  videoId?: string;
  reconciliation?: OperationReconciliation;
};

export type ResumableUploadProvider = {
  initialize(request: {
    title: string;
    description?: string;
    privacyStatus: 'private' | 'unlisted' | 'public';
    publishAt?: string;
    fileSize: number;
    mimeType: string;
  }): Promise<{ status: number; sessionUrl?: string }>;
  probe(sessionUrl: string, fileSize: number): Promise<{ status: number; offset?: number; videoId?: string }>;
  uploadChunk(request: { sessionUrl: string; filePath: string; fileDescriptor?: number; offset: number; fileSize: number; mimeType: string }): Promise<{ status: number; offset?: number; videoId?: string }>;
  cancel(sessionUrl: string): Promise<{ status: number }>;
};

type NormalizedUploadRequest = Required<Pick<UploadRequest, 'filePath' | 'title'>> & UploadRequest & { privacyStatus: 'private' | 'unlisted' | 'public' };

/** Safe local orchestration for resumable uploads. Media bytes are passed only to the provider adapter. */
export class UploadService {
  constructor(
    private readonly operations: Pick<OperationService, 'preflight' | 'approve' | 'requireApproved' | 'claim' | 'settle'>,
    private readonly store: UploadStore,
    private readonly provider: ResumableUploadProvider,
    private readonly profile: CreatorProfile,
    private readonly principal: { verifyPrincipal(): Promise<unknown> },
  ) {}

  async preflight(input: UploadRequest): Promise<OperationPreview> {
    const request = normalize(input);
    requirePublish(request);
    const validated = await validateUploadInput(request);
    await this.principal.verifyPrincipal();
    const uploadId = randomUUID();
    const preview = await this.operations.preflight({
      profile: this.profile,
      kind: 'video.upload',
      targetId: uploadId,
      desired: desiredOf(request, validated),
      currentFingerprint: validated.fileFingerprint,
      reconciliation: uploadReconciliation(uploadId),
    });
    return preview;
  }

  async preflightResume(input: UploadRequest & { uploadId: string }): Promise<OperationPreview> {
    const record = await this.requiredRecord(input.uploadId);
    const request = normalize(input);
    requirePublish(request);
    const validated = await validateUploadInput({ ...request, expectedFileFingerprint: record.fileFingerprint });
    if (validated.metadataFingerprint !== record.metadataFingerprint) throw metadataChangedError();
    await this.principal.verifyPrincipal();
    const preview = await this.operations.preflight({
      profile: this.profile,
      kind: 'video.upload.resume',
      targetId: record.uploadId,
      desired: desiredOf(request, validated),
      currentFingerprint: recordFingerprint(record),
      reconciliation: uploadReconciliation(record.uploadId),
    });
    return preview;
  }

  async preflightCancel(input: { uploadId: string }): Promise<OperationPreview> {
    await this.principal.verifyPrincipal();
    const record = await this.requiredRecord(input.uploadId);
    const preview = await this.operations.preflight({
      profile: this.profile,
      kind: 'video.upload.cancel',
      targetId: record.uploadId,
      desired: { uploadId: record.uploadId },
      currentFingerprint: recordFingerprint(record),
      reconciliation: uploadReconciliation(record.uploadId),
    });
    return preview;
  }

  async approve(input: { approvalId: string; confirm?: boolean }): Promise<OperationPreview> {
    return this.operations.approve({ approvalId: input.approvalId, confirm: input.confirm, profileId: this.profile.id, channelId: this.profile.channelId });
  }

  async upload(input: ApprovedUploadRequest): Promise<UploadStatusResult> {
    const request = normalize(input);
    requirePublish(request);
    const preview = await this.requireApproved(input.approvalId, input.confirm);
    this.requirePreview(preview, 'video.upload', preview.targetId);
    await this.principal.verifyPrincipal();
    return withValidatedUpload({ ...request, expectedFileFingerprint: desiredString(preview, 'fileFingerprint') }, async (validated, fileDescriptor) => {
      const desired = desiredOf(request, validated);
      this.requirePreview(preview, 'video.upload', preview.targetId, desired);
      await this.claim(input.approvalId, validated.fileFingerprint, input.confirm);
      let initialized: { status: number; sessionUrl?: string };
      try {
        initialized = await this.provider.initialize({ title: request.title.trim(), description: request.description, privacyStatus: request.privacyStatus, publishAt: request.publishAt, fileSize: validated.fileSize, mimeType: validated.mimeType });
      } catch {
        return this.outcome(input.approvalId, unknown(preview.targetId, input.approvalId));
      }
      if (initialized.status === 404) {
        await this.outcome(input.approvalId, unknown(preview.targetId, input.approvalId));
        throw expiredError(input.approvalId, preview.targetId);
      }
      if (!initialized.sessionUrl || initialized.status < 200 || initialized.status >= 300) return this.outcome(input.approvalId, unknown(preview.targetId, input.approvalId));
      const record: UploadRecord = { uploadId: preview.targetId, sessionUrl: initialized.sessionUrl, fileSize: validated.fileSize, fileFingerprint: validated.fileFingerprint, offset: 0, metadataFingerprint: validated.metadataFingerprint, createdAt: new Date().toISOString(), lastStatus: 'created' };
      await this.store.save(record);
      return this.send(record, request.filePath, validated.mimeType, input.approvalId, fileDescriptor);
    });
  }

  async resume(input: ApprovedUploadRequest & { uploadId: string }): Promise<UploadStatusResult> {
    const request = normalize(input);
    requirePublish(request);
    const preview = await this.requireApproved(input.approvalId, input.confirm);
    this.requirePreview(preview, 'video.upload.resume', input.uploadId);
    await this.principal.verifyPrincipal();
    const record = await this.requiredRecord(input.uploadId);
    return withValidatedUpload({ ...request, expectedFileFingerprint: record.fileFingerprint }, async (validated, fileDescriptor) => {
      if (validated.metadataFingerprint !== record.metadataFingerprint) throw metadataChangedError();
      this.requirePreview(preview, 'video.upload.resume', input.uploadId, desiredOf(request, validated));
      await this.claim(input.approvalId, recordFingerprint(record), input.confirm);
      let probe;
      try { probe = await this.provider.probe(record.sessionUrl, record.fileSize); } catch {
        await this.store.updateProgress(record.uploadId, record.offset, 'unknown');
        return this.outcome(input.approvalId, unknown(record.uploadId, input.approvalId));
      }
      if (probe.status === 404) {
        await this.store.updateProgress(record.uploadId, record.offset, 'unknown');
        await this.outcome(input.approvalId, unknown(record.uploadId, input.approvalId));
        throw expiredError(input.approvalId, record.uploadId);
      }
      if (confirmedCompletion(probe)) {
        await this.bestEffortComplete(record);
        return this.outcome(input.approvalId, { uploadId: record.uploadId, state: 'complete', videoId: probe.videoId });
      }
      if (probe.status !== 308 || probe.offset === undefined) {
        await this.store.updateProgress(record.uploadId, record.offset, 'unknown');
        return this.outcome(input.approvalId, unknown(record.uploadId, input.approvalId));
      }
      const progressed = await this.store.updateProgress(record.uploadId, probe.offset, 'in_progress');
      return this.send(progressed ?? record, request.filePath, validated.mimeType, input.approvalId, fileDescriptor);
    });
  }

  async getStatus(input: { uploadId: string }): Promise<UploadStatusResult> {
    await this.principal.verifyPrincipal();
    const record = await this.requiredRecord(input.uploadId);
    let probe;
    try {
      probe = await this.provider.probe(record.sessionUrl, record.fileSize);
    } catch {
      await this.store.updateProgress(record.uploadId, record.offset, 'unknown');
      return unknown(record.uploadId);
    }
    if (probe.status === 404) {
      await this.store.updateProgress(record.uploadId, record.offset, 'unknown');
      return { uploadId: record.uploadId, state: 'expired', reconciliation: uploadReconciliation(record.uploadId) };
    }
    if (confirmedCompletion(probe)) {
      await this.bestEffortComplete(record);
      return { uploadId: record.uploadId, state: 'complete', videoId: probe.videoId };
    }
    if (probe.status === 308 && probe.offset !== undefined) {
      await this.store.updateProgress(record.uploadId, probe.offset, 'in_progress');
      return { uploadId: record.uploadId, state: 'in_progress', offset: probe.offset };
    }
    await this.store.updateProgress(record.uploadId, record.offset, 'unknown');
    return unknown(record.uploadId);
  }

  async cancel(input: { approvalId: string; uploadId: string; confirm?: boolean }): Promise<UploadStatusResult> {
    const preview = await this.requireApproved(input.approvalId, input.confirm);
    this.requirePreview(preview, 'video.upload.cancel', input.uploadId, { uploadId: input.uploadId });
    await this.principal.verifyPrincipal();
    const record = await this.requiredRecord(input.uploadId);
    await this.claim(input.approvalId, recordFingerprint(record), input.confirm);
    try {
      const response = await this.provider.cancel(record.sessionUrl);
      if (response.status < 200 || response.status >= 300) return this.outcome(input.approvalId, unknown(record.uploadId, input.approvalId));
    } catch {
      return this.outcome(input.approvalId, unknown(record.uploadId, input.approvalId));
    }
    await this.store.updateProgress(record.uploadId, record.offset, 'cancelled');
    return this.outcome(input.approvalId, { uploadId: record.uploadId, state: 'cancelled' });
  }

  private async send(record: UploadRecord, filePath: string, mimeType: string, operationId: string, fileDescriptor?: number): Promise<UploadStatusResult> {
    let response;
    try {
      response = await this.provider.uploadChunk({ sessionUrl: record.sessionUrl, filePath, fileDescriptor, offset: record.offset, fileSize: record.fileSize, mimeType });
    } catch {
      await this.store.updateProgress(record.uploadId, record.offset, 'unknown');
      return this.outcome(operationId, unknown(record.uploadId, operationId));
    }
    if (response.status === 404) {
      await this.store.updateProgress(record.uploadId, record.offset, 'unknown');
      await this.outcome(operationId, unknown(record.uploadId, operationId));
      throw expiredError(operationId, record.uploadId);
    }
    if (response.status === 308 && response.offset !== undefined) {
      await this.store.updateProgress(record.uploadId, response.offset, 'in_progress');
      return this.outcome(operationId, { uploadId: record.uploadId, state: 'in_progress', offset: response.offset });
    }
    if (confirmedCompletion(response)) {
      await this.bestEffortComplete(record);
      return this.outcome(operationId, { uploadId: record.uploadId, state: 'complete', videoId: response.videoId });
    }
    await this.store.updateProgress(record.uploadId, record.offset, 'unknown');
    return this.outcome(operationId, unknown(record.uploadId, operationId));
  }

  private async requireApproved(approvalId: string, confirm: boolean | undefined): Promise<OperationPreview> {
    return this.operations.requireApproved({ approvalId, confirm, profileId: this.profile.id, channelId: this.profile.channelId });
  }

  private async claim(approvalId: string, currentFingerprint: string, confirm: boolean | undefined): Promise<void> {
    await this.operations.claim({ approvalId, confirm, currentFingerprint, profileId: this.profile.id, channelId: this.profile.channelId });
  }

  private async outcome(operationId: string, result: UploadStatusResult): Promise<UploadStatusResult> {
    const state = result.state === 'complete' ? 'succeeded'
      : result.state === 'cancelled' ? 'cancelled'
        : result.state === 'in_progress' ? 'running'
          : 'unknown';
    await this.operations.settle({ operationId, profileId: this.profile.id, channelId: this.profile.channelId, state });
    return { ...result, operationId };
  }

  private async bestEffortComplete(record: UploadRecord): Promise<void> {
    try {
      await this.store.updateProgress(record.uploadId, record.fileSize, 'complete');
    } catch {
      // The provider's confirmed completion is authoritative; local progress can be reconciled later.
    }
  }

  private requirePreview(preview: OperationPreview, kind: string, targetId: string, desired?: Record<string, unknown>): void {
    if (preview.kind !== kind || preview.targetId !== targetId || (desired && preview.desiredFingerprint !== fingerprint(desired))) throw approvalRequiredError();
  }

  private async requiredRecord(uploadId: string): Promise<UploadRecord> {
    const record = await this.store.get(uploadId);
    if (!record) throw uploadNotFoundError();
    return record;
  }
}

function normalize(input: UploadRequest): NormalizedUploadRequest {
  return { ...input, privacyStatus: input.privacyStatus ?? 'private' } as NormalizedUploadRequest;
}

function desiredOf(request: NormalizedUploadRequest, validated: ValidatedUpload): Record<string, unknown> {
  return { title: request.title.trim(), description: request.description ?? '', privacyStatus: request.privacyStatus, publishAt: request.publishAt, publish: request.publish === true, fileFingerprint: validated.fileFingerprint, metadataFingerprint: validated.metadataFingerprint };
}

function recordFingerprint(record: UploadRecord): string {
  return `${record.fileFingerprint}:${record.metadataFingerprint}:${record.offset}`;
}

function desiredString(preview: OperationPreview, key: string): string {
  const value = preview.desired[key];
  if (typeof value !== 'string' || value.length === 0) throw approvalRequiredError();
  return value;
}

function uploadReconciliation(uploadId: string): OperationReconciliation {
  return { tool: 'youtube_get_upload_status', arguments: { uploadId } };
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(sortValue(value))).digest('hex');
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sortValue((value as Record<string, unknown>)[key])]));
}

function confirmedCompletion(response: { status: number; videoId?: string }): response is { status: number; videoId: string } {
  return response.status >= 200 && response.status < 300 && typeof response.videoId === 'string' && response.videoId.length > 0;
}

function unknown(uploadId: string, operationId?: string): UploadStatusResult {
  return { uploadId, ...(operationId ? { operationId } : {}), state: 'unknown', reconciliation: uploadReconciliation(uploadId) };
}

function requirePublish(input: NormalizedUploadRequest): void {
  if (input.privacyStatus === 'public' && input.publish !== true) {
    throw new AppError('publish_confirmation_required', 'Public visibility needs publish: true.', 'Review the target and repeat with publish: true.', false);
  }
}

function approvalRequiredError(): AppError {
  return new AppError('approval_required', 'This upload requires an approved preview.', 'Preflight, approve, and repeat with confirm: true.', false);
}

function metadataChangedError(): AppError {
  return new AppError('upload_metadata_changed', 'Upload metadata changed after preflight.', 'Preflight this exact upload again.', false);
}

function expiredError(operationId: string, uploadId: string): AppError {
  return new AppError(
    'upload_session_expired',
    'The resumable upload session expired.',
    'Reconcile this upload status, then preflight and confirm a new upload. Do not retry this session.',
    false,
    operationId,
    uploadReconciliation(uploadId),
  );
}

function uploadNotFoundError(): AppError {
  return new AppError('upload_not_found', 'No local resumable upload record was found.', 'Preflight a new private upload.', false);
}
