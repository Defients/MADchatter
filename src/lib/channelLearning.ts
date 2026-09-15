/**
 * Channel Learning Profile — the closed feedback loop for AutoForge.
 *
 * MADchatter already observes post-send engagement (D4) and session goals,
 * but those signals terminate in analytics. This module converts those
 * observations into a bounded, explainable, per-channel learning signal
 * that can influence future AutoForge decisions as *advisory historical
 * evidence* — never as an instruction to maximize engagement.
 *
 * Design principles (see AGENTS.md "Channel Learning"):
 * - Channel-scoped: what works in one community may fail in another.
 * - Cold start = existing behavior: no evidence → no injected block at all.
 * - Minimum samples + shrinkage toward neutral: five lucky outcomes must
 *   never look as trustworthy as five hundred.
 * - Recency decay: old evidence fades (14-day half-life) but is never
 *   abruptly erased.
 * - Bounded influence: every score lives in [-1, +1] and only enters the
 *   decision prompt as a soft prior below mentions, safety, rate limits,
 *   director notes, and hard rules.
 * - Goodhart resistance: outcomes are normalized against pre-send room
 *   velocity, and bot-generated lines (self or other MADchatter bots) are
 *   structurally excluded from success scoring.
 * - Silence is first-class: restraint followed by a room that stayed
 *   healthy on its own counts as (weak, capped) positive evidence.
 *
 * Everything here is deterministic and local — zero additional AI calls.
 */

import type { ChatMessage, GoalEvaluationResult } from "../types";
import { normalizeSessionChannel } from "./normalizeChannel";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Per-action learned statistics for one channel. All accumulators are
 *  decay-compounded on write so reads need no clock beyond `now`. */
export interface LearnedActionStats {
  sampleCount: number;
  /** Decay-compounded effective evidence weight (≈ recent sample count). */
  effectiveWeight: number;
  /** Decay-compounded weighted outcome sum; per-sample scores ∈ [-1, +1]. */
  weightedOutcome: number;
  /** Faster-decaying accumulators (trend detection only). */
  recentEffectiveWeight: number;
  recentWeightedOutcome: number;
  lastObservedAt?: number;
}

/** What MADchatter has learned about its own behavior in one channel. */
export interface ChannelLearningProfile {
  version: number;
  actions: Record<string, LearnedActionStats>;
  overallSampleCount: number;
  lastUpdatedAt?: number;
}

/** Read-model for one action type (shrinkage + confidence applied). */
export interface LearnedActionView {
  actionType: string;
  samples: number;
  effectiveWeight: number;
  /** Unshrunk decayed average, [-1, +1]. */
  rawScore: number;
  /** Shrunk toward neutral, strictly inside (-1, +1). */
  score: number;
  /** 0..1 — effectiveWeight / (effectiveWeight + PRIOR_WEIGHT). */
  confidence: number;
  trend: "improving" | "stable" | "declining";
  lastObservedAt?: number;
  /** true when effectiveWeight ≥ MIN_EFFECTIVE_WEIGHT (prompt-eligible). */
  actionable: boolean;
}

// ─── Tuning constants (single source of truth — no scattered magic numbers) ──

export const LEARNING_PROFILE_VERSION = 1;

/** Evidence half-life: communities evolve; old observations fade gradually. */
const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
/** Faster half-life for the trend estimator. */
const RECENT_HALF_LIFE_MS = 2 * 24 * 60 * 60 * 1000;
/** Neutral pseudo-samples used for shrinkage toward neutral. */
const PRIOR_WEIGHT = 5;
/** Below this effective weight an action is informational only. */
const MIN_EFFECTIVE_WEIGHT = 3;
/** Cap distinct tracked action types (prunes stale/renamed taxonomies). */
const MAX_TRACKED_ACTIONS = 12;

/** Silence evidence is intentionally weak: capped score + low sample weight. */
export const SILENCE_ACTION = "deliberate_silence";
const SILENCE_MAX_SCORE = 0.2;
export const SILENCE_SAMPLE_WEIGHT = 0.3;
/** At most one silence observation per channel per interval — the loop
 *  decides silence every ~15s and unbounded sampling would swamp sends. */
const SILENCE_MIN_INTERVAL_MS = 10 * 60 * 1000;

/** Pre-send window used to baseline room velocity. */
const PRE_WINDOW_MS = 60 * 1000;
/** Default observation window (matches ENGAGEMENT_CHECK_DELAY_MS in loops). */
export const DEFAULT_OBSERVATION_WINDOW_MS = 30 * 1000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function decay(ageMs: number, halfLifeMs: number): number {
  return ageMs <= 0 ? 1 : Math.pow(0.5, ageMs / halfLifeMs);
}

export function emptyLearningProfile(): ChannelLearningProfile {
  return { version: LEARNING_PROFILE_VERSION, actions: {}, overallSampleCount: 0 };
}

/** Defensive validation for persisted/imported profiles. Malformed data
 *  degrades to a fresh profile or per-field defaults — never crashes. */
export function sanitizeLearningProfile(raw: unknown): ChannelLearningProfile {
  if (!raw || typeof raw !== "object") return emptyLearningProfile();
  const r = raw as Partial<ChannelLearningProfile>;
  const out = emptyLearningProfile();
  out.overallSampleCount =
    typeof r.overallSampleCount === "number" && Number.isFinite(r.overallSampleCount) && r.overallSampleCount >= 0
      ? Math.floor(r.overallSampleCount)
      : 0;
  out.lastUpdatedAt = typeof r.lastUpdatedAt === "number" && Number.isFinite(r.lastUpdatedAt) ? r.lastUpdatedAt : undefined;
  if (r.actions && typeof r.actions === "object") {
    for (const [key, value] of Object.entries(r.actions as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const v = value as Partial<LearnedActionStats>;
      const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
      const entry: LearnedActionStats = {
        sampleCount: Math.max(0, Math.floor(num(v.sampleCount))),
        effectiveWeight: clamp(num(v.effectiveWeight), 0, 1e6),
        weightedOutcome: clamp(num(v.weightedOutcome), -1e6, 1e6),
        recentEffectiveWeight: clamp(num(v.recentEffectiveWeight), 0, 1e6),
        recentWeightedOutcome: clamp(num(v.recentWeightedOutcome), -1e6, 1e6),
        lastObservedAt: typeof v.lastObservedAt === "number" && Number.isFinite(v.lastObservedAt) ? v.lastObservedAt : undefined,
      };
      if (entry.sampleCount > 0 || entry.effectiveWeight > 0) out.actions[key] = entry;
    }
  }
  return out;
}

// ─── Normalization: outcome → bounded feedback (Phase 2) ─────────────────────

export interface NormalizedOutcome {
  /** Bounded feedback signal, [-1, +1]. */
  score: number;
  humanLinesAfter: number;
  botLinesAfter: number;
  humanMentionsAfter: number;
  humanReactionsAfter: number;
  /** Human lines in the pre-send window (baseline room velocity). */
  baselineHumanLines: number;
  /** Baseline-projected expected lines for the observation window. */
  expectedLines: number;
}

/**
 * Convert a sent action's post-send chat observation into a canonical,
 * bounded feedback score.
 *
 * Confounders handled structurally:
 * - Room velocity: continuation is measured *relative to* the pre-send
 *   baseline, so a busy room cannot make mediocre messages look good and
 *   a dead room cannot make silence look brilliant.
 * - Bot attribution: every username in `botUsernames` (the sending bot +
 *   all other active MADchatter bots) is excluded from human counts, so
 *   bots can never manufacture engagement rewards for each other.
 * - Mention responses: when the send answered a direct mention, continued
 *   mentions are discounted (an active exchange already implies them).
 */
export function computeNormalizedOutcome(opts: {
  chatLog: ChatMessage[];
  sentAt: number;
  evaluatedAt?: number;
  botUsernames: string[];
  subjectUsername?: string;
  wasMentionResponse?: boolean;
}): NormalizedOutcome {
  const evaluatedAt = opts.evaluatedAt ?? Date.now();
  const windowMs = clamp(evaluatedAt - opts.sentAt, 5_000, 120_000);
  const windowStart = opts.sentAt;
  const windowEnd = opts.sentAt + windowMs;
  const preStart = opts.sentAt - PRE_WINDOW_MS;

  const bots = new Set(
    opts.botUsernames
      .filter(Boolean)
      .map((u) => u.trim().toLowerCase())
      .filter(Boolean),
  );
  const subject = (opts.subjectUsername || opts.botUsernames[0] || "").trim().toLowerCase();
  const mentionPatterns = subject ? [subject, subject.replace(/[^a-z0-9]/g, "")].filter(Boolean) : [];

  let baselineHumanLines = 0;
  let humanLinesAfter = 0;
  let botLinesAfter = 0;
  let humanMentionsAfter = 0;
  let humanReactionsAfter = 0;

  for (const m of opts.chatLog) {
    if (m.marker) continue;
    const isBot = bots.has(m.user.trim().toLowerCase());
    if (m.timestamp <= windowStart) {
      if (m.timestamp > preStart && !isBot) baselineHumanLines++;
      continue;
    }
    if (m.timestamp > windowEnd) continue;
    if (isBot) {
      botLinesAfter++;
      continue;
    }
    humanLinesAfter++;
    const lower = m.text.toLowerCase();
    if (mentionPatterns.some((p) => lower.includes(p))) humanMentionsAfter++;
    // Reaction heuristic mirrors countPostSendEngagement (autoForgeCore).
    if (m.text.length < 20 && /^[A-Z\s!?]+$/.test(m.text)) humanReactionsAfter++;
  }

  const baselineRate = baselineHumanLines / (PRE_WINDOW_MS / 1000); // lines/sec
  const expectedLines = Math.max(0.5, baselineRate * (windowMs / 1000));

  const mentionScore = Math.min(1, humanMentionsAfter / 2) * (opts.wasMentionResponse ? 0.7 : 1);
  const reactionScore = Math.min(1, humanReactionsAfter / 3);
  const continuation = clamp((humanLinesAfter - expectedLines) / Math.max(2, expectedLines), -1, 1);
  // The room was visibly talking (≥3 baseline lines/min) and then produced
  // zero human lines — mild negative, never catastrophic (could be chance).
  const ignorePenalty = baselineHumanLines >= 3 && humanLinesAfter === 0 ? 1 : 0;

  const score = clamp(
    0.45 * mentionScore + 0.2 * reactionScore + 0.25 * continuation - 0.2 * ignorePenalty,
    -1,
    1,
  );

  return {
    score,
    humanLinesAfter,
    botLinesAfter,
    humanMentionsAfter,
    humanReactionsAfter,
    baselineHumanLines,
    expectedLines,
  };
}

// ─── Silence evidence (first-class restraint) ────────────────────────────────

export interface SilenceOutcome {
  /** True only when the room stayed organically healthy without the bot —
   *  the one counterfactual we can honestly observe. */
  eligible: boolean;
  score: number;
  humanLinesAfter: number;
  baselineHumanLines: number;
}

/**
 * Score a deliberate_silence decision. Only positive, capped, low-weight
 * evidence is ever produced: "the room didn't need us" is observable;
 * "speaking would have helped" is not, so no negative silence evidence
 * is ever fabricated.
 */
export function computeSilenceOutcome(opts: {
  chatLog: ChatMessage[];
  decidedAt: number;
  evaluatedAt?: number;
  botUsernames: string[];
}): SilenceOutcome {
  const evaluatedAt = opts.evaluatedAt ?? Date.now();
  const windowMs = clamp(evaluatedAt - opts.decidedAt, 5_000, 120_000);
  const windowEnd = opts.decidedAt + windowMs;
  const preStart = opts.decidedAt - PRE_WINDOW_MS;

  const bots = new Set(
    opts.botUsernames
      .filter(Boolean)
      .map((u) => u.trim().toLowerCase())
      .filter(Boolean),
  );

  let baselineHumanLines = 0;
  let humanLinesAfter = 0;
  for (const m of opts.chatLog) {
    if (m.marker) continue;
    if (bots.has(m.user.trim().toLowerCase())) continue;
    if (m.timestamp <= opts.decidedAt) {
      if (m.timestamp > preStart) baselineHumanLines++;
    } else if (m.timestamp <= windowEnd) {
      humanLinesAfter++;
    }
  }

  // Room was alive before AND stayed alive without the bot (≥60% of the
  // baseline-projected pace). Both conditions must hold — silence during a
  // dead room proves nothing.
  const baselineRate = baselineHumanLines / (PRE_WINDOW_MS / 1000);
  const expected = Math.max(0.5, baselineRate * (windowMs / 1000));
  const eligible = baselineHumanLines >= 2 && humanLinesAfter >= expected * 0.6;

  return { eligible, score: SILENCE_MAX_SCORE, humanLinesAfter, baselineHumanLines };
}

/** Cadence gate: silence decisions repeat every ~15s; sample them sparsely
 *  so restraint evidence cannot numerically swamp send evidence. */
export function shouldRecordSilenceObservation(profile: ChannelLearningProfile, now: number): boolean {
  const last = profile.actions[SILENCE_ACTION]?.lastObservedAt;
  return !last || now - last >= SILENCE_MIN_INTERVAL_MS;
}

// ─── Aggregation: decay + accumulate (Phase 3) ────────────────────────────────

/**
 * Record one outcome for an action type. Existing evidence is decayed to
 * `now` before merging, so old observations lose influence gradually and
 * repeatedly applying over a span equals one application over that span.
 */
export function recordLearningOutcome(
  profile: ChannelLearningProfile,
  actionType: string,
  score: number,
  now: number,
  sampleWeight: number = 1,
): ChannelLearningProfile {
  if (!actionType) return profile;
  const s = clamp(score, -1, 1);
  const w = clamp(sampleWeight, 0, 1);
  const prev = profile.actions[actionType];
  const d = prev?.lastObservedAt ? decay(now - prev.lastObservedAt, HALF_LIFE_MS) : 1;
  const rd = prev?.lastObservedAt ? decay(now - prev.lastObservedAt, RECENT_HALF_LIFE_MS) : 1;

  const next: LearnedActionStats = {
    sampleCount: (prev?.sampleCount ?? 0) + 1,
    effectiveWeight: (prev?.effectiveWeight ?? 0) * d + w,
    weightedOutcome: (prev?.weightedOutcome ?? 0) * d + s * w,
    recentEffectiveWeight: (prev?.recentEffectiveWeight ?? 0) * rd + w,
    recentWeightedOutcome: (prev?.recentWeightedOutcome ?? 0) * rd + s * w,
    lastObservedAt: now,
  };

  const actions: Record<string, LearnedActionStats> = { ...profile.actions, [actionType]: next };
  const keys = Object.keys(actions);
  if (keys.length > MAX_TRACKED_ACTIONS) {
    const sorted = keys.sort((a, b) => (actions[a].lastObservedAt ?? 0) - (actions[b].lastObservedAt ?? 0));
    for (const k of sorted.slice(0, keys.length - MAX_TRACKED_ACTIONS)) delete actions[k];
  }

  return {
    version: LEARNING_PROFILE_VERSION,
    actions,
    overallSampleCount: profile.overallSampleCount + 1,
    lastUpdatedAt: now,
  };
}

/**
 * Read learned stats for one action type with shrinkage toward neutral:
 *
 *   score       = (decayed outcome sum) / (effectiveWeight + PRIOR_WEIGHT)
 *   confidence  = effectiveWeight / (effectiveWeight + PRIOR_WEIGHT)
 *
 * Small datasets therefore produce small scores AND small confidence —
 * five good outcomes never look like five hundred.
 */
export function getLearnedActionStats(
  profile: ChannelLearningProfile,
  actionType: string,
  now: number = Date.now(),
): LearnedActionView | null {
  const entry = profile.actions[actionType];
  if (!entry || (entry.sampleCount <= 0 && entry.effectiveWeight <= 0)) return null;
  const d = entry.lastObservedAt ? decay(now - entry.lastObservedAt, HALF_LIFE_MS) : 1;
  const rd = entry.lastObservedAt ? decay(now - entry.lastObservedAt, RECENT_HALF_LIFE_MS) : 1;

  const weight = entry.effectiveWeight * d;
  const outcomeSum = entry.weightedOutcome * d;
  const rawScore = weight > 0 ? outcomeSum / weight : 0;
  const score = outcomeSum / (weight + PRIOR_WEIGHT);
  const confidence = weight / (weight + PRIOR_WEIGHT);

  let trend: LearnedActionView["trend"] = "stable";
  const recentWeight = entry.recentEffectiveWeight * rd;
  if (recentWeight >= 1 && weight >= 2) {
    const recentAvg = (entry.recentWeightedOutcome * rd) / recentWeight;
    const overallAvg = rawScore;
    const diff = recentAvg - overallAvg;
    if (diff > 0.15) trend = "improving";
    else if (diff < -0.15) trend = "declining";
  }

  return {
    actionType,
    samples: entry.sampleCount,
    effectiveWeight: weight,
    rawScore,
    score,
    confidence,
    trend,
    lastObservedAt: entry.lastObservedAt,
    actionable: weight >= MIN_EFFECTIVE_WEIGHT,
  };
}

// ─── Prompt blocks (Phase 5 — decision integration) ──────────────────────────

function formatScore(score: number): string {
  return `${score >= 0 ? "+" : ""}${score.toFixed(2)}`;
}

export function describeConfidence(confidence: number): "high" | "medium" | "low" {
  if (confidence >= 0.7) return "high";
  if (confidence >= 0.45) return "medium";
  return "low";
}

function describeActionType(actionType: string): string {
  return actionType.replace(/_/g, " ");
}

/**
 * Build the compact, token-efficient self-performance block injected into
 * the AutoForge decision prompt. Returns null when there is no actionable
 * evidence (cold start → the block is omitted entirely, preserving
 * existing behavior exactly).
 *
 * The block is phrased as advisory historical evidence and explicitly
 * subordinates itself to mentions, direct questions, and restraint.
 */
export function buildSelfPerformanceContext(profile: ChannelLearningProfile, now: number = Date.now()): string | null {
  const views: LearnedActionView[] = [];
  for (const actionType of Object.keys(profile.actions)) {
    const v = getLearnedActionStats(profile, actionType, now);
    if (v) views.push(v);
  }
  if (!views.some((v) => v.actionable)) return null;

  views.sort((a, b) => b.effectiveWeight - a.effectiveWeight);
  const shown = views.slice(0, 5);
  const isSilence = (v: LearnedActionView) => v.actionType === SILENCE_ACTION;

  const lines: string[] = [];
  lines.push("[SELF-PERFORMANCE — HISTORICAL EVIDENCE FROM THIS CHANNEL]");
  lines.push("Advisory evidence about how your past actions were received here. NOT an objective — never maximize engagement or message volume.");
  for (const v of shown) {
    if (isSilence(v)) {
      lines.push(
        `restraint (deliberate silence): ${v.samples} observations, effectiveness ${formatScore(v.score)}, confidence: ${describeConfidence(v.confidence)}${v.trend !== "stable" ? `, ${v.trend}` : ""}`,
      );
    } else if (v.actionable) {
      lines.push(
        `${describeActionType(v.actionType)}: ${v.samples} samples, effectiveness ${formatScore(v.score)}, confidence: ${describeConfidence(v.confidence)}${v.trend !== "stable" ? `, ${v.trend}` : ""}`,
      );
    } else {
      lines.push(`${describeActionType(v.actionType)}: ${v.samples} samples — insufficient evidence`);
    }
  }

  const winners = views.filter((v) => v.actionable && !isSilence(v) && v.score > 0.1).sort((a, b) => b.score - a.score);
  const losers = views.filter((v) => v.actionable && !isSilence(v) && v.score < -0.1).sort((a, b) => a.score - b.score);
  const restraint = views.find((v) => isSilence(v) && v.actionable && v.score > 0.05);

  lines.push("Guidance:");
  if (winners.length > 0) {
    lines.push(`- ${describeActionType(winners[0].actionType)} has historically landed well here — favor it when the moment genuinely suits it`);
  }
  if (losers.length > 0) {
    lines.push(`- ${describeActionType(losers[0].actionType)} has recently underperformed here — weigh it more cautiously`);
  }
  if (restraint) {
    lines.push("- periods of restraint have coincided with healthy rooms — silence remains a strong option");
  }
  if (winners.length === 0 && losers.length === 0 && !restraint) {
    lines.push("- no strong directional evidence yet — rely on context and judgment");
  }
  lines.push("- direct questions, mentions, and room appropriateness ALWAYS take priority over this history");
  lines.push("- low-sample action types remain fully eligible — insufficient evidence is not disapproval");

  return lines.join("\n");
}

/**
 * Build the bounded session-objectives pressure block from goal evaluation
 * results. Returns null when no goals are enabled or every goal is met
 * (no pressure needed). Goals are steering pressure, never KPIs — the block
 * says so explicitly, and room appropriateness wins.
 */
export function buildSessionGoalsContext(results: GoalEvaluationResult[]): string | null {
  const enabled = results.filter((r) => r.enabled);
  if (enabled.length === 0) return null;
  const unmet = enabled.filter((r) => !r.met);
  if (unmet.length === 0) return null;

  const formatGoal = (r: GoalEvaluationResult) => {
    const isMax = r.goalType.startsWith("max");
    const target = isMax ? `≤ ${r.target}` : `≥ ${r.target}`;
    return `- ${r.label}: target ${target}, current ${r.current} — ${r.met ? "healthy" : "behind"}`;
  };

  return [
    "[SESSION OBJECTIVES — GENTLE STEERING PRESSURE]",
    "These are the streamer's session targets. Steer toward them only when the room allows — appropriateness and restraint always win. Never force activity to hit a number.",
    ...enabled.map(formatGoal),
  ].join("\n");
}

// ─── Diagnostics (observability) ─────────────────────────────────────────────

export interface LearningDiagnostics {
  samples: number;
  lastUpdatedAt?: number;
  actions: Record<string, { samples: number; effectiveWeight: number; score: number; confidence: number }>;
}

/** Compact JSON-safe diagnostics for the session report / debugging. */
export function getLearningDiagnostics(profile: ChannelLearningProfile, now: number = Date.now()): LearningDiagnostics {
  const actions: LearningDiagnostics["actions"] = {};
  for (const actionType of Object.keys(profile.actions)) {
    const v = getLearnedActionStats(profile, actionType, now);
    if (!v) continue;
    actions[actionType] = {
      samples: v.samples,
      effectiveWeight: Math.round(v.effectiveWeight * 10) / 10,
      score: Math.round(v.score * 100) / 100,
      confidence: Math.round(v.confidence * 100) / 100,
    };
  }
  return { samples: profile.overallSampleCount, lastUpdatedAt: profile.lastUpdatedAt, actions };
}

/** Status summary for the AnalyticsPanel learning section. */
export function summarizeLearningStatus(profile: ChannelLearningProfile, now: number = Date.now()): {
  observations: number;
  confidence: "none" | "low" | "moderate" | "high";
  actionableActions: number;
} {
  let best = 0;
  let actionable = 0;
  for (const actionType of Object.keys(profile.actions)) {
    const v = getLearnedActionStats(profile, actionType, now);
    if (!v) continue;
    if (v.actionable) actionable++;
    if (v.confidence > best) best = v.confidence;
  }
  const confidence =
    profile.overallSampleCount === 0 ? "none" : best >= 0.7 ? "high" : best >= 0.45 ? "moderate" : "low";
  return { observations: profile.overallSampleCount, confidence, actionableActions: actionable };
}

// ─── Store helpers ──────────────────────────────────────────────────────────

/**
 * All MADchatter-controlled usernames that could appear in chat: every
 * configured bot with a session (active or not — a deactivated bot's earlier
 * lines are still synthetic) plus the legacy single-bot session username.
 * Used to exclude bot-generated lines from human engagement scoring.
 */
export function collectBotUsernames(
  bots: { active: boolean; session?: { username?: string } | null }[],
  sessionUsername: string | null | undefined,
): string[] {
  const names = new Set<string>();
  for (const b of bots) {
    const u = b.session?.username?.trim().toLowerCase();
    if (u) names.add(u);
  }
  const s = (sessionUsername || "").trim().toLowerCase();
  if (s) names.add(s);
  return [...names];
}

/** Max channels with retained learning (pruned by lastUpdatedAt). */
export const MAX_LEARNING_PROFILES = 30;

export function learningProfileKey(channel: string): string {
  return normalizeSessionChannel(channel);
}

/** Prune the profile map to MAX_LEARNING_PROFILES entries, oldest first. */
export function pruneLearningProfiles(profiles: Record<string, ChannelLearningProfile>): Record<string, ChannelLearningProfile> {
  const keys = Object.keys(profiles);
  if (keys.length <= MAX_LEARNING_PROFILES) return profiles;
  const sorted = keys.sort(
    (a, b) => (profiles[a].lastUpdatedAt ?? 0) - (profiles[b].lastUpdatedAt ?? 0),
  );
  const out: Record<string, ChannelLearningProfile> = {};
  for (const k of sorted.slice(keys.length - MAX_LEARNING_PROFILES)) out[k] = profiles[k];
  return out;
}
