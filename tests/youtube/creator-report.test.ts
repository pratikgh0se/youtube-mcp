import { describe, expect, it } from 'vitest';

import { CreatorAnalyticsService, pacificToday } from '../../src/youtube/analytics.js';
import { buildReportQuery } from '../../src/youtube/creator-report.js';
import { YouTubeClient, type YouTubeAnalyticsApi } from '../../src/youtube/client.js';
import { creatorReportSchema } from '../../src/mcp/schemas.js';
import { testYouTubeApi } from '../helpers/youtube-api.js';

const today = '2026-10-28';
const invalid = { code: 'invalid_input' };

describe('buildReportQuery', () => {
  it('defaults to the last 28 days, channel==MINE and comma-joined columns', () => {
    expect(buildReportQuery({ metrics: ['views', 'likes'], dimensions: ['day'] }, today)).toEqual({
      ids: 'channel==MINE', startDate: '2026-09-30', endDate: '2026-10-28', metrics: 'views,likes', dimensions: 'day',
    });
  });

  it('builds filters, sort and defaults sort/maxResults for per-video reports', () => {
    expect(buildReportQuery({ metrics: ['views'], dimensions: ['video'], filters: { country: 'us', videoIds: ['a', 'b'] } }, today)).toMatchObject({
      filters: 'video==a,b;country==US', sort: '-views', maxResults: 25,
    });
  });

  it('rejects metrics and dimensions outside the allowlist', () => {
    expect(() => buildReportQuery({ metrics: ['estimatedRevenue'] }, today)).toThrow(expect.objectContaining(invalid));
    expect(() => buildReportQuery({ metrics: ['views'], dimensions: ['playlist'] }, today)).toThrow(expect.objectContaining(invalid));
  });

  it('allows ageGroup/gender only with viewerPercentage and vice versa', () => {
    expect(buildReportQuery({ metrics: ['viewerPercentage'], dimensions: ['ageGroup', 'gender'] }, today)).toMatchObject({ metrics: 'viewerPercentage', dimensions: 'ageGroup,gender' });
    expect(() => buildReportQuery({ metrics: ['views'], dimensions: ['ageGroup'] }, today)).toThrow(expect.objectContaining(invalid));
    expect(() => buildReportQuery({ metrics: ['views', 'viewerPercentage'], dimensions: ['gender'] }, today)).toThrow(expect.objectContaining(invalid));
    expect(() => buildReportQuery({ metrics: ['viewerPercentage'], dimensions: ['day'] }, today)).toThrow(expect.objectContaining(invalid));
    expect(() => buildReportQuery({ metrics: ['viewerPercentage'], dimensions: ['gender', 'country'] }, today)).toThrow(expect.objectContaining(invalid));
  });

  it('requires one video plus an insightTrafficSourceType filter and views metrics for traffic source detail', () => {
    const base = { metrics: ['views'], dimensions: ['insightTrafficSourceDetail'] };
    expect(() => buildReportQuery(base, today)).toThrow(expect.objectContaining(invalid));
    expect(() => buildReportQuery({ ...base, filters: { videoIds: ['v1'] } }, today)).toThrow(/insightTrafficSourceType/);
    expect(() => buildReportQuery({ ...base, filters: { insightTrafficSourceType: 'YT_SEARCH' } }, today)).toThrow(/video/);
    expect(() => buildReportQuery({ ...base, metrics: ['likes'], filters: { videoIds: ['v1'], insightTrafficSourceType: 'YT_SEARCH' } }, today)).toThrow(expect.objectContaining(invalid));
    expect(() => buildReportQuery({ ...base, maxResults: 50, filters: { videoIds: ['v1'], insightTrafficSourceType: 'YT_SEARCH' } }, today)).toThrow(expect.objectContaining(invalid));
    expect(buildReportQuery({ ...base, filters: { videoIds: ['v1'], insightTrafficSourceType: 'YT_SEARCH' } }, today)).toMatchObject({
      filters: 'video==v1;insightTrafficSourceType==YT_SEARCH', sort: '-views', maxResults: 25,
    });
  });

  it('rejects sharingService without shares, day+month, bad sort keys and inverted dates', () => {
    expect(() => buildReportQuery({ metrics: ['views'], dimensions: ['sharingService'] }, today)).toThrow(expect.objectContaining(invalid));
    expect(buildReportQuery({ metrics: ['shares'], dimensions: ['sharingService'] }, today)).toMatchObject({ dimensions: 'sharingService' });
    expect(() => buildReportQuery({ metrics: ['views'], dimensions: ['day', 'month'] }, today)).toThrow(expect.objectContaining(invalid));
    expect(() => buildReportQuery({ metrics: ['views'], sort: ['-likes'] }, today)).toThrow(expect.objectContaining(invalid));
    expect(() => buildReportQuery({ metrics: ['views'], startDate: '2026-02-01', endDate: '2026-01-01' }, today)).toThrow(expect.objectContaining(invalid));
    expect(() => buildReportQuery({ metrics: ['views'], startDate: '2026-02-30x' }, today)).toThrow(expect.objectContaining(invalid));
  });

  it('keeps the insightTrafficSourceType filter out of non-detail reports', () => {
    expect(() => buildReportQuery({ metrics: ['views'], dimensions: ['day'], filters: { insightTrafficSourceType: 'YT_SEARCH' } }, today)).toThrow(expect.objectContaining(invalid));
  });
});

describe('creatorReportSchema', () => {
  it('accepts a minimal request and rejects malformed dates and countries', () => {
    expect(creatorReportSchema.safeParse({ metrics: ['views'] }).success).toBe(true);
    expect(creatorReportSchema.safeParse({ metrics: [] }).success).toBe(false);
    expect(creatorReportSchema.safeParse({ metrics: ['views'], startDate: '01/01/2026' }).success).toBe(false);
    expect(creatorReportSchema.safeParse({ metrics: ['views'], filters: { country: 'USA' } }).success).toBe(false);
  });
});

describe('CreatorAnalyticsService.report', () => {
  function service(requests: Record<string, unknown>[], data: { columnHeaders?: unknown[]; rows?: unknown[][] }) {
    const analytics: YouTubeAnalyticsApi = { reports: { query: async (request) => { requests.push(request); return { data }; } } };
    return new CreatorAnalyticsService(
      { getAccessToken: async () => 'token' },
      new YouTubeClient({ stateDir: '/tmp/x', diagnostics: () => '' }, {
        createPublicApi: () => testYouTubeApi(), createAuthorizedApi: () => testYouTubeApi(), createAuthorizedAnalyticsApi: () => analytics,
      }),
      () => today,
    );
  }

  it('sends ids=channel==MINE with the validated query and returns rows as objects', async () => {
    const requests: Record<string, unknown>[] = [];
    const report = await service(requests, {
      columnHeaders: [{ name: 'day' }, { name: 'views' }],
      rows: [['2026-10-01', 5], ['2026-10-02', 7]],
    }).report({ metrics: ['views'], dimensions: ['day'], sort: ['day'] });
    expect(requests).toEqual([{ ids: 'channel==MINE', startDate: '2026-09-30', endDate: today, metrics: 'views', dimensions: 'day', sort: 'day' }]);
    expect(report).toMatchObject({ columns: ['day', 'views'], rowCount: 2, rows: [{ day: '2026-10-01', views: 5 }, { day: '2026-10-02', views: 7 }] });
  });

  it('throws provider_error when a column header name is missing instead of returning empty rows', async () => {
    await expect(service([], { columnHeaders: [{ name: 'day' }, {}], rows: [['2026-10-01', 5]] }).report({ metrics: ['views'] })).rejects.toMatchObject({ code: 'provider_error' });
    await expect(service([], { columnHeaders: [{ name: '' }], rows: [[1]] }).report({ metrics: ['views'] })).rejects.toMatchObject({ code: 'provider_error' });
  });

  it('defaults the end date to the Pacific calendar day, not UTC', () => {
    expect(pacificToday(new Date('2026-10-28T03:00:00Z'))).toBe('2026-10-27');
    expect(pacificToday(new Date('2026-10-28T08:00:00Z'))).toBe('2026-10-28');
    expect(pacificToday(new Date('2026-01-15T07:59:00Z'))).toBe('2026-01-14');
  });

  it('returns zero rows for an empty report and never calls Google for invalid input', async () => {
    const requests: Record<string, unknown>[] = [];
    const reports = service(requests, { columnHeaders: [{ name: 'views' }] });
    await expect(reports.report({ metrics: ['views'] })).resolves.toMatchObject({ rows: [], rowCount: 0 });
    await expect(reports.report({ metrics: ['views'], dimensions: ['ageGroup'] })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(requests).toHaveLength(1);
  });
});
