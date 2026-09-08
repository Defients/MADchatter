export interface ActionRateLimitConfig {
  maxActionsPerHour: number;
  maxActionsPerTenMinutes: number;
  minCooldownMs: number;
}

export const DEFAULT_RATE_LIMIT: ActionRateLimitConfig = {
  maxActionsPerHour: 30,
  maxActionsPerTenMinutes: 8,
  minCooldownMs: 15_000,
};

export class ActionRateLimiter {
  private actionTimestamps: number[] = [];
  private config: ActionRateLimitConfig;

  constructor(config: ActionRateLimitConfig = DEFAULT_RATE_LIMIT) {
    this.config = config;
  }

  updateConfig(config: Partial<ActionRateLimitConfig>): void {
    this.config = { ...this.config, ...config };
  }

  canAct(): boolean {
    const now = Date.now();
    this.actionTimestamps = this.actionTimestamps.filter(
      (t) => now - t < 3_600_000,
    );

    const lastHour = this.actionTimestamps.length;
    const lastTenMin = this.actionTimestamps.filter(
      (t) => now - t < 600_000,
    ).length;

    if (lastHour >= this.config.maxActionsPerHour) return false;
    if (lastTenMin >= this.config.maxActionsPerTenMinutes) return false;

    if (this.actionTimestamps.length > 0) {
      const lastAction = this.actionTimestamps[this.actionTimestamps.length - 1];
      if (now - lastAction < this.config.minCooldownMs) return false;
    }

    return true;
  }

  recordAction(): void {
    this.actionTimestamps.push(Date.now());
  }

  getStats(): {
    actionsLastHour: number;
    actionsLastTenMin: number;
    maxPerHour: number;
    maxPerTenMin: number;
    msUntilNextAllowed: number;
  } {
    const now = Date.now();
    const lastHour = this.actionTimestamps.filter(
      (t) => now - t < 3_600_000,
    ).length;
    const lastTenMin = this.actionTimestamps.filter(
      (t) => now - t < 600_000,
    ).length;

    let msUntilNext = 0;
    if (this.actionTimestamps.length > 0) {
      const last = this.actionTimestamps[this.actionTimestamps.length - 1];
      const cooldownRemaining = this.config.minCooldownMs - (now - last);
      if (cooldownRemaining > 0) msUntilNext = cooldownRemaining;
    }

    return {
      actionsLastHour: lastHour,
      actionsLastTenMin: lastTenMin,
      maxPerHour: this.config.maxActionsPerHour,
      maxPerTenMin: this.config.maxActionsPerTenMinutes,
      msUntilNextAllowed: msUntilNext,
    };
  }

  reset(): void {
    this.actionTimestamps = [];
  }
}

export const actionRateLimiter = new ActionRateLimiter();
