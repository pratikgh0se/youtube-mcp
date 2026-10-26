import type { ConsumptionDateRange, ConsumptionProfile, ConsumptionTrends } from './store.js';
import { ConsumptionStore } from './store.js';

export class ConsumptionInsights {
  constructor(private readonly store: ConsumptionStore) {}

  profile(range: ConsumptionDateRange): ConsumptionProfile {
    return this.store.profile(range);
  }

  trends(baseline: ConsumptionDateRange, comparison: ConsumptionDateRange): ConsumptionTrends {
    return this.store.trends(baseline, comparison);
  }
}
