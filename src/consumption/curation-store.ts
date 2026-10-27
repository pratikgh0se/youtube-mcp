import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import { openDatabase } from '../sqlite/open-database.js';

export type CurationCandidateSource = 'allowlist' | 'playlist' | 'search';

export type CurationPolicy = {
  profileId: string;
  allowedSources: string[];
  retentionDays?: number;
};

export type CurationCandidate = {
  profileId: string;
  videoId: string;
  source: CurationCandidateSource;
  sourceId: string;
  title: string;
  reason?: string;
  estimatedMinutes?: number;
  apiFetchedAt?: string;
  apiExpiresAt?: string;
};

export type ConsumptionQueueItem = {
  videoId: string;
  reason: string;
  estimatedMinutes?: number;
  source: CurationCandidateSource;
  sourceApproved: boolean;
  apiFetchedAt?: string;
};

export type ConsumptionQueue = {
  queueId: string;
  profileId: string;
  source: 'local_self_report';
  estimatedMinutes: number;
  items: ConsumptionQueueItem[];
  state: 'proposed' | 'applied';
};

export type CurationResetResult = { profileId: string; deleted: { policies: number; candidates: number; queues: number } };

type PolicyRow = { profileId: string; allowedSources: string; retentionDays: number };
type CandidateRow = Omit<CurationCandidate, 'reason' | 'estimatedMinutes' | 'apiFetchedAt' | 'apiExpiresAt'> & {
  reason: string | null;
  estimatedMinutes: number | null;
  apiFetchedAt: string | null;
  apiExpiresAt: string | null;
};
type QueueRow = Omit<ConsumptionQueue, 'items'> & { items: string };

const schema = `
  CREATE TABLE IF NOT EXISTS curation_policies (
    profile_id TEXT PRIMARY KEY,
    allowed_sources TEXT NOT NULL,
    retention_days INTEGER NOT NULL DEFAULT 30
  );
  CREATE TABLE IF NOT EXISTS curation_candidates (
    profile_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    title TEXT NOT NULL,
    reason TEXT,
    estimated_minutes INTEGER,
    api_fetched_at TEXT,
    api_expires_at TEXT,
    PRIMARY KEY (profile_id, video_id)
  );
  CREATE TABLE IF NOT EXISTS consumption_queues (
    queue_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    source TEXT NOT NULL,
    estimated_minutes INTEGER NOT NULL,
    items TEXT NOT NULL,
    state TEXT NOT NULL
  );
`;

export class CurationStore {
  private database?: Database.Database;

  constructor(private readonly databasePath: string, private readonly now: () => Date = () => new Date()) {}

  initialize(): void {
    if (this.database) return;
    if (this.databasePath !== ':memory:') {
      const directory = dirname(this.databasePath);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    this.database = openDatabase(this.databasePath);
    if (this.databasePath !== ':memory:' && existsSync(this.databasePath)) chmodSync(this.databasePath, 0o600);
    this.database.exec(schema);
    this.addColumnIfMissing('curation_policies', 'retention_days', 'INTEGER NOT NULL DEFAULT 30');
    this.addColumnIfMissing('curation_candidates', 'api_expires_at', 'TEXT');
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  savePolicy(policy: CurationPolicy): void {
    const retentionDays = policy.retentionDays ?? 30;
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new Error('invalid retention days');
    this.ready().prepare(`
      INSERT INTO curation_policies (profile_id, allowed_sources, retention_days) VALUES (@profileId, @allowedSources, @retentionDays)
      ON CONFLICT(profile_id) DO UPDATE SET allowed_sources = excluded.allowed_sources, retention_days = excluded.retention_days
    `).run({ profileId: policy.profileId, allowedSources: JSON.stringify(unique(policy.allowedSources)), retentionDays });
  }

  policy(profileId: string): CurationPolicy | undefined {
    const row = this.ready().prepare<{ profileId: string }, PolicyRow>(`
      SELECT profile_id AS profileId, allowed_sources AS allowedSources, retention_days AS retentionDays
      FROM curation_policies WHERE profile_id = @profileId
    `).get({ profileId });
    return row && { profileId: row.profileId, allowedSources: JSON.parse(row.allowedSources) as string[], retentionDays: row.retentionDays };
  }

  saveCandidate(candidate: CurationCandidate): void {
    const apiExpiresAt = candidate.apiFetchedAt
      ? candidate.apiExpiresAt ?? expiryFrom(candidate.apiFetchedAt, this.policy(candidate.profileId)?.retentionDays ?? 30)
      : undefined;
    this.ready().prepare(`
      INSERT INTO curation_candidates (profile_id, video_id, source, source_id, title, reason, estimated_minutes, api_fetched_at, api_expires_at)
      VALUES (@profileId, @videoId, @source, @sourceId, @title, @reason, @estimatedMinutes, @apiFetchedAt, @apiExpiresAt)
      ON CONFLICT(profile_id, video_id) DO UPDATE SET
        source = excluded.source, source_id = excluded.source_id, title = excluded.title,
        reason = excluded.reason, estimated_minutes = excluded.estimated_minutes, api_fetched_at = excluded.api_fetched_at,
        api_expires_at = excluded.api_expires_at
    `).run({ ...candidate, reason: candidate.reason ?? null, estimatedMinutes: candidate.estimatedMinutes ?? null, apiFetchedAt: candidate.apiFetchedAt ?? null, apiExpiresAt: apiExpiresAt ?? null });
  }

  candidates(profileId: string): CurationCandidate[] {
    this.ready().prepare(`DELETE FROM curation_candidates WHERE profile_id = @profileId AND api_expires_at IS NOT NULL AND api_expires_at <= @now`)
      .run({ profileId, now: this.now().toISOString() });
    return this.ready().prepare<{ profileId: string }, CandidateRow>(`
      SELECT profile_id AS profileId, video_id AS videoId, source, source_id AS sourceId, title,
             reason, estimated_minutes AS estimatedMinutes, api_fetched_at AS apiFetchedAt, api_expires_at AS apiExpiresAt
      FROM curation_candidates WHERE profile_id = @profileId ORDER BY rowid ASC
    `).all({ profileId }).map((row) => ({
      ...row,
      reason: row.reason ?? undefined,
      estimatedMinutes: row.estimatedMinutes ?? undefined,
      apiFetchedAt: row.apiFetchedAt ?? undefined,
      apiExpiresAt: row.apiExpiresAt ?? undefined,
    }));
  }

  createQueue(queue: Omit<ConsumptionQueue, 'queueId' | 'state'>): ConsumptionQueue {
    const stored: ConsumptionQueue = { ...queue, queueId: randomUUID(), state: 'proposed' };
    this.ready().prepare(`
      INSERT INTO consumption_queues (queue_id, profile_id, source, estimated_minutes, items, state)
      VALUES (@queueId, @profileId, @source, @estimatedMinutes, @items, @state)
    `).run({ ...stored, items: JSON.stringify(stored.items) });
    return stored;
  }

  queue(queueId: string): ConsumptionQueue | undefined {
    const row = this.ready().prepare<{ queueId: string }, QueueRow>(`
      SELECT queue_id AS queueId, profile_id AS profileId, source, estimated_minutes AS estimatedMinutes, items, state
      FROM consumption_queues WHERE queue_id = @queueId
    `).get({ queueId });
    return row && { ...row, items: JSON.parse(row.items) as ConsumptionQueueItem[] };
  }

  markApplied(queueId: string): void {
    this.ready().prepare(`UPDATE consumption_queues SET state = 'applied' WHERE queue_id = @queueId`).run({ queueId });
  }

  reset(profileId: string): CurationResetResult {
    const database = this.ready();
    return database.transaction(() => ({
      profileId,
      deleted: {
        queues: database.prepare('DELETE FROM consumption_queues WHERE profile_id = ?').run(profileId).changes,
        candidates: database.prepare('DELETE FROM curation_candidates WHERE profile_id = ?').run(profileId).changes,
        policies: database.prepare('DELETE FROM curation_policies WHERE profile_id = ?').run(profileId).changes,
      },
    }))();
  }

  private ready(): Database.Database {
    this.initialize();
    return this.database!;
  }

  private addColumnIfMissing(table: 'curation_policies' | 'curation_candidates', column: string, declaration: string): void {
    const columns = this.database!.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all();
    if (!columns.some((existing) => existing.name === column)) this.database!.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function expiryFrom(fetchedAt: string, retentionDays: number): string {
  const fetched = new Date(fetchedAt);
  if (Number.isNaN(fetched.getTime())) throw new Error('invalid API fetch time');
  return new Date(fetched.getTime() + retentionDays * 24 * 60 * 60_000).toISOString();
}
