import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TakeoutImporter } from '../../src/consumption/importer.js';
import { ConsumptionInsights } from '../../src/consumption/insights.js';
import { ConsumptionStore } from '../../src/consumption/store.js';

const fixturePath = new URL('../fixtures/takeout/watch-history.json', import.meta.url);
const january = { startDate: '2026-01-01', endDate: '2026-01-31' };
const february = { startDate: '2026-02-01', endDate: '2026-02-28' };

let temporaryDirectory = '';
let insights: ConsumptionInsights;
let store: ConsumptionStore;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'youtube-mcp-insights-'));
  store = new ConsumptionStore(join(temporaryDirectory, 'consumption.sqlite'));
  await new TakeoutImporter(store).import(fixturePath.pathname);
  insights = new ConsumptionInsights(store);
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('ConsumptionInsights', () => {
  it('reports whether local Takeout history has been imported without returning any history records', () => {
    expect(new ConsumptionStore(':memory:').hasImportedHistory()).toBe(false);
    expect(store.hasImportedHistory()).toBe(true);
  });

  it('groups a bounded date range by channel, derived topic, and content type', () => {
    expect(insights.profile(january)).toMatchObject({
      totalWatchCount: 2,
      totalActivityCount: 2,
      searchCount: 0,
      topChannels: [{ channelId: 'c1', watchCount: 2 }],
      topTopics: [{ topic: 'software engineering', activityCount: 2 }],
      contentTypes: [{ eventType: 'watch', eventCount: 2 }],
    });
  });

  it('uses imported search history in topic trends and content-type counts', () => {
    expect(insights.profile(february)).toMatchObject({
      totalWatchCount: 1,
      totalActivityCount: 3,
      searchCount: 2,
      contentTypes: [
        { eventType: 'search', eventCount: 2 },
        { eventType: 'watch', eventCount: 1 },
      ],
      byHour: [
        { hour: 8, activityCount: 2 },
        { hour: 9, activityCount: 1 },
      ],
    });
    expect(insights.trends(january, february)).toMatchObject({
      increasedTopics: ['software engineering'],
    });
  });

  it('includes events on the requested end date without leaking the next day', () => {
    expect(insights.profile({ startDate: '2026-02-03', endDate: '2026-02-03' })).toMatchObject({
      totalWatchCount: 1,
      totalActivityCount: 2,
      searchCount: 1,
      topChannels: [{ channelId: 'c2', watchCount: 1 }],
    });
    expect(insights.profile({ startDate: '2026-02-04', endDate: '2026-02-04' })).toMatchObject({
      totalWatchCount: 0,
    });
  });
});
