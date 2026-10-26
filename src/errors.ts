import type { AppError as AppErrorShape, OperationReconciliation } from './types.js';

export class AppError extends Error implements AppErrorShape {
  constructor(
    public readonly code: string,
    message: string,
    public readonly action: string,
    public readonly retryable: boolean,
    public readonly operationId?: string,
    public readonly reconciliation?: OperationReconciliation,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function providerOutcomeUnknownError(operationId: string, reconciliation: OperationReconciliation): AppError {
  return new AppError(
    'provider_outcome_unknown',
    'The provider outcome could not be confirmed.',
    `Reconcile operation ${operationId} with ${reconciliation.tool} before attempting another mutation.`,
    false,
    operationId,
    reconciliation,
  );
}

export function confirmationRequiredError(): AppError {
  return new AppError(
    'confirmation_required',
    'This action changes your YouTube account.',
    'Repeat the call with confirm: true.',
    false,
  );
}

export function operationApprovalRequiredError(): AppError {
  return new AppError(
    'approval_required',
    'This operation requires exact confirmation.',
    'Repeat the call with confirm: true and the unexpired approval ID.',
    false,
  );
}

export function stalePreviewError(): AppError {
  return new AppError(
    'stale_preview',
    'The target changed after this operation was previewed.',
    'Preflight the operation again against the current target.',
    false,
  );
}

export function invalidProfileError(): AppError {
  return new AppError(
    'invalid_profile',
    'The selected profile is invalid.',
    'Select a valid local connection profile.',
    false,
  );
}

export function channelRequiredError(): AppError {
  return new AppError(
    'channel_required',
    'A selected channel is required for this operation.',
    'Select the creator channel before preflighting or executing the operation.',
    false,
  );
}

export function profileMismatchError(): AppError {
  return new AppError(
    'profile_mismatch',
    'The selected profile or channel does not match this approval.',
    'Preflight the operation again for the selected profile and channel.',
    false,
  );
}

export function approvalConsumedError(): AppError {
  return new AppError(
    'approval_consumed',
    'This approval has already been used.',
    'Preflight a new operation before trying again.',
    false,
  );
}

function quotaExceededError(): AppError {
  return new AppError(
    'quota_exhausted',
    'YouTube API quota is exhausted.',
    'Wait for the quota to reset, then try again.',
    false,
  );
}

function reauthorizationRequiredError(): AppError {
  return new AppError(
    'reauthorization_required',
    'The YouTube authorization is no longer valid.',
    'Run youtube-auth to authorize this account.',
    false,
  );
}

function providerError(): AppError {
  return new AppError(
    'provider_error',
    'The YouTube provider could not complete the request.',
    'Try again. If the problem continues, verify the provider configuration.',
    true,
  );
}

function isQuotaExceeded(error: unknown): boolean {
  return hasQuotaExceededShape(error) || hasQuotaExceededShape(quotaErrorDetail(error));
}

function quotaErrorDetail(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  return (error as { response?: { data?: { error?: unknown } } }).response?.data?.error;
}

function hasQuotaExceededShape(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; errors?: unknown };
  return candidate.code === 403 && Array.isArray(candidate.errors) && candidate.errors.some(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      (item as { reason?: unknown }).reason === 'quotaExceeded',
  );
}

function isInvalidGrant(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as {
    error?: unknown;
    response?: { data?: { error?: unknown } };
  };

  return candidate.error === 'invalid_grant' || candidate.response?.data?.error === 'invalid_grant';
}

export function toSafeError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (isQuotaExceeded(error)) {
    return quotaExceededError();
  }

  return isInvalidGrant(error) ? reauthorizationRequiredError() : providerError();
}
