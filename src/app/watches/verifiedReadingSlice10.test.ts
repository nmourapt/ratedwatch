import { describe, expect, it } from '@jest/globals';
import { VerifiedReadingSlice10 } from './VerifiedReadingSlice10';
import { FeatureFlagService } from './services/FeatureFlagService';

describe('VerifiedReadingSlice10', () => {
  it('should flip verified_reading_cv feature flag to always', async () => {
    const mockFeatureFlags = new FeatureFlagService();
    const slice = new VerifiedReadingSlice10(mockFeatureFlags);
    await slice.run();
    expect(mockFeatureFlags.get('verified_reading_cv').mode).toBe('always');
  });
});