import { describe, expect, it } from 'vitest';

import { toSafeError } from '../src/errors.js';
import { UploadValidationError } from '../src/youtube/upload-validation.js';

describe('toSafeError', () => {
  it('maps a Google quota response to an actionable safe error', () => {
    expect(
      toSafeError({ code: 403, errors: [{ reason: 'quotaExceeded' }] }),
    ).toMatchObject({
      code: 'quota_exhausted',
      action: expect.any(String),
      message: expect.any(String),
      retryable: false,
    });
  });

  it('maps a wrapped Google quota response to the same actionable safe error', () => {
    expect(
      toSafeError({ response: { data: { error: { code: 403, errors: [{ reason: 'quotaExceeded' }] } } } }),
    ).toMatchObject({
      code: 'quota_exhausted',
      retryable: false,
    });
  });

  it('converts an unknown provider failure into a safe error object', () => {
    const providerError = new Error('provider returned account-secret');

    const safeError = toSafeError(providerError);

    expect(safeError).toMatchObject({
      code: 'provider_error',
      action: expect.any(String),
      message: expect.any(String),
      retryable: true,
    });
    expect(safeError).not.toBe(providerError);
    expect(safeError.message).not.toContain('account-secret');
  });

  it.each([
    'invalid_upload_file',
    'unsupported_upload_media',
    'invalid_upload_metadata',
    'invalid_upload_schedule',
    'upload_source_changed',
  ] as const)('preserves the safe upload validation code %s at the MCP boundary', (code) => {
    expect(toSafeError(new UploadValidationError(code))).toMatchObject({
      code,
      action: expect.any(String),
      message: expect.not.stringContaining('/private/'),
      retryable: false,
    });
  });
});
