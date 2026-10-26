import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CurationService, ProfileCurationService } from '../../src/consumption/curation.js';
import { CurationStore } from '../../src/consumption/curation-store.js';

let store: CurationStore;
let curation: CurationService;

beforeEach(() => {
  store = new CurationStore(':memory:');
  curation = new CurationService(store);
});

afterEach(() => {
  store.close();
});

describe('CurationService', () => {
  it('builds a 45-minute queue only from the consumer allowlist and labels it as a local self-report', () => {
    store.savePolicy({
      profileId: 'consumer',
      allowedSources: ['channel-approved'],
    });
    store.saveCandidate({
      profileId: 'consumer',
      videoId: 'approved-video',
      source: 'allowlist',
      sourceId: 'channel-approved',
      title: 'Approved video',
      estimatedMinutes: 30,
    });
    store.saveCandidate({
      profileId: 'consumer',
      videoId: 'unapproved-video',
      source: 'allowlist',
      sourceId: 'channel-unapproved',
      title: 'Unapproved video',
      estimatedMinutes: 10,
    });
    store.saveCandidate({
      profileId: 'creator',
      videoId: 'other-profile-video',
      source: 'allowlist',
      sourceId: 'channel-approved',
      title: 'Other profile video',
      estimatedMinutes: 10,
    });

    const queue = curation.propose({ profileId: 'consumer', minutes: 45 });

    expect(queue.profileId).toBe('consumer');
    expect(queue.source).toBe('local_self_report');
    expect(queue.items).toEqual([expect.objectContaining({
      videoId: 'approved-video',
      sourceApproved: true,
      estimatedMinutes: 30,
    })]);
  });

  it('keeps queue estimates within the requested time budget', () => {
    store.savePolicy({ profileId: 'consumer', allowedSources: ['channel-approved'] });
    store.saveCandidate({ profileId: 'consumer', videoId: 'first', source: 'allowlist', sourceId: 'channel-approved', title: 'First', estimatedMinutes: 30 });
    store.saveCandidate({ profileId: 'consumer', videoId: 'second', source: 'allowlist', sourceId: 'channel-approved', title: 'Second', estimatedMinutes: 20 });

    const queue = curation.propose({ profileId: 'consumer', minutes: 45 });

    expect(queue.items.map((item) => item.videoId)).toEqual(['first']);
    expect(queue.estimatedMinutes).toBe(30);
    expect(queue.estimatedMinutes).toBeLessThanOrEqual(45);
  });

  it('accepts approved playlist and search candidates in a finite queue', () => {
    store.savePolicy({ profileId: 'consumer', allowedSources: ['playlist-approved', 'search-approved'] });
    store.saveCandidate({ profileId: 'consumer', videoId: 'playlist-video', source: 'playlist', sourceId: 'playlist-approved', title: 'Playlist video', estimatedMinutes: 10 });
    store.saveCandidate({ profileId: 'consumer', videoId: 'search-video', source: 'search', sourceId: 'search-approved', title: 'Search video', estimatedMinutes: 15 });

    const queue = curation.propose({ profileId: 'consumer', minutes: 30 });

    expect(queue.items.map((item) => item.videoId)).toEqual(['playlist-video', 'search-video']);
    expect(queue.items.every((item) => item.sourceApproved)).toBe(true);
  });

  it('expires stale API-derived candidates according to the profile retention policy', () => {
    store.close();
    store = new CurationStore(':memory:', () => new Date('2026-08-18T00:00:00.000Z'));
    curation = new CurationService(store);
    store.savePolicy({ profileId: 'consumer', allowedSources: ['channel-approved'], retentionDays: 7 });
    store.saveCandidate({
      profileId: 'consumer', videoId: 'stale-video', source: 'allowlist', sourceId: 'channel-approved',
      title: 'Stale API result', estimatedMinutes: 20, apiFetchedAt: '2026-08-01T00:00:00.000Z',
    });

    expect(curation.propose({ profileId: 'consumer', minutes: 30 }).items).toEqual([]);
    expect(store.candidates('consumer')).toEqual([]);
  });

  it('injects the selected profile and resets only its local curation data after confirmation', async () => {
    store.savePolicy({ profileId: 'consumer', allowedSources: ['consumer-channel'] });
    store.saveCandidate({ profileId: 'consumer', videoId: 'consumer-video', source: 'allowlist', sourceId: 'consumer-channel', title: 'Consumer' });
    store.savePolicy({ profileId: 'research', allowedSources: ['research-channel'] });
    store.saveCandidate({ profileId: 'research', videoId: 'research-video', source: 'allowlist', sourceId: 'research-channel', title: 'Research' });
    const scoped = new ProfileCurationService(curation, store, 'consumer');

    expect(scoped.savePolicy({ allowedSources: ['new-channel'], retentionDays: 14 })).toMatchObject({ profileId: 'consumer' });
    await expect(scoped.reset({ confirm: false })).rejects.toMatchObject({ code: 'confirmation_required' });
    await expect(scoped.reset({ confirm: true })).resolves.toMatchObject({ profileId: 'consumer', deleted: { policies: 1, candidates: 1 } });
    expect(store.policy('consumer')).toBeUndefined();
    expect(store.candidates('consumer')).toEqual([]);
    expect(store.policy('research')).toMatchObject({ profileId: 'research' });
    expect(store.candidates('research')).toHaveLength(1);
  });
});
