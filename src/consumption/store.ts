import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import { AppError } from '../errors.js';

export type ConsumptionDateRange = {
  startDate: string;
  endDate: string;
};

export type WatchEvent = {
  sourceKey: string;
  eventType: 'watch' | 'search';
  watchedAt: string;
  videoId?: string;
  channelId?: string;
  title: string;
  query?: string;
  topic?: string;
};

export type ImportSummary = {
  imported: number;
  skipped: number;
};

export type ConsumptionProfile = {
  totalWatchCount: number;
  totalActivityCount: number;
  searchCount: number;
  topChannels: Array<{ channelId: string; watchCount: number }>;
  topTopics: Array<{ topic: string; activityCount: number }>;
  contentTypes: Array<{ eventType: 'watch' | 'search'; eventCount: number }>;
  byHour: Array<{ hour: number; activityCount: number }>;
};

export type ConsumptionTrends = {
  increasedTopics: string[];
};

type CountRow = { value: string | null; activityCount: number };
type TotalRow = { totalWatchCount: number; totalActivityCount: number; searchCount: number };
type WatchEventParameters = Omit<WatchEvent, 'videoId' | 'channelId' | 'query' | 'topic'> & {
  videoId: string | null;
  channelId: string | null;
  query: string | null;
  topic: string | null;
};

const schema = `
  CREATE TABLE IF NOT EXISTS watch_events (
    source_key TEXT PRIMARY KEY,
    watched_at TEXT NOT NULL,
    video_id TEXT,
    channel_id TEXT,
    title TEXT NOT NULL,
    event_type TEXT NOT NULL DEFAULT 'watch',
    query TEXT,
    topic TEXT
  );
  CREATE INDEX IF NOT EXISTS watch_events_watched_at_idx ON watch_events(watched_at);
`;

export class ConsumptionStore {
  private database?: Database.Database;

  constructor(private readonly databasePath: string) {}

  initialize(): void {
    if (this.database) {
      return;
    }

    try {
      if (this.databasePath !== ':memory:') {
        const stateDirectory = dirname(this.databasePath);
        mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
        chmodSync(stateDirectory, 0o700);
      }

      this.database = new Database(this.databasePath);
      if (this.databasePath !== ':memory:' && existsSync(this.databasePath)) {
        chmodSync(this.databasePath, 0o600);
      }
      this.database.exec(schema);
      const isLegacyRawKeyDatabase = !this.hasColumn('event_type');
      this.addColumnIfMissing('event_type', "TEXT NOT NULL DEFAULT 'watch'");
      this.addColumnIfMissing('query', 'TEXT');
      if (isLegacyRawKeyDatabase) {
        this.rekeyLegacyWatchEvents();
      }
    } catch (error) {
      this.database?.close();
      this.database = undefined;
      throw consumptionStorageError(error);
    }
  }

  upsertWatchEvents(events: WatchEvent[]): ImportSummary {
    try {
      const database = this.readyDatabase();
      const existing = database.prepare<{ sourceKey: string }, { sourceKey: string }>(`
        SELECT source_key AS sourceKey FROM watch_events WHERE source_key = @sourceKey
      `);
      const insert = database.prepare<WatchEventParameters>(`
        INSERT OR IGNORE INTO watch_events (source_key, watched_at, video_id, channel_id, title, event_type, query, topic)
        VALUES (@sourceKey, @watchedAt, @videoId, @channelId, @title, @eventType, @query, @topic)
      `);
      const refresh = database.prepare<WatchEventParameters>(`
        UPDATE watch_events
        SET watched_at = @watchedAt,
            video_id = @videoId,
            channel_id = @channelId,
            title = @title,
            event_type = @eventType,
            query = @query,
            topic = @topic
        WHERE source_key = @sourceKey
      `);
      let imported = 0;

      database.transaction((records: WatchEvent[]) => {
        for (const event of records) {
          const parameters = toDatabaseParameters(event);
          if (existing.get({ sourceKey: event.sourceKey })) {
            refresh.run(parameters);
          } else {
            imported += insert.run(parameters).changes;
          }
        }
      })(events);

      return { imported, skipped: events.length - imported };
    } catch (error) {
      throw consumptionStorageError(error);
    }
  }

  hasImportedHistory(): boolean {
    try {
      const database = this.readyDatabase();
      return database.prepare<[], { imported: number }>('SELECT EXISTS(SELECT 1 FROM watch_events) AS imported').get()?.imported === 1;
    } catch (error) {
      throw consumptionStorageError(error);
    }
  }

  profile(range: ConsumptionDateRange): ConsumptionProfile {
    try {
      const bounds = dateBounds(range);
      const database = this.readyDatabase();
      const parameters = { start: bounds.start, end: bounds.endExclusive };
      const totals = database.prepare<{ start: string; end: string }, TotalRow>(`
        SELECT
          COALESCE(SUM(CASE WHEN event_type = 'watch' THEN 1 ELSE 0 END), 0) AS totalWatchCount,
          COUNT(*) AS totalActivityCount,
          COALESCE(SUM(CASE WHEN event_type = 'search' THEN 1 ELSE 0 END), 0) AS searchCount
        FROM watch_events
        WHERE watched_at >= @start AND watched_at < @end
      `).get(parameters) ?? { totalWatchCount: 0, totalActivityCount: 0, searchCount: 0 };

      return {
        totalWatchCount: totals.totalWatchCount,
        totalActivityCount: totals.totalActivityCount,
        searchCount: totals.searchCount,
        topChannels: this.countBy('channel_id', parameters)
          .filter((row) => row.value !== null)
          .map((row) => ({ channelId: row.value!, watchCount: row.activityCount })),
        topTopics: this.countBy('topic', parameters)
          .filter((row) => row.value !== null)
          .map((row) => ({ topic: row.value!, activityCount: row.activityCount })),
        contentTypes: database.prepare<{ start: string; end: string }, { eventType: 'watch' | 'search'; eventCount: number }>(`
          SELECT event_type AS eventType, COUNT(*) AS eventCount
          FROM watch_events
          WHERE watched_at >= @start AND watched_at < @end
          GROUP BY event_type
          ORDER BY eventCount DESC, eventType ASC
        `).all(parameters),
        byHour: database.prepare<{ start: string; end: string }, { hour: string; activityCount: number }>(`
          SELECT strftime('%H', watched_at) AS hour, COUNT(*) AS activityCount
          FROM watch_events
          WHERE watched_at >= @start AND watched_at < @end
          GROUP BY hour
          ORDER BY activityCount DESC, hour ASC
        `).all(parameters).map((row) => ({ hour: Number(row.hour), activityCount: row.activityCount })),
      };
    } catch (error) {
      throw consumptionStorageError(error);
    }
  }

  trends(baseline: ConsumptionDateRange, comparison: ConsumptionDateRange): ConsumptionTrends {
    try {
      const baselineTopics = countsByValue(this.countBy('topic', queryParameters(baseline)));
      const comparisonTopics = countsByValue(this.countBy('topic', queryParameters(comparison)));
      const increasedTopics = [...comparisonTopics]
        .filter(([topic, comparisonCount]) => comparisonCount > (baselineTopics.get(topic) ?? 0))
        .sort(([leftTopic, leftCount], [rightTopic, rightCount]) => rightCount - leftCount || compareStrings(leftTopic, rightTopic))
        .map(([topic]) => topic);

      return { increasedTopics };
    } catch (error) {
      throw consumptionStorageError(error);
    }
  }

  private countBy(column: 'channel_id' | 'topic', parameters: { start: string; end: string }): CountRow[] {
    const database = this.readyDatabase();
    return database.prepare<{ start: string; end: string }, CountRow>(`
      SELECT ${column} AS value, COUNT(*) AS activityCount
      FROM watch_events
      WHERE watched_at >= @start AND watched_at < @end
      GROUP BY ${column}
      ORDER BY activityCount DESC, value ASC
    `).all(parameters);
  }

  private readyDatabase(): Database.Database {
    this.initialize();
    return this.database!;
  }

  private addColumnIfMissing(column: string, declaration: string): void {
    if (!this.hasColumn(column)) {
      this.database!.exec(`ALTER TABLE watch_events ADD COLUMN ${column} ${declaration}`);
    }
  }

  private hasColumn(column: string): boolean {
    const columns = this.database!.prepare<[], { name: string }>('PRAGMA table_info(watch_events)').all();
    return columns.some((existing) => existing.name === column);
  }

  /** Replaces pre-0.1 raw-export hashes with canonical watch identities and collapses collisions. */
  private rekeyLegacyWatchEvents(): void {
    const database = this.database!;
    const rows = database.prepare<[], { sourceKey: string; watchedAt: string; videoId: string | null; title: string }>(`
      SELECT source_key AS sourceKey, watched_at AS watchedAt, video_id AS videoId, title
      FROM watch_events
    `).all();
    const find = database.prepare<{ sourceKey: string }, { sourceKey: string }>(`
      SELECT source_key AS sourceKey FROM watch_events WHERE source_key = @sourceKey
    `);
    const rename = database.prepare<{ sourceKey: string; canonicalKey: string }>(`
      UPDATE watch_events SET source_key = @canonicalKey WHERE source_key = @sourceKey
    `);
    const remove = database.prepare<{ sourceKey: string }>('DELETE FROM watch_events WHERE source_key = @sourceKey');

    database.transaction(() => {
      for (const row of rows) {
        const canonicalKey = canonicalSourceKey('watch', row.watchedAt, row.videoId ?? undefined, row.title);
        if (canonicalKey === row.sourceKey) {
          continue;
        }
        if (find.get({ sourceKey: canonicalKey })) {
          remove.run({ sourceKey: row.sourceKey });
        } else {
          rename.run({ sourceKey: row.sourceKey, canonicalKey });
        }
      }
    })();
  }
}

/**
 * Matching normalized type, timestamp, video id, and title/query intentionally collapse to one event.
 * A true duplicate with those same identity fields cannot be distinguished from a re-exported record.
 */
export function canonicalSourceKey(
  eventType: 'watch' | 'search',
  watchedAt: string,
  videoId: string | undefined,
  titleOrQuery: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([eventType, watchedAt, videoId ?? '', normalizeEventText(titleOrQuery)]))
    .digest('hex');
}

export function normalizeEventText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function countsByValue(rows: CountRow[]): Map<string, number> {
  return new Map(rows.flatMap((row) => row.value === null ? [] : [[row.value, row.activityCount]]));
}

function toDatabaseParameters(event: WatchEvent): WatchEventParameters {
  return {
    ...event,
    videoId: event.videoId ?? null,
    channelId: event.channelId ?? null,
    query: event.query ?? null,
    topic: event.topic ?? null,
  };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function queryParameters(range: ConsumptionDateRange): { start: string; end: string } {
  const bounds = dateBounds(range);
  return { start: bounds.start, end: bounds.endExclusive };
}

function dateBounds(range: ConsumptionDateRange): { start: string; endExclusive: string } {
  const start = parseDate(range.startDate);
  const end = parseDate(range.endDate);
  if (start.getTime() > end.getTime()) {
    throw invalidDateRangeError();
  }

  end.setUTCDate(end.getUTCDate() + 1);
  return { start: start.toISOString(), endExclusive: end.toISOString() };
}

function parseDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw invalidDateRangeError();
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw invalidDateRangeError();
  }
  return date;
}

function invalidDateRangeError(): AppError {
  return new AppError(
    'invalid_date_range',
    'Consumption date ranges must use valid YYYY-MM-DD bounds.',
    'Provide a start date on or before the end date.',
    false,
  );
}

function consumptionStorageError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  return new AppError(
    'consumption_storage_failed',
    'The local consumption database could not be initialized or updated.',
    'Verify that the configured state directory is writable, then try again.',
    false,
  );
}
