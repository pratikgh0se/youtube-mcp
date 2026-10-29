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

  it('adds the HTTP status and Google reason to a forbidden thumbnail failure with the verification action', () => {
    const error = Object.assign(new Error('The authenticated user doesn\'t have permissions to upload and set custom video thumbnails.'), {
      code: 403,
      errors: [{ reason: 'forbidden', message: 'private text' }],
      config: { url: 'https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=abc&key=SECRET' },
    });

    const safe = toSafeError(error);

    expect(safe).toMatchObject({ code: 'provider_error', status: 403, reason: 'forbidden', retryable: false });
    expect(safe.action).toContain('youtube.com/verify');
    expect(JSON.stringify(safe)).not.toContain('SECRET');
    expect(JSON.stringify(safe)).not.toContain('private text');
  });

  it('adds status, reason and the midnight-Pacific action to quota exhaustion', () => {
    expect(toSafeError({ code: 403, errors: [{ reason: 'quotaExceeded' }] })).toMatchObject({
      code: 'quota_exhausted', status: 403, reason: 'quotaExceeded', action: expect.stringContaining('midnight Pacific'),
    });
  });

  it('reads status and reason from a wrapped gaxios response and reports 404 as non-retryable', () => {
    expect(toSafeError({ code: '404', response: { status: 404, data: { error: { errors: [{ reason: 'notFound' }] } } } })).toMatchObject({
      code: 'provider_error', status: 404, reason: 'notFound', retryable: false,
    });
  });

  it('explains a 400 invalidPublishAt rejection', () => {
    expect(toSafeError({ response: { status: 400, data: { error: { errors: [{ reason: 'invalidPublishAt' }] } } } })).toMatchObject({
      code: 'provider_error', status: 400, reason: 'invalidPublishAt', retryable: false,
      action: expect.stringContaining('never been public'),
    });
  });

  it('never copies an unsafe reason string or raw response body', () => {
    const safe = toSafeError({ response: { status: 400, data: { error: { errors: [{ reason: 'Bearer abc.def secret token' }], message: 'raw body' } } } });
    expect(safe.reason).toBeUndefined();
    expect(JSON.stringify(safe)).not.toContain('Bearer');
    expect(JSON.stringify(safe)).not.toContain('raw body');
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
