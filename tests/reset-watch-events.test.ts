import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

// Behaviour tests for youtube_reset_consumption_data watch-event deletion,
// driven through the MCP surface over stdio against the built server. Offline.

type Json = Record<string, any>;

const cleanups: Array<() => Promise<void>> = [];

interface Harness {
  call(name: string, args?: Json): Promise<{ isError: boolean; body: Json }>;
  dir: string;
}

async function startHarness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'youtube-mcp-reset-events-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js', '--transport', 'stdio'],
    env: {
      PATH: process.env.PATH ?? '',
      YOUTUBE_API_KEY: 'placeholder-not-a-real-key',
      YOUTUBE_MCP_PROFILE_ID: 'reset-test-profile',
      YOUTUBE_MCP_STATE_DIR: dir,
    },
  });
  const client = new Client({ name: 'reset-watch-events-test', version: '1.0.0' });
  cleanups.push(async () => {
    await client.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });
  await client.connect(transport);
  return {
    dir,
    async call(name, args = {}) {
      const result = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        structuredContent?: Json;
        content?: Array<{ type: string; text?: string }>;
      };
      let body: Json | undefined = result.structuredContent;
      if (!body) {
        const text = result.content?.find((part) => part.type === 'text')?.text ?? '';
        try {
          body = JSON.parse(text) as Json;
        } catch {
          body = { message: text };
        }
      }
      return { isError: result.isError === true, body };
    },
  };
}

const iso = (day: string, time = '12:00:00') => `${day}T${time}.000Z`;

async function writeTakeout(dir: string, times: string[]): Promise<string> {
  const records = times.map((time, index) => ({
    title: `Watched Video number ${index}`,
    titleUrl: `https://www.youtube.com/watch?v=vid-${index}`,
    time,
    subtitles: [{ name: 'Some Channel', url: 'https://www.youtube.com/channel/c1' }],
    details: [{ name: 'From Google Search' }],
  }));
  const path = join(dir, 'takeout.json');
  await writeFile(path, JSON.stringify(records), 'utf8');
  return path;
}

async function importTimes(h: Harness, times: string[]): Promise<string> {
  const path = await writeTakeout(h.dir, times);
  const result = await h.call('youtube_import_takeout', { inputPath: path });
  expect(result.isError).toBe(false);
  expect(result.body.imported).toBe(times.length);
  return path;
}

async function watchCount(h: Harness, startDate = '2000-01-01', endDate = '2099-12-31'): Promise<number> {
  const result = await h.call('youtube_consumption_profile', { startDate, endDate });
  expect(result.isError).toBe(false);
  return result.body.totalWatchCount as number;
}

async function seedCuration(h: Harness): Promise<void> {
  expect((await h.call('youtube_save_curation_policy', { allowedSources: ['UCsource1'] })).isError).toBe(false);
  expect(
    (await h.call('youtube_save_curation_candidate', {
      videoId: 'dQw4w9WgXcQ',
      source: 'allowlist',
      sourceId: 'UCsource1',
      title: 'A candidate',
    })).isError,
  ).toBe(false);
}

const RANGE_TIMES = [
  iso('2025-03-09', '23:59:59'), // one second before range
  iso('2025-03-10', '00:00:00'), // first moment of watchedFrom
  iso('2025-03-11', '12:00:00'),
  iso('2025-03-12', '23:59:59'), // last moment of watchedTo
  iso('2025-03-13', '00:00:00'), // one second after range
];

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { stdio: 'ignore' });
}, 120_000);

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

describe('youtube_reset_consumption_data watch events', () => {
  it('1: without new params and confirm:true, deletes curation data only and keeps watch events', async () => {
    const h = await startHarness();
    await importTimes(h, RANGE_TIMES);
    await seedCuration(h);

    const result = await h.call('youtube_reset_consumption_data', { confirm: true });

    expect(result.isError).toBe(false);
    expect(result.body.deleted).not.toHaveProperty('watchEvents');
    expect(result.body.deleted.policies).toBe(1);
    expect(result.body.deleted.candidates).toBe(1);
    expect(await watchCount(h)).toBe(5);
  });

  it('2: without confirm returns confirmation_required and deletes nothing', async () => {
    const h = await startHarness();
    await importTimes(h, RANGE_TIMES);
    await seedCuration(h);

    for (const args of [{}, { includeWatchEvents: true }, { includeWatchEvents: true, confirm: false }]) {
      const result = await h.call('youtube_reset_consumption_data', args);
      expect(result.isError).toBe(true);
      expect(result.body.code).toBe('confirmation_required');
    }
    expect(await watchCount(h)).toBe(5);
    const reset = await h.call('youtube_reset_consumption_data', { confirm: true });
    expect(reset.body.deleted.policies).toBe(1);
    expect(reset.body.deleted.candidates).toBe(1);
  });

  it('3: confirmation message for watch events warns about permanent deletion, scope, and all profiles', async () => {
    const h = await startHarness();

    const all = await h.call('youtube_reset_consumption_data', { includeWatchEvents: true });
    expect(all.body.code).toBe('confirmation_required');
    expect(all.body.message).toMatch(/permanently deleted/i);
    expect(all.body.message).toContain('all watch history');
    expect(all.body.message).toMatch(/every profile/i);

    const ranged = await h.call('youtube_reset_consumption_data', {
      includeWatchEvents: true,
      watchedFrom: '2025-03-10',
      watchedTo: '2025-03-12',
    });
    expect(ranged.body.code).toBe('confirmation_required');
    expect(ranged.body.message).toMatch(/permanently deleted/i);
    expect(ranged.body.message).toContain('2025-03-10');
    expect(ranged.body.message).toContain('2025-03-12');
    expect(ranged.body.message).toMatch(/every profile/i);
  });

  it('4: confirmation message without new params does not mention watch event deletion', async () => {
    const h = await startHarness();

    const result = await h.call('youtube_reset_consumption_data', {});

    expect(result.body.code).toBe('confirmation_required');
    expect(result.body.message).not.toMatch(/watch events?/i);
    expect(result.body.message).not.toMatch(/permanently/i);
    expect(result.body.message).not.toContain('watch history');
  });

  it('5: includeWatchEvents with no dates deletes every event and reports the exact count', async () => {
    const h = await startHarness();
    await importTimes(h, RANGE_TIMES);

    const result = await h.call('youtube_reset_consumption_data', { includeWatchEvents: true, confirm: true });

    expect(result.isError).toBe(false);
    expect(result.body.deleted.watchEvents).toBe(5);
    expect(await watchCount(h)).toBe(0);
  });

  it('6: date range is inclusive on both UTC days, with exact count and neighbours kept', async () => {
    const h = await startHarness();
    await importTimes(h, RANGE_TIMES);

    const result = await h.call('youtube_reset_consumption_data', {
      includeWatchEvents: true,
      watchedFrom: '2025-03-10',
      watchedTo: '2025-03-12',
      confirm: true,
    });

    expect(result.isError).toBe(false);
    expect(result.body.deleted.watchEvents).toBe(3);
    expect(await watchCount(h)).toBe(2);
    expect(await watchCount(h, '2025-03-09', '2025-03-09')).toBe(1);
    expect(await watchCount(h, '2025-03-13', '2025-03-13')).toBe(1);
    expect(await watchCount(h, '2025-03-10', '2025-03-12')).toBe(0);
  });

  it('7: watchedFrom alone deletes that day onward; watchedTo alone deletes up to and including that day', async () => {
    const fromHarness = await startHarness();
    await importTimes(fromHarness, RANGE_TIMES);
    const from = await fromHarness.call('youtube_reset_consumption_data', {
      includeWatchEvents: true,
      watchedFrom: '2025-03-11',
      confirm: true,
    });
    expect(from.body.deleted.watchEvents).toBe(3);
    expect(await watchCount(fromHarness)).toBe(2);
    expect(await watchCount(fromHarness, '2025-03-09', '2025-03-10')).toBe(2);

    const toHarness = await startHarness();
    await importTimes(toHarness, RANGE_TIMES);
    const to = await toHarness.call('youtube_reset_consumption_data', {
      includeWatchEvents: true,
      watchedTo: '2025-03-11',
      confirm: true,
    });
    expect(to.body.deleted.watchEvents).toBe(3);
    expect(await watchCount(toHarness)).toBe(2);
    expect(await watchCount(toHarness, '2025-03-12', '2025-03-13')).toBe(2);
  });

  describe('8: invalid options are rejected and nothing is deleted', () => {
    const cases: Array<{ name: string; args: Json; code: string }> = [
      { name: 'watchedFrom without includeWatchEvents', args: { watchedFrom: '2025-03-10' }, code: 'invalid_reset_options' },
      { name: 'watchedTo without includeWatchEvents', args: { watchedTo: '2025-03-10' }, code: 'invalid_reset_options' },
      {
        name: 'dates with includeWatchEvents false',
        args: { includeWatchEvents: false, watchedFrom: '2025-03-10' },
        code: 'invalid_reset_options',
      },
      { name: 'malformed date', args: { includeWatchEvents: true, watchedFrom: 'March 10' }, code: 'invalid_date_range' },
      { name: 'malformed watchedTo', args: { includeWatchEvents: true, watchedTo: '2025-3-1' }, code: 'invalid_date_range' },
      { name: 'impossible date', args: { includeWatchEvents: true, watchedFrom: '2025-02-30' }, code: 'invalid_date_range' },
      {
        name: 'from later than to',
        args: { includeWatchEvents: true, watchedFrom: '2025-03-12', watchedTo: '2025-03-10' },
        code: 'invalid_date_range',
      },
    ];

    for (const testCase of cases) {
      for (const withConfirm of [true, false]) {
        it(`${testCase.name} (${withConfirm ? 'confirm: true' : 'no confirm'})`, async () => {
          const h = await startHarness();
          await importTimes(h, RANGE_TIMES);
          await seedCuration(h);

          const args = withConfirm ? { ...testCase.args, confirm: true } : testCase.args;
          const result = await h.call('youtube_reset_consumption_data', args);

          expect(result.isError).toBe(true);
          expect(result.body.code).toBe(testCase.code);
          expect(await watchCount(h)).toBe(5);
          const reset = await h.call('youtube_reset_consumption_data', { confirm: true });
          expect(reset.body.deleted.policies).toBe(1);
          expect(reset.body.deleted.candidates).toBe(1);
        });
      }
    }
  });

  it('9: deleting when nothing was ever imported succeeds with zero watch events', async () => {
    const h = await startHarness();

    const result = await h.call('youtube_reset_consumption_data', { includeWatchEvents: true, confirm: true });

    expect(result.isError).toBe(false);
    expect(result.body.deleted.watchEvents).toBe(0);
  });

  it('10: curation data is deleted together with the watch events', async () => {
    const h = await startHarness();
    await importTimes(h, RANGE_TIMES);
    await seedCuration(h);

    const result = await h.call('youtube_reset_consumption_data', { includeWatchEvents: true, confirm: true });

    expect(result.isError).toBe(false);
    expect(result.body.deleted.watchEvents).toBe(5);
    expect(result.body.deleted.policies).toBe(1);
    expect(result.body.deleted.candidates).toBe(1);
    const again = await h.call('youtube_reset_consumption_data', { confirm: true });
    expect(again.body.deleted.policies).toBe(0);
    expect(again.body.deleted.candidates).toBe(0);
  });

  it('11: re-importing the same Takeout file restores the deleted events', async () => {
    const h = await startHarness();
    const path = await importTimes(h, RANGE_TIMES);
    await h.call('youtube_reset_consumption_data', { includeWatchEvents: true, confirm: true });
    expect(await watchCount(h)).toBe(0);

    const reimport = await h.call('youtube_import_takeout', { inputPath: path });

    expect(reimport.isError).toBe(false);
    expect(reimport.body.imported).toBe(5);
    expect(await watchCount(h)).toBe(5);
  });

  it('12: after deleting all events, auth status reports no imported history', async () => {
    const h = await startHarness();
    await importTimes(h, RANGE_TIMES);
    const before = await h.call('youtube_auth_status');
    expect(before.body.localConsumption.hasImportedHistory).toBe(true);

    await h.call('youtube_reset_consumption_data', { includeWatchEvents: true, confirm: true });

    const after = await h.call('youtube_auth_status');
    expect(after.body.localConsumption.hasImportedHistory).toBe(false);
  });
});
