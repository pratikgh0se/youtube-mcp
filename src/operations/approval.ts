import type { OperationPreview } from '../types.js';
import type { OperationService } from './service.js';

export type ApprovalTool = { approve(input: { approvalId: string; confirm?: boolean }): Promise<OperationPreview> };

/**
 * One approval entry point for every preflighted operation (upload, creator content, playlist, moderation).
 * All domains persist operations in the same per-profile OperationStore, so the lookup is by approvalId within the
 * active profile and channel; the returned preview echoes kind, target and the exact desired change.
 * Execution tools still re-check kind, target and desired fingerprint, so approving here never widens what they accept.
 */
export function createApprovalTool(operations: Pick<OperationService, 'approve'>, profile: { id: string; channelId: string }): ApprovalTool {
  return {
    approve: (input) => operations.approve({ approvalId: input.approvalId, confirm: input.confirm, profileId: profile.id, channelId: profile.channelId }),
  };
}
