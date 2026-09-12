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
  // Per-action-type tracking (C5)
  private perActionTimestamps: Record<string, number[]> = {};
  private perActionConfig: Record<string, { maxPerHour: number; maxPerTenMinutes: number; cooldownMs: number }> = {};

  constructor(config: ActionRateLimitConfig = DEFAULT_RATE_LIMIT) {
    this.config = config;
  }

  updateConfig(config: Partial<ActionRateLimitConfig>): void {
    this.config = { ...this.config, ...config };
  }

  updatePerActionConfig(config: Record<string, { maxPerHour: number; maxPerTenMinutes: number; cooldownMs: number }>): void {
    this.perActionConfig = config;
  }

  canAct(actionType?: string): boolean {
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

    // Per-action-type check (C5)
    if (actionType && this.perActionConfig[actionType]) {
      const limits = this.perActionConfig[actionType];
      const timestamps = (this.perActionTimestamps[actionType] || []).filter(
        (t) => now - t < 3_600_000,
      );
      this.perActionTimestamps[actionType] = timestamps;

      const perHour = timestamps.length;
      const perTenMin = timestamps.filter((t) => now - t < 600_000).length;

      if (perHour >= limits.maxPerHour) return false;
      if (perTenMin >= limits.maxPerTenMinutes) return false;

      if (timestamps.length > 0) {
        const last = timestamps[timestamps.length - 1];
        if (now - last < limits.cooldownMs) return false;
      }
    }

    return true;
  }

  recordAction(actionType?: string): void {
    const now = Date.now();
    // Prune entries older than 1 hour to keep arrays bounded
    this.actionTimestamps = this.actionTimestamps.filter((t) => now - t < 3_600_000);
    this.actionTimestamps.push(now);
    if (actionType) {
      if (!this.perActionTimestamps[actionType]) this.perActionTimestamps[actionType] = [];
      else this.perActionTimestamps[actionType] = this.perActionTimestamps[actionType].filter((t) => now - t < 3_600_000);
      this.perActionTimestamps[actionType].push(now);
    }
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

  getPerActionStats(actionType: string): { actionsLastHour: number; actionsLastTenMin: number; maxPerHour: number; maxPerTenMin: number; msUntilNextAllowed: number } | null {
    const limits = this.perActionConfig[actionType];
    if (!limits) return null;
    const now = Date.now();
    const timestamps = (this.perActionTimestamps[actionType] || []).filter((t) => now - t < 3_600_000);
    this.perActionTimestamps[actionType] = timestamps;
    const lastHour = timestamps.length;
    const lastTenMin = timestamps.filter((t) => now - t < 600_000).length;
    let msUntilNext = 0;
    if (timestamps.length > 0) {
      const last = timestamps[timestamps.length - 1];
      const cooldownRemaining = limits.cooldownMs - (now - last);
      if (cooldownRemaining > 0) msUntilNext = cooldownRemaining;
    }
    return { actionsLastHour: lastHour, actionsLastTenMin: lastTenMin, maxPerHour: limits.maxPerHour, maxPerTenMin: limits.maxPerTenMinutes, msUntilNextAllowed: msUntilNext };
  }

  reset(): void {
    this.actionTimestamps = [];
    this.perActionTimestamps = {};
  }
}

export const actionRateLimiter = new ActionRateLimiter();

// ─── Per-bot rate limiters (multi-bot mode) ─────────────────────────────────
// In multi-bot mode, each bot needs its own rate-limit tracking so bot A's
// sends don't count against bot B's quota. The global singleton remains
// available for legacy single-bot mode. Both share the same config (synced
// from the store on every check), so the user-configured limits apply
// uniformly — only the timestamp tracking is per-bot.
const botRateLimiters = new Map<string, ActionRateLimiter>();

export function getBotRateLimiter(botId: string): ActionRateLimiter {
  let limiter = botRateLimiters.get(botId);
  if (!limiter) {
    limiter = new ActionRateLimiter();
    botRateLimiters.set(botId, limiter);
  }
  return limiter;
}

// Sync config from the store to every active per-bot limiter. Called once
// per check cycle by useAutoForgeBot (mirrors the legacy loop's config sync).
export function syncBotRateLimiterConfig(
  botId: string,
  config: ActionRateLimitConfig,
  perActionConfig: Record<string, { maxPerHour: number; maxPerTenMinutes: number; cooldownMs: number }>,
): void {
  const limiter = getBotRateLimiter(botId);
  limiter.updateConfig(config);
  limiter.updatePerActionConfig(perActionConfig);
}

// Clean up per-bot limiters when a bot is removed. Prevents unbounded
// growth of the Map over long sessions with bot churn.
export function removeBotRateLimiter(botId: string): void {
  botRateLimiters.delete(botId);
}
