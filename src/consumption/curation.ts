import { AppError } from '../errors.js';
import type { ConsumptionQueue, ConsumptionQueueItem, CurationCandidate, CurationPolicy, CurationResetResult } from './curation-store.js';
import { CurationStore } from './curation-store.js';

export type QueueProposal = {
  profileId: string;
  minutes: number;
};

export class CurationService {
  constructor(private readonly store: CurationStore) {}

  propose(input: QueueProposal): ConsumptionQueue {
    const policy = this.store.policy(input.profileId);
    if (!policy) {
      throw new AppError('curation_policy_not_found', 'No local curation policy exists for this profile.', 'Save a policy before proposing a queue.', false);
    }
    if (!Number.isFinite(input.minutes) || input.minutes <= 0) {
      throw new AppError('invalid_curation_budget', 'The queue time budget must be greater than zero.', 'Provide a positive number of minutes.', false);
    }

    const items = selectItems(this.store.candidates(input.profileId), policy, input.minutes);
    return this.store.createQueue({
      profileId: input.profileId,
      source: 'local_self_report',
      estimatedMinutes: items.reduce((total, item) => total + (item.estimatedMinutes ?? 0), 0),
      items,
    });
  }

}

/** Injects the selected local connection profile so MCP callers cannot cross profile boundaries. */
export class ProfileCurationService {
  constructor(
    private readonly curation: CurationService,
    private readonly store: CurationStore,
    private readonly profileId: string,
  ) {}

  savePolicy(input: Omit<CurationPolicy, 'profileId'>): CurationPolicy {
    const profileId = this.selectedProfileId();
    this.store.savePolicy({ ...input, profileId });
    return this.store.policy(profileId)!;
  }

  saveCandidate(input: Omit<CurationCandidate, 'profileId'>): CurationCandidate {
    const candidate = { ...input, profileId: this.selectedProfileId() };
    this.store.saveCandidate(candidate);
    return this.store.candidates(candidate.profileId).find((stored) => stored.videoId === candidate.videoId)!;
  }

  propose(input: Omit<QueueProposal, 'profileId'>): ConsumptionQueue {
    return this.curation.propose({ ...input, profileId: this.selectedProfileId() });
  }

  async reset(input: { confirm?: boolean }): Promise<CurationResetResult> {
    if (input.confirm !== true) {
      throw new AppError('confirmation_required', 'Resetting curation data deletes local policy and queues.', 'Repeat with confirm: true.', false);
    }
    return this.store.reset(this.selectedProfileId());
  }

  private selectedProfileId(): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(this.profileId)) {
      throw new AppError('invalid_profile', 'A selected local profile is required.', 'Set YOUTUBE_MCP_PROFILE_ID before using curation tools.', false);
    }
    return this.profileId;
  }
}

function selectItems(candidates: CurationCandidate[], policy: CurationPolicy, minutes: number): ConsumptionQueueItem[] {
  let remaining = minutes;
  const items: ConsumptionQueueItem[] = [];
  for (const candidate of candidates) {
    const sourceApproved = policy.allowedSources.includes(candidate.sourceId);
    const estimatedMinutes = candidate.estimatedMinutes;
    if (!sourceApproved || estimatedMinutes === undefined || estimatedMinutes <= 0 || estimatedMinutes > remaining) continue;
    items.push({
      videoId: candidate.videoId,
      reason: candidate.reason ?? `Approved ${candidate.source} source: ${candidate.sourceId}`,
      estimatedMinutes,
      source: candidate.source,
      sourceApproved,
      apiFetchedAt: candidate.apiFetchedAt,
    });
    remaining -= estimatedMinutes;
  }
  return items;
}
