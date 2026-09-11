/**
 * Shared pure computation logic for the AutoForge decision loop.
 *
 * Both `useAutoForge` (legacy single-bot) and `useAutoForgeBot` (per-bot
 * multi-bot) call these functions so the computation stays in sync without
 * copy-paste duplication. The hooks own the store-access and send paths;
 * this module owns the math.
 */

import type { ChatMessage, RuleEngineContext, SessionGoal, SentimentReading, EnhancedSessionStats, PinnedMemory, StreamHealthScore, GoalEvaluationResult } from "../types";

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
  return recentSentMessages.includes(payloadLower);
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
