/**
 * ParticipationAwareness — Annoyance Awareness / Deliberate Silence (v28).
 *
 * Problem: MADchatter's restraint was distributed across independent systems
 * (rate limits, prompt instructions, confidence thresholds, cooldowns, dedup,
 * per-action limits) with no coherent answer to one question:
 *
 *   Are we beginning to overstay our welcome?
 *
 * Solution: a bounded, explainable, deterministic behavioral layer that
 * estimates whether MADchatter's participation is currently helpful, neutral,
 * or becoming socially costly — and makes silence a deliberate, receipted
 * action rather than the mere absence of generation.
 *
 * Pipeline:
 *   ROOM STATE + RECENT HUMAN ACTIVITY + RECENT BOT ACTIVITY + RECENT OUTCOMES
 *     → bounded risk dimensions (saturation / interruption / loop / outcome
 *       trend / repetition / recency — every value 0..1)
 *     → stable participation state (open → measured → quiet → cooldown,
 *       with hysteresis + dwell so it never flickers)
 *     → per-opportunity decision (allow / silence + threshold modifier +
 *       reason codes + confidence)
 *
 * Design constraints:
 *   - Pure module: no store, no React, no AI calls, no timers. The engine is a
 *     deterministic function of its bounded ingestion buffers — the same
 *     pattern as roomModel / semanticCoordination. Zero recurring LLM cost.
 *   - Silence is an action: every meaningful restraint decision emits a
 *     bounded receipt with reason codes, risk dimensions, obligation, and
 *     confidence. Receipts are throttled (at most one per 20s) so a quiet
 *     state does not spam a receipt per 15s cycle.
 *   - Humans own the room: healthy human conversation raises interruption
 *     risk instead of looking like an engagement opportunity. Bot-only
 *     chatter can never manufacture human receptivity — humans and bots are
 *     attributed at every layer.
 *   - Annoyance is probabilistic: risk dimensions, never claimed emotional
 *     states. Confidence (evidence weight) is separate from risk (how much
 *     restraint is warranted) — weak evidence produces gentle intervention.
 *   - Contextual saturation: bot share alone never punishes tiny streams
 *     (below the minimum message volume all ratio-based dimensions are 0).
 *   - Direct obligations survive restraint: mentions / forced checks /
 *     streamer callouts classify as DIRECT/REQUIRED and always evaluate
 *     allowed. Restraint modulates the threshold for OPTIONAL/RELEVANT
 *     contributions instead of muting the bot.
 *   - Explicit human intent is sovereign: a streamer quiet instruction
 *     ("bots chill for a bit") and the manual Quiet / Direct-only / Global
 *     Stop controls override inferred recovery until they expire or are
 *     cleared by an explicit resume.
 *   - Channel isolation: the engine is channel-scoped exactly like
 *     semanticCoordination — `reset(channel)` wipes every volatile buffer on
 *     channel change, so Channel-A restraint can never leak into Channel B.
 *     Nothing here persists across sessions; yesterday's temporary annoyance
 *     is never today's starting state.
 *
 * What this layer does NOT do (scope discipline):
 *   - It does not replace hard rate limits (CAN'T speak), send guards,
 *     safety, semantic coordination (WHO speaks), or the Room Model (WHAT is
 *     happening). It coordinates them with the missing judgment — SHOULD we
 *     speak — and leaves their authority intact.
 *   - It does not optimize engagement. Outcome evidence is used
 *     conservatively (repeated ignored OPTIONAL sends only; one ignored
 *     message is weak evidence and can never force a quiet state alone).
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** Stable participation states. Escalation is immediate; recovery is gradual. */
export type ParticipationState =
  | "open" // normal policy
  | "measured" // slightly elevated thresholds; optional actions face more scrutiny
  | "quiet" // only strong opportunities generally pass
  | "cooldown" // temporary elevated silence after obvious over-participation
  | "direct_only"; // only direct obligations may pass (manual control)

/** Why the current state is active. */
export type ParticipationSource = "inferred" | "manual" | "explicit_instruction";

/** How strong the current conversational obligation is. */
export type Obligation =
  | "none" // no opportunity
  | "optional" // generic joke / reaction opportunity
  | "relevant" // bot could add useful information (spike, question)
  | "direct" // human explicitly addresses the bot
  | "required"; // forced check / hard user intent

/** Manual user control (persisted preference, never inferred). */
export type ManualParticipationMode = "auto" | "quiet" | "direct_only";

/** Canonical machine-readable reason codes for restraint decisions. */
export type SilenceReasonCode =
  | "human_conversation_active"
  | "recent_bot_activity"
  | "bot_saturation_high"
  | "bot_only_loop"
  | "repeated_weak_outcomes"
  | "repetitive_function"
  | "explicit_quiet_instruction"
  | "manual_quiet_mode"
  | "manual_direct_only_mode"
  | "cooldown_active"
  | "below_restraint_threshold";

/** User-facing translations — never shown as raw codes. */
export const PARTICIPATION_REASON_LABELS: Record<SilenceReasonCode, string> = {
  human_conversation_active: "Humans are carrying the conversation",
  recent_bot_activity: "We spoke very recently",
  bot_saturation_high: "Bots have been unusually active",
  bot_only_loop: "Bots are mostly talking to each other",
  repeated_weak_outcomes: "Recent optional messages went unanswered",
  repetitive_function: "Same kind of contribution repeatedly",
  explicit_quiet_instruction: "Asked to quiet down",
  manual_quiet_mode: "Quiet mode is on",
  manual_direct_only_mode: "Direct-only mode is on",
  cooldown_active: "Cooling down after heavy activity",
  below_restraint_threshold: "Below the raised confidence bar",
};

/** Bounded risk dimensions. Every value is 0..1. */
export interface ParticipationRiskDimensions {
  /** How much recent conversational space MADchatter occupied (contextual). */
  botSaturation: number;
  /** Would speaking disrupt healthy human interaction? */
  interruptionRisk: number;
  /** Repeated conversational-function usage (joke after joke). */
  repetitionRisk: number;
  /** Have recent OPTIONAL contributions been repeatedly ignored? */
  outcomeTrendRisk: number;
  /** Bot-only streak pressure (bots stimulating each other). */
  botLoopRisk: number;
  /** How recently did the ensemble already speak? */
  recencyPressure: number;
}

export interface ParticipationRisk {
  dimensions: ParticipationRiskDimensions;
  /** Weighted bounded combination (0..1). */
  overall: number;
  /** Evidence weight behind the estimate (0..1) — NOT the risk itself. */
  confidence: number;
  reasonCodes: SilenceReasonCode[];
  recent: {
    humanMessages: number;
    botMessages: number;
    consecutiveBotMessages: number;
    botShare: number;
  };
}

/** Bounded receipt for a meaningful deliberate-silence decision. */
export interface SilenceReceipt {
  timestamp: number;
  channel: string | null;
  botId?: string;
  reasonCodes: SilenceReasonCode[];
  participationState: ParticipationState;
  risk: { overall: number; botSaturation: number; interruptionRisk: number };
  obligation: Obligation;
  /** True when the model had proposed/would have proposed a send. */
  wouldHaveActed: boolean;
  confidence: number;
}

export interface ParticipationEvaluation {
  state: ParticipationState;
  source: ParticipationSource;
  risk: ParticipationRisk;
  obligation: Obligation;
  disposition: "allow" | "silence";
  /** Added to the user's stored confidence threshold (never mutates it). */
  effectiveThresholdModifier: number;
  reasonCodes: SilenceReasonCode[];
  /** Present only when this evaluation chose silence for a real opportunity. */
  receipt?: SilenceReceipt;
}

/** UI mirror of the engine (session-scoped, never persisted). */
export interface ParticipationSnapshot {
  state: ParticipationState;
  source: ParticipationSource;
  reasonCodes: SilenceReasonCode[];
  risk: {
    overall: number;
    confidence: number;
    dimensions: ParticipationRiskDimensions;
  };
  updatedAt: number;
  /** Epoch ms while an explicit quiet instruction is active, else null. */
  explicitQuietUntil: number | null;
}

// ─── Limits & Weights (centralized, exported for tests) ──────────────────────

export const PARTICIPATION_LIMITS = {
  /** Bounded ingestion buffers (this is not a chat database). */
  maxTimelineEntries: 120,
  maxOutcomes: 40,
  maxReceipts: 30,
  /** Saturation / speaker-balance window. */
  saturationWindowMs: 5 * 60_000,
  /** Below this recent message volume, ratio-based risk is unreliable —
   * tiny streams (2 humans + 1 bot message) must not read as saturation. */
  saturationMinMessages: 6,
  /** Recent bot send pressure window. */
  recencyWindowMs: 120_000,
  /** Human thread health: ≥2 distinct humans within this window… */
  threadWindowMs: 60_000,
  /** …and the latest of them within this recency. */
  threadRecencyMs: 30_000,
  /** A human mention inside this window means the bot IS part of the
   * conversation — interruption risk collapses. */
  mentionGraceMs: 180_000,
  /** Outcome trend window (repeated ignored optional sends). */
  outcomeWindowMs: 30 * 60_000,
  /** Consecutive bot-only messages at full loop risk (2 → 0.33, 3 → 0.67). */
  botLoopStreakMax: 4,
  /** Repetition (same-function pressure) window. */
  repetitionWindowMs: 3 * 60_000,
  /** Hysteresis: minimum time in a state before de-escalation is allowed. */
  stateMinDwellMs: 90_000,
  /** Cooldown auto-lowers to quiet after this long. */
  cooldownDurationMs: 3 * 60_000,
  /** Default explicit quiet instruction duration when text has no number. */
  explicitQuietDefaultMs: 10 * 60_000,
  /** Receipt throttle — a quiet loop must not emit one receipt per cycle. */
  receiptMinIntervalMs: 20_000,
} as const;

export const PARTICIPATION_WEIGHTS = {
  // Risk dimension weights (sum to 1.0 — no dimension can dominate by scale,
  // and no single dimension can reach a quiet state alone: quieting the
  // ensemble always requires multiple agreeing signals or an explicit
  // instruction, which is the pathological-silence guard).
  botSaturation: 0.28,
  interruption: 0.24,
  outcomeTrend: 0.15,
  botLoop: 0.22,
  repetition: 0.05,
  recency: 0.06,
  // State machine thresholds (enter high, exit low → hysteresis).
  measuredEnter: 0.38,
  quietEnter: 0.58,
  cooldownEnter: 0.78,
  stateExit: 0.3,
  // Bot-only loop floors (severe social signals escalate independent of the
  // weighted sum): 3 consecutive bot messages → at least MEASURED, 4+ → at
  // least QUIET (near-hard suppression for optional openings, matching the
  // semantic coordinator's multi-bot loop suppression).
  loopFloorMeasured: 0.67,
  loopFloorQuiet: 1,
  // Effective confidence-threshold modifiers per state (added to the stored
  // user setting at evaluation time — the stored setting is never mutated).
  thresholdModifiers: {
    open: 0,
    measured: 0.06,
    quiet: 0.15,
    cooldown: 0.25,
    direct_only: 0.15,
  } as Record<ParticipationState, number>,
} as const;

// ─── Small pure helpers ──────────────────────────────────────────────────────

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Explicit quiet-instruction detection (conservative by design) ───────────

/**
 * Recognize an explicit human instruction for the bots to quiet down.
 *
 * Deliberately narrow: the broad patterns only count when the speaker is the
 * streamer (username === channel) or the message addresses a bot (isMention
 * carried from the existing mention detection). Random chatters joking
 * "chill" at each other must never quiet the ensemble.
 */
const QUIET_COMMAND_RE =
  /\b(bots?\s+(?:chill|quiet|stop|settle|relax|calm(?:\s+down)?)|(?:chill|quiet|settle|relax|calm down|cool it|give it a rest|take it down a notch|too much|not now|stop talking|stop spamming|shut up)\b(?:[^.?!]{0,24}\bbots?)?)/i;

const RESUME_COMMAND_RE =
  /\b(you'?re good|ur good|go ahead|carry on|back at it|back to normal|resume|okay bots?|ok bots?|alright bots?)/i;

/** Parse a duration from quiet-command text. Absent numbers → default. */
export function parseQuietDurationMs(text: string, now: number): number {
  const explicit = /(\d+)\s*(min|mins|minutes|m)\b/i.exec(text);
  if (explicit) {
    const mins = Math.min(120, Math.max(1, parseInt(explicit[1], 10)));
    return now + mins * 60_000;
  }
  if (/\b(hour|while|awhile)\b/i.test(text)) return now + 30 * 60_000;
  if (/\b(a|few)?\s*(sec|second|moment|bit|minute)\b/i.test(text)) return now + 3 * 60_000;
  return now + PARTICIPATION_LIMITS.explicitQuietDefaultMs;
}

export function isQuietInstruction(text: string): boolean {
  return QUIET_COMMAND_RE.test(text);
}

export function isResumeInstruction(text: string): boolean {
  return RESUME_COMMAND_RE.test(text);
}

// ─── Risk computation (pure) ─────────────────────────────────────────────────

interface TimelineEntry {
  t: number;
  type: "human" | "bot";
  user?: string;
  isMention?: boolean;
  isStreamer?: boolean;
}

interface OutcomeEntry {
  t: number;
  label: "ignored" | "low" | "moderate" | "high";
  wasOptional: boolean;
}

export function computeParticipationRisk(
  timeline: TimelineEntry[],
  outcomes: OutcomeEntry[],
  now: number,
): ParticipationRisk {
  const L = PARTICIPATION_LIMITS;
  const W = PARTICIPATION_WEIGHTS;

  const windowed = timeline.filter((e) => now - e.t <= L.saturationWindowMs);
  const humans = windowed.filter((e) => e.type === "human");
  const bots = windowed.filter((e) => e.type === "bot");
  const total = windowed.length;

  // ── Bot saturation (contextual: share AND absolute volume) ──
  // Below the minimum volume, ratios are noise — a 3-message stream is never
  // "saturated" no matter the split (tiny-stream false-positive guard).
  let botSaturation = 0;
  if (total >= L.saturationMinMessages) {
    const share = bots.length / total;
    const shareScore = clamp01((share - 0.35) / 0.45);
    const volumeScore = clamp01((bots.length - 5) / 10);
    botSaturation = clamp01(0.65 * shareScore + 0.35 * volumeScore);
  }

  // ── Recency pressure ──
  let lastBotAt = -Infinity;
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i].type === "bot") { lastBotAt = timeline[i].t; break; }
  }
  const sinceBot = now - lastBotAt;
  const recencyPressure =
    lastBotAt === -Infinity || sinceBot > L.recencyWindowMs
      ? 0
      : clamp01(0.8 * (1 - sinceBot / L.recencyWindowMs));

  // ── Bot-only loop risk (trailing streak, attributed) ──
  let streak = 0;
  for (let i = windowed.length - 1; i >= 0; i--) {
    if (windowed[i].type === "bot") streak++;
    else break;
  }
  const botLoopRisk = clamp01((streak - 1) / (L.botLoopStreakMax - 1));

  // ── Interruption risk (healthy human thread, bot not addressed) ──
  const lastHuman = [...timeline].reverse().find((e) => e.type === "human");
  const recentMention = timeline.some(
    (e) => e.type === "human" && e.isMention && now - e.t <= L.mentionGraceMs,
  );
  let interruptionRisk = 0;
  if (!recentMention && lastHuman && now - lastHuman.t <= L.threadRecencyMs) {
    const threadHumans = timeline.filter(
      (e) => e.type === "human" && now - e.t <= L.threadWindowMs,
    );
    const distinct = new Set(threadHumans.map((e) => e.user ?? "")).size;
    if (distinct >= 2) {
      interruptionRisk = 0.6;
      const streamerEngaged = timeline
        .slice(-5)
        .some((e) => e.type === "human" && e.isStreamer);
      if (streamerEngaged) interruptionRisk += 0.15;
      if (total >= L.saturationMinMessages && bots.length / total <= 0.2) {
        interruptionRisk += 0.1;
      }
      interruptionRisk = clamp01(interruptionRisk);
    }
  }

  // ── Outcome trend risk (repeated ignored OPTIONAL sends only) ──
  // One ignored message is weak evidence and can never move this dimension;
  // two ignored optional sends start to matter. Engaged sends never count —
  // this is not an engagement optimizer.
  const optionalOutcomes = outcomes.filter(
    (o) => o.wasOptional && now - o.t <= L.outcomeWindowMs,
  );
  const ignored = optionalOutcomes.filter((o) => o.label === "ignored").length;
  const outcomeTrendRisk = ignored >= 2 ? clamp01((ignored - 1) / 3) : 0;

  // ── Repetition risk (send density within the function window) ──
  const recentBotSends = timeline.filter(
    (e) => e.type === "bot" && now - e.t <= L.repetitionWindowMs,
  ).length;
  const repetitionRisk = clamp01((recentBotSends - 1) / 3);

  const dimensions: ParticipationRiskDimensions = {
    botSaturation: round2(botSaturation),
    interruptionRisk: round2(interruptionRisk),
    repetitionRisk: round2(repetitionRisk),
    outcomeTrendRisk: round2(outcomeTrendRisk),
    botLoopRisk: round2(botLoopRisk),
    recencyPressure: round2(recencyPressure),
  };

  const overall = clamp01(
    W.botSaturation * dimensions.botSaturation +
    W.interruption * dimensions.interruptionRisk +
    W.outcomeTrend * dimensions.outcomeTrendRisk +
    W.botLoop * dimensions.botLoopRisk +
    W.repetition * dimensions.repetitionRisk +
    W.recency * dimensions.recencyPressure,
  );

  // Confidence = evidence weight. Sparse evidence → low confidence → the
  // state machine treats the estimate gently (enter thresholds still apply,
  // but cooldown requires enough volume to be reachable at all).
  const confidence = clamp01(
    0.2 + 0.04 * Math.min(10, total) + 0.1 * Math.min(3, optionalOutcomes.length),
  );

  const reasonCodes: SilenceReasonCode[] = [];
  if (dimensions.botSaturation >= 0.5) reasonCodes.push("bot_saturation_high");
  if (dimensions.interruptionRisk >= 0.5) reasonCodes.push("human_conversation_active");
  if (dimensions.botLoopRisk >= 0.5) reasonCodes.push("bot_only_loop");
  if (dimensions.outcomeTrendRisk >= 0.4) reasonCodes.push("repeated_weak_outcomes");
  if (dimensions.recencyPressure >= 0.6) reasonCodes.push("recent_bot_activity");
  if (dimensions.repetitionRisk >= 0.6) reasonCodes.push("repetitive_function");

  return {
    dimensions,
    overall: round2(overall),
    confidence: round2(confidence),
    reasonCodes,
    recent: {
      humanMessages: humans.length,
      botMessages: bots.length,
      consecutiveBotMessages: streak,
      botShare: total > 0 ? round2(bots.length / total) : 0,
    },
  };
}

// ─── State machine (pure transition) ─────────────────────────────────────────

export interface StateMachineInput {
  current: ParticipationState;
  enteredAt: number;
  riskOverall: number;
  /** Bot-only loop risk — severe values escalate independent of the sum. */
  botLoopRisk: number;
  now: number;
  manualMode: ManualParticipationMode;
  explicitQuietUntil: number | null;
}

export interface StateMachineResult {
  state: ParticipationState;
  source: ParticipationSource;
  enteredAt: number;
}

/**
 * Hysteresis state machine. Escalation is immediate (severe events should not
 * wait); de-escalation requires BOTH the risk to fall below the exit
 * threshold AND the minimum dwell to have elapsed, so a risk hovering at the
 * boundary can never flip the product behavior every cycle. Explicit sources
 * (manual mode, quiet instruction) override inference entirely.
 */
export function resolveParticipationState(input: StateMachineInput): StateMachineResult {
  const W = PARTICIPATION_WEIGHTS;
  const L = PARTICIPATION_LIMITS;
  const { now, riskOverall, manualMode } = input;

  if (manualMode === "direct_only") {
    return { state: "direct_only", source: "manual", enteredAt: input.current === "direct_only" ? input.enteredAt : now };
  }
  if (manualMode === "quiet") {
    return { state: "quiet", source: "manual", enteredAt: input.current === "quiet" ? input.enteredAt : now };
  }
  if (input.explicitQuietUntil !== null && input.explicitQuietUntil > now) {
    return { state: "quiet", source: "explicit_instruction", enteredAt: input.current === "quiet" ? input.enteredAt : now };
  }

  // Inferred target.
  let target: ParticipationState;
  if (riskOverall >= W.cooldownEnter) target = "cooldown";
  else if (riskOverall >= W.quietEnter) target = "quiet";
  else if (riskOverall >= W.measuredEnter) target = "measured";
  else target = "open";

  // Severe bot-only loop floors: 3 consecutive bot messages → at least
  // MEASURED; 4+ → at least QUIET (near-hard suppression for optional
  // openings). Escalation only — the normal exit rules still recover once
  // a human breaks the streak.
  const rank: Record<ParticipationState, number> = {
    open: 0, measured: 1, quiet: 2, cooldown: 3, direct_only: 4,
  };
  if (input.botLoopRisk >= W.loopFloorQuiet && rank[target] < rank.quiet) target = "quiet";
  else if (input.botLoopRisk >= W.loopFloorMeasured && rank[target] < rank.measured) target = "measured";

  // Cooldown is temporary — after its duration it decays to quiet, then the
  // normal exit rules recover from there.
  if (input.current === "cooldown" && target === "cooldown" && now - input.enteredAt >= L.cooldownDurationMs) {
    target = "quiet";
  }

  if (target === input.current) {
    return { state: input.current, source: "inferred", enteredAt: input.enteredAt };
  }

  const escalating = rank[target] > rank[input.current];

  if (escalating) {
    return { state: target, source: "inferred", enteredAt: now };
  }
  // De-escalation needs the risk below the exit threshold AND minimum dwell.
  if (riskOverall < W.stateExit && now - input.enteredAt >= L.stateMinDwellMs) {
    return { state: target, source: "inferred", enteredAt: now };
  }
  return { state: input.current, source: "inferred", enteredAt: input.enteredAt };
}

// ─── Obligation classification ──────────────────────────────────────────────

export function classifyObligation(opts: {
  force?: boolean;
  isMentioned?: boolean;
  activitySpike?: boolean;
  firstMessagePending?: boolean;
}): Obligation {
  if (opts.force) return "required";
  if (opts.isMentioned) return "direct";
  if (opts.activitySpike || opts.firstMessagePending) return "relevant";
  return "optional";
}

// ─── Prompt context (compact, no bloat) ──────────────────────────────────────

/**
 * Compact advisory block for autoforgeDecide. Only rendered when the state is
 * not "open" — an open room adds zero prompt tokens. Direct evidence
 * (mentions, transcript, recent chat) always outranks this block.
 */
export function formatParticipationContext(snapshot: {
  state: ParticipationState;
  source: ParticipationSource;
  reasonCodes: SilenceReasonCode[];
  risk: { overall: number };
} | null): string {
  if (!snapshot || snapshot.state === "open") return "";
  const reasons = snapshot.reasonCodes.length > 0
    ? snapshot.reasonCodes.map((c) => PARTICIPATION_REASON_LABELS[c]).join("; ")
    : "elevated participation risk";
  const lines = [
    "[PARTICIPATION STATE]",
    `Mode: ${snapshot.state.toUpperCase()}${snapshot.source === "explicit_instruction" ? " (asked to quiet down)" : ""}`,
    `Why: ${reasons}`,
  ];
  switch (snapshot.state) {
    case "measured":
      lines.push(
        "Guidance:",
        "- prefer clearly additive contributions over filler",
        "- direct mentions still deserve responses",
        "- avoid follow-up chains",
      );
      break;
    case "quiet":
      lines.push(
        "Guidance:",
        "- remain silent unless the contribution is clearly additive",
        "- direct mentions still deserve responses",
        "- no follow-up chains; keep direct answers concise",
      );
      break;
    case "cooldown":
      lines.push(
        "Guidance:",
        "- strong restraint: prefer deliberate_silence for optional openings",
        "- direct mentions still deserve concise responses",
      );
      break;
    case "direct_only":
      lines.push(
        "Guidance:",
        "- only respond when directly addressed; choose deliberate_silence otherwise",
      );
      break;
  }
  return lines.join("\n");
}

// ─── Engine (bounded buffers, module singleton) ──────────────────────────────

export interface EvaluateOptions {
  now?: number;
  channel?: string | null;
  botId?: string;
  force?: boolean;
  isMentioned?: boolean;
  activitySpike?: boolean;
  firstMessagePending?: boolean;
  manualMode?: ManualParticipationMode;
  /** True when the model already proposed a send (post-AI gate). */
  wouldHaveActed?: boolean;
}

export class ParticipationEngine {
  private channel: string | null = null;
  private timeline: TimelineEntry[] = [];
  private outcomes: OutcomeEntry[] = [];
  private receipts: SilenceReceipt[] = [];
  private lastReceiptAt = 0;
  private state: ParticipationState = "open";
  private stateEnteredAt = 0;
  private explicitQuietUntil: number | null = null;
  private explicitQuietSource: string | null = null;

  /** Bind to a channel and wipe every volatile buffer (channel switch). */
  reset(channel: string | null): void {
    this.channel = channel !== null && channel !== undefined ? channel.trim().toLowerCase() : null;
    this.timeline = [];
    this.outcomes = [];
    this.receipts = [];
    this.lastReceiptAt = 0;
    this.state = "open";
    this.stateEnteredAt = 0;
    this.explicitQuietUntil = null;
    this.explicitQuietSource = null;
  }

  getChannel(): string | null {
    return this.channel;
  }

  getExplicitQuietUntil(): number | null {
    return this.explicitQuietUntil;
  }

  private accept(channel?: string | null): boolean {
    const normalized = channel !== null && channel !== undefined ? channel.trim().toLowerCase() : null;
    // Unbound engine accepts everything (tests); a bound engine only accepts
    // notes for its own channel — Channel-A evidence can never quiet B.
    return this.channel === null || this.channel === normalized;
  }

  private push(entry: TimelineEntry): void {
    this.timeline.push(entry);
    if (this.timeline.length > PARTICIPATION_LIMITS.maxTimelineEntries) {
      this.timeline.splice(0, this.timeline.length - PARTICIPATION_LIMITS.maxTimelineEntries);
    }
  }

  /**
   * Human chat ingestion (wired at store-action level in App.tsx). Also the
   * chokepoint for explicit streamer quiet/resume instructions — those are
   * high-priority human intent, tracked with provenance separately from
   * inferred annoyance.
   */
  noteHumanChat(input: {
    channel?: string | null;
    username: string;
    text: string;
    isMention?: boolean;
    isStreamer?: boolean;
    timestamp?: number;
  }): void {
    if (!this.accept(input.channel)) return;
    const t = input.timestamp ?? Date.now();
    this.push({
      t,
      type: "human",
      user: input.username.toLowerCase(),
      isMention: input.isMention,
      isStreamer: input.isStreamer,
    });
    // Explicit instruction detection: streamer OR a message that addresses a
    // bot. Random chatter joking "chill" at another human never qualifies.
    const authoritative = input.isStreamer || input.isMention;
    if (authoritative) {
      if (isResumeInstruction(input.text)) {
        this.explicitQuietUntil = null;
        this.explicitQuietSource = null;
      } else if (isQuietInstruction(input.text)) {
        this.explicitQuietUntil = parseQuietDurationMs(input.text, t);
        this.explicitQuietSource = `chat:${input.username}`;
      }
    }
  }

  /** Bot send ingestion (wired in store addSentMessage / addBotSentMessage). */
  noteBotSend(input: { channel?: string | null; botId?: string; timestamp?: number }): void {
    if (!this.accept(input.channel)) return;
    this.push({ t: input.timestamp ?? Date.now(), type: "bot", user: input.botId });
  }

  /** Post-send outcome ingestion (wired from the engagement checks). */
  noteOutcome(input: {
    channel?: string | null;
    label: "ignored" | "low" | "moderate" | "high";
    wasOptional: boolean;
    timestamp?: number;
  }): void {
    if (!this.accept(input.channel)) return;
    this.outcomes.push({ t: input.timestamp ?? Date.now(), label: input.label, wasOptional: input.wasOptional });
    if (this.outcomes.length > PARTICIPATION_LIMITS.maxOutcomes) {
      this.outcomes.splice(0, this.outcomes.length - PARTICIPATION_LIMITS.maxOutcomes);
    }
  }

  /** Manual "quiet for a while" from the UI — explicit human intent. */
  setExplicitQuiet(untilMs: number | null, source = "manual"): void {
    this.explicitQuietUntil = untilMs;
    this.explicitQuietSource = untilMs !== null ? source : null;
  }

  /**
   * Evaluate the current opportunity. Pure given the engine's bounded buffers
   * and the injected clock — the single decision chokepoint both AutoForge
   * loops consume (pre-AI and post-AI).
   */
  evaluate(opts: EvaluateOptions = {}): ParticipationEvaluation {
    const now = opts.now ?? Date.now();
    const manualMode = opts.manualMode ?? "auto";

    // Stale-channel guard: an evaluation requested for a different channel
    // than the engine is bound to must never restrain (or release restraint)
    // from foreign evidence — it returns a neutral allow without touching
    // the engine's state machine. The store resets the engine on every
    // channel switch; this is the defensive second layer.
    if (opts.channel !== undefined && opts.channel !== null && this.channel !== null) {
      const normalized = opts.channel.trim().toLowerCase();
      if (normalized !== this.channel) {
        const obligation = classifyObligation(opts);
        return {
          state: "open",
          source: "inferred",
          risk: computeParticipationRisk([], [], now),
          obligation,
          disposition: "allow",
          effectiveThresholdModifier: 0,
          reasonCodes: [],
        };
      }
    }

    const risk = computeParticipationRisk(this.timeline, this.outcomes, now);
    const resolved = resolveParticipationState({
      current: this.state,
      enteredAt: this.stateEnteredAt,
      riskOverall: risk.overall,
      botLoopRisk: risk.dimensions.botLoopRisk,
      now,
      manualMode,
      explicitQuietUntil: this.explicitQuietUntil,
    });
    this.state = resolved.state;
    this.stateEnteredAt = resolved.enteredAt;

    const obligation = classifyObligation(opts);

    // Decision tree — direct/required obligations always evaluate allowed;
    // restraint modulates thresholds for optional/relevant contributions.
    let disposition: "allow" | "silence" = "allow";
    const reasonCodes: SilenceReasonCode[] = [...risk.reasonCodes];

    if (obligation === "optional" || obligation === "relevant") {
      const W = PARTICIPATION_WEIGHTS;
      switch (resolved.state) {
        case "direct_only":
          disposition = "silence";
          reasonCodes.push("manual_direct_only_mode");
          break;
        case "cooldown":
          disposition = "silence";
          reasonCodes.push("cooldown_active");
          break;
        case "quiet":
          // Strong opportunities may still pass when the risk that entered
          // quiet has already decayed (hysteresis holds the state, not a ban).
          if (obligation === "optional" || risk.overall >= W.quietEnter) {
            disposition = "silence";
            if (resolved.source === "explicit_instruction") reasonCodes.push("explicit_quiet_instruction");
            else if (resolved.source === "manual") reasonCodes.push("manual_quiet_mode");
            else reasonCodes.push("bot_saturation_high");
          }
          break;
        case "measured":
        case "open":
        default:
          break;
      }
    }

    const thresholdModifier =
      PARTICIPATION_WEIGHTS.thresholdModifiers[resolved.state] ?? 0;
    if (thresholdModifier > 0 && disposition === "allow") {
      reasonCodes.push("below_restraint_threshold");
    }

    // Receipt: only for a meaningful evaluated restraint (a real opportunity
    // the layer suppressed), throttled so quiet-state cycles don't spam.
    let receipt: SilenceReceipt | undefined;
    if (disposition === "silence" && obligation !== "required") {
      const shouldRecord =
        opts.wouldHaveActed === true ||
        now - this.lastReceiptAt >= PARTICIPATION_LIMITS.receiptMinIntervalMs;
      if (shouldRecord) {
        this.lastReceiptAt = now;
        receipt = {
          timestamp: now,
          channel: this.channel,
          botId: opts.botId,
          reasonCodes: dedupe(reasonCodes),
          participationState: resolved.state,
          risk: {
            overall: risk.overall,
            botSaturation: risk.dimensions.botSaturation,
            interruptionRisk: risk.dimensions.interruptionRisk,
          },
          obligation,
          wouldHaveActed: opts.wouldHaveActed === true,
          confidence: risk.confidence,
        };
        this.receipts.push(receipt);
        if (this.receipts.length > PARTICIPATION_LIMITS.maxReceipts) {
          this.receipts.splice(0, this.receipts.length - PARTICIPATION_LIMITS.maxReceipts);
        }
      }
    }

    return {
      state: resolved.state,
      source: resolved.source,
      risk,
      obligation,
      disposition,
      effectiveThresholdModifier: thresholdModifier,
      reasonCodes: dedupe(reasonCodes),
      receipt,
    };
  }

  getSnapshot(now: number = Date.now()): ParticipationSnapshot {
    const risk = computeParticipationRisk(this.timeline, this.outcomes, now);
    const resolved = resolveParticipationState({
      current: this.state,
      enteredAt: this.stateEnteredAt,
      riskOverall: risk.overall,
      botLoopRisk: risk.dimensions.botLoopRisk,
      now,
      manualMode: "auto",
      explicitQuietUntil: this.explicitQuietUntil,
    });
    return {
      state: resolved.state,
      source: resolved.source,
      reasonCodes: risk.reasonCodes,
      risk: {
        overall: risk.overall,
        confidence: risk.confidence,
        dimensions: risk.dimensions,
      },
      updatedAt: now,
      explicitQuietUntil: this.explicitQuietUntil !== null && this.explicitQuietUntil > now ? this.explicitQuietUntil : null,
    };
  }

  getReceipts(): SilenceReceipt[] {
    return [...this.receipts];
  }

  /**
   * Seed a prior state (dwell timing) for deterministic hysteresis tests.
   * Never called by product code — the state machine's own transitions are
   * the only production path.
   */
  seedState(state: ParticipationState, enteredAt: number): void {
    this.state = state;
    this.stateEnteredAt = enteredAt;
  }

  /** Developer observability (spec §71) — no secrets, no hidden reasoning. */
  getDebug(now: number = Date.now()) {
    const snapshot = this.getSnapshot(now);
    return {
      channel: this.channel,
      state: snapshot.state,
      source: snapshot.source,
      annoyanceRisk: snapshot.risk.overall,
      confidence: snapshot.risk.confidence,
      dimensions: snapshot.risk.dimensions,
      recent: {
        humanMessages: this.timeline.filter((e) => e.type === "human" && now - e.t <= PARTICIPATION_LIMITS.saturationWindowMs).length,
        botMessages: this.timeline.filter((e) => e.type === "bot" && now - e.t <= PARTICIPATION_LIMITS.saturationWindowMs).length,
        consecutiveBotMessages: (() => {
          let streak = 0;
          for (let i = this.timeline.length - 1; i >= 0; i--) {
            if (this.timeline[i].type === "bot") streak++;
            else break;
          }
          return streak;
        })(),
      },
      reasons: snapshot.reasonCodes,
      explicitQuiet: this.explicitQuietUntil,
      explicitQuietSource: this.explicitQuietSource,
      receipts: this.receipts.length,
    };
  }
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

export const participation = new ParticipationEngine();

// ─── Simulation harness ──────────────────────────────────────────────────────

export interface ParticipationSimulationInput {
  channel?: string;
  now?: number;
  /** Ordered conversation (oldest first), human or bot attributed. */
  conversation: Array<{ type: "human" | "bot"; user?: string; text?: string; isMention?: boolean; isStreamer?: boolean; at: number }>;
  outcomes?: Array<{ label: "ignored" | "low" | "moderate" | "high"; wasOptional: boolean; at: number }>;
  opportunity?: {
    isMentioned?: boolean;
    activitySpike?: boolean;
    firstMessagePending?: boolean;
    force?: boolean;
  };
  manualMode?: ManualParticipationMode;
  /** Pre-seeded state (for hysteresis / recovery scenarios). */
  currentState?: ParticipationState;
  stateEnteredAt?: number;
}

export interface ParticipationSimulationResult {
  state: ParticipationState;
  source: ParticipationSource;
  disposition: "allow" | "silence";
  obligation: Obligation;
  annoyanceRisk: number;
  interruptionRisk: number;
  saturation: number;
  confidence: number;
  reasonCodes: SilenceReasonCode[];
  thresholdModifier: number;
  receipt?: SilenceReceipt;
}

/**
 * Deterministic restraint simulation: feed a conversation transcript, recent
 * outcomes, and an opportunity; receive the participation judgment. Primary
 * tuning surface for annoyance-awareness behavior — no UI/store/network.
 */
export function runParticipationSimulation(
  input: ParticipationSimulationInput,
): ParticipationSimulationResult {
  const now = input.now ?? 1_000_000;
  const engine = new ParticipationEngine();
  engine.reset(input.channel ?? "sim");
  for (const m of input.conversation) {
    if (m.type === "human") {
      engine.noteHumanChat({
        channel: input.channel ?? "sim",
        username: m.user ?? "human",
        text: m.text ?? "",
        isMention: m.isMention,
        isStreamer: m.isStreamer,
        timestamp: m.at,
      });
    } else {
      engine.noteBotSend({ channel: input.channel ?? "sim", timestamp: m.at });
    }
  }
  for (const o of input.outcomes ?? []) {
    engine.noteOutcome({ channel: input.channel ?? "sim", label: o.label, wasOptional: o.wasOptional, timestamp: o.at });
  }
  // Seed a prior state for hysteresis / dwell-timing scenarios.
  if (input.currentState && input.currentState !== "open") {
    engine.seedState(input.currentState, input.stateEnteredAt ?? now);
  }
  const evaluation = engine.evaluate({
    now,
    channel: input.channel ?? "sim",
    manualMode: input.manualMode ?? "auto",
    ...input.opportunity,
  });
  return {
    state: evaluation.state,
    source: evaluation.source,
    disposition: evaluation.disposition,
    obligation: evaluation.obligation,
    annoyanceRisk: evaluation.risk.overall,
    interruptionRisk: evaluation.risk.dimensions.interruptionRisk,
    saturation: evaluation.risk.dimensions.botSaturation,
    confidence: evaluation.risk.confidence,
    reasonCodes: evaluation.reasonCodes,
    thresholdModifier: evaluation.effectiveThresholdModifier,
    receipt: evaluation.receipt,
  };
}
