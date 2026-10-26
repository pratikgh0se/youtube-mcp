import { toSafeError } from '../errors.js';
import type { OAuthService } from '../auth/oauth.js';
import { YouTubeClient, type YouTubeAnalyticsApi } from './client.js';

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

export const overviewMetrics =
  'views,estimatedMinutesWatched,averageViewDuration,likes,comments,subscribersGained,subscribersLost';
const topVideoMetrics = 'views,estimatedMinutesWatched,averageViewDuration,likes,comments';
const retentionMetrics = 'audienceWatchRatio,relativeRetentionPerformance';

export class CreatorAnalyticsService {
  constructor(
    private readonly oauth: Pick<OAuthService, 'getAccessToken'>,
    private readonly client: YouTubeClient,
    private readonly today: () => string = () => new Date().toISOString().slice(0, 10),
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
