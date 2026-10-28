import { AppError } from '../errors.js';

/**
 * Allowlisted YouTube Analytics reports.query building blocks for youtube_creator_report.
 * Known-invalid combinations are rejected here with invalid_input instead of letting Google answer 400.
 */
export const reportMetrics = [
  'views', 'estimatedMinutesWatched', 'averageViewDuration', 'averageViewPercentage',
  'subscribersGained', 'subscribersLost', 'likes', 'comments', 'shares',
] as const;
export const demographicMetric = 'viewerPercentage';
export const reportDimensions = [
  'day', 'month', 'video', 'country', 'deviceType', 'operatingSystem',
  'insightTrafficSourceType', 'insightTrafficSourceDetail', 'ageGroup', 'gender', 'subscribedStatus', 'sharingService',
] as const;
/** Values accepted by the insightTrafficSourceType filter when requesting insightTrafficSourceDetail. */
export const trafficSourceDetailTypes = [
  'ADVERTISING', 'CAMPAIGN_CARD', 'END_SCREEN', 'EXT_URL', 'HASHTAGS', 'NOTIFICATION', 'PLAYLIST',
  'RELATED_VIDEO', 'SHORTS', 'SOUND_PAGE', 'YT_CHANNEL', 'YT_OTHER_PAGE', 'YT_SEARCH',
] as const;
const detailMetrics = ['views', 'estimatedMinutesWatched'];
const demographicDimensions = ['ageGroup', 'gender'];

export type CreatorReportInput = {
  startDate?: string;
  endDate?: string;
  metrics: string[];
  dimensions?: string[];
  filters?: { videoIds?: string[]; country?: string; insightTrafficSourceType?: string };
  sort?: string[];
  maxResults?: number;
};

export type CreatorReportQuery = {
  ids: 'channel==MINE';
  startDate: string;
  endDate: string;
  metrics: string;
  dimensions?: string;
  filters?: string;
  sort?: string;
  maxResults?: number;
};

export function buildReportQuery(input: CreatorReportInput, today: string): CreatorReportQuery {
  const metrics = unique(input.metrics);
  const dimensions = unique(input.dimensions ?? []);
  const { startDate, endDate } = resolveRange(input, today);

  for (const metric of metrics) {
    if (!(reportMetrics as readonly string[]).includes(metric) && metric !== demographicMetric) {
      throw invalid(`Metric "${metric}" is not allowed.`, `Use one of: ${[...reportMetrics, demographicMetric].join(', ')}.`);
    }
  }
  for (const dimension of dimensions) {
    if (!(reportDimensions as readonly string[]).includes(dimension)) {
      throw invalid(`Dimension "${dimension}" is not allowed.`, `Use one of: ${reportDimensions.join(', ')}.`);
    }
  }

  const demographic = dimensions.some((dimension) => demographicDimensions.includes(dimension));
  const hasViewerPercentage = metrics.includes(demographicMetric);
  if (demographic && (metrics.length !== 1 || !hasViewerPercentage)) {
    throw invalid('ageGroup and gender can only be reported with the viewerPercentage metric alone.', 'Set metrics to ["viewerPercentage"].');
  }
  if (hasViewerPercentage && !demographic) {
    throw invalid('viewerPercentage is only available with the ageGroup and/or gender dimensions.', 'Add dimensions ["ageGroup"], ["gender"] or both, or choose other metrics.');
  }
  if (demographic && dimensions.some((dimension) => !demographicDimensions.includes(dimension))) {
    throw invalid('ageGroup and gender cannot be combined with other dimensions.', 'Use only ageGroup and/or gender as dimensions.');
  }

  if (dimensions.includes('day') && dimensions.includes('month')) {
    throw invalid('day and month cannot be combined.', 'Choose one time dimension.');
  }

  const sharing = dimensions.includes('sharingService');
  if (sharing && (metrics.length !== 1 || metrics[0] !== 'shares')) {
    throw invalid('The sharingService dimension only supports the shares metric.', 'Set metrics to ["shares"].');
  }
  if (metrics.includes('shares') && dimensions.some((dimension) => ['insightTrafficSourceType', 'insightTrafficSourceDetail'].includes(dimension))) {
    throw invalid('shares cannot be broken down by traffic source.', 'Use views or estimatedMinutesWatched with traffic source dimensions.');
  }

  const detail = dimensions.includes('insightTrafficSourceDetail');
  const sourceType = input.filters?.insightTrafficSourceType;
  if (sourceType !== undefined && !detail) {
    throw invalid('The insightTrafficSourceType filter is only meaningful with the insightTrafficSourceDetail dimension.', 'Add the insightTrafficSourceDetail dimension or drop the filter.');
  }
  if (detail) {
    if (dimensions.length !== 1) {
      throw invalid('insightTrafficSourceDetail must be the only dimension.', 'Run separate reports for other breakdowns.');
    }
    if (!input.filters?.videoIds || input.filters.videoIds.length !== 1) {
      throw invalid('insightTrafficSourceDetail requires exactly one video in filters.videoIds.', 'Pass filters.videoIds with a single owned video ID.');
    }
    if (!sourceType || !(trafficSourceDetailTypes as readonly string[]).includes(sourceType)) {
      throw invalid('insightTrafficSourceDetail requires an insightTrafficSourceType filter.', `Set filters.insightTrafficSourceType to one of: ${trafficSourceDetailTypes.join(', ')}.`);
    }
    if (metrics.some((metric) => !detailMetrics.includes(metric))) {
      throw invalid('insightTrafficSourceDetail only supports the views and estimatedMinutesWatched metrics.', 'Use metrics from ["views", "estimatedMinutesWatched"].');
    }
    if ((input.maxResults ?? 0) > 25) {
      throw invalid('insightTrafficSourceDetail reports return at most 25 rows.', 'Set maxResults to 25 or less.');
    }
  }

  const known = new Set([...metrics, ...dimensions]);
  for (const key of input.sort ?? []) {
    if (!known.has(key.replace(/^-/, ''))) {
      throw invalid(`Sort key "${key}" is not one of the selected metrics or dimensions.`, 'Sort only by columns you requested; prefix with - for descending.');
    }
  }

  let sort = input.sort?.length ? input.sort : undefined;
  let maxResults = input.maxResults;
  const needsTopN = detail || dimensions.includes('video');
  if (needsTopN) {
    // Google requires both sort and maxResults for per-video and traffic-source-detail reports.
    sort ??= [metrics.includes('views') ? '-views' : `-${metrics[0]}`];
    maxResults ??= 25;
  }

  const filters = buildFilters(input.filters, sourceType);
  return {
    ids: 'channel==MINE',
    startDate,
    endDate,
    metrics: metrics.join(','),
    ...(dimensions.length ? { dimensions: dimensions.join(',') } : {}),
    ...(filters ? { filters } : {}),
    ...(sort ? { sort: sort.join(',') } : {}),
    ...(maxResults !== undefined ? { maxResults } : {}),
  };
}

function buildFilters(filters: CreatorReportInput['filters'], sourceType?: string): string | undefined {
  const parts: string[] = [];
  if (filters?.videoIds?.length) {
    const ids = unique(filters.videoIds);
    if (ids.some((videoId) => /[;,=]/.test(videoId))) {
      throw invalid('Video IDs cannot contain ",", ";" or "=".', 'Pass plain YouTube video IDs.');
    }
    parts.push(`video==${ids.join(',')}`);
  }
  if (filters?.country) parts.push(`country==${filters.country.toUpperCase()}`);
  if (sourceType) parts.push(`insightTrafficSourceType==${sourceType}`);
  return parts.length ? parts.join(';') : undefined;
}

function resolveRange(input: CreatorReportInput, today: string): { startDate: string; endDate: string } {
  const endDate = input.endDate ?? today;
  const startDate = input.startDate ?? shiftDays(endDate, -28);
  for (const value of [startDate, endDate]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
      throw invalid(`"${value}" is not a valid YYYY-MM-DD date.`, 'Use YYYY-MM-DD dates.');
    }
  }
  if (startDate > endDate) {
    throw invalid('startDate must not be after endDate.', 'Swap the dates or widen the range.');
  }
  return { startDate, endDate };
}

function shiftDays(date: string, days: number): string {
  const moment = new Date(`${date}T00:00:00Z`);
  moment.setUTCDate(moment.getUTCDate() + days);
  return moment.toISOString().slice(0, 10);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function invalid(message: string, action: string): AppError {
  return new AppError('invalid_input', message, action, false);
}
