import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../../src/sqlite/open-database.js';

import { MAX_TAKEOUT_BYTES, TakeoutImporter } from '../../src/consumption/importer.js';
import { ConsumptionStore } from '../../src/consumption/store.js';

const fixturePath = new URL('../fixtures/takeout/watch-history.json', import.meta.url);
const htmlFixturePath = new URL('../fixtures/takeout/watch-history.html', import.meta.url);
const htmlSearchFixturePath = new URL('../fixtures/takeout/search-history.html', import.meta.url);
const temporaryDirectories: string[] = [];

async function createImporter(): Promise<TakeoutImporter> {
  const directory = await mkdtemp(join(tmpdir(), 'youtube-mcp-consumption-'));
  temporaryDirectories.push(directory);
  return new TakeoutImporter(new ConsumptionStore(join(directory, 'consumption.sqlite')));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('TakeoutImporter', () => {
  it('imports watch events without changing the source file', async () => {
    const importer = await createImporter();
    const before = await readFile(fixturePath, 'utf8');

    await expect(importer.import(fixturePath.pathname)).resolves.toEqual({ imported: 5, skipped: 0 });
    await expect(readFile(fixturePath, 'utf8')).resolves.toBe(before);
  });

  it('does not duplicate already imported history events', async () => {
    const importer = await createImporter();

    await importer.import(fixturePath.pathname);

    await expect(importer.import(fixturePath.pathname)).resolves.toEqual({ imported: 0, skipped: 5 });
  });

  it('deduplicates exports with the same normalized event despite irrelevant record fields', async () => {
    const importer = await createImporter();
    const directory = temporaryDirectories[0]!;
    const originalPath = join(directory, 'original.json');
    const reexportPath = join(directory, 'reexport.json');
    await writeFile(originalPath, JSON.stringify([{
      title: 'Watched  TypeScript   reliability ',
      titleUrl: 'https://www.youtube.com/watch?v=same-video',
      time: '2026-03-01T10:00:00.000Z',
      details: [{ name: 'ignored detail' }],
    }]), 'utf8');
    await writeFile(reexportPath, JSON.stringify([{
      time: '2026-03-01T10:00:00.000Z',
      titleUrl: 'https://www.youtube.com/watch?v=same-video',
      title: 'Watched TypeScript reliability',
      products: ['YouTube'],
      details: [{ name: 'a reordered, irrelevant export field' }],
    }]), 'utf8');

    await expect(importer.import(originalPath)).resolves.toEqual({ imported: 1, skipped: 0 });
    await expect(importer.import(reexportPath)).resolves.toEqual({ imported: 0, skipped: 1 });
  });

  it('imports a standard local Takeout HTML watch record', async () => {
    const importer = await createImporter();

    await expect(importer.import(htmlFixturePath.pathname)).resolves.toEqual({ imported: 1, skipped: 0 });
  });

  it('imports a standard local Takeout HTML search record', async () => {
    const importer = await createImporter();

    await expect(importer.import(htmlSearchFixturePath.pathname)).resolves.toEqual({ imported: 1, skipped: 0 });
  });

  it('rekeys legacy raw-hash watch rows before importing the same Takeout export', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'youtube-mcp-legacy-store-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'consumption.sqlite');
    const legacyRecord = {
      title: 'Watched Refactoring a TypeScript service',
      titleUrl: 'https://www.youtube.com/watch?v=video-jan-1',
      time: '2026-01-05T10:00:00.000Z',
      subtitles: [{ name: 'Code Channel', url: 'https://www.youtube.com/channel/c1' }],
      details: [{ name: 'From Google Search' }],
    };
    const legacyDatabase = openDatabase(databasePath);
    legacyDatabase.exec(`
      CREATE TABLE watch_events (
        source_key TEXT PRIMARY KEY,
        watched_at TEXT NOT NULL,
        video_id TEXT,
        channel_id TEXT,
        title TEXT NOT NULL,
        topic TEXT
      );
    `);
    legacyDatabase.prepare(`
      INSERT INTO watch_events (source_key, watched_at, video_id, channel_id, title, topic)
      VALUES (@sourceKey, @watchedAt, @videoId, @channelId, @title, @topic)
    `).run({
      sourceKey: createHash('sha256').update(JSON.stringify(legacyRecord)).digest('hex'),
      watchedAt: '2026-01-05T10:00:00.000Z',
      videoId: 'video-jan-1',
      channelId: 'c1',
      title: 'Refactoring a TypeScript service',
      topic: 'code quality',
    });
    legacyDatabase.close();

    await expect(new TakeoutImporter(new ConsumptionStore(databasePath)).import(fixturePath.pathname))
      .resolves.toEqual({ imported: 4, skipped: 1 });
  });

  it('rejects non-local or unsupported paths without exposing their contents', async () => {
    const importer = await createImporter();
    const directory = temporaryDirectories[0]!;
    const sourcePath = join(directory, 'history.txt');
    await writeFile(sourcePath, 'very private history content', 'utf8');

    await expect(importer.import('https://example.test/history.json')).rejects.toMatchObject({
      code: 'invalid_takeout_path',
      message: expect.not.stringContaining('https://example.test'),
    });
    await expect(importer.import(sourcePath)).rejects.toMatchObject({
      code: 'invalid_takeout_path',
      message: expect.not.stringContaining('very private history content'),
    });
  });

  it('rejects a Takeout file above the local size limit before parsing it', async () => {
    const importer = await createImporter();
    const sourcePath = join(temporaryDirectories[0]!, 'too-large.json');
    await writeFile(sourcePath, '[]', 'utf8');
    await truncate(sourcePath, MAX_TAKEOUT_BYTES + 1);

    await expect(importer.import(sourcePath)).rejects.toMatchObject({
      code: 'takeout_file_too_large',
      message: expect.not.stringContaining(sourcePath),
    });
  });

  it('returns a safe storage error when the local database cannot initialize', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'youtube-mcp-storage-error-'));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, 'history.json');
    const databaseParent = join(directory, 'not-a-directory');
    await writeFile(sourcePath, '[{"title":"Watched TypeScript","titleUrl":"https://www.youtube.com/watch?v=storage-test","time":"2026-03-01T10:00:00.000Z"}]', 'utf8');
    await writeFile(databaseParent, 'not a directory', 'utf8');
    const importer = new TakeoutImporter(new ConsumptionStore(join(databaseParent, 'consumption.sqlite')));

    const error = await importer.import(sourcePath).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'consumption_storage_failed' });
    expect(error).toMatchObject({
      message: expect.not.stringContaining(databaseParent),
      action: expect.not.stringContaining('Watched TypeScript'),
    });
  });

  it('rejects a nonempty export that has no recognized watch or search history', async () => {
    const importer = await createImporter();
    const sourcePath = join(temporaryDirectories[0]!, 'unrecognized.json');
    await writeFile(sourcePath, '[{"title":"Visited a non-history product","time":"2026-03-01T10:00:00.000Z"}]', 'utf8');

    await expect(importer.import(sourcePath)).rejects.toMatchObject({
      code: 'takeout_no_supported_history',
      action: expect.stringContaining('YouTube'),
    });
  });
});
