/**
 * In-memory feature flag service for demonstration.
 * In production, this would integrate with a remote config system.
 */
export class FeatureFlagService {
  private flags: Record<string, unknown> = {
    verified_reading_cv: { mode: 'never' },
  };

  get(flagName: string): unknown {
    return this.flags[flagName];
  }

  set(flagName: string, value: unknown): void {
    this.flags[flagName] = value;
  }
}