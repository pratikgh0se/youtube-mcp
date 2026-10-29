import { AppError, toSafeError } from '../errors.js';
import type { OAuthService } from '../auth/oauth.js';
import { YouTubeClient, type YouTubeAnalyticsApi } from './client.js';
import { buildReportQuery, type CreatorReportInput, type CreatorReportQuery } from './creator-report.js';

export type DateRange = {
  startDate: string;
  endDate: string;
};

export type CreatorOverview = {
  views: number;
  estimatedMinutesWatched: number;
  averageViewDuration: number;
  likes: number;
  comments: number;
  subscribersGained: number;
  subscribersLost: number;
};

export type CreatorTopVideo = Pick<CreatorOverview,
  'views' | 'estimatedMinutesWatched' | 'averageViewDuration' | 'likes' | 'comments'
> & { videoId: string };

export type RetentionPoint = {
  elapsedVideoTimeRatio: number;
  audienceWatchRatio: number;
  relativeRetentionPerformance: number;
};

export type CreatorReport = {
  query: Omit<CreatorReportQuery, 'ids'>;
  columns: string[];
  rows: Array<Record<string, string | number | null>>;
  rowCount: number;
};

export const overviewMetrics =
  'views,estimatedMinutesWatched,averageViewDuration,likes,comments,subscribersGained,subscribersLost';
const topVideoMetrics = 'views,estimatedMinutesWatched,averageViewDuration,likes,comments';
const retentionMetrics = 'audienceWatchRatio,relativeRetentionPerformance';

/** YouTube Analytics reports by Pacific-time day, so "today" is the America/Los_Angeles calendar date, not the UTC one. */
export function pacificToday(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export class CreatorAnalyticsService {
  constructor(
    private readonly oauth: Pick<OAuthService, 'getAccessToken'>,
    private readonly client: YouTubeClient,
    private readonly today: () => string = () => pacificToday(new Date()),
  ) {}

  async overview(range: DateRange): Promise<CreatorOverview> {
    try {
      const response = await (await this.authorized()).reports.query({
        ids: 'channel==MINE',
        startDate: range.startDate,
        endDate: range.endDate,
        metrics: overviewMetrics,
      });
      return normalizeOverview(response.data);
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async topVideos(range: DateRange, limit?: number): Promise<CreatorTopVideo[]> {
    try {
      const response = await (await this.authorized()).reports.query({
        ids: 'channel==MINE',
        startDate: range.startDate,
        endDate: range.endDate,
        dimensions: 'video',
        metrics: topVideoMetrics,
        sort: '-views',
        maxResults: limit,
      });
      return normalizeTopVideos(response.data);
    } catch (error) {
      throw toSafeError(error);
    }
  }

  async retention(videoId: string): Promise<RetentionPoint[]> {
    try {
      const response = await (await this.authorized()).reports.query({
        ids: 'channel==MINE',
        startDate: '2005-02-14',
        endDate: this.today(),
        dimensions: 'elapsedVideoTimeRatio',
        filters: `video==${videoId}`,
        metrics: retentionMetrics,
      });
      return normalizeRetention(response.data);
    } catch (error) {
      throw toSafeError(error);
    }
  }

  /** Flexible allowlisted report; validation happens before any provider call. */
  async report(input: CreatorReportInput): Promise<CreatorReport> {
    const { ids, ...query } = buildReportQuery(input, this.today());
    try {
      const response = await (await this.authorized()).reports.query({ ids, ...query });
      const columns = (response.data.columnHeaders ?? []).map((header) => stringAt(asRecord(header) ?? {}, 'name') ?? '');
      if (columns.some((name) => !name) || (columns.length === 0 && (response.data.rows ?? []).length > 0)) {
        throw new AppError('provider_error', 'YouTube Analytics returned an unexpected analytics response (missing column names).', 'Try again later; no data was interpreted.', true);
      }
      const rows = (response.data.rows ?? []).map((row) => Object.fromEntries(
        columns.map((name, index) => [name, cell(row[index])]),
      ));
      return { query, columns, rows, rowCount: rows.length };
    } catch (error) {
      throw toSafeError(error);
    }
  }

  private async authorized(): Promise<YouTubeAnalyticsApi> {
    return this.client.analytics(await this.oauth.getAccessToken('analytics.read'));
  }
}

type ReportData = { columnHeaders?: unknown[]; rows?: unknown[][] };

function normalizeOverview(data: ReportData): CreatorOverview {
  const row = rowValues(data)[0] ?? {};
  return {
    views: numberAt(row, 'views'),
    estimatedMinutesWatched: numberAt(row, 'estimatedMinutesWatched'),
    averageViewDuration: numberAt(row, 'averageViewDuration'),
    likes: numberAt(row, 'likes'),
    comments: numberAt(row, 'comments'),
    subscribersGained: numberAt(row, 'subscribersGained'),
    subscribersLost: numberAt(row, 'subscribersLost'),
  };
}

function normalizeTopVideos(data: ReportData): CreatorTopVideo[] {
  return rowValues(data).flatMap((row) => {
    const videoId = stringAt(row, 'video');
    if (!videoId) {
      return [];
    }
    return [{
      videoId,
      views: numberAt(row, 'views'),
      estimatedMinutesWatched: numberAt(row, 'estimatedMinutesWatched'),
      averageViewDuration: numberAt(row, 'averageViewDuration'),
      likes: numberAt(row, 'likes'),
      comments: numberAt(row, 'comments'),
    }];
  });
}

function normalizeRetention(data: ReportData): RetentionPoint[] {
  return rowValues(data).map((row) => ({
    elapsedVideoTimeRatio: numberAt(row, 'elapsedVideoTimeRatio'),
    audienceWatchRatio: numberAt(row, 'audienceWatchRatio'),
    relativeRetentionPerformance: numberAt(row, 'relativeRetentionPerformance'),
  }));
}

function rowValues(data: ReportData): Array<Record<string, unknown>> {
  const names = (data.columnHeaders ?? []).map((header) => stringAt(asRecord(header) ?? {}, 'name'));
  if (names.some((name) => !name)) {
    return [];
  }
  return (data.rows ?? []).map((row) => Object.fromEntries(names.map((name, index) => [name, row[index]])));
}

function numberAt(row: Record<string, unknown>, name: string): number {
  const value = row[name];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function stringAt(row: Record<string, unknown>, name: string): string | undefined {
  const value = row[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function cell(value: unknown): string | number | null {
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}
