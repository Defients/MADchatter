/**
 * Shared rate-limiter + dedup base class used by Twitch, Kick, and Joystick send managers.
 * Provides ordered delivery, sliding-window attempt limits and success-only deduplication.
 */
import { throwIfSendCancelled, waitForSend, waitForSendDelay } from "./sendCancellation";

export class SendRateLimiter {
  protected sendTimestamps: number[] = [];
  protected recentMessages: Map<string, number> = new Map();
  protected maxPerWindow = 20;
  protected windowMs = 30_000;
  protected dedupMs = 60_000;
  private sendTail: Promise<void> = Promise.resolve();

  /** Serialize admission and delivery per account; a rejected send releases the queue. */
  protected sendWithRateLimit(message: string, deliver: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    const send = this.sendTail.then(async () => {
      throwIfSendCancelled(signal);
      // Recheck after acquiring the slot: another queued send may have just succeeded.
      if (this.isDuplicate(message)) {
        throw new Error("Duplicate message blocked — this exact message was sent within the last 60 seconds. Modify the message and try again.");
      }
      while (!this.canSendNow()) {
        await this.waitForCapacity(this.getWaitMs(), signal);
        throwIfSendCancelled(signal);
      }
      // Reserve capacity before awaiting transport. Failed attempts still consume
      // capacity, but only successful delivery enters the duplicate cache.
      throwIfSendCancelled(signal);
      this.sendTimestamps.push(Date.now());
      await deliver();
      this.recentMessages.set(message.trim().toLowerCase(), Date.now());
    });
    this.sendTail = send.catch(() => {});
    // The caller can leave promptly. Keep the ordered tail attached to real
    // delivery settlement: a non-abortable IRC write must not overlap a retry.
    return waitForSend(send, signal);
  }

  protected waitForCapacity(ms: number, signal?: AbortSignal): Promise<void> {
    return waitForSendDelay(ms, signal);
  }

  /** Returns true if this message is a duplicate within the dedup window */
  protected isDuplicate(message: string): boolean {
    const now = Date.now();
    const key = message.trim().toLowerCase();
    const lastSent = this.recentMessages.get(key);
    if (lastSent !== undefined && now - lastSent < this.dedupMs) return true;
    for (const [k, t] of this.recentMessages) {
      if (now - t >= this.dedupMs) this.recentMessages.delete(k);
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

  /** Get current rate limit status for UI display */
  getRateStatus(): { used: number; max: number; windowMs: number } {
    const now = Date.now();
    this.sendTimestamps = this.sendTimestamps.filter((t) => now - t < this.windowMs);
    return { used: this.sendTimestamps.length, max: this.maxPerWindow, windowMs: this.windowMs };
  }
}
