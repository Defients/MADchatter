/**
 * Shared rate-limiter + dedup base class used by Twitch, Kick, and Joystick send managers.
 * Provides sliding-window token bucket rate limiting and message deduplication.
 */
export class SendRateLimiter {
  protected sendTimestamps: number[] = [];
  protected recentMessages: Map<string, number> = new Map();
  protected maxPerWindow = 20;
  protected windowMs = 30_000;
  protected dedupMs = 60_000;

  /** Returns true if this message is a duplicate within the dedup window */
  protected isDuplicate(message: string): boolean {
    const now = Date.now();
    const key = message.trim().toLowerCase();
    const lastSent = this.recentMessages.get(key);
    if (lastSent && now - lastSent < this.dedupMs) return true;
    for (const [k, t] of this.recentMessages) {
      if (now - t > this.dedupMs) this.recentMessages.delete(k);
    }
    return false;
  }

  /** Returns true if we're within rate limits */
  protected canSendNow(): boolean {
    const now = Date.now();
    this.sendTimestamps = this.sendTimestamps.filter((t) => now - t < this.windowMs);
    return this.sendTimestamps.length < this.maxPerWindow;
  }

  /** Get ms to wait before next send is allowed */
  protected getWaitMs(): number {
    if (this.sendTimestamps.length === 0) return 0;
    const oldest = this.sendTimestamps[0];
    const now = Date.now();
    return Math.max(0, this.windowMs - (now - oldest) + 50);
  }

  /** Record a successful send for rate-limiting and dedup tracking */
  protected recordSend(message: string): void {
    this.sendTimestamps.push(Date.now());
    this.recentMessages.set(message.trim().toLowerCase(), Date.now());
  }

  /** Get current rate limit status for UI display */
  getRateStatus(): { used: number; max: number; windowMs: number } {
    const now = Date.now();
    this.sendTimestamps = this.sendTimestamps.filter((t) => now - t < this.windowMs);
    return { used: this.sendTimestamps.length, max: this.maxPerWindow, windowMs: this.windowMs };
  }
}
