import type { AppError as AppErrorShape, OperationReconciliation } from './types.js';

export class AppError extends Error implements AppErrorShape {
  constructor(
    public readonly code: string,
    message: string,
    public readonly action: string,
    public readonly retryable: boolean,
    public readonly operationId?: string,
    public readonly reconciliation?: OperationReconciliation,
    public readonly status?: number,
    public readonly reason?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }

  /** Error message is non-enumerable by default; serialise the safe fields explicitly for MCP clients. */
  toJSON(): AppErrorShape {
    return {
      code: this.code,
      message: this.message,
      action: this.action,
      retryable: this.retryable,
      ...(this.operationId === undefined ? {} : { operationId: this.operationId }),
      ...(this.reconciliation === undefined ? {} : { reconciliation: this.reconciliation }),
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.reason === undefined ? {} : { reason: this.reason }),
    };
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

function quotaExceededError(status?: number): AppError {
  return new AppError(
    'quota_exhausted',
    'YouTube API quota is exhausted.',
    'Daily YouTube API quota used up; resets at midnight Pacific.',
    false,
    undefined,
    undefined,
    status ?? 403,
    'quotaExceeded',
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

function providerError(error?: unknown): AppError {
  const status = httpStatusOf(error);
  const reason = googleReasonOf(error);
  if (status === undefined && reason === undefined) {
    return new AppError(
      'provider_error',
      'The YouTube provider could not complete the request.',
      'Try again. If the problem continues, verify the provider configuration.',
      true,
    );
  }
  const clientRejection = status !== undefined && status >= 400 && status < 500 && status !== 429 && status !== 408;
  return new AppError(
    'provider_error',
    `The YouTube provider rejected the request${status === undefined ? '' : ` (HTTP ${status})`}${reason === undefined ? '' : `: ${reason}`}.`,
    actionFor(status, reason, mentionsThumbnails(error)),
    !clientRejection,
    undefined,
    undefined,
    status,
    reason,
  );
}

function actionFor(status: number | undefined, reason: string | undefined, thumbnails: boolean): string {
  if (reason === 'forbidden' && thumbnails) {
    return 'Channel needs phone verification for custom thumbnails: youtube.com/verify';
  }
  switch (reason) {
    case 'insufficientPermissions':
    case 'insufficientScopes':
      return 'Re-run youtube-auth and grant the required YouTube permissions.';
    case 'forbidden':
      return 'YouTube refused this request. Check that the selected channel owns the resource and may perform this action.';
    case 'notFound':
    case 'videoNotFound':
    case 'playlistNotFound':
    case 'commentNotFound':
    case 'captionNotFound':
      return 'YouTube could not find that resource. Check the ID.';
    case 'rateLimitExceeded':
    case 'userRateLimitExceeded':
      return 'YouTube is rate limiting requests. Wait a minute, then try again.';
    default:
  }
  if (status === 404) return 'YouTube could not find that resource. Check the ID.';
  if (status === 403) return 'YouTube refused this request. Check channel permissions.';
  if (status === 401) return 'Run youtube-auth to authorize this account.';
  if (status !== undefined && status >= 400 && status < 500 && status !== 429 && status !== 408) {
    return 'YouTube rejected the request as invalid. Check the inputs; nothing was changed.';
  }
  return 'Try again. If the problem continues, verify the provider configuration.';
}

function mentionsThumbnails(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { config?: { url?: unknown }; message?: unknown };
  const url = typeof candidate.config?.url === 'string' ? candidate.config.url : '';
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  return /\/thumbnails\/set/.test(url) || /thumbnail/i.test(message);
}

/** HTTP status of a Google API failure, only when Google actually answered. */
export function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { status?: unknown; code?: unknown; response?: { status?: unknown; data?: { error?: { code?: unknown } } } };
  for (const value of [candidate.response?.status, candidate.status, candidate.response?.data?.error?.code, candidate.code]) {
    const numeric = typeof value === 'string' && /^\d{3}$/.test(value) ? Number(value) : value;
    if (typeof numeric === 'number' && Number.isInteger(numeric) && numeric >= 100 && numeric <= 599) return numeric;
  }
  return undefined;
}

/** Google error reason (for example forbidden, quotaExceeded); only short identifier-like values are passed on. */
export function googleReasonOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { errors?: unknown; response?: { data?: { error?: { errors?: unknown } } } };
  for (const list of [candidate.errors, candidate.response?.data?.error?.errors]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const reason = typeof item === 'object' && item !== null ? (item as { reason?: unknown }).reason : undefined;
      if (typeof reason === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(reason)) return reason;
    }
  }
  return undefined;
}

/** True when Google returned a clean 4xx: the request was rejected and the write did not happen. */
export function isDefinitiveRejection(error: unknown): boolean {
  const status = httpStatusOf(error);
  return status !== undefined && status >= 400 && status < 500 && status !== 408;
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

function isSqliteFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = String((error as { code?: unknown }).code ?? '');
  return code === 'ERR_SQLITE_ERROR' || /^SQLITE_/.test(code);
}

/** Never includes the database path or the underlying SQLite message. */
export function storageUnavailableError(): AppError {
  return new AppError(
    'storage_unavailable',
    'Local storage could not be opened or written.',
    'Check that the state directory exists and is writable, then try again. Use Node.js 22.13 or newer.',
    false,
  );
}

export function toSafeError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (isQuotaExceeded(error)) {
    return quotaExceededError(httpStatusOf(error));
  }

  if (isInvalidGrant(error)) {
    return reauthorizationRequiredError();
  }

  return isSqliteFailure(error) ? storageUnavailableError() : providerError(error);
}
