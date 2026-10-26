import { createHash, randomUUID } from 'node:crypto';

import { approvalConsumedError, channelRequiredError, operationApprovalRequiredError, profileMismatchError, providerOutcomeUnknownError, stalePreviewError } from '../errors.js';
import type { ConnectionProfile, OperationPreview, OperationReceipt, OperationReconciliation, OperationState } from '../types.js';
import { OperationStore, type StoredOperation } from './store.js';

export type PreflightOperation = {
  profile: ConnectionProfile;
  kind: string;
  targetId: string;
  desired: Record<string, unknown>;
  currentFingerprint: string;
  reconciliation?: OperationReconciliation;
  expiresInMs?: number;
};

export type ExecuteOperation = {
  approvalId: string;
  confirm?: boolean;
  currentFingerprint: string;
  profileId: string;
  channelId: string;
};

export type ApproveOperation = Pick<ExecuteOperation, 'approvalId' | 'confirm' | 'profileId' | 'channelId'>;

export class OperationService {
  constructor(
    private readonly store: OperationStore,
    private readonly now: () => Date = () => new Date(),
    private readonly executeApproved: (operation: StoredOperation) => Promise<OperationState> = async () => 'succeeded',
  ) {}

  async preflight(input: PreflightOperation): Promise<OperationPreview> {
    requireSelectedChannel(input.profile);
    const now = this.now();
    const approvalId = randomUUID();
    const reconciliation = input.reconciliation ?? { tool: 'youtube_get_operation_status', arguments: { approvalId } };
    const operation = await this.store.create({
      approvalId,
      profile: input.profile,
      kind: input.kind,
      targetId: input.targetId,
      desired: input.desired,
      desiredFingerprint: fingerprint(input.desired),
      currentFingerprint: input.currentFingerprint,
      expiresAt: new Date(now.getTime() + (input.expiresInMs ?? 5 * 60_000)).toISOString(),
      state: 'planned',
      reconciliation,
    });
    return previewOf(operation);
  }

  async approve(input: ApproveOperation): Promise<OperationPreview> {
    const operation = await this.requiredOperation(input.approvalId, input.profileId, input.channelId);
    this.requireUnexpired(operation);
    if (input.confirm !== true) throw operationApprovalRequiredError();
    const approved = await this.store.approve(operation.profile.id, operation.approvalId);
    if (!approved) throw approvalConsumedError();
    return previewOf(approved);
  }

  async execute(input: ExecuteOperation): Promise<OperationReceipt> {
    const claimed = await this.claimOperation(input);
    try {
      const state = await this.executeApproved(claimed);
      const completed = await this.store.update(claimed.profile.id, claimed.approvalId, { state });
      return receiptOf(completed!);
    } catch (error) {
      const state = terminalStateFor(error);
      const completed = await this.store.update(claimed.profile.id, claimed.approvalId, { state });
      if (state === 'unknown') {
        throw providerOutcomeUnknownError(claimed.approvalId, receiptOf(completed!).reconciliation);
      }
      throw error;
    }
  }

  /** Claims an approved operation for a caller that must reconcile a provider outcome itself. */
  async claim(input: ExecuteOperation): Promise<OperationReceipt> {
    return receiptOf(await this.claimOperation(input));
  }

  /** Checks local approval and literal confirmation before a caller performs any provider reread. */
  async requireApproved(input: ApproveOperation): Promise<OperationPreview> {
    const operation = await this.requiredOperation(input.approvalId, input.profileId, input.channelId);
    this.requireUnexpired(operation);
    if (input.confirm !== true || operation.state === 'planned') throw operationApprovalRequiredError();
    if (operation.state !== 'approved') throw approvalConsumedError();
    return previewOf(operation);
  }

  async settle(input: { operationId: string; profileId: string; channelId: string; state: OperationState }): Promise<OperationReceipt> {
    const operation = await this.requiredOperation(input.operationId, input.profileId, input.channelId);
    if (operation.state !== 'running') throw approvalConsumedError();
    const settled = await this.store.update(operation.profile.id, operation.approvalId, { state: input.state });
    return receiptOf(settled!);
  }

  private async claimOperation(input: ExecuteOperation): Promise<StoredOperation> {
    await this.requireApproved(input);
    const operation = await this.requiredOperation(input.approvalId, input.profileId, input.channelId);
    if (operation.currentFingerprint !== input.currentFingerprint) throw stalePreviewError();
    const claimed = await this.store.claim(operation.profile.id, operation.approvalId);
    if (!claimed) throw approvalConsumedError();
    return claimed;
  }

  async reconcile(input: { profileId: string; channelId: string; operationId: string }): Promise<OperationReceipt | undefined> {
    if (!input.profileId || !input.channelId) throw channelRequiredError();
    const operation = await this.store.get(input.profileId, input.operationId);
    if (operation && operation.profile.channelId !== input.channelId) throw profileMismatchError();
    return operation ? receiptOf(operation) : undefined;
  }

  private async requiredOperation(approvalId: string, profileId: string, channelId: string): Promise<StoredOperation> {
    if (!profileId || !channelId) throw channelRequiredError();
    const operation = await this.store.get(profileId, approvalId);
    if (!operation || operation.profile.channelId !== channelId) throw profileMismatchError();
    return operation;
  }

  private requireUnexpired(operation: StoredOperation): void {
    if (new Date(operation.expiresAt).getTime() <= this.now().getTime()) throw stalePreviewError();
  }
}

function requireSelectedChannel(profile: ConnectionProfile): asserts profile is ConnectionProfile & { channelId: string } {
  if (!profile.id || !profile.channelId) throw channelRequiredError();
}

function terminalStateFor(error: unknown): 'failed' | 'unknown' {
  return typeof error === 'object' && error !== null && (error as { operationState?: unknown }).operationState === 'failed'
    ? 'failed'
    : 'unknown';
}

function previewOf(operation: StoredOperation): OperationPreview {
  return {
    approvalId: operation.approvalId,
    profile: operation.profile,
    kind: operation.kind,
    targetId: operation.targetId,
    desired: operation.desired,
    desiredFingerprint: operation.desiredFingerprint,
    currentFingerprint: operation.currentFingerprint,
    expiresAt: operation.expiresAt,
    state: operation.state === 'approved' ? 'approved' : 'planned',
    reconciliation: operation.reconciliation ?? { tool: 'youtube_get_operation_status', arguments: { approvalId: operation.approvalId } },
  };
}

function receiptOf(operation: StoredOperation): OperationReceipt {
  return {
    operationId: operation.approvalId,
    state: operation.state,
    reconciliation: operation.reconciliation ?? { tool: 'youtube_get_operation_status', arguments: { approvalId: operation.approvalId } },
  };
}

function fingerprint(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(sortValue(value))).digest('hex');
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sortValue((value as Record<string, unknown>)[key])]));
}
