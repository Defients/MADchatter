/**
 * SemanticCoordination — shared conversational-awareness layer for Multi-Bot
 * (v1.1, active only when multiBotEnabled).
 *
 * Problem: the legacy BotCoordinator resolved the speaker floor with a purely
 * mechanical score (confidence + personaFit*0.001 + mention bonus), where
 * "personaFit" was 1 − |roomActivity − chaosSlider| — an activity/chaos
 * similarity heuristic, not a semantic judgment. N independent bots each
 * produced N chances to speak and the loudest confidence won.
 *
 * Solution: a shared, deterministic coordination substrate that answers, per
 * floor window:
 *   1. What kind of conversational opportunity exists?  (opportunity)
 *   2. Which persona is semantically suited to it?      (persona fit)
 *   3. What has the ensemble already covered?          (ledger + redundancy)
 *   4. Should anyone speak at all?                     (restraint)
 *
 * Pipeline:  shared ledger + candidate hints → opportunity classification →
 * per-bot semantic bids (all components normalized 0..1) → coordination
 * modifiers (redundancy / dogpile / saturation / interruption / loop) →
 * deterministic floor resolution → speak | defer | silence, plus a bounded
 * receipt for diagnostics.
 *
 * Design constraints:
 *   - Pure module. No store, no React, no AI calls, no timers. Everything is a
 *     pure function of its inputs plus the engine's bounded ledger, so the
 *     whole layer is deterministically testable and costs O(N × L) per floor
 *     window (N bids × bounded ledger L) — no per-bot LLM coordination, ever.
 *   - Facts first: every penalty/bonus is derived from recorded ledger
 *     entries attributed to human or bot speakers. Bot-only chatter can never
 *     manufacture human momentum (saturation, threads, and loop detection all
 *     attribute speaker type at every layer).
 *   - Silence is a first-class outcome. A window can resolve with no winner.
 *   - Personas stay distinct: the shared layer knows affinities and history,
 *     never voice. Coordination projects existing personas; it does not
 *     rewrite them.
 */

import type { ForgeConfig } from "../types";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Contribution kinds the ensemble reasons about. Compact by design. */
export type ResponseFunction =
  | "answer"
  | "analyze"
  | "joke"
  | "react"
  | "hype"
  | "clarify"
  | "callback"
  | "support"
  | "challenge"
  | "summarize"
  | "emote";

export type OpportunitySource =
  | "direct_mention"
  | "streamer_callout"
  | "reply_thread"
  | "room_event"
  | "topic"
  | "social_opening"
  | "bot_followup";

/** What kind of conversational opening exists right now. */
export interface ConversationOpportunity {
  id: string;
  timestamp: number;
  source: OpportunitySource;
  /** Bots directly addressed in this window (mention/callout). */
  targetBotIds: string[];
  /** Who triggered the opportunity (mention author / streamer). */
  targetUserId?: string;
  topicHints: string[];
  responseFunctions: ResponseFunction[];
  /** 0..1 — how time-sensitive responding is. */
  urgency: number;
  /** 0..1 — evidence agreement behind the classification. */
  confidence: number;
  humanOriginated: boolean;
  /** ≥2 humans actively conversing recently, no bot addressed. */
  humanThreadActive: boolean;
  evidenceRefs: string[];
}

/** Coordination projection of an existing persona (never a second persona system). */
export interface CoordinationPersonaProfile {
  botId: string;
  affinities: {
    analysis: number;
    humor: number;
    hype: number;
    empathy: number;
    challenge: number;
    conciseReaction: number;
    storytelling: number;
  };
  topicHints: string[];
  participationStyle: {
    assertiveness: number;
    spontaneity: number;
    verbosity: number;
  };
}

/** Bounded record of who said what to whom, human vs bot attributed. */
export interface ConversationalLedgerEntry {
  id: string;
  timestamp: number;
  channel: string;
  speakerType: "human" | "bot";
  /** Username (humans) or botId (bots). */
  speakerId: string;
  speakerUsername?: string;
  targetType?: "human" | "bot" | "room";
  targetId?: string;
  topicHints: string[];
  responseFunction?: ResponseFunction;
  isGreeting?: boolean;
  /** Trimmed message text for cross-bot similarity (bots only). */
  message?: string;
}

/** The candidate contract the coordinator resolves. Structural so
 *  botCoordinator can extend it without a circular import. */
export interface SemanticCandidate {
  decision: string;
  confidence: number;
  payload?: string;
  /** Display/HUD preview of persona fit (the coordinator computes the real
   *  ensemble fit at floor resolution against the shared opportunity). */
  personaFit: number;
  isMentioned?: boolean;
  /** Coordination projection of this bot's persona. */
  personaProfile?: CoordinationPersonaProfile;
  mentionSource?: "chat" | "audio" | "both";
  /** Who this bot is responding to (mention author / streamer). */
  targetUsername?: string;
  questionPending?: boolean;
  socialOpening?: boolean;
  firstMessagePending?: boolean;
}

export interface SemanticBidRequest {
  botId: string;
  candidate: SemanticCandidate;
  enqueuedAt: number;
}

export type BotDisposition = "speak" | "defer" | "silence";

/** Inspectable, fully normalized bid. Every component is 0..1. */
export interface SemanticBotBid {
  botId: string;
  opportunityId: string;
  eligible: boolean;
  enqueuedAt: number;
  baseConfidence: number;
  semanticFit: number;
  directMentionScore: number;
  continuityScore: number;
  underParticipationBonus: number;
  redundancyPenalty: number;
  recentSpeakerPenalty: number;
  dogpilePenalty: number;
  saturationPenalty: number;
  interruptionPenalty: number;
  targetStealPenalty: number;
  finalScore: number;
  disposition: BotDisposition;
  reasons: string[];
}

export type CoordinationOutcome =
  | "speaker_selected"
  | "collective_silence"
  | "direct_target_unavailable"
  | "all_suppressed"
  | "stale_channel";

export interface CoordinationReceipt {
  opportunityId: string;
  timestamp: number;
  channel: string | null;
  candidates: Array<{
    botId: string;
    finalScore: number;
    disposition: BotDisposition;
    topReasons: string[];
  }>;
  winnerBotId?: string;
  outcome: CoordinationOutcome;
  reason: string;
}

// ─── Limits & Weights (centralized, exported for tests) ──────────────────────

export const SEMANTIC_COORDINATION_LIMITS = {
  /** Ledger entries retained (bounded — this is not a chat database). */
  maxLedgerEntries: 60,
  /** Coordination receipts retained. */
  maxReceipts: 30,
  /** Recent messages considered for saturation (subset of ledger). */
  saturationWindowCount: 20,
  /** How far back saturation / speaker balance looks. */
  saturationWindowMs: 5 * 60_000,
  /** Cross-bot redundancy comparison window (topic ownership is temporary). */
  redundancyWindowMs: 45_000,
  /** Dogpile window — repeated bot targeting of the same human. */
  dogpileWindowMs: 30_000,
  /** Recent-speaker penalty window. */
  recentSpeakerWindowMs: 120_000,
  /** Consecutive bot-only messages before loop suppression (normal mode). */
  maxBotOnlyStreak: 4,
  /** Consecutive bot-only messages before loop suppression (Supercharge). */
  maxSuperchargeBotOnlyStreak: 8,
  /** One greeting per cohort window unless human conversation intervenes. */
  greetingSpacingMs: 45_000,
  /** Thread health: humans must have spoken this recently. */
  humanThreadRecencyMs: 30_000,
  /** Human thread needs ≥2 distinct speakers within this window. */
  humanThreadWindowMs: 60_000,
  /** Ledger message length stored for similarity. */
  maxMessageLength: 200,
  /** Diagnostics: per-bot disposition expiry. */
  dispositionTtlMs: 120_000,
};

/**
 * Bid weights. Every component is normalized 0..1 before weighting, so no
 * heuristic can dominate simply because its numeric scale is larger.
 * Positive weights sum to ~1.02; penalties subtract.
 */
export const SEMANTIC_COORDINATION_WEIGHTS = {
  confidence: 0.45,
  semanticFit: 0.3,
  directMention: 0.15,
  continuity: 0.08,
  underParticipation: 0.08,
  redundancy: 0.25,
  recentSpeaker: 0.12,
  dogpile: 0.3,
  saturation: 0.3,
  interruption: 0.25,
  targetSteal: 0.35,
  /** Base speak threshold — a window may resolve with NO winner below it. */
  speakThresholdBase: 0.25,
  /** Lower bar when a bot is directly addressed (conversational obligation). */
  speakThresholdDirect: 0.12,
  /** Minimum confidence for a direct-target bid to OWN its obligation — a
   *  bot that barely decided to answer must not hold the floor hostage. */
  targetValidityMinConfidence: 0.3,
} as const;

// ─── Small pure helpers ──────────────────────────────────────────────────────

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "your", "with", "this",
  "that", "have", "from", "was", "were", "they", "them", "their", "there",
  "what", "when", "where", "which", "while", "about", "would", "could",
  "should", "does", "just", "like", "some", "more", "very", "into", "than",
  "then", "been", "being", "will", "wanna", "gonna", "really", "actually",
  "literally", "basically", "over", "after", "before", "because", "everyone",
  "someone", "something", "anything", "nothing", "here", "chat", "guys",
]);

/** Deterministic keyword extraction (frequency, then lexicographic tiebreak). */
export function extractKeywords(text: string, max: number): string[] {
  if (!text) return [];
  const counts = new Map<string, number>();
  const words = text.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/);
  for (const w of words) {
    if (w.length < 4 || STOPWORDS.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([w]) => w);
}

function tokenizeWords(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter((w) => w.length > 0),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const w of small) if (large.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

/** Keyword-set overlap: |A ∩ B| / min(|A|, |B|) — partial credit friendly. */
function keywordOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const bs = new Set(b);
  let inter = 0;
  for (const w of new Set(a)) if (bs.has(w)) inter++;
  return inter / Math.min(a.length, b.length);
}

/** Functions that "complete" a topic — duplicates of these are functional dupes. */
const INFORMATIONAL_FUNCTIONS: ReadonlySet<ResponseFunction> = new Set([
  "answer", "analyze", "clarify", "summarize",
]);

function normalizeTarget(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const t = name.trim().toLowerCase().replace(/^@/, "");
  return t.length > 0 ? t : undefined;
}

/** Content words (stopwords dropped, naive plural stem) for paraphrase match. */
function stemContentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of tokenizeWords(text)) {
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    out.add(w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w);
  }
  return out;
}

// ─── Persona projection ──────────────────────────────────────────────────────

/**
 * Affinity boosts per existing MADchatter profile id. These reuse the
 * documented profile definitions (prompts.ts) — the projection never invents
 * new personas, it maps the ones the product already has onto coordination
 * affinities.
 */
const PROFILE_AFFINITY_BOOSTS: Record<string, Partial<CoordinationPersonaProfile["affinities"]>> = {
  analyst: { analysis: 0.9, challenge: 0.5 },
  gremlin: { humor: 0.9, conciseReaction: 0.65 },
  hype: { hype: 0.9, conciseReaction: 0.55 },
  support: { empathy: 0.9 },
  questioner: { challenge: 0.85, analysis: 0.5 },
  translator: { analysis: 0.6, storytelling: 0.55 },
};

/**
 * How much a persona's affinities reward each response function. A function's
 * fit is the max over its weighted affinities, so mixed personas (e.g.
 * analyst+gremlin) can be decent at several things without being best at all
 * of them.
 */
const FUNCTION_AFFINITY_MAP: Record<ResponseFunction, Array<[keyof CoordinationPersonaProfile["affinities"], number]>> = {
  answer: [["analysis", 1]],
  analyze: [["analysis", 1]],
  joke: [["humor", 1]],
  react: [["conciseReaction", 0.7], ["hype", 0.5]],
  hype: [["hype", 1]],
  clarify: [["analysis", 0.7], ["empathy", 0.5]],
  callback: [["humor", 0.7], ["storytelling", 0.5]],
  support: [["empathy", 1]],
  challenge: [["challenge", 1]],
  summarize: [["storytelling", 0.6], ["analysis", 0.6]],
  emote: [["conciseReaction", 1], ["hype", 0.6]],
};

function affinityForFunction(
  profile: CoordinationPersonaProfile,
  fn: ResponseFunction,
): number {
  let best = 0;
  for (const [key, weight] of FUNCTION_AFFINITY_MAP[fn]) {
    best = Math.max(best, profile.affinities[key] * weight);
  }
  return best;
}

/** Map an AutoForge decision type onto its intended response function. */
export function decisionResponseFunction(decision: string): ResponseFunction | undefined {
  switch (decision) {
    case "short_reaction": return "react";
    case "emote_only": return "emote";
    case "joke_callback": return "callback";
    case "quick_followup": return "callback";
    case "meta_observation": return "summarize";
    // full_forge picks its angle from the opportunity itself.
    default: return undefined;
  }
}

/**
 * Derive the coordination profile from an existing ForgeConfig. Deterministic,
 * allocation-light, and cached by the caller if desired (re-deriving per cycle
 * is also fine — it is pure arithmetic over small arrays).
 */
export function deriveCoordinationProfile(
  config: ForgeConfig,
  botId = "",
): CoordinationPersonaProfile {
  const affinities: CoordinationPersonaProfile["affinities"] = {
    analysis: 0.4,
    humor: 0.4,
    hype: 0.4,
    empathy: 0.4,
    challenge: 0.4,
    conciseReaction: 0.45,
    storytelling: 0.4,
  };

  const profiles = [...(config.activeProfiles ?? [])];
  if (config.primaryProfile && !profiles.includes(config.primaryProfile)) {
    profiles.push(config.primaryProfile);
  }
  for (const p of profiles) {
    const boost = PROFILE_AFFINITY_BOOSTS[String(p).toLowerCase()];
    if (boost) {
      for (const [k, v] of Object.entries(boost)) {
        const key = k as keyof CoordinationPersonaProfile["affinities"];
        affinities[key] = Math.max(affinities[key], v as number);
      }
    }
  }

  // Sliders contribute — they never masquerade as the whole semantic.
  // A high humor slider makes any persona funnier; a gremlin stays a gremlin
  // even at a modest humor setting (persona identity dominates).
  affinities.humor = Math.max(affinities.humor, (config.humorLevel / 100) * 0.85);

  const verbosity =
    config.lengthPreference === "short" ? 0.25 :
    config.lengthPreference === "long" ? 0.8 : 0.5;

  const chaos = config.chaosLevel ?? 50;

  return {
    botId,
    affinities,
    topicHints: extractKeywords(
      `${config.customDirectives ?? ""} ${config.additionalInstructions ?? ""}`,
      8,
    ),
    participationStyle: {
      assertiveness: clamp01(0.5 + (chaos - 50) / 200),
      spontaneity: clamp01(chaos / 100),
      verbosity,
    },
  };
}

// ─── Opportunity classification ──────────────────────────────────────────────

export interface OpportunityClassificationInput {
  requests: SemanticBidRequest[];
  ledger: ConversationalLedgerEntry[];
  now: number;
}

/**
 * Deterministic opportunity classification. Uses only candidate-carried
 * hints (mention flags, question/social detection computed in the bot loops
 * from the shared chat log) plus ledger evidence — no AI call, ever.
 */
export function classifyOpportunity(
  input: OpportunityClassificationInput,
): ConversationOpportunity {
  const { requests, ledger, now } = input;

  const mentioned = requests.filter((r) => r.candidate.isMentioned);
  const targetBotIds = mentioned.map((r) => r.botId);

  // Triggering human evidence: most recent human ledger entries.
  const recentHuman = [...ledger].reverse().filter((e) => e.speakerType === "human").slice(0, 3);
  const lastHuman = recentHuman[0];

  // Streamer callout: the mention came through audio/transcript (the person
  // speaking on stream is the streamer).
  const audioMention = mentioned.some(
    (r) => r.candidate.mentionSource === "audio" || r.candidate.mentionSource === "both",
  );

  const questionPending = requests.some((r) => r.candidate.questionPending);
  const socialOpening = requests.some((r) => r.candidate.socialOpening);

  // Human thread health: ≥2 distinct humans spoke within the thread window
  // and the latest of them was recent. Bot entries never count.
  const threadHumans = ledger.filter(
    (e) => e.speakerType === "human" && now - e.timestamp <= SEMANTIC_COORDINATION_LIMITS.humanThreadWindowMs,
  );
  const distinctHumans = new Set(threadHumans.map((e) => e.speakerId));
  const humanThreadActive =
    distinctHumans.size >= 2 &&
    lastHuman !== undefined &&
    now - lastHuman.timestamp <= SEMANTIC_COORDINATION_LIMITS.humanThreadRecencyMs;

  let source: OpportunitySource;
  if (mentioned.length > 0) {
    source = audioMention && mentioned.every((r) => r.candidate.mentionSource === "audio")
      ? "streamer_callout"
      : "direct_mention";
  } else if (socialOpening) {
    source = "social_opening";
  } else if (questionPending) {
    source = "topic";
  } else if (humanThreadActive) {
    source = "reply_thread";
  } else {
    // Room event: a burst of human chat (hype/eruption) with no specific
    // trigger — reaction/hype territory. Bot-to-bot followup: the most recent
    // entries are bot sends (Supercharge territory). Neither is ever counted
    // as human momentum for thread health.
    const burst = ledger.filter(
      (e) => e.speakerType === "human" && now - e.timestamp <= 15_000,
    ).length >= 3;
    const tail = [...ledger].reverse();
    const lastTwo = tail.slice(0, 2);
    source = burst
      ? "room_event"
      : lastTwo.length === 2 && lastTwo.every((e) => e.speakerType === "bot")
        ? "bot_followup"
        : "topic";
  }

  // Response functions the opportunity calls for.
  let responseFunctions: ResponseFunction[];
  const mentionQuestion = mentioned.some((r) => r.candidate.questionPending);
  switch (source) {
    case "direct_mention":
      responseFunctions = mentionQuestion
        ? ["answer", "analyze", "clarify"]
        : ["react", "joke", "support"];
      break;
    case "streamer_callout":
      responseFunctions = ["answer", "react", "hype"];
      break;
    case "social_opening":
      responseFunctions = ["support", "react"];
      break;
    case "topic":
      responseFunctions = questionPending
        ? ["answer", "analyze", "clarify"]
        : ["react", "analyze", "hype"];
      break;
    case "reply_thread":
      responseFunctions = ["react", "support", "analyze"];
      break;
    case "room_event":
      responseFunctions = ["react", "hype", "joke"];
      break;
    case "bot_followup":
      responseFunctions = ["react", "callback", "joke"];
      break;
  }

  const targetUserId =
    normalizeTarget(mentioned[0]?.candidate.targetUsername) ??
    normalizeTarget(lastHuman?.speakerUsername) ??
    undefined;

  const topicHints = extractKeywords(
    recentHuman.map((e) => (e.message ?? "")).join(" ") || " ",
    6,
  );

  const urgency =
    source === "streamer_callout" ? 0.95 :
    source === "direct_mention" ? 0.9 :
    source === "social_opening" ? 0.6 :
    questionPending ? 0.6 :
    source === "bot_followup" ? 0.2 : 0.35;

  return {
    id: `opp_${now}_${input.requests.length}`,
    timestamp: now,
    source,
    targetBotIds,
    targetUserId,
    topicHints,
    responseFunctions,
    urgency,
    confidence: mentioned.length > 0 ? 0.95 : recentHuman.length > 0 ? 0.6 : 0.35,
    humanOriginated: mentioned.length > 0 || (lastHuman !== undefined && now - lastHuman.timestamp < 60_000),
    humanThreadActive,
    evidenceRefs: recentHuman.slice(0, 3).map((e) => e.id),
  };
}

// ─── Semantic fit ────────────────────────────────────────────────────────────

/**
 * Bounded semantic fit (0..1): does this persona suit THIS opportunity?
 *
 *   semanticFit = 0.55 × functionFit + 0.30 × topicFit + 0.15 × toneFit
 *
 * functionFit is persona affinity for the contribution the bot intends (or the
 * best function the opportunity allows, for full_forge), damped when the
 * intended function is off-opportunity. topicFit is keyword overlap between
 * the opportunity and the persona's directive-derived interests. toneFit
 * aligns empathy/hype with the room's sentiment lane. No single slider can
 * dominate: chaosLevel only modulates spontaneity, never fit directly.
 */
export function computeSemanticFit(
  opportunity: ConversationOpportunity,
  profile: CoordinationPersonaProfile | undefined,
  candidate: SemanticCandidate,
): number {
  if (!profile) {
    // Legacy candidate without a persona projection — degrade to the
    // caller-provided preview so old callers keep their tiebreak behavior.
    return clamp01(candidate.personaFit);
  }

  const intended = decisionResponseFunction(candidate.decision);
  let functionFit: number;
  if (intended) {
    const affinity = affinityForFunction(profile, intended);
    // Off-function contributions are allowed (a comic CAN answer) but weaker —
    // the ensemble prefers the persona the moment calls for.
    functionFit = opportunity.responseFunctions.includes(intended)
      ? affinity
      : affinity * 0.4;
  } else {
    // full_forge: the model picks its angle from context — score the best
    // function the opportunity allows.
    let best = 0;
    for (const fn of opportunity.responseFunctions) {
      best = Math.max(best, affinityForFunction(profile, fn));
    }
    functionFit = best;
  }

  const topicFit =
    profile.topicHints.length === 0 || opportunity.topicHints.length === 0
      ? 0.5 // neutral when either side has no reliable topic evidence
      : clamp01(keywordOverlap(opportunity.topicHints, profile.topicHints) * 0.6 + 0.3);

  // Tone fit: support/empathy personalities fit negative-sentiment moments,
  // hype personalities fit celebratory ones. Derived from the triggering
  // source — cheap and deterministic.
  const toneFit =
    opportunity.source === "social_opening"
      ? profile.affinities.empathy
      : opportunity.source === "room_event" || opportunity.source === "bot_followup"
        ? profile.affinities.hype
        : 0.5;

  return clamp01(0.55 * functionFit + 0.3 * topicFit + 0.15 * toneFit);
}

/**
 * Cheap preview of persona fit for HUD/decision-record display. The real fit
 * is computed at floor resolution against the shared opportunity; this
 * estimates it from the same affinity tables so the number users see means
 * the same thing.
 */
export function previewSemanticFit(
  profile: CoordinationPersonaProfile,
  hints: { isMentioned?: boolean; questionPending?: boolean; socialOpening?: boolean; hypeMoment?: boolean },
): number {
  const fns: ResponseFunction[] = hints.questionPending
    ? ["answer", "analyze"]
    : hints.socialOpening
      ? ["support"]
      : hints.hypeMoment
        ? ["hype", "joke", "react"]
        : ["react", "analyze"];
  let best = 0;
  for (const fn of fns) best = Math.max(best, affinityForFunction(profile, fn));
  let fit = 0.55 * best + 0.45 * 0.5; // neutral topic/tone preview
  if (hints.isMentioned) fit = Math.min(1, fit + 0.2);
  return round2(clamp01(fit));
}

// ─── Coordination context & scoring ───────────────────────────────────────────

export interface CoordinationContext {
  opportunity: ConversationOpportunity;
  ledger: ConversationalLedgerEntry[];
  now: number;
  /** Supercharge relaxes saturation but keeps loop detection. */
  supercharge: boolean;
  /** Number of active bots (participation-pressure scaling). */
  botCount: number;
}

export interface WindowResolution {
  winnerBotId: string | null;
  bids: SemanticBotBid[];
  dispositions: Map<string, { disposition: BotDisposition; reason: string; finalScore: number }>;
  outcome: CoordinationOutcome;
  reason: string;
  receipt: CoordinationReceipt;
}

function lastBotSend(ledger: ConversationalLedgerEntry[], botId: string): ConversationalLedgerEntry | undefined {
  for (let i = ledger.length - 1; i >= 0; i--) {
    if (ledger[i].speakerType === "bot" && ledger[i].speakerId === botId) return ledger[i];
  }
  return undefined;
}

/** Global ensemble saturation from the bounded ledger. Bot-only. */
export function computeSaturation(
  ledger: ConversationalLedgerEntry[],
  now: number,
  supercharge: boolean,
): { penalty: number; botOnlyStreak: number; botShare: number } {
  const L = SEMANTIC_COORDINATION_LIMITS;
  const recent = ledger.slice(-L.saturationWindowCount).filter(
    (e) => now - e.timestamp <= L.saturationWindowMs,
  );
  if (recent.length < 6) {
    return { penalty: 0, botOnlyStreak: trailingBotStreak(ledger), botShare: 0 };
  }
  const botCount = recent.filter((e) => e.speakerType === "bot").length;
  const botShare = botCount / recent.length;

  let lastHumanAt = -Infinity;
  for (let i = ledger.length - 1; i >= 0; i--) {
    if (ledger[i].speakerType === "human") { lastHumanAt = ledger[i].timestamp; break; }
  }
  const timeSinceHuman = now - lastHumanAt;

  let p =
    0.5 * clamp01((botShare - 0.35) / 0.4) +
    0.3 * clamp01((trailingBotStreak(ledger) - 2) / 3) +
    0.2 * (timeSinceHuman > 180_000 && botShare > 0.3 ? 1 : 0);
  if (supercharge) p *= 0.5; // the user asked for maximum engagement
  return { penalty: clamp01(p), botOnlyStreak: trailingBotStreak(ledger), botShare };
}

function trailingBotStreak(ledger: ConversationalLedgerEntry[]): number {
  let streak = 0;
  for (let i = ledger.length - 1; i >= 0; i--) {
    if (ledger[i].speakerType === "bot") streak++;
    else break;
  }
  return streak;
}

/** Cross-bot redundancy: has another bot already covered this? */
export function computeRedundancy(
  botId: string,
  payload: string | undefined,
  intended: ResponseFunction | undefined,
  opportunity: ConversationOpportunity,
  ledger: ConversationalLedgerEntry[],
  now: number,
  isGreeting: boolean,
): { penalty: number; reason?: string } {
  const L = SEMANTIC_COORDINATION_LIMITS;
  const window = ledger.filter(
    (e) => e.speakerType === "bot" && e.speakerId !== botId && now - e.timestamp <= L.redundancyWindowMs,
  );
  let worst = 0;
  let reason: string | undefined;

  const payloadTokens = payload ? tokenizeWords(payload) : null;

  for (const entry of window) {
    // Greeting cohort spacing: one arrival greeting per window unless human
    // conversation has flowed since.
    if (isGreeting && entry.isGreeting) {
      const humanSince = ledger.some(
        (h) => h.speakerType === "human" && h.timestamp > entry.timestamp,
      );
      if (!humanSince && now - entry.timestamp <= L.greetingSpacingMs) {
        if (worst < 1) { worst = 1; reason = "greeting already sent this window"; }
        continue;
      }
    }

    // Lexical duplicate — reworded included. Two signals: full-set Jaccard on
    // raw tokens (strong), and stemmed content-word overlap relative to the
    // smaller message (catches paraphrases that dilute the union, e.g.
    // "haste is better because it aligns with cooldowns" vs "haste pulls
    // ahead because cooldown windows line up").
    if (payload && entry.message) {
      if (payloadTokens && payloadTokens.size >= 3 && tokenizeWords(entry.message).size >= 3) {
        if (jaccard(payloadTokens, tokenizeWords(entry.message)) >= 0.6) {
          if (worst < 1) { worst = 1; reason = "another bot said essentially the same thing"; }
          continue;
        }
      }
      const stemA = stemContentWords(payload);
      const stemB = stemContentWords(entry.message);
      if (stemA.size >= 2 && stemB.size >= 2) {
        let stemInter = 0;
        for (const w of stemA) if (stemB.has(w)) stemInter++;
        const stemOverlap = stemInter / Math.min(stemA.size, stemB.size);
        if (stemOverlap >= 0.4 && stemInter >= 2) {
          if (worst < 1) { worst = 1; reason = "another bot said essentially the same thing"; }
          continue;
        }
      }
    }

    // Functional duplicate: intended function known (short_reaction etc.) →
    // exact comparison. Unknown (full_forge picks its own angle) → assume a
    // different angle unless the lexical signals above already caught it; a
    // prior informational entry only lightly dampens another full answer on
    // the same topic (it might genuinely add information).
    const overlap = keywordOverlap(opportunity.topicHints, entry.topicHints);
    if (overlap >= 0.34) {
      const candidateFn =
        intended ??
        (opportunity.responseFunctions.find((f) => INFORMATIONAL_FUNCTIONS.has(f)) ??
          opportunity.responseFunctions[0]);
      const entryFn = entry.responseFunction;
      const sameFn =
        intended !== undefined &&
        entryFn !== undefined &&
        (candidateFn === entryFn ||
          (INFORMATIONAL_FUNCTIONS.has(candidateFn) && INFORMATIONAL_FUNCTIONS.has(entryFn)));
      const p = sameFn ? 0.7 : 0.2;
      if (p > worst) {
        worst = p;
        reason = sameFn
          ? "another bot already covered this topic the same way"
          : "topic partially covered (different angle allowed)";
      }
    }
  }
  return { penalty: clamp01(worst), reason };
}

/** Dogpile: multiple bots hitting the same human/message/topic at once. */
export function computeDogpile(
  botId: string,
  targetUserId: string | undefined,
  opportunity: ConversationOpportunity,
  ledger: ConversationalLedgerEntry[],
  now: number,
): { penalty: number; reason?: string } {
  const L = SEMANTIC_COORDINATION_LIMITS;
  const social = opportunity.source === "social_opening";
  const target = normalizeTarget(targetUserId);
  const hits = ledger.filter((e) => {
    if (e.speakerType !== "bot" || e.speakerId === botId) return false;
    if (now - e.timestamp > L.dogpileWindowMs) return false;
    // A prior welcome is pile-on even without target attribution.
    if (social && e.isGreeting) return true;
    if (normalizeTarget(e.targetId) === target) return true;
    // Same-topic hit: piling onto the same message/topic.
    return (
      target !== undefined &&
      keywordOverlap(opportunity.topicHints, e.topicHints) >= 0.34
    );
  }).length;
  if (social) {
    // One welcome feels human; three feels synthetic.
    return hits >= 1
      ? { penalty: 1, reason: "another bot already welcomed this viewer" }
      : { penalty: 0 };
  }
  if (hits >= 2) return { penalty: 1, reason: "bots are swarming this target" };
  if (hits === 1) return { penalty: 0.5, reason: "another bot just replied to this viewer" };
  return { penalty: 0 };
}

function computeRecentSpeakerPenalty(
  ledger: ConversationalLedgerEntry[],
  botId: string,
  now: number,
): { penalty: number; reason?: string } {
  const L = SEMANTIC_COORDINATION_LIMITS;
  const last = lastBotSend(ledger, botId);
  if (!last) return { penalty: 0 };
  const dt = now - last.timestamp;
  if (dt > L.recentSpeakerWindowMs) return { penalty: 0 };
  let p = 0.4 + 0.6 * (1 - dt / L.recentSpeakerWindowMs);
  const recentCount = ledger.filter(
    (e) => e.speakerType === "bot" && e.speakerId === botId && now - e.timestamp <= L.saturationWindowMs,
  ).length;
  if (recentCount >= 3) p += 0.3;
  return { penalty: clamp01(p), reason: "spoke recently" };
}

function computeContinuity(
  ledger: ConversationalLedgerEntry[],
  botId: string,
  opportunity: ConversationOpportunity,
  now: number,
): number {
  if (!opportunity.targetUserId) return 0;
  const target = normalizeTarget(opportunity.targetUserId)!;
  const engaged = ledger.some(
    (e) =>
      e.speakerType === "bot" &&
      e.speakerId === botId &&
      normalizeTarget(e.targetId) === target &&
      now - e.timestamp <= SEMANTIC_COORDINATION_LIMITS.saturationWindowMs,
  );
  return engaged ? 0.6 : 0;
}

function computeUnderParticipation(
  ledger: ConversationalLedgerEntry[],
  botId: string,
  firstMessagePending: boolean,
  now: number,
): number {
  if (firstMessagePending) return 1; // arrival greeting is owed a turn
  const last = lastBotSend(ledger, botId);
  if (!last) return 0.5;
  const quiet = now - last.timestamp;
  if (quiet > 8 * 60_000) return 1;
  if (quiet > 3 * 60_000) return 0.5;
  return 0;
}

function speakThreshold(
  opportunity: ConversationOpportunity,
  saturationPenalty: number,
  supercharge: boolean,
): number {
  let t: number = SEMANTIC_COORDINATION_WEIGHTS.speakThresholdBase;
  if (opportunity.source === "direct_mention" || opportunity.source === "streamer_callout") {
    t = SEMANTIC_COORDINATION_WEIGHTS.speakThresholdDirect;
  }
  if (saturationPenalty > 0.5) t += 0.15;
  if (opportunity.humanThreadActive && opportunity.targetBotIds.length === 0) t += 0.08;
  if (supercharge) t -= 0.05;
  return Math.min(0.5, Math.max(0.1, t));
}

/**
 * Deterministic floor resolution over all valid bids. Pure — the engine wraps
 * this with its ledger and records the receipt.
 *
 * Order: score every bid → if a directly-addressed bot made a valid bid,
 * everyone else defers to it (target steal) → rank → threshold → winner or
 * collective silence. Ties: score desc, then oldest bid, then botId — stable.
 */
export function resolveSemanticBids(
  requests: SemanticBidRequest[],
  ctx: CoordinationContext,
): WindowResolution {
  const W = SEMANTIC_COORDINATION_WEIGHTS;
  const L = SEMANTIC_COORDINATION_LIMITS;
  const { opportunity, ledger, now, supercharge } = ctx;

  const saturation = computeSaturation(ledger, now, supercharge);
  const maxStreak = supercharge ? L.maxSuperchargeBotOnlyStreak : L.maxBotOnlyStreak;
  const loopSuppressed = saturation.botOnlyStreak >= maxStreak;

  const bids: SemanticBotBid[] = requests.map((r) => {
    const c = r.candidate;
    const intended = decisionResponseFunction(c.decision);
    const semanticFit = computeSemanticFit(opportunity, c.personaProfile, c);
    const redundancy = computeRedundancy(
      r.botId, c.payload, intended, opportunity, ledger, now, !!c.firstMessagePending,
    );
    const dogpile = computeDogpile(r.botId, opportunity.targetUserId, opportunity, ledger, now);
    const recentSpeaker = computeRecentSpeakerPenalty(ledger, r.botId, now);
    const continuity = computeContinuity(ledger, r.botId, opportunity, now);
    // Under-participation is a fairness pressure, not a license: it scales by
    // semantic fit (a quiet bot that FITS is owed a look; a poor fit is not),
    // and vanishes entirely while humans are healthily conversing (staying
    // out of a human thread is not under-participation).
    const healthyThread =
      opportunity.humanThreadActive &&
      !c.isMentioned &&
      opportunity.targetBotIds.length === 0;
    const interruption = healthyThread ? 0.6 : 0;
    const underParticipation =
      computeUnderParticipation(ledger, r.botId, !!c.firstMessagePending, now) *
      semanticFit *
      (1 - interruption);

    const saturationPenalty = loopSuppressed ? 1 : saturation.penalty;

    const finalScore =
      W.confidence * clamp01(c.confidence) +
      W.semanticFit * semanticFit +
      W.directMention * (c.isMentioned ? 1 : 0) +
      W.continuity * continuity +
      W.underParticipation * underParticipation -
      W.redundancy * redundancy.penalty -
      W.recentSpeaker * recentSpeaker.penalty -
      W.dogpile * dogpile.penalty -
      W.saturation * saturationPenalty -
      W.interruption * interruption;

    const reasons: string[] = [
      `confidence ${round2(clamp01(c.confidence))}`,
      `semantic fit ${round2(semanticFit)}`,
    ];
    if (c.isMentioned) reasons.push("directly mentioned");
    if (continuity > 0) reasons.push("established thread with target");
    if (underParticipation >= 1) reasons.push(c.firstMessagePending ? "first message owed" : "long quiet");
    if (redundancy.penalty > 0) reasons.push(`redundancy ${round2(redundancy.penalty)}`);
    if (recentSpeaker.penalty > 0) reasons.push("spoke recently");
    if (dogpile.penalty > 0) reasons.push(`dogpile ${round2(dogpile.penalty)}`);
    if (saturationPenalty > 0) reasons.push(`ensemble saturation ${round2(saturationPenalty)}`);
    if (interruption > 0) reasons.push("healthy human thread");
    if (loopSuppressed) reasons.push("bot-only loop suppression");

    return {
      botId: r.botId,
      opportunityId: opportunity.id,
      eligible: true,
      enqueuedAt: r.enqueuedAt,
      baseConfidence: clamp01(c.confidence),
      semanticFit,
      directMentionScore: c.isMentioned ? 1 : 0,
      continuityScore: continuity,
      underParticipationBonus: underParticipation,
      redundancyPenalty: redundancy.penalty,
      recentSpeakerPenalty: recentSpeaker.penalty,
      dogpilePenalty: dogpile.penalty,
      saturationPenalty,
      interruptionPenalty: interruption,
      targetStealPenalty: 0,
      finalScore: round2(finalScore),
      disposition: "silence",
      reasons,
    };
  });

  const dispositions = new Map<string, { disposition: BotDisposition; reason: string; finalScore: number }>();
  const thresholdFor = (bid: SemanticBotBid) =>
    speakThreshold(opportunity, bid.saturationPenalty, supercharge);

  let outcome: CoordinationOutcome;
  let reason: string;

  if (loopSuppressed && opportunity.targetBotIds.length === 0) {
    for (const bid of bids) {
      dispositions.set(bid.botId, {
        disposition: "silence",
        reason: "bot-only loop suppression",
        finalScore: bid.finalScore,
      });
    }
    outcome = "all_suppressed";
    reason = `bot-only streak ${saturation.botOnlyStreak} ≥ ${maxStreak}`;
    return finish(bids, dispositions, null, outcome, reason, opportunity, now, ctx);
  }

  // Direct-target obligation: a directly addressed bot that cleared the bar
  // owns this opportunity. Others may not steal it; if the target didn't
  // clear the bar (or didn't bid), the floor opens to fair competition.
  const targetBotIds = new Set(opportunity.targetBotIds);
  const targetBids = bids.filter((b) => targetBotIds.has(b.botId));
  const validTargets = targetBids.filter(
    (b) =>
      b.finalScore >= thresholdFor(b) &&
      b.baseConfidence >= SEMANTIC_COORDINATION_WEIGHTS.targetValidityMinConfidence,
  );

  if (validTargets.length > 0) {
    for (const bid of bids) {
      if (targetBotIds.has(bid.botId)) continue;
      bid.targetStealPenalty = 1;
      bid.finalScore = round2(bid.finalScore - W.targetSteal);
      bid.reasons.push("another bot was directly addressed");
    }
    const winner = rankBids(validTargets)[0];
    for (const bid of bids) {
      if (bid === winner) continue;
      dispositions.set(bid.botId, {
        disposition: "defer",
        reason: targetBotIds.has(bid.botId)
          ? "deferred to the stronger direct-target bid"
          : "another bot was directly addressed",
        finalScore: bid.finalScore,
      });
    }
    dispositions.set(winner.botId, { disposition: "speak", reason: "direct target priority", finalScore: winner.finalScore });
    return finish(bids, dispositions, winner.botId, "speaker_selected", "direct target priority", opportunity, now, ctx);
  }

  const ranked = rankBids(bids);
  const best = ranked[0];
  const bestThreshold = thresholdFor(best);

  if (targetBids.length > 0 && validTargets.length === 0) {
    // The addressed bot couldn't clear the bar — open competition, but say so.
    outcome = "direct_target_unavailable";
    reason = "directly addressed bot unavailable/under bar — open competition";
  } else if (best.finalScore < bestThreshold) {
    for (const bid of bids) {
      dispositions.set(bid.botId, {
        disposition: "silence",
        reason: `below speak threshold (${bid.finalScore} < ${round2(bestThreshold)})`,
        finalScore: bid.finalScore,
      });
    }
    return finish(bids, dispositions, null, "collective_silence", `no bid above threshold (${round2(best.finalScore)} < ${round2(bestThreshold)})`, opportunity, now, ctx);
  } else {
    outcome = "speaker_selected";
    reason = "strongest semantic bid";
  }

  for (const bid of bids) {
    if (bid === best) {
      dispositions.set(bid.botId, { disposition: "speak", reason: outcome === "direct_target_unavailable" ? "won open competition (target unavailable)" : "strongest semantic bid", finalScore: bid.finalScore });
    } else {
      dispositions.set(bid.botId, {
        disposition: bid.finalScore >= thresholdFor(bid) ? "defer" : "silence",
        reason: bid.finalScore >= thresholdFor(bid) ? "valid but outbid — better fit elsewhere" : `below speak threshold (${bid.finalScore})`,
        finalScore: bid.finalScore,
      });
    }
  }

  return finish(bids, dispositions, best.botId, outcome, reason, opportunity, now, ctx);
}

function rankBids(bids: SemanticBotBid[]): SemanticBotBid[] {
  return [...bids].sort(
    (a, b) =>
      b.finalScore - a.finalScore ||
      a.enqueuedAt - b.enqueuedAt ||
      a.botId.localeCompare(b.botId),
  );
}

function finish(
  bids: SemanticBotBid[],
  dispositions: Map<string, { disposition: BotDisposition; reason: string; finalScore: number }>,
  winnerBotId: string | null,
  outcome: CoordinationOutcome,
  reason: string,
  opportunity: ConversationOpportunity,
  now: number,
  ctx: CoordinationContext,
): WindowResolution {
  // Sync each bid's inspectable disposition from the resolution map.
  for (const bid of bids) {
    const d = dispositions.get(bid.botId);
    if (d) bid.disposition = d.disposition;
  }
  const receipt: CoordinationReceipt = {
    opportunityId: opportunity.id,
    timestamp: now,
    channel: null,
    candidates: bids.map((b) => ({
      botId: b.botId,
      finalScore: b.finalScore,
      disposition: dispositions.get(b.botId)?.disposition ?? "silence",
      topReasons: b.reasons.slice(0, 4),
    })),
    winnerBotId: winnerBotId ?? undefined,
    outcome,
    reason,
  };
  void ctx;
  return { winnerBotId, bids, dispositions, outcome, reason, receipt };
}

// ─── Engine (bounded ledger + receipts, module singleton) ────────────────────

let ledgerSeq = 0;

export interface BotDispositionInfo {
  disposition: BotDisposition;
  reason: string;
  finalScore: number;
  at: number;
}

export class SemanticCoordinationEngine {
  private channel: string | null = null;
  private ledger: ConversationalLedgerEntry[] = [];
  private receipts: CoordinationReceipt[] = [];
  private lastDispositions = new Map<string, BotDispositionInfo>();

  /** Bind to a channel and wipe ephemeral state (channel switch / reset). */
  reset(channel: string | null): void {
    this.channel = channel !== null && channel !== undefined ? channel.trim().toLowerCase() : null;
    this.ledger = [];
    this.receipts = [];
    this.lastDispositions.clear();
  }

  getChannel(): string | null {
    return this.channel;
  }

  private accept(channel?: string | null): boolean {
    const normalized = channel !== null && channel !== undefined ? channel.trim().toLowerCase() : null;
    // Unbound engine accepts everything (tests / pre-orchestrator wiring);
    // a bound engine only accepts notes for its own channel.
    return this.channel === null || this.channel === normalized;
  }

  /** Human chat ingestion (wired at store-action level, App.tsx). */
  noteHumanChat(input: {
    channel?: string | null;
    username: string;
    text: string;
    timestamp?: number;
    sentimentLabel?: string;
  }): void {
    if (!this.accept(input.channel)) return;
    const timestamp = input.timestamp ?? Date.now();
    const text = input.text.slice(0, SEMANTIC_COORDINATION_LIMITS.maxMessageLength);
    const explicitTarget = /@(\w+)/.exec(input.text)?.[1];
    const isQuestion =
      /\?\s*$/.test(input.text.trim()) ||
      /^(what|which|how|why|when|where|who|can|does|do|is|are|should|could|would|will|anyone|anybody)\b/i.test(input.text.trim());
    this.push({
      id: `led_${timestamp}_${ledgerSeq++}`,
      timestamp,
      channel: this.channel ?? "",
      speakerType: "human",
      speakerId: input.username.toLowerCase(),
      speakerUsername: input.username,
      targetType: explicitTarget ? "human" : "room",
      targetId: normalizeTarget(explicitTarget),
      topicHints: extractKeywords(text, 4),
      responseFunction: isQuestion ? "answer" : "react",
      message: text,
    });
  }

  /** Bot send ingestion (wired in store.addBotSentMessage). */
  noteBotSend(input: {
    channel?: string | null;
    botId: string;
    botUsername?: string;
    message: string;
    timestamp?: number;
    isGreeting?: boolean;
    responseFunction?: ResponseFunction;
    targetId?: string;
  }): void {
    if (!this.accept(input.channel)) return;
    const timestamp = input.timestamp ?? Date.now();
    this.push({
      id: `led_${timestamp}_${ledgerSeq++}`,
      timestamp,
      channel: this.channel ?? "",
      speakerType: "bot",
      speakerId: input.botId,
      speakerUsername: input.botUsername,
      targetType: input.targetId ? "human" : "room",
      targetId: normalizeTarget(input.targetId),
      topicHints: extractKeywords(input.message, 4),
      responseFunction: input.responseFunction,
      isGreeting: input.isGreeting,
      message: input.message.slice(0, SEMANTIC_COORDINATION_LIMITS.maxMessageLength),
    });
  }

  private push(entry: ConversationalLedgerEntry): void {
    this.ledger.push(entry);
    if (this.ledger.length > SEMANTIC_COORDINATION_LIMITS.maxLedgerEntries) {
      this.ledger.splice(0, this.ledger.length - SEMANTIC_COORDINATION_LIMITS.maxLedgerEntries);
    }
  }

  /**
   * Cross-bot duplicate check for the bot loops: is this payload a
   * near-duplicate of what ANOTHER bot sent recently? (Per-bot exact dedup
   * already exists in the loops; this closes the cross-bot gap.)
   */
  isCrossBotDuplicate(botId: string, payload: string, now: number = Date.now()): boolean {
    const L = SEMANTIC_COORDINATION_LIMITS;
    const tokens = tokenizeWords(payload);
    if (tokens.size < 3) return false;
    for (let i = this.ledger.length - 1; i >= 0; i--) {
      const e = this.ledger[i];
      if (now - e.timestamp > L.redundancyWindowMs) break;
      if (e.speakerType !== "bot" || e.speakerId === botId || !e.message) continue;
      const entryTokens = tokenizeWords(e.message);
      if (entryTokens.size < 3) continue;
      if (jaccard(tokens, entryTokens) >= 0.6) return true;
    }
    return false;
  }

  /**
   * Resolve a floor window. Channel-guarded: a window resolved for a
   * different channel than the engine is bound to discards every bid (no
   * stale Channel-A bid may speak in Channel B).
   */
  resolveWindow(
    requests: SemanticBidRequest[],
    opts: { now?: number; channel?: string | null; supercharge?: boolean; botCount?: number },
  ): WindowResolution {
    const now = opts.now ?? Date.now();
    const channel = opts.channel !== null && opts.channel !== undefined ? opts.channel.trim().toLowerCase() : null;
    const supercharge = opts.supercharge ?? false;

    if (this.channel !== null && channel !== null && this.channel !== channel) {
      const bids = requests.map((r) => ({
        botId: r.botId,
        opportunityId: "stale",
        eligible: false,
        enqueuedAt: r.enqueuedAt,
        baseConfidence: 0,
        semanticFit: 0,
        directMentionScore: 0,
        continuityScore: 0,
        underParticipationBonus: 0,
        redundancyPenalty: 0,
        recentSpeakerPenalty: 0,
        dogpilePenalty: 0,
        saturationPenalty: 0,
        interruptionPenalty: 0,
        targetStealPenalty: 0,
        finalScore: 0,
        disposition: "silence" as BotDisposition,
        reasons: ["stale channel — discarded"],
      }));
      const dispositions = new Map<string, { disposition: BotDisposition; reason: string; finalScore: number }>();
      for (const r of requests) {
        dispositions.set(r.botId, { disposition: "silence", reason: "stale channel — discarded", finalScore: 0 });
      }
      const receipt: CoordinationReceipt = {
        opportunityId: `opp_stale_${now}`,
        timestamp: now,
        channel: this.channel,
        candidates: bids.map((b) => ({ botId: b.botId, finalScore: 0, disposition: "silence", topReasons: ["stale channel"] })),
        outcome: "stale_channel",
        reason: `window resolved for channel "${channel}" but engine is bound to "${this.channel}"`,
      };
      this.recordReceipt(receipt, dispositions, now);
      return { winnerBotId: null, bids, dispositions, outcome: "stale_channel", reason: receipt.reason, receipt };
    }

    const opportunity = classifyOpportunity({ requests, ledger: this.ledger, now });
    const result = resolveSemanticBids(requests, {
      opportunity,
      ledger: this.ledger,
      now,
      supercharge,
      botCount: opts.botCount ?? requests.length,
    });
    result.receipt.channel = this.channel;
    this.recordReceipt(result.receipt, result.dispositions, now);
    return result;
  }

  private recordReceipt(
    receipt: CoordinationReceipt,
    dispositions: Map<string, { disposition: BotDisposition; reason: string; finalScore: number }>,
    now: number,
  ): void {
    this.receipts.push(receipt);
    if (this.receipts.length > SEMANTIC_COORDINATION_LIMITS.maxReceipts) {
      this.receipts.splice(0, this.receipts.length - SEMANTIC_COORDINATION_LIMITS.maxReceipts);
    }
    this.lastDispositions.clear();
    for (const [botId, d] of dispositions) {
      this.lastDispositions.set(botId, { ...d, at: now });
    }
  }

  /** Diagnostics: how did this bot's last floor bid resolve? */
  getBotDisposition(botId: string, now: number = Date.now()): BotDispositionInfo | null {
    const info = this.lastDispositions.get(botId);
    if (!info) return null;
    if (now - info.at > SEMANTIC_COORDINATION_LIMITS.dispositionTtlMs) return null;
    return info;
  }

  getLastReceipt(): CoordinationReceipt | null {
    return this.receipts.length > 0 ? this.receipts[this.receipts.length - 1] : null;
  }

  getReceipts(): CoordinationReceipt[] {
    return [...this.receipts];
  }

  getLedgerSnapshot(): ConversationalLedgerEntry[] {
    return [...this.ledger];
  }
}

export const semanticCoordination = new SemanticCoordinationEngine();

// ─── Simulation harness ───────────────────────────────────────────────────────

export interface CoordinationSimulationInput {
  room?: {
    humanThreadActive?: boolean;
    supercharge?: boolean;
    channel?: string;
  };
  opportunity?: Partial<ConversationOpportunity> & {
    source?: OpportunitySource;
    responseFunctions?: ResponseFunction[];
  };
  bots: Array<{
    botId: string;
    confidence: number;
    /** Full profile, or a ForgeConfig to derive one from. */
    persona?: Partial<CoordinationPersonaProfile["affinities"]> | ForgeConfig;
    candidate?: Partial<SemanticCandidate>;
  }>;
  recentLedger?: Array<Partial<ConversationalLedgerEntry> & { speakerType: "human" | "bot"; speakerId: string }>;
  now?: number;
}

export interface CoordinationSimulationResult {
  winner: string | null;
  bids: SemanticBotBid[];
  outcome: CoordinationOutcome;
  reason: string;
}

/**
 * Deterministic coordinator simulation: feed a room, an opportunity, bots,
 * and a recent ledger; receive winner + bids + outcome. Primary regression
 * surface for coordination behavior — no UI/network/provider state involved.
 */
export function runCoordinationSimulation(
  input: CoordinationSimulationInput,
): CoordinationSimulationResult {
  const now = input.now ?? 1_000_000;
  const engine = new SemanticCoordinationEngine();
  engine.reset(input.room?.channel ?? "sim");

  for (const entry of input.recentLedger ?? []) {
    if (entry.speakerType === "human") {
      engine.noteHumanChat({
        channel: input.room?.channel ?? "sim",
        username: entry.speakerId,
        text: entry.message ?? "",
        timestamp: entry.timestamp ?? now - 10_000,
      });
    } else {
      engine.noteBotSend({
        channel: input.room?.channel ?? "sim",
        botId: entry.speakerId,
        message: entry.message ?? "",
        timestamp: entry.timestamp ?? now - 10_000,
        isGreeting: entry.isGreeting,
        targetId: entry.targetId,
        responseFunction: entry.responseFunction,
      });
    }
  }

  const requests: SemanticBidRequest[] = input.bots.map((b, i) => {
    let profile: CoordinationPersonaProfile | undefined;
    if (b.persona) {
      // ForgeConfig → derive; flat affinity map → merge onto neutral defaults.
      if ("humorLevel" in (b.persona as ForgeConfig)) {
        profile = deriveCoordinationProfile(b.persona as ForgeConfig, b.botId);
      } else {
        profile = {
          botId: b.botId,
          affinities: {
            analysis: 0.4, humor: 0.4, hype: 0.4, empathy: 0.4, challenge: 0.4,
            conciseReaction: 0.45, storytelling: 0.4,
            ...(b.persona as Partial<CoordinationPersonaProfile["affinities"]>),
          },
          topicHints: [],
          participationStyle: { assertiveness: 0.5, spontaneity: 0.5, verbosity: 0.5 },
        };
      }
    }
    return {
      botId: b.botId,
      enqueuedAt: now + i,
      candidate: {
        decision: "full_forge",
        confidence: b.confidence,
        personaFit: 0.5,
        personaProfile: profile,
        ...b.candidate,
      } as SemanticCandidate,
    };
  });

  // An explicit opportunity override replaces the classified one (tests pin
  // the opening directly); otherwise the engine classifies from the ledger.
  const supercharge = input.room?.supercharge ?? false;
  let result: WindowResolution;
  if (input.opportunity && Object.keys(input.opportunity).length > 0) {
    const base = classifyOpportunity({ requests, ledger: engine.getLedgerSnapshot(), now });
    const opportunity: ConversationOpportunity = {
      ...base,
      ...input.opportunity,
      targetBotIds: input.opportunity.targetBotIds ?? base.targetBotIds,
      responseFunctions: input.opportunity.responseFunctions ?? base.responseFunctions,
      topicHints: input.opportunity.topicHints ?? base.topicHints,
    };
    result = resolveSemanticBids(requests, {
      opportunity,
      ledger: engine.getLedgerSnapshot(),
      now,
      supercharge,
      botCount: input.bots.length,
    });
  } else {
    result = engine.resolveWindow(requests, {
      now,
      channel: input.room?.channel ?? "sim",
      supercharge,
      botCount: input.bots.length,
    });
  }

  return { winner: result.winnerBotId, bids: result.bids, outcome: result.outcome, reason: result.reason };
}
