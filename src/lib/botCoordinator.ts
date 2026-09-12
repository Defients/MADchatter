/**
 * BotCoordinator — multi-bot speaker floor (active only when multiBotEnabled).
 *
 * Problem: each bot runs an independent AutoForge decision loop. If two bots
 * decide to speak at nearly the same time, they'd talk over each other.
 *
 * Solution: a time-based floor + short bidding window.
 *   - After any bot sends, a `floorGapMs` cooldown blocks new sends (prevents
 *     rapid-fire overlap).
 *   - When a bot requests the floor and the cooldown has elapsed, a short
 *     `bidWindowMs` window opens to collect competing candidates. When the
 *     window closes, the highest-scoring candidate wins the floor (persona-
 *     assigned routing: score = confidence, tiebreak by personaFit). The winner
 *     may send; all others are told to stand down until their next cycle.
 *
 * Manual `force` sends bypass the coordinator (the forced bot always speaks,
 * subject only to its own per-account rate limit).
 */

export interface BotCandidate {
  decision: string;
  confidence: number;
  payload?: string;
  personaFit: number; // 0–1, how well the bot's persona fits the moment
  isMentioned?: boolean; // true when this bot was directly mentioned in chat
}

interface PendingRequest {
  botId: string;
  candidate: BotCandidate;
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

  configure(opts: { floorGapMs?: number; bidWindowMs?: number }) {
    if (opts.floorGapMs !== undefined) this.floorGapMs = opts.floorGapMs;
    if (opts.bidWindowMs !== undefined) this.bidWindowMs = opts.bidWindowMs;
  }

  /** Reset all state (e.g. when multi-bot mode is disabled). */
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

  onSpeakerChosen(listener: SpeakerChosenListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Request the floor for a bot. Resolves true if this bot won the floor and
   * should send now; false if it should stand down (either because the cooldown
   * hasn't elapsed, or it lost the bidding window to a higher-scoring bot).
   */
  requestFloor(botId: string, candidate: BotCandidate): Promise<boolean> {
    const now = Date.now();

    // Cooldown not elapsed → stand down this cycle.
    if (now - this.lastSpeakMs < this.floorGapMs) {
      return Promise.resolve(false);
    }

    // Open / join a bidding window.
    return new Promise<boolean>((resolve) => {
      this.pending.push({ botId, candidate, resolve });
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

    // Pick the highest-scoring candidate.
    // score = confidence + personaFit tiebreak + mention bonus.
    // The 0.15 mention bonus lets a mentioned bot win over a slightly-higher-
    // confidence non-mentioned bot, but doesn't override a strong confidence gap.
    let best = requests[0];
    for (const r of requests) {
      const rScore = r.candidate.confidence + r.candidate.personaFit * 0.001 + (r.candidate.isMentioned ? 0.15 : 0);
      const bScore = best.candidate.confidence + best.candidate.personaFit * 0.001 + (best.candidate.isMentioned ? 0.15 : 0);
      if (rScore > bScore) best = r;
    }

    this.lastSpeakMs = Date.now();
    this.lastSpeakerBotId = best.botId;

    for (const r of requests) {
      r.resolve(r === best);
    }

    this.listeners.forEach((l) =>
      l({ botId: best.botId, candidate: best.candidate }),
    );
  }

  getlastSpeakerBotId() {
    return this.lastSpeakerBotId;
  }
}

export const botCoordinator = new BotCoordinator();
