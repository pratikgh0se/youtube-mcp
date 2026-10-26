import { stat, readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import { AppError } from '../errors.js';
import type { ImportSummary, WatchEvent } from './store.js';
import { canonicalSourceKey, ConsumptionStore, normalizeEventText } from './store.js';

type TakeoutRecord = {
  title?: unknown;
  titleUrl?: unknown;
  time?: unknown;
  subtitles?: unknown;
  details?: unknown;
};

type ParsedTakeout = {
  records: TakeoutRecord[];
  sourceRecordCount: number;
};

export const MAX_TAKEOUT_BYTES = 25 * 1024 * 1024;

export class TakeoutImporter {
  constructor(private readonly store: ConsumptionStore) {}

  async import(inputPath: string): Promise<ImportSummary> {
    await validateLocalHistoryPath(inputPath);
    const source = await readLocalHistory(inputPath);
    const parsed = parseTakeout(source, extname(inputPath).toLowerCase());
    const events = parsed.records.flatMap(normalizeHistoryEvent);
    if (parsed.sourceRecordCount > 0 && events.length === 0) {
      throw new AppError(
        'takeout_no_supported_history',
        'The Takeout file did not contain recognizable YouTube watch or search history.',
        'Export YouTube watch and search history, then import that local file.',
        false,
      );
    }
    const imported = this.store.upsertWatchEvents(events);
    return { imported: imported.imported, skipped: parsed.sourceRecordCount - imported.imported };
  }
}

async function validateLocalHistoryPath(inputPath: string): Promise<void> {
  const extension = extname(inputPath).toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(inputPath) || !['.json', '.html', '.htm'].includes(extension)) {
    throw invalidPathError();
  }

  try {
    const metadata = await stat(inputPath);
    if (!metadata.isFile()) {
      throw invalidPathError();
    }
    if (metadata.size > MAX_TAKEOUT_BYTES) {
      throw new AppError(
        'takeout_file_too_large',
        'The local Takeout history file exceeds the 25 MiB import limit.',
        'Split the export into smaller history files and import them separately.',
        false,
      );
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(
      'takeout_read_failed',
      'Could not read the local Takeout history file.',
      'Verify that the file exists and is readable.',
      false,
    );
  }
}

async function readLocalHistory(inputPath: string): Promise<string> {
  try {
    return await readFile(inputPath, 'utf8');
  } catch {
    throw new AppError(
      'takeout_read_failed',
      'Could not read the local Takeout history file.',
      'Verify that the file exists and is readable.',
      false,
    );
  }
}

function parseTakeout(source: string, extension: string): ParsedTakeout {
  try {
    if (extension === '.json') {
      const value: unknown = JSON.parse(source);
      if (!Array.isArray(value)) {
        throw new Error('Takeout history must be an array.');
      }
      return { records: value.filter(isTakeoutRecord), sourceRecordCount: value.length };
    }
    const records = parseHtmlHistory(source);
    return { records, sourceRecordCount: records.length || (source.trim() ? 1 : 0) };
  } catch {
    throw new AppError(
      'takeout_parse_failed',
      'The local Takeout history file could not be parsed.',
      'Export YouTube history again in JSON or HTML format.',
      false,
    );
  }
}

function parseHtmlHistory(source: string): TakeoutRecord[] {
  const records: TakeoutRecord[] = [];
  for (const block of source.split(/<div[^>]*class="[^"]*content-cell[^"]*"[^>]*>/i).slice(1)) {
    const activity = /(Watched|Searched for)\s*<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/i.exec(block);
    const time = /<br\s*\/?>([^<]+)<br\s*\/?>(?:\s*Products:)?/i.exec(block);
    if (!activity || !time) {
      continue;
    }
    const watchedAt = new Date(decodeHtml(time[1]!).trim());
    if (Number.isNaN(watchedAt.getTime())) {
      continue;
    }
    records.push({
      title: `${activity[1]} ${decodeHtml(activity[3]!).trim()}`,
      titleUrl: decodeHtml(activity[2]!),
      time: watchedAt.toISOString(),
    });
  }
  return records;
}

function normalizeHistoryEvent(record: TakeoutRecord): WatchEvent[] {
  const title = stringValue(record.title);
  const watchedAt = normalizeTimestamp(record.time);
  if (!title || !watchedAt) {
    return [];
  }

  if (title.startsWith('Watched ')) {
    return normalizeWatchEvent(title, watchedAt, stringValue(record.titleUrl), record.subtitles);
  }
  if (title.startsWith('Searched for ')) {
    return normalizeSearchEvent(title, watchedAt, stringValue(record.titleUrl));
  }
  return [];
}

function normalizeWatchEvent(
  rawTitle: string,
  watchedAt: string,
  titleUrl: string | undefined,
  subtitles: unknown,
): WatchEvent[] {
  const videoId = videoIdFromUrl(titleUrl);
  if (!titleUrl || !videoId) {
    return [];
  }

  const normalizedTitle = normalizeText(rawTitle.slice('Watched '.length));
  if (!normalizedTitle) {
    return [];
  }
  return [{
    sourceKey: canonicalSourceKey('watch', watchedAt, videoId, normalizedTitle),
    eventType: 'watch',
    watchedAt,
    videoId,
    channelId: channelIdFromSubtitles(subtitles),
    title: normalizedTitle,
    topic: topicFromText(normalizedTitle, titleUrl),
  }];
}

function normalizeSearchEvent(rawTitle: string, watchedAt: string, titleUrl: string | undefined): WatchEvent[] {
  const query = normalizeText(rawTitle.slice('Searched for '.length));
  if (!query) {
    return [];
  }
  return [{
    sourceKey: canonicalSourceKey('search', watchedAt, undefined, query),
    eventType: 'search',
    watchedAt,
    title: query,
    query,
    topic: topicFromText(query, titleUrl),
  }];
}

function normalizeTimestamp(value: unknown): string | undefined {
  const timestamp = stringValue(value);
  if (!timestamp) {
    return undefined;
  }
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function videoIdFromUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(url.hostname)) {
      return undefined;
    }
    const candidate = url.hostname === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v');
    return candidate && /^[A-Za-z0-9_-]+$/.test(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function channelIdFromSubtitles(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const subtitle of value) {
    if (!isRecord(subtitle) || typeof subtitle.url !== 'string') {
      continue;
    }
    try {
      const url = new URL(subtitle.url);
      const match = /^\/channel\/([^/]+)$/.exec(url.pathname);
      if (match && /^[A-Za-z0-9_-]+$/.test(match[1]!)) {
        return match[1];
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function topicFromText(titleOrQuery: string, url: string | undefined): string | undefined {
  const signal = `${titleOrQuery} ${url ?? ''}`.toLowerCase();
  if (/\b(?:typescript|javascript|node(?:\.js)?|compiler|software|code|debug(?:ging)?|tests?(?:ing)?|refactor(?:ing)?)\b/.test(signal)) {
    return 'software engineering';
  }
  if (/\b(?:recipe|cooking|cook|food|thai food|baking)\b/.test(signal)) {
    return 'food and cooking';
  }
  if (/\b(?:workout|fitness|running|run|strength training)\b/.test(signal)) {
    return 'fitness';
  }
  if (/\b(?:game|gaming|walkthrough|speedrun)\b/.test(signal)) {
    return 'gaming';
  }
  if (/\b(?:song|music|album|guitar|piano)\b/.test(signal)) {
    return 'music';
  }
  return undefined;
}

/**
 * Matching normalized type, timestamp, video id, and title/query intentionally collapse to one event.
 * A true duplicate with those same identity fields cannot be distinguished from a re-exported record.
 */
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizeText(value: string): string {
  return normalizeEventText(value);
}

function isTakeoutRecord(value: unknown): value is TakeoutRecord {
  return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function invalidPathError(): AppError {
  return new AppError(
    'invalid_takeout_path',
    'Takeout imports require a local JSON or HTML history file.',
    'Provide the path to a local Takeout export.',
    false,
  );
}

function decodeHtml(value: string): string {
  return value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
}
