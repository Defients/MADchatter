/**
 * BotCoordinator — multi-bot speaker floor (active only when multiBotEnabled).
 *
 * Problem: each bot runs an independent AutoForge decision loop. If two bots
 * decide to speak at nearly the same time, they'd talk over each other.
 *
 * Solution: a time-based floor + short bidding window, resolved by the
 * SemanticCoordination layer (v1.1).
 *   - After any bot sends, a `floorGapMs` cooldown blocks new sends (prevents
 *     rapid-fire overlap).
 *   - When a bot requests the floor and the cooldown has elapsed, a short
 *     `bidWindowMs` window opens to collect competing candidates. When the
 *     window closes, the semantic engine classifies the shared opportunity
 *     (mention / question / hype / social opening), scores every bid with
 *     normalized components (confidence, persona-function fit, mention
 *     priority, continuity) minus ensemble modifiers (redundancy, dogpile,
 *     saturation, interruption, loop suppression), and resolves exactly one
 *     winner — or deliberate collective silence. Directly addressed bots own
 *     their opportunity; others defer. See semanticCoordination.ts.
 *
 * Channel safety: the coordinator is channel-scoped. `setChannel` wipes the
 * floor + the semantic ledger on every channel change, so no Channel-A bid or
 * ledger entry can influence a Channel-B window. The bot loops' own session
 * guards remain authoritative for the actual sends.
 *
 * Manual `force` sends bypass the coordinator (the forced bot always speaks,
 * subject only to its own per-account rate limit).
 */

import {
  semanticCoordination,
  type SemanticCandidate,
} from "./semanticCoordination";

export interface BotCandidate extends SemanticCandidate {}

interface PendingRequest {
  botId: string;
  candidate: BotCandidate;
  enqueuedAt: number;
  resolve: (granted: boolean) => void;
}

type SpeakerChosenListener = (info: { botId: string; candidate: BotCandidate } | null) => void;

export const DEFAULT_FLOOR_GAP_MS = 15_000; // min gap between any two bot sends
const DEFAULT_BID_WINDOW_MS = 2_500; // how long to collect competing candidates

class BotCoordinator {
  private lastSpeakMs = 0;
  private lastSpeakerBotId: string | null = null;
  private floorGapMs = DEFAULT_FLOOR_GAP_MS;
  private bidWindowMs = DEFAULT_BID_WINDOW_MS;
  private pending: PendingRequest[] = [];
  private windowTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<SpeakerChosenListener>();
  private channel: string | null = null;
  private superchargeActive = false;
  private eventFloorOwner: string | null = null;
  private autonomousResumeAt = 0;
  private blockedAutonomousMessages = 0;
  private droppedStaleMessages = 0;

  configure(opts: { floorGapMs?: number; bidWindowMs?: number }) {
    if (opts.floorGapMs !== undefined) this.floorGapMs = opts.floorGapMs;
    if (opts.bidWindowMs !== undefined) this.bidWindowMs = opts.bidWindowMs;
  }

  /**
   * Channel scoping. Any change re-binds the semantic ledger and wipes the
   * floor — pending Channel-A bids are stood down, not resolved into the new
   * channel.
   */
  setChannel(channel: string | null) {
    const normalized = channel ? channel.trim().toLowerCase() : null;
    if (normalized === this.channel) return;
    this.channel = normalized;
    this.reset();
    semanticCoordination.reset(normalized);
  }

  setSupercharge(active: boolean) {
    this.superchargeActive = active;
  }

  /** Reset floor state (e.g. when multi-bot mode is disabled). */
  reset() {
    if (this.windowTimer) {
      clearTimeout(this.windowTimer);
      this.windowTimer = null;
    }
    this.pending.forEach((p) => p.resolve(false));
    this.pending = [];
    this.lastSpeakMs = 0;
    this.lastSpeakerBotId = null;
  }

  /**
   * Temporarily lease the speaking floor to a choreographed app event.
   * Ordinary AutoForge bids stand down until the same owner releases it.
   * Re-acquiring by the current owner is idempotent; a different owner can
   * never steal a live lease.
   */
  acquireEventFloor(owner: string): boolean {
    const normalized = owner.trim();
    if (!normalized) return false;
    if (this.eventFloorOwner && this.eventFloorOwner !== normalized) return false;
    this.reset();
    this.eventFloorOwner = normalized;
    return true;
  }

  releaseEventFloor(owner: string, cooldownMs = 30_000): boolean {
    if (this.eventFloorOwner !== owner) return false;
    this.eventFloorOwner = null;
    this.autonomousResumeAt = Date.now() + Math.max(0, cooldownMs);
    this.reset();
    return true;
  }

  isAutonomousSpeechSuppressed(now = Date.now()): boolean {
    return this.eventFloorOwner !== null || now < this.autonomousResumeAt;
  }

  noteBlockedAutonomous(staleAfterScene = false): void {
    this.blockedAutonomousMessages += 1;
    if (staleAfterScene) this.droppedStaleMessages += 1;
  }

  getEventFloorDebug() {
    return {
      owner: this.eventFloorOwner,
      autonomousResumeAt: this.autonomousResumeAt,
      blockedNormalMessages: this.blockedAutonomousMessages,
      droppedStaleMessages: this.droppedStaleMessages,
    };
  }

  getEventFloorOwner(): string | null {
    return this.eventFloorOwner;
  }

  isEventFloorOwner(owner: string): boolean {
    return this.eventFloorOwner === owner;
  }

  onSpeakerChosen(listener: SpeakerChosenListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Request the floor for a bot. Resolves true if this bot won the floor and
   * should send now; false if it should stand down (cooldown active, lost the
   * semantic bid, or the ensemble chose collective silence).
   */
  requestFloor(botId: string, candidate: BotCandidate): Promise<boolean> {
    if (this.isAutonomousSpeechSuppressed()) {
      this.noteBlockedAutonomous(this.eventFloorOwner === null);
      return Promise.resolve(false);
    }
    const now = Date.now();

    // Cooldown not elapsed → stand down this cycle.
    if (now - this.lastSpeakMs < this.floorGapMs) {
      return Promise.resolve(false);
    }

    // Open / join a bidding window.
    return new Promise<boolean>((resolve) => {
      this.pending.push({ botId, candidate, enqueuedAt: now, resolve });
      if (this.windowTimer === null) {
        this.windowTimer = setTimeout(() => this.resolveWindow(), this.bidWindowMs);
      }
    });
  }

  private resolveWindow() {
    this.windowTimer = null;
    const requests = this.pending;
    this.pending = [];
    if (requests.length === 0) return;

    const now = Date.now();
    const result = semanticCoordination.resolveWindow(
      requests.map((r) => ({ botId: r.botId, candidate: r.candidate, enqueuedAt: r.enqueuedAt })),
      { now, channel: this.channel, supercharge: this.superchargeActive },
    );

    // Only an actual winner advances the floor clock — collective silence
    // must not block the next (potentially worthwhile) opportunity.
    if (result.winnerBotId) {
      this.lastSpeakMs = now;
      this.lastSpeakerBotId = result.winnerBotId;
      const winner = requests.find((r) => r.botId === result.winnerBotId);
      if (winner) {
        this.listeners.forEach((l) =>
          l({ botId: result.winnerBotId!, candidate: winner.candidate }),
        );
      }
    }

    for (const r of requests) {
      r.resolve(r.botId === result.winnerBotId);
    }
  }

  getlastSpeakerBotId() {
    return this.lastSpeakerBotId;
  }
}

export const botCoordinator = new BotCoordinator();
