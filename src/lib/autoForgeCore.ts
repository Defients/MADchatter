/**
 * Shared pure computation logic for the AutoForge decision loop.
 *
 * Both `useAutoForge` (legacy single-bot) and `useAutoForgeBot` (per-bot
 * multi-bot) call these functions so the computation stays in sync without
 * copy-paste duplication. The hooks own the store-access and send paths;
 * this module owns the math.
 */

import type { ChatMessage, RuleEngineContext, SessionGoal, SentimentReading, EnhancedSessionStats, PinnedMemory, StreamHealthScore, GoalEvaluationResult } from "../types";
import { isNearDuplicate } from "./antiRepetition";

// ─── Chat Activity ───────────────────────────────────────────────────────────

export interface ChatActivityResult {
  chatVelocity: number;
  activityLevel: number;
  activitySpike: boolean;
  newMessages: number;
  elapsedMs: number;
  now: number;
}

export function computeChatActivity(
  currentMessagesReceived: number,
  lastCheckTime: number,
  lastMessagesReceived: number,
): ChatActivityResult {
  const now = Date.now();
  const elapsedMs = now - lastCheckTime;
  const elapsedMin = elapsedMs / 60000;
  const newMessages = Math.max(0, currentMessagesReceived - lastMessagesReceived);
  const chatVelocity = elapsedMin > 0 ? Math.round(newMessages / elapsedMin) : 0;

  let activityLevel = 0;
  if (chatVelocity >= 30) activityLevel = 4;
  else if (chatVelocity >= 15) activityLevel = 3;
  else if (chatVelocity >= 5) activityLevel = 2;
  else if (chatVelocity >= 1) activityLevel = 1;

  const activitySpike = newMessages >= 10 && elapsedMs < 120000;

  return { chatVelocity, activityLevel, activitySpike, newMessages, elapsedMs, now };
}

// ─── Engagement Score ────────────────────────────────────────────────────────

export interface EngagementScores {
  velocityScore: number;
  sentimentScore: number;
  diversityScore: number;
  recencyScore: number;
  overall: number;
}

export function computeEngagementScores(
  chatVelocity: number,
  sentimentHistory: SentimentReading[],
  uniqueChatters: number,
  lastActionMs: number,
  now: number,
): EngagementScores {
  const recentSentiment = sentimentHistory.slice(-20);
  const positiveRatio = recentSentiment.length > 0
    ? recentSentiment.filter(s => s.label === "positive" || s.label === "hype" || s.label === "wholesome").length / recentSentiment.length
    : 0.5;
  const velocityScore = Math.min(1, chatVelocity / 30);
  const sentimentScore = positiveRatio;
  const diversityScore = Math.min(1, uniqueChatters / 20);
  const recencyScore = lastActionMs
    ? Math.max(0, 1 - (now - lastActionMs) / 600000)
    : 0;
  const overall = Math.round((velocityScore * 0.35 + sentimentScore * 0.25 + diversityScore * 0.25 + recencyScore * 0.15) * 100);

  return { velocityScore, sentimentScore, diversityScore, recencyScore, overall };
}

// ─── Stream Health ───────────────────────────────────────────────────────────

export function computeStreamHealth(
  velocityScore: number,
  sentimentScore: number,
  diversityScore: number,
  isMentioned: boolean,
  mentionsDetected: number,
  visualContextTags: string[],
  now: number,
): StreamHealthScore {
  const mentionScore = Math.min(100, (isMentioned ? 30 : 0) + (mentionsDetected * 5));
  const visualScore = visualContextTags.length > 0 ? 70 : 0;
  const overall = Math.round(
    velocityScore * 30 + sentimentScore * 25 + diversityScore * 20 +
    (mentionScore / 100) * 15 + (visualScore / 100) * 10
  );
  const label: StreamHealthScore["label"] =
    overall >= 80 ? "poppin" : overall >= 60 ? "healthy" : overall >= 40 ? "active" : overall >= 20 ? "slow" : "dead";
  return {
    velocityScore: Math.round(velocityScore * 100),
    sentimentScore: Math.round(sentimentScore * 100),
    diversityScore: Math.round(diversityScore * 100),
    mentionScore,
    visualScore,
    overall,
    label,
    updatedAt: now,
  };
}

// ─── Hype Level ──────────────────────────────────────────────────────────────

export function computeHypeLevel(activitySpike: boolean, chatVelocity: number): number {
  if (activitySpike || chatVelocity >= 30) return 3;
  if (chatVelocity >= 15) return 2;
  if (chatVelocity >= 5) return 1;
  return 0;
}

// ─── Offline Detection ────────────────────────────────────────────────────────

export function detectOfflineStream(
  viewerCount: number,
  newMessages: number,
  elapsedMs: number,
): boolean {
  const noChatForLongTime = newMessages === 0 && elapsedMs > 300000;
  return viewerCount === 0 && noChatForLongTime;
}

// ─── Long-Term Memory Context ────────────────────────────────────────────────

export function buildLongTermMemoryContext(
  longTermMemory: string,
  pinnedMemories: PinnedMemory[],
  goldenMemoryId: string | null,
): string {
  if (longTermMemory) return longTermMemory;
  return [
    ...pinnedMemories.filter(m => m.id !== goldenMemoryId).map(m => m.label),
    ...pinnedMemories.filter(m => m.id === goldenMemoryId).map(m => `[GOLDEN MEMORY — PRIORITIZE THIS]: ${m.label}`),
  ].join("\n");
}

// ─── Rule Engine Context ─────────────────────────────────────────────────────

export function buildRuleEngineContext(
  chatVelocity: number,
  sentimentHistory: SentimentReading[],
  lastActionMs: number,
  chatLog: ChatMessage[],
  isMentioned: boolean,
  activitySpike: boolean,
  streamHealthLabel: string | null,
  hypeLevel: number,
  uniqueChatters: number,
  viewerCount: number,
  audioEnergyRms: number,
  now: number,
  autoForgeEnabled: boolean,
  currentMood: string | null,
  consecutiveSilence: number,
  activeBotCount: number,
): RuleEngineContext {
  const recentChatText = chatLog
    .slice(-30)
    .filter(m => !m.marker)
    .map(m => m.text)
    .join(" ");
  const currentSentiment = sentimentHistory.length > 0
    ? sentimentHistory[sentimentHistory.length - 1].label
    : null;
  const timeSinceLastAction = lastActionMs ? now - lastActionMs : Infinity;

  return {
    chatVelocity,
    sentimentLabel: currentSentiment,
    timeSinceLastActionMs: timeSinceLastAction,
    recentChatText,
    isMentioned,
    activitySpike,
    streamHealthLabel,
    hypeLevel,
    uniqueChatters,
    viewerCount,
    audioEnergyRms,
    autoForgeEnabled,
    currentMood,
    consecutiveSilence,
    activeBotCount,
  };
}

// ─── Session Goal Evaluation ────────────────────────────────────────────────

export function evaluateSessionGoals(
  goals: SessionGoal[],
  enhancedStats: EnhancedSessionStats,
  sentimentHistory: SentimentReading[],
): GoalEvaluationResult[] {
  return goals.filter(g => g.enabled).map(goal => {
    let current = 0;
    switch (goal.type) {
      case "mentionResponseRate":
        current = enhancedStats.mentionsDetected > 0
          ? Math.round((enhancedStats.autoForgeActions / enhancedStats.mentionsDetected) * 100)
          : 0;
        break;
      case "minActionsPerHour":
        current = Math.round(enhancedStats.autoForgeActions / Math.max(1, (Date.now() - enhancedStats.sessionStart) / 3600000));
        break;
      case "positiveSentimentRatio": {
        const positive = sentimentHistory.filter(s => s.label === "positive" || s.label === "hype" || s.label === "wholesome").length;
        current = sentimentHistory.length > 0 ? Math.round((positive / sentimentHistory.length) * 100) : 0;
        break;
      }
      case "maxSilenceRatio": {
        const total = enhancedStats.autoForgeActions + enhancedStats.silenceDecisions;
        current = total > 0 ? Math.round((enhancedStats.silenceDecisions / total) * 100) : 0;
        break;
      }
      case "minMessagesSent":
        current = enhancedStats.messagesSent;
        break;
      case "maxAvgResponseMs":
        current = enhancedStats.avgResponseTimeMs;
        break;
    }
    const progress = goal.type.startsWith("max") ? 1 - Math.min(1, current / goal.target) : Math.min(1, current / goal.target);
    const met = goal.type.startsWith("max") ? current <= goal.target : current >= goal.target;
    return { goalId: goal.id, goalType: goal.type, label: goal.label, current, target: goal.target, progress, met, enabled: goal.enabled };
  });
}

// ─── Manual Activity Cooldown ───────────────────────────────────────────────

export interface ManualCooldownResult {
  shouldDelay: boolean;
  delayMs: number;
  msSinceManual: number;
}

export function computeManualCooldown(
  lastManualSendMs: number,
  lastUserChatTypingMs: number,
  now: number,
  cooldownMs: number = 30_000,
): ManualCooldownResult {
  const recentManualActivity = Math.max(lastManualSendMs, lastUserChatTypingMs);
  const msSinceManual = now - recentManualActivity;
  if (msSinceManual < cooldownMs) {
    return { shouldDelay: true, delayMs: cooldownMs - msSinceManual, msSinceManual };
  }
  return { shouldDelay: false, delayMs: 0, msSinceManual };
}

// ─── Next Action Scheduling ──────────────────────────────────────────────────

export function computeNextActionMinutes(
  estimatedNextActionMinutes: number | undefined,
  activitySpike: boolean,
  decision: string,
): number {
  let nextMinutes = estimatedNextActionMinutes || 1.5;
  if (!Number.isFinite(nextMinutes) || nextMinutes < 0) nextMinutes = 1.5;
  if (activitySpike && decision === "deliberate_silence") {
    nextMinutes = Math.min(nextMinutes, 0.5);
  }
  return nextMinutes;
}

// ─── Vibe Check (pre-AI-call heuristic) ───────────────────────────────────────

export interface VibeCheckResult {
  shouldSkip: boolean;
  reason: string;
  nextCheckDelayMs: number;
}

/**
 * Cheap local heuristic run before the expensive `autoforgeDecide` AI call.
 * If the moment is clearly not worth an AI round-trip (dead chat, offline
 * stream, user is forging), this returns shouldSkip=true so the caller can
 * short-circuit without spending tokens or GPU cycles.
 *
 * Never skips when the bot is mentioned or an activity spike is detected —
 * those are the highest-priority signals to act.
 */
export function vibeCheck(opts: {
  isMentioned: boolean;
  activitySpike: boolean;
  chatVelocity: number;
  activityLevel: number;
  timeSinceLastActionMs: number;
  viewerCount: number;
  isForging: boolean;
}): VibeCheckResult {
  // Mentions and spikes are always worth checking — never skip.
  if (opts.isMentioned || opts.activitySpike) {
    return { shouldSkip: false, reason: "", nextCheckDelayMs: 0 };
  }
  // User is actively forging — don't compete with manual work.
  if (opts.isForging) {
    return { shouldSkip: true, reason: "user is forging", nextCheckDelayMs: 15_000 };
  }
  // Stream likely offline: no viewers AND no chat movement.
  if (opts.viewerCount === 0 && opts.chatVelocity === 0 && opts.timeSinceLastActionMs > 120_000) {
    return { shouldSkip: true, reason: "stream likely offline (0 viewers, no chat for 2+ min)", nextCheckDelayMs: 120_000 };
  }
  // Dead chat: no activity, no velocity, and been a while since last action.
  if (opts.activityLevel === 0 && opts.chatVelocity === 0 && opts.timeSinceLastActionMs > 300_000) {
    return { shouldSkip: true, reason: "dead chat — no signal to act", nextCheckDelayMs: 30_000 };
  }
  return { shouldSkip: false, reason: "", nextCheckDelayMs: 0 };
}

// ─── Confidence Threshold ────────────────────────────────────────────────────

export function normalizeConfidence(raw: unknown): number {
  const val = typeof raw === "number" && !isNaN(raw as number) ? raw : Number(raw) || 0;
  return val;
}

// ─── Dedup Guard ─────────────────────────────────────────────────────────────

export function isDuplicateMessage(
  payload: string,
  recentSentMessages: string[],
): boolean {
  const payloadLower = payload.toLowerCase().trim();
  if (!payloadLower) return false;
  // Fast path: exact match.
  if (recentSentMessages.includes(payloadLower)) return true;
  // Semantic path: Jaccard similarity on word sets catches reworded duplicates.
  return isNearDuplicate(payloadLower, recentSentMessages.map(m => m.toLowerCase().trim()));
}

// ─── Adaptive Check-Interval Backoff ──────────────────────────────────────────

/**
 * Progressively lengthen the check interval when AutoForge repeatedly chooses
 * silence during dead periods, reducing unnecessary AI calls. Resets to normal
 * pacing when activity resumes (mention or spike bypasses backoff entirely).
 *
 * consecutiveSilences 0-2  → baseMinutes (normal)
 * consecutiveSilences 3-5  → baseMinutes * 1.5
 * consecutiveSilences 6-10 → baseMinutes * 2
 * consecutiveSilences 10+  → baseMinutes * 3 (capped at 5 minutes max)
 */
export function computeAdaptiveBackoff(
  consecutiveSilences: number,
  baseMinutes: number,
  isMentioned: boolean,
  activitySpike: boolean,
): number {
  // Active moments always use the base interval — no backoff.
  if (isMentioned || activitySpike) return baseMinutes;
  if (consecutiveSilences <= 2) return baseMinutes;
  let multiplier = 1;
  if (consecutiveSilences <= 5) multiplier = 1.5;
  else if (consecutiveSilences <= 10) multiplier = 2;
  else multiplier = 3;
  return Math.min(5, baseMinutes * multiplier);
}

// ─── Engagement Check Label ──────────────────────────────────────────────────

export function labelEngagement(totalEngagement: number): "ignored" | "low" | "moderate" | "high" {
  if (totalEngagement === 0) return "ignored";
  if (totalEngagement < 3) return "low";
  if (totalEngagement < 8) return "moderate";
  return "high";
}

export function countPostSendEngagement(
  chatLog: ChatMessage[],
  sentAt: number,
  botName: string,
): { linesAfter: number; mentionsAfter: number; reactionsAfter: number; total: number } {
  const linesAfter = chatLog.filter(m => m.timestamp > sentAt && !m.marker).length;
  const mentionsAfter = botName
    ? chatLog.filter(m => m.timestamp > sentAt && !m.marker && m.text.toLowerCase().includes(`@${botName}`)).length
    : 0;
  const reactionsAfter = chatLog.filter(m => m.timestamp > sentAt && !m.marker && m.text.length < 20 && /^[A-Z\s!?]+$/.test(m.text)).length;
  const total = linesAfter + mentionsAfter * 2 + reactionsAfter;
  return { linesAfter, mentionsAfter, reactionsAfter, total };
}
