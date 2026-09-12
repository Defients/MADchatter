import { useEffect, useRef } from "react";
import { useAppStore } from "../store";
import { toast } from "sonner";
import { autoforgeDecide, generateChat, rankVariants } from "../lib/ai";
import { getPlatformSendFn } from "../lib/platformSend";
import { botCoordinator, type BotCandidate } from "../lib/botCoordinator";
import { playSfx } from "../lib/sfx";
import { speakMessage } from "../lib/tts";
import { getActiveProvider, getApiKey } from "../lib/keys";
import { formatChatLog } from "../lib/chatUtils";
import { retrieveRelevantMemories, formatMemoryContext, formatDirectorNotesContext } from "../lib/memoryRetrieval";
import { boostMemory, boostJoke } from "../lib/memoryEngine";
import { recordJokeUsage, getActiveJokes, scoreJokeRelevance } from "../lib/jokeEngine";
import { analyzeRepetition, formatRepetitionContext } from "../lib/antiRepetition";
import { getBotRateLimiter, syncBotRateLimiterConfig } from "../lib/actionRateLimiter";
import { isNameMentioned } from "../lib/nameMatch";
import { summarizeSentiment, formatSentimentContext } from "../lib/sentiment";
import { getAvailableEmoteNames } from "../lib/emotes";
import { evaluateAllRules } from "../lib/ruleEngine";
import {
  computeChatActivity,
  computeEngagementScores,
  computeStreamHealth,
  computeHypeLevel,
  detectOfflineStream,
  buildLongTermMemoryContext,
  buildRuleEngineContext,
  evaluateSessionGoals,
  computeManualCooldown,
  computeNextActionMinutes,
  computeAdaptiveBackoff,
  normalizeConfidence,
  isDuplicateMessage,
  vibeCheck,
  labelEngagement,
  countPostSendEngagement,
} from "../lib/autoForgeCore";
import { generateSmartReplies, canGenerateSmartReplies, cleanExpiredSmartReplies } from "../lib/smartReplies";
import { isSchedulerCancellation, isQueueTimeout } from "../lib/aiScheduler";

// D4: Post-send engagement correlation — delay before evaluating chat response.
// Mirrors the legacy useAutoForge constant so multi-bot engagement metrics
// use the same 30-second observation window.
const ENGAGEMENT_CHECK_DELAY_MS = 30_000;

// Max time a single checkBot run (or a manual Forge) may hold its gate before
// it's considered wedged — e.g. a hung SDK call or dead-socket send whose
// promise never settles. A real forge never exceeds ~60s.
const FORGE_WATCHDOG_MS = 120_000;

/**
 * Per-bot AutoForge decision loop (multi-bot mode only).
 *
 * This is a focused, bot-scoped parallel to the legacy useAutoForge(). It reads
 * SHARED stream context (chatLog, streamMetadata, audio, visual) plus this bot's
 * OWN runtime/persona, asks autoforgeDecide for a decision, then asks the
 * BotCoordinator for the speaker floor. Only if granted does it send (via this
 * bot's own per-identity send manager) and record into bots[botId].runtime.
 *
 * The legacy useAutoForge() is untouched and self-disables via its own guard
 * when multiBotEnabled === true.
 *
 * Scope: core decide → coordinate → send → record cycle. full_forge
 * decisions generate + rank variants via generateChat/rankVariants (parity
 * with the legacy loop). Advanced features mirrored from the legacy loop:
 * rule engine, smart replies, post-send engagement correlation, session
 * goals, manual cooldown, and stale-channel guards.
 */
export function useAutoForgeBot(botId: string) {
  const isForgingRef = useRef(false);
  const forgingStartedAtRef = useRef(0);
  const lastChatLengthRef = useRef(0);
  const lastCheckTimeRef = useRef(Date.now());
  const lastMessagesReceivedRef = useRef(0);
  const consecutiveSilenceRef = useRef(0);
  const followupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const engagementTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const checkBot = async (force = false) => {
    const store = useAppStore.getState();
    const supercharged = store.superchargeActive;
    if (isForgingRef.current) {
      // Watchdog: if a previous check's await never settled (hung SDK call,
      // dead-socket send, etc.) the flag would wedge this bot forever — the
      // NEXT CHECK timer sits at 0s and FORCE is silently swallowed.
      if (Date.now() - forgingStartedAtRef.current > FORGE_WATCHDOG_MS) {
        console.warn(`[AutoForgeBot ${botId}] in-flight check exceeded ${FORGE_WATCHDOG_MS / 1000}s — resetting guard`);
        isForgingRef.current = false;
        store.setBotIsAutoForgeThinking(botId, false);
      } else {
        if (force) toast.info("A check is already running — try again in a moment.");
        return;
      }
    }
    if (!store.multiBotEnabled) return;
    const bot = store.bots.find((b) => b.id === botId);
    if (!bot || !bot.active || !bot.session) {
      if (force) toast.info("Bot must be active and signed in to force a check.");
      return;
    }
    if (!store.autoForgeEnabled) {
      if (force) toast.info("Enable AutoForge to use Force.");
      return;
    }
    // Self-heal a wedged manual-forge flag. If a forge request hung without
    // settling, isForging would gate every bot check + force forever.
    if (store.isForging && (store.forgeStartedAtMs === null || Date.now() - store.forgeStartedAtMs > FORGE_WATCHDOG_MS)) {
      console.warn(`[AutoForgeBot ${botId}] isForging stuck >${FORGE_WATCHDOG_MS / 1000}s — clearing stale flag`);
      store.setIsForging(false);
    }
    if (store.isForging && !force) {
      // Gated on a live manual forge — push NEXT CHECK forward so the HUD
      // countdown reflects the real deferral instead of sitting at 0s.
      store.setBotAutoForgeNextActionMs(botId, Date.now() + 15_000);
      return;
    }
    // force bypasses the isForging gate — the scheduler arbitrates contention
    // (the decide queues behind the critical forge on Ollama, or runs
    // concurrently on cloud providers).
    const runtime = bot.runtime;
    if (!force && Date.now() < runtime.autoForgeNextActionMs) return;

    isForgingRef.current = true;
    forgingStartedAtRef.current = Date.now();
    store.setBotIsAutoForgeThinking(botId, true);
    try {
      const activeProvider = getActiveProvider();
      // Only the user-selected provider is used — no cross-provider fallback.
      // If the selected provider isn't configured, skip quietly rather than
      // silently rerouting to another provider that happens to have a key.
      if (!getApiKey(activeProvider)) {
        store.setBotAutoForgeNextActionMs(botId, Date.now() + 60000);
        return;
      }

      // ── Activity metrics (from shared chat) ──────────────────────────────
      const currentMessagesReceived = store.sessionStats.messagesReceived;
      const { chatVelocity, activityLevel, activitySpike, newMessages, elapsedMs, now } =
        computeChatActivity(currentMessagesReceived, lastCheckTimeRef.current, lastMessagesReceivedRef.current);
      lastMessagesReceivedRef.current = currentMessagesReceived;
      lastCheckTimeRef.current = now;

      // ── Engagement score (composite metric, shared with HUD) ─────────────
      // Mirrors the legacy useAutoForge computation so the HUD Engagement Score
      // updates in multi-bot mode too. Uses shared chat state + this bot's
      // last action time for the recency component.
      const uniqueChatters = new Set(store.chatLog.filter((m) => !m.marker).map((m) => m.user)).size;
      store.updateBotEnhancedStats(botId, {
        uniqueChatters,
        peakChatVelocity: Math.max(runtime.enhancedStats.peakChatVelocity, chatVelocity),
      });
      // Mirror into global enhancedStats so AnalyticsPanel populates in multi-bot mode.
      // The legacy useAutoForge loop self-disables when multi-bot is active, so without
      // this mirror the global stats (Messages Out, Chatters, Peak Velocity, etc.)
      // stay frozen at zero for the whole multi-bot session.
      store.updateEnhancedStats({
        uniqueChatters,
        peakChatVelocity: Math.max(store.enhancedStats.peakChatVelocity, chatVelocity),
      });
      const sentimentHistoryForEngagement = store.sentimentHistory;
      const engagement = computeEngagementScores(
        chatVelocity, sentimentHistoryForEngagement, uniqueChatters, runtime.autoForgeLastActionMs, now,
      );
      store.setEngagementScore({
        velocityScore: Math.round(engagement.velocityScore * 100),
        sentimentScore: Math.round(engagement.sentimentScore * 100),
        diversityScore: Math.round(engagement.diversityScore * 100),
        recencyScore: Math.round(engagement.recencyScore * 100),
        overall: engagement.overall,
      });

      // ── Mention detection for THIS bot's username ────────────────────────
      // Uses fuzzy matching so Whisper mishears (e.g. "kovrycha" → "cory cha")
      // still trigger a mention. Checks both chat log and audio transcript.
      const botUsername = (bot.session.username || "").toLowerCase();
      const recentMessages = store.chatLog.slice(-15).filter((m) => !m.marker);
      const mentionedLines: string[] = [];
      if (botUsername) {
        for (const msg of recentMessages) {
          if (isNameMentioned(msg.text, botUsername)) {
            mentionedLines.push(`${msg.user}: ${msg.text}`);
          }
        }
      }
      // Also check audio transcript for name mentions (the legacy loop does
      // this but self-disables in multi-bot mode, so the per-bot loop must
      // handle it here).
      const audioMentionLines: string[] = [];
      if (botUsername && store.audioTranscript) {
        const audioLines = store.audioTranscript.split("\n").slice(-15);
        for (const line of audioLines) {
          if (isNameMentioned(line, botUsername)) {
            audioMentionLines.push(`[AUDIO] ${line}`);
          }
        }
      }
      const isMentioned = mentionedLines.length > 0 || audioMentionLines.length > 0;

      // ── Mirror mention/spike detection into global stats ────────────────
      // The legacy loop handles these globally but self-disables in multi-bot
      // mode. Without this mirror, the AnalyticsPanel "Mentions" and "Spikes"
      // counters stay at zero. Events go to per-bot runtime so the AutoForge
      // Report can merge them without duplication.
      if (isMentioned) {
        store.incrementStat("mentionsDetected");
        const allMentionLines = [...mentionedLines, ...audioMentionLines];
        const source = audioMentionLines.length > 0 && mentionedLines.length === 0 ? "audio" : mentionedLines.length > 0 && audioMentionLines.length === 0 ? "chat" : "chat+audio";
        store.addBotAutoForgeEvent(botId, {
          timestamp: Date.now(),
          type: "mention",
          severity: "high",
          summary: `[${bot.session.username}] Mentioned (${source}): ${allMentionLines.slice(0, 3).join(" | ")}`,
          details: { mentionedLines, audioMentionLines, botUsername, botId },
        });

        // Smart reply generation — when smart replies are enabled, generate
        // click-to-send suggestions for this bot's mention. Passes botId so
        // the smart reply prompt uses THIS bot's identity, not the manual
        // send bot's. Shared global smartReplies state (UI suggestions).
        if (store.smartRepliesEnabled && canGenerateSmartReplies()) {
          store.setSmartRepliesLoading(true);
          generateSmartReplies(allMentionLines, { botId })
            .then((replies) => {
              if (replies.length > 0) {
                useAppStore.getState().setSmartReplies(replies);
              }
              useAppStore.getState().setSmartRepliesLoading(false);
            })
            .catch((e) => {
              if (!isSchedulerCancellation(e) && !isQueueTimeout(e)) {
                console.error(`[AutoForgeBot ${bot.session.username}] Smart reply generation failed:`, e);
              }
              useAppStore.getState().setSmartRepliesLoading(false);
            });
        }
      }
      if (activitySpike) {
        store.incrementStat("spikesDetected");
        store.addBotAutoForgeEvent(botId, {
          timestamp: Date.now(),
          type: "spike",
          severity: "medium",
          summary: `Activity spike: ${newMessages} new lines in ${Math.round(elapsedMs / 1000)}s (velocity: ${chatVelocity}/min)`,
          details: { newMessages, elapsedMs, chatVelocity, activityLevel },
        });
      }

      // ── A10: Stream health score ─────────────────────────────────────────
      const es = store.enhancedStats;
      const health = computeStreamHealth(
        engagement.velocityScore, engagement.sentimentScore, engagement.diversityScore,
        isMentioned, es.mentionsDetected, store.visualContextTags, now,
      );
      store.setStreamHealth(health);

      // ── B12: Hype level ──────────────────────────────────────────────────
      store.setHypeLevel(computeHypeLevel(activitySpike, chatVelocity));

      // ── Offline detection ───────────────────────────────────────────────
      const viewerCount = store.streamMetadata?.viewerCount || 0;
      const likelyOffline = detectOfflineStream(viewerCount, newMessages, elapsedMs);
      store.setStreamLikelyOffline(likelyOffline);
      if (likelyOffline && !force) {
        store.setBotAutoForgeNextActionMs(botId, now + 120000);
        return;
      }

      // ── Persona fit (0–1): how well this bot's persona matches the moment ─
      // High-chaos personas fit high activity; calm personas fit low activity.
      const normActivity = activityLevel / 4;
      const normChaos = (bot.persona.config.chaosLevel || 50) / 100;
      let personaFit = 1 - Math.abs(normActivity - normChaos);
      if (isMentioned) personaFit = Math.min(1, personaFit + 0.3); // mentioned bot strongly fits

      // ── Memory context (per-bot) ─────────────────────────────────────────
      let memoryContext = "";
      if (runtime.autoMemoryConfig?.enabled) {
        const retrieved = retrieveRelevantMemories(
          runtime.autoMemories,
          runtime.userProfiles,
          runtime.insideJokes,
          runtime.personalityState,
          {
            currentChatLog: store.chatLog,
            audioTranscript: store.audioTranscript,
            visualContext: store.visualContextTags.join(" "),
            streamMetadata: store.streamMetadata,
            activeUsers: [],
            tokenBudget: runtime.autoMemoryConfig.contextInjectionTokenBudget,
          },
        );
        memoryContext = formatMemoryContext(retrieved, {
          memoriesFormed: runtime.personalityState?.sessionMemoriesFormed ?? 0,
          jokesCreated: runtime.personalityState?.sessionJokesCreated ?? 0,
        }, runtime.directorNotes);
      } else {
        // Director notes are user-authored directives, not auto-extracted
        // memories — inject them even when AutoMemory is disabled.
        memoryContext = formatDirectorNotesContext(runtime.directorNotes);
      }

      // ── Sentiment context (per-bot) ──────────────────────────────────────
      let sentimentContext = "";
      if (runtime.sentimentHistory.length > 0) {
        const summary = summarizeSentiment(runtime.sentimentHistory);
        sentimentContext = formatSentimentContext(summary);
      }

      // ── Anti-repetition (per-bot sent history) ───────────────────────────
      const repAnalysis = analyzeRepetition(runtime.sentMessages);
      const antiRepetitionContext = formatRepetitionContext(repAnalysis);

      // ── C1: AutoForge Rule Engine — evaluate user-defined rules ──────────
      // Mirrors the legacy useAutoForge rule evaluation. Rules are shared
      // (global), not per-bot — they fire based on shared stream context.
      // Rule send actions go through this bot's identity via botId, so
      // send_message/send_emote rules send as the bot whose tick fired them.
      const autoForgeRules = store.autoForgeRules;
      if (autoForgeRules.length > 0) {
        const ruleCtx = buildRuleEngineContext(
          chatVelocity,
          store.sentimentHistory,
          runtime.autoForgeLastActionMs,
          store.chatLog,
          isMentioned,
          activitySpike,
          store.streamHealth?.label ?? null,
          store.hypeLevel,
          uniqueChatters,
          store.streamMetadata.viewerCount,
          store.audioEnergy?.rms ?? 0,
          now,
          store.autoForgeEnabled,
          store.moodLock.locked ? store.moodLock.mood : null,
          consecutiveSilenceRef.current,
          store.bots.filter((b) => b.active && b.session).length || 1,
        );

        const ruleResults = await evaluateAllRules(autoForgeRules, ruleCtx, botId);
        const firedRules = ruleResults.filter((r) => r.fired);
        if (firedRules.length > 0) {
          const ruleActions = firedRules.reduce((s, r) => s + r.actionsExecuted, 0);
          if (ruleActions > 0) {
            // Update last action time so manual-activity delay applies
            store.setBotAutoForgeLastActionMs(botId, now);
            store.addBotAutoForgeEvent(botId, {
              timestamp: Date.now(),
              type: "rule_fired",
              severity: "medium",
              summary: `[${bot.session.username}] Rule engine: ${firedRules.length} rule(s) fired, ${ruleActions} action(s) executed`,
              details: { firedRules: firedRules.map((r) => ({ id: r.ruleId, name: r.ruleName, actions: r.actionsExecuted })) },
            });
          }
        }
      }

      // ── Rate limit (per-bot limiter) ──────────────────────────────────────
      // Each bot gets its own rate-limit tracking so bot A's sends don't
      // count against bot B's quota. Config is synced from the store every
      // cycle so user-configured limits apply uniformly. The legacy loop
      // uses the shared singleton; the per-bot loop uses per-bot instances.
      const botLimiter = getBotRateLimiter(botId);
      syncBotRateLimiterConfig(botId, store.rateLimitConfig, store.perActionRateLimits);

      if (!force && !supercharged && !botLimiter.canAct()) {
        const rateStats = botLimiter.getStats();
        store.setBotAutoForgeNextActionMs(botId, Date.now() + Math.max(30000, rateStats.msUntilNextAllowed));
        return;
      }

      // ── Vibe check: skip the AI call entirely when the moment is dead ────
      // Cheap local heuristic — never skips mentions or spikes. Saves tokens
      // and GPU cycles during dead/offline periods. Supercharge mode bypasses
      // it entirely — the user asked for maximum engagement.
      if (!force && !supercharged) {
        const vibe = vibeCheck({
          isMentioned,
          activitySpike,
          chatVelocity,
          activityLevel,
          timeSinceLastActionMs: runtime.autoForgeLastActionMs ? now - runtime.autoForgeLastActionMs : Infinity,
          viewerCount: store.streamMetadata?.viewerCount || 0,
          isForging: store.isForging,
        });
        if (vibe.shouldSkip) {
          store.addBotAutoForgeEvent(botId, {
            timestamp: Date.now(),
            type: "silence",
            severity: "low",
            summary: `[${bot.session.username}] Vibe check skip: ${vibe.reason}`,
            details: { reason: vibe.reason, chatVelocity, activityLevel },
          });
          store.setBotAutoForgeNextActionMs(botId, Date.now() + vibe.nextCheckDelayMs);
          return;
        }
      }

      // ── Decide ───────────────────────────────────────────────────────────
      const decisionStartTime = Date.now();
      // First Message Mode: acquire the per-bot generation lock before the
      // decision call so the "arrival" directive is injected into BOTH the
      // autoforgeDecide call (short_reaction / emote_only / quick_followup
      // generate their payload here) and the full_forge generateChat call.
      // The lock prevents duplicate concurrent first-message generations for
      // the same bot. It is released on any non-send outcome (silence, failed
      // generation, failed send); a successful send completes it via
      // addBotSentMessage → completeBotFirstMessage.
      const isFirstMessage = useAppStore.getState().acquireFirstMessageLock(botId);
      const decision = await autoforgeDecide({
        streamMetadata: store.streamMetadata,
        visualContext: store.visualContextTags.join(" "),
        recentChatLog: formatChatLog(store.chatLog),
        audioTranscript: store.audioTranscript,
        longTermContext: buildLongTermMemoryContext(runtime.longTermMemory, runtime.pinnedMemories, runtime.goldenMemoryId),
        config: bot.persona.config,
        activeProvider,
        lastActionMs: runtime.autoForgeLastActionMs,
        currentChatActivity: activityLevel,
        chatVelocity,
        activitySpike,
        isMentioned,
        mentionedLines: [...mentionedLines, ...audioMentionLines],
        contextTokenLimit: bot.persona.config.autoForgeContextTokens ?? 4000,
        r34lEnabled: store.r34lEnabled,
        botUsername,
        force,
        memoryContext,
        antiRepetitionContext,
        sentimentContext,
        availableEmotes: store.emoteAwarenessEnabled
          ? getAvailableEmoteNames(store.streamMetadata.channelName, 50)
          : undefined,
        botIdentityMode: bot.persona.botIdentityMode,
        botIdentityStory: bot.persona.botIdentityStory,
        audioEnergyLabel: store.audioEnergy?.label,
        streamEvents: store.streamEvents.slice(-5),
        firstMessageMode: isFirstMessage,
        superchargeMode: supercharged,
        fellowBotUsernames: supercharged
          ? store.bots
              .filter((b) => b.id !== botId && b.active && b.session)
              .map((b) => b.session!.username)
              .filter(Boolean)
          : undefined,
      });

      // First Message lock release helper. Safe to call on any exit path: it
      // only acts on the "sending" state, so it's a no-op once a successful
      // send has completed the bot (status → "complete"). This keeps the
      // lock from leaking on silence / failed-generation / failed-send paths.
      const releaseFM = () => { if (isFirstMessage) useAppStore.getState().releaseFirstMessageLock(botId); };
      // True when a quick_followup send is deferred via setTimeout — the lock
      // must stay held until that deferred send resolves (complete on success,
      // release on failure), so the end-of-cycle release is skipped for it.
      let firstMessageSendPending = false;

      // Record token usage from the decision call
      if (decision.tokenUsage) {
        useAppStore.getState().recordTokenUsage("autoforge_decide", decision.tokenUsage);
      }

      // Mirror response time + provider fallback into global enhancedStats so
      // the AnalyticsPanel "Avg Response" and "Fallbacks" counters populate in
      // multi-bot mode (the legacy loop that normally handles these is off).
      const responseTimeMs = Date.now() - decisionStartTime;
      const actionDist = { ...store.enhancedStats.actionDistribution };
      actionDist[decision.decision] = (actionDist[decision.decision] || 0) + 1;
      store.updateEnhancedStats({
        actionDistribution: actionDist,
        avgResponseTimeMs: Math.round(store.enhancedStats.avgResponseTimeMs * 0.7 + responseTimeMs * 0.3),
      });
      if (decision.used_fallback_provider) {
        store.incrementStat("providerFallbacks");
      }

      store.setBotLastAutoForgeDecision(botId, { ...decision, timestamp: now, activityLevel, personaFit, isMentioned });

      // ── Decision log entry (per-bot) ──────────────────────────────────────
      // Mirrors the legacy useAutoForge decision log so the AnalyticsPanel
      // decision log table populates in multi-bot mode. The entry is created
      // before acting; outcome is updated as the send resolves.
      const sentimentSummary = store.sentimentSummary;
      const decisionLogId = store.addBotDecisionLogEntry(botId, {
        timestamp: now,
        decision: decision.decision === "deliberate_silence" || decision.decision === "meta_observation"
          ? "silence"
          : decision.decision === "quick_followup"
            ? "followup"
            : "action",
        action: decision.action_payload,
        reasoning: decision.reason,
        sentimentLabel: sentimentSummary?.current || "neutral",
        sentimentScore: sentimentSummary?.dominantScore || 0,
        chatVelocity,
        isMentioned,
        activitySpike,
        provider: decision.used_fallback_provider || activeProvider,
        responseTimeMs,
      });

      // Confidence threshold (unless forced)
      const conf = normalizeConfidence(decision.confidence);
      const threshold = store.autoForgeConfidenceThreshold ?? 0.5;
      if (!force && conf < threshold && decision.decision !== "deliberate_silence") {
        store.addBotAutoForgeEvent(botId, {
          timestamp: Date.now(),
          type: "silence",
          severity: "low",
          summary: `[${bot.session.username}] Below confidence threshold (${conf.toFixed(2)} < ${threshold}): ${decision.reason}`,
          details: { decision: decision.decision, confidence: conf, threshold, reason: decision.reason },
        });
        decision.decision = "deliberate_silence";
        decision.reason = `Confidence ${conf.toFixed(2)} below threshold ${threshold}.`;
      }

      if (force && decision.decision === "deliberate_silence") {
        decision.decision = "full_forge";
        decision.reason = "Force override.";
      }

      // Dry run
      if (store.autoForgeDryRun && decision.decision !== "deliberate_silence") {
        toast.info(`AutoForge DRY RUN [${bot.session.username}]: ${decision.decision}`, {
          description: decision.action_payload || decision.reason,
          icon: "🧪",
        });
        store.updateBotDecisionLogEntry(botId, decisionLogId, { outcome: "queued" });
        store.setBotAutoForgeLastActionMs(botId, Date.now());
        let nextMin = decision.estimated_next_action_minutes || 1.5;
        if (!Number.isFinite(nextMin) || nextMin < 0) nextMin = 1.5;
        store.setBotAutoForgeNextActionMs(botId, Date.now() + nextMin * 60 * 1000);
        releaseFM();
        return;
      }

      // ── Act ──────────────────────────────────────────────────────────────
      // Helper: schedule a post-send engagement check (D4 parity with legacy).
      // After ENGAGEMENT_CHECK_DELAY_MS, counts chat lines, mentions, and
      // reactions that arrived after the send, then labels the engagement
      // level and updates the per-bot action history entry + accuracy metric.
      const scheduleEngagementCheck = (actionType: string, message: string, sentAt: number) => {
        const engTimer = setTimeout(() => {
          engagementTimersRef.current.delete(engTimer);
          const currentState = useAppStore.getState();
          const currentBot = currentState.bots.find((b) => b.id === botId);
          if (!currentBot) return;
          // Find the matching action history entry in per-bot runtime
          const target = [...currentBot.runtime.actionHistory].reverse().find((e) =>
            e.actionType === actionType &&
            e.message === message &&
            Math.abs(e.timestamp - sentAt) < 5000
          );
          if (!target) return;
          const currentChat = currentState.chatLog;
          const botName = (currentBot.session?.username || "").toLowerCase();
          const eng = countPostSendEngagement(currentChat, sentAt, botName);
          const label = labelEngagement(eng.total);
          useAppStore.getState().updateBotActionHistoryEntry(botId, target.id, {
            engagement: { chatLinesAfter: eng.linesAfter, mentionsAfter: eng.mentionsAfter, reactionsAfter: eng.reactionsAfter, label, evaluatedAt: Date.now() },
          });
          // A9: Record accuracy metric (shared global — no per-bot twin exists)
          useAppStore.getState().recordActionEngagement(actionType, label);
        }, ENGAGEMENT_CHECK_DELAY_MS);
        engagementTimersRef.current.add(engTimer);
      };

      if (decision.decision === "full_forge") {
        // C5: Per-action rate limit check for full_forge
        if (!force && !supercharged && !botLimiter.canAct("full_forge")) {
          store.addBotAutoForgeEvent(botId, {
            timestamp: Date.now(),
            type: "silence",
            severity: "low",
            summary: `[${bot.session.username}] full_forge per-action rate limited`,
          });
          decision.decision = "deliberate_silence";
          decision.reason = "full_forge per-action rate limit reached.";
        } else {
          // A3: Generate variants, rank, and send the best one — mirroring the
          // legacy useAutoForge full_forge path. The decision's action_payload
          // is a draft; we replace it with a fully generated + ranked variant
          // so multi-bot full_forge matches single-bot quality.
          try {
            // Stale channel guard: capture channel before the async generation
            // so we can discard results if the user switched streamers mid-Forge.
            const forgeChannel = store.streamMetadata.channelName;
            const chatResult = await generateChat({
              streamMetadata: store.streamMetadata,
              visualContext: store.visualContextTags.join(" "),
              screenshot: store.visualSnapshotUrl || undefined,
              recentChatLog: formatChatLog(store.chatLog),
              audioTranscript: store.audioTranscript,
              longTermContext: buildLongTermMemoryContext(runtime.longTermMemory, runtime.pinnedMemories, runtime.goldenMemoryId),
              config: bot.persona.config,
              activeProvider,
              count: 3,
              r34lEnabled: store.r34lEnabled,
              botUsername,
              memoryContext,
              sentimentContext,
              availableEmotes: store.emoteAwarenessEnabled
                ? getAvailableEmoteNames(store.streamMetadata.channelName, 50)
                : undefined,
              // AutoForge full_forge generates the actual message to send.
              // Once the bot has decided to act, this must not be preempted by
              // vision (interactive) — otherwise the bot decides to speak but
              // the message is never sent. Use interactive priority so vision
              // queues behind it; manual Forge (critical) can still preempt.
              priority: "interactive",
              firstMessageMode: isFirstMessage,
            });

            // Stale channel guard: discard if the user switched streamers.
            const currentChannel = useAppStore.getState().streamMetadata.channelName;
            if (currentChannel !== forgeChannel) {
              console.log(`[AutoForgeBot:${botId}] Discarding stale full_forge result (channel changed: ${forgeChannel} → ${currentChannel})`);
              releaseFM();
              return;
            }

            if (chatResult.tokenUsage) {
              useAppStore.getState().recordTokenUsage("forge", chatResult.tokenUsage);
            }

            const variants = chatResult.suggestions || [];
            if (variants.length === 0) throw new Error("No variants generated");

            const ranked = rankVariants(variants, {
              config: bot.persona.config,
              recentSentMessages: runtime.sentMessages.map((m) => m.message).slice(-20),
            });
            const bestVariant = ranked.find((v) => v.best) || ranked[0];
            const messageToSend = bestVariant.message;
            if (!messageToSend) throw new Error("Best variant had no message");

            // Dedup guard (per-bot sent history) — bypassed for forced checks
            // (the user explicitly requested action; the SendGuard dedup at the
            // Twitch level still catches exact duplicates before they go out).
            if (!force) {
              const recentSent = runtime.sentMessages.slice(-15).map((m) => m.message.toLowerCase().trim());
              const payloadLower = messageToSend.toLowerCase().trim();
              if (recentSent.includes(payloadLower)) {
                decision.decision = "deliberate_silence";
                decision.reason = "Duplicate of recently sent message (full_forge variant).";
                store.addBotAutoForgeEvent(botId, {
                  timestamp: Date.now(),
                  type: "silence",
                  severity: "low",
                  summary: `[${bot.session.username}] full_forge variant was duplicate — downgraded to silence`,
                  details: { message: messageToSend },
                });
              }
            } else {
              // Request the speaker floor
              const candidate: BotCandidate = {
                decision: "full_forge",
                confidence: conf,
                payload: messageToSend,
                personaFit,
                isMentioned,
              };
              const granted = force ? true : await botCoordinator.requestFloor(botId, candidate);
              if (!granted) {
                store.setBotLastAutoForgeDecision(botId, { ...decision, decision: "deliberate_silence", reason: "Lost speaker floor — another bot won the bid.", timestamp: now, activityLevel, personaFit, isMentioned });
                store.addBotAutoForgeEvent(botId, {
                  timestamp: Date.now(),
                  type: "silence",
                  severity: "low",
                  summary: `[${bot.session.username}] Lost speaker floor — deferring full_forge "${messageToSend.slice(0, 40)}"`,
                  details: { decision: "full_forge", confidence: conf },
                });
                store.setBotAutoForgeNextActionMs(botId, Date.now() + 20_000);
                releaseFM();
                return;
              }

              // Won the floor — send the best variant
              const sendFn = getPlatformSendFn(store.platform, botId);
              const channel = store.streamMetadata.channelName;
              playSfx("autoforge_action");
              botLimiter.recordAction("full_forge");
              store.incrementBotStat(botId, "autoForgeActions");
              store.incrementStat("autoForgeActions");

              try {
                await sendFn(channel, messageToSend);
                store.updateBotDecisionLogEntry(botId, decisionLogId, { outcome: "sent" });
              } catch (e: any) {
                store.updateBotDecisionLogEntry(botId, decisionLogId, { outcome: "failed" });
                console.error(`[AutoForgeBot ${bot.session.username}] full_forge send failed:`, e);
                store.addBotAutoForgeEvent(botId, {
                  timestamp: Date.now(),
                  type: "error",
                  severity: "high",
                  summary: `[${bot.session.username}] Full Forge send FAILED: ${e.message || e}`,
                  details: { decision: "full_forge", message: messageToSend },
                });
                store.setBotAutoForgeNextActionMs(botId, Date.now() + 20_000);
                releaseFM();
                return;
              }

              speakMessage(messageToSend);
              store.addBotSentMessage(botId, {
                message: messageToSend,
                channel,
                timestamp: Date.now(),
                source: "autoforge",
                botId,
              });
              store.incrementBotStat(botId, "messagesSent");
              store.incrementMessagesSent();
              store.addBotActionHistoryEntry(botId, {
                timestamp: Date.now(),
                actionType: "full_forge",
                message: messageToSend,
                provider: decision.used_fallback_provider || activeProvider,
                success: true,
              });
              // D4: Schedule post-send engagement correlation
              scheduleEngagementCheck("full_forge", messageToSend, Date.now());
              store.setBotAutoForgeLastActionMs(botId, Date.now());
              store.addBotAutoForgeEvent(botId, {
                timestamp: Date.now(),
                type: "action_sent",
                severity: "high",
                summary: `[${bot.session.username}] full_forge: "${messageToSend}"`,
                details: {
                  decision: "full_forge",
                  confidence: conf,
                  reason: decision.reason,
                  action_payload: messageToSend,
                  variantsGenerated: variants.length,
                  bestVariantId: bestVariant.variant_id,
                },
              });

              // Boost referenced memories (per-bot auto-memory).
              // Mirrors the legacy useAutoForge post-send memory boosting.
              if (runtime.autoMemoryConfig?.enabled && decision.referenced_memory_ids) {
                for (const mid of decision.referenced_memory_ids) {
                  boostMemory((store.streamMetadata.channelName || "default").toLowerCase(), mid).catch(console.error);
                }
              }
            }
          } catch (e: any) {
            // Scheduler preemption/cancellation is an intentional yield —
            // don't log as a failure or toast; let the outer catch reschedule
            // quietly.
            if (isSchedulerCancellation(e) || isQueueTimeout(e)) {
              store.updateBotDecisionLogEntry(botId, decisionLogId, { outcome: "skipped" });
              releaseFM();
              throw e;
            }
            store.updateBotDecisionLogEntry(botId, decisionLogId, { outcome: "failed" });
            console.error(`[AutoForgeBot ${bot.session.username}] full_forge generation failed:`, e);
            store.addBotAutoForgeEvent(botId, {
              timestamp: Date.now(),
              type: "error",
              severity: "high",
              summary: `[${bot.session.username}] Full Forge generation FAILED: ${e.message || e}`,
              details: { decision: "full_forge", reason: decision.reason },
            });
            toast.error(`AutoForge [${bot.session.username}] full_forge failed: ${e.message || e}`);
            releaseFM();
          }
        }
      } else if (decision.decision === "quick_followup" && decision.action_payload) {
        // Delayed follow-up: schedule the send with a setTimeout so the bot
        // doesn't speak immediately after its last message. Mirrors the legacy
        // useAutoForge quick_followup path (lines 830-880).
        const delayMs = Math.max(1500, Math.min(12000, decision.followup_delay_ms ||
          decision.action_payload.length * 65));

        // C5: Per-action rate limit check for quick_followup
        if (!force && !supercharged && !botLimiter.canAct("quick_followup")) {
          store.addBotAutoForgeEvent(botId, {
            timestamp: Date.now(),
            type: "silence",
            severity: "low",
            summary: `[${bot.session.username}] quick_followup per-action rate limited`,
          });
          decision.decision = "deliberate_silence";
          decision.reason = "quick_followup per-action rate limit reached.";
        } else {
        // Dedup guard (per-bot sent history) — bypassed for forced checks
        let isFollowupDup = false;
        if (!force) {
          const recentSent = runtime.sentMessages.slice(-15).map((m) => m.message.toLowerCase().trim());
          const payloadLower = decision.action_payload.toLowerCase().trim();
          if (recentSent.includes(payloadLower)) {
            isFollowupDup = true;
            decision.decision = "deliberate_silence";
            decision.reason = "Duplicate of recently sent message.";
          }
        }
        if (!isFollowupDup) {
          // Request the speaker floor at scheduling time so the coordinator's
          // 15s floor gap protects the delayed send from overlapping with
          // other bots.
          const candidate: BotCandidate = {
            decision: "quick_followup",
            confidence: conf,
            payload: decision.action_payload,
            personaFit,
            isMentioned,
          };
          const granted = force ? true : await botCoordinator.requestFloor(botId, candidate);
          if (!granted) {
            store.setBotLastAutoForgeDecision(botId, { ...decision, decision: "deliberate_silence", reason: "Lost speaker floor — another bot won the bid.", timestamp: now, activityLevel, personaFit, isMentioned });
            store.addBotAutoForgeEvent(botId, {
              timestamp: Date.now(),
              type: "silence",
              severity: "low",
              summary: `[${bot.session.username}] Lost speaker floor — deferring quick_followup "${decision.action_payload.slice(0, 40)}"`,
              details: { decision: "quick_followup", confidence: conf },
            });
            store.setBotAutoForgeNextActionMs(botId, Date.now() + 20_000);
            releaseFM();
            return;
          }

          toast.info(`[${bot.session.username}] quick follow-up in ${(delayMs / 1000).toFixed(1)}s`, { description: decision.action_payload });
          playSfx("autoforge_action");
          botLimiter.recordAction("quick_followup");
          store.incrementBotStat(botId, "autoForgeActions");
          store.incrementStat("followupActions");

          // Clear any pending follow-up before scheduling a new one to avoid timer leaks
          if (followupTimerRef.current) {
            clearTimeout(followupTimerRef.current);
            followupTimerRef.current = null;
          }

          const channel = store.streamMetadata.channelName;
          const followupPayload = decision.action_payload;
          const followupReason = decision.reason;
          const followupConf = conf;
          // The send is deferred — keep the First Message lock held until it
          // resolves (complete on success via addBotSentMessage, release on
          // failure). Skip the end-of-cycle release for this path.
          firstMessageSendPending = true;

          followupTimerRef.current = setTimeout(() => {
            followupTimerRef.current = null;
            const sendFn = getPlatformSendFn(store.platform, botId);
            sendFn(channel, followupPayload).then(() => {
              store.updateBotDecisionLogEntry(botId, decisionLogId, { outcome: "sent" });
              speakMessage(followupPayload);
              store.addBotSentMessage(botId, {
                message: followupPayload,
                channel,
                timestamp: Date.now(),
                source: "followup",
                botId,
              });
              store.incrementBotStat(botId, "messagesSent");
              store.incrementMessagesSent();
              store.setBotAutoForgeLastActionMs(botId, Date.now());
              store.updateBotRuntime(botId, { autoForgeFollowup: { message: followupPayload, deliveredAt: Date.now() } });
              store.addBotActionHistoryEntry(botId, {
                timestamp: Date.now(),
                actionType: "quick_followup",
                message: followupPayload,
                provider: decision.used_fallback_provider || activeProvider,
                success: true,
              });
              // D4: Schedule post-send engagement correlation
              scheduleEngagementCheck("quick_followup", followupPayload, Date.now());
              store.addBotAutoForgeEvent(botId, {
                timestamp: Date.now(),
                type: "action_sent",
                severity: "medium",
                summary: `[${bot.session.username}] Quick follow-up: "${followupPayload}"`,
                details: { decision: "quick_followup", confidence: followupConf, reason: followupReason, action_payload: followupPayload, delay_ms: delayMs },
              });
            }).catch((e) => {
              store.updateBotDecisionLogEntry(botId, decisionLogId, { outcome: "failed" });
              console.error(`[AutoForgeBot ${bot.session.username}] quick_followup send failed:`, e);
              store.addBotAutoForgeEvent(botId, {
                timestamp: Date.now(),
                type: "error",
                severity: "high",
                summary: `[${bot.session.username}] Quick follow-up send FAILED: ${e.message || e}`,
                details: { decision: "quick_followup", message: followupPayload },
              });
              releaseFM();
            });
          }, delayMs);
        }
        }
      } else if (decision.decision !== "deliberate_silence" && decision.action_payload) {
        // Direct-send path for short_reaction, emote_only, joke_callback, meta_observation
        // (matches the legacy useAutoForge send path — meta_observation is a
        // valid action that sends a light meta comment, not a silence).
        // C5: Per-action rate limit check
        if (!force && !supercharged && !botLimiter.canAct(decision.decision)) {
          store.addBotAutoForgeEvent(botId, {
            timestamp: Date.now(),
            type: "silence",
            severity: "low",
            summary: `[${bot.session.username}] ${decision.decision} per-action rate limited`,
          });
          decision.decision = "deliberate_silence";
          decision.reason = `${decision.decision} per-action rate limit reached.`;
        } else {
        // A2: For joke_callback, consult the joke engine to verify the joke
        // is real and active. If no matching joke is found, downgrade to
        // short_reaction so we don't send a fabricated punchline.
        let effectiveDecision = decision.decision;
        if (decision.decision === "joke_callback" && runtime.autoMemoryConfig?.enabled) {
          try {
            const activeJokes = getActiveJokes(runtime.insideJokes);
            if (activeJokes.length > 0) {
              const contextText = `${store.chatLog.slice(-10).map((m) => m.text).join(" ")} ${store.audioTranscript?.slice(-200) || ""} ${store.visualContextTags.join(" ")}`;
              const scored = activeJokes
                .map((j) => ({ joke: j, score: scoreJokeRelevance(j, contextText) }))
                .sort((a, b) => b.score - a.score);
              const bestMatch = scored[0];
              const punchlineLower = (bestMatch.joke.punchline || "").toLowerCase();
              const payloadLower = (decision.action_payload || "").toLowerCase();
              const matchesJoke = bestMatch.score > 0.1 ||
                payloadLower.includes(punchlineLower) ||
                punchlineLower.includes(payloadLower);
              if (matchesJoke) {
                recordJokeUsage((store.streamMetadata.channelName || "default").toLowerCase(), bestMatch.joke.id, decision.action_payload).catch(console.error);
              } else {
                console.log(`[AutoForgeBot ${bot.session.username}] joke_callback payload doesn't match any active joke — downgrading to short_reaction`);
                effectiveDecision = "short_reaction";
                store.updateBotDecisionLogEntry(botId, decisionLogId, {
                  reasoning: "joke_callback downgraded to short_reaction (no matching active joke)",
                });
              }
            } else {
              effectiveDecision = "short_reaction";
              store.updateBotDecisionLogEntry(botId, decisionLogId, {
                reasoning: "joke_callback downgraded to short_reaction (no active jokes)",
              });
            }
          } catch (e) {
            console.error(`[AutoForgeBot ${bot.session.username}] joke engine check failed:`, e);
          }
        }

        // Dedup guard (per-bot sent history) — bypassed for forced checks
        // (the user explicitly requested action; the SendGuard dedup at the
        // Twitch level still catches exact duplicates before they go out).
        let isDup = false;
        if (!force) {
          const recentSent = runtime.sentMessages.slice(-15).map((m) => m.message.toLowerCase().trim());
          const payloadLower = decision.action_payload.toLowerCase().trim();
          if (recentSent.includes(payloadLower)) {
            isDup = true;
            decision.decision = "deliberate_silence";
            decision.reason = "Duplicate of recently sent message.";
          }
        }
        if (!isDup) {
          // Request the speaker floor from the coordinator (unless forced).
          const candidate: BotCandidate = {
            decision: effectiveDecision,
            confidence: conf,
            payload: decision.action_payload,
            personaFit,
            isMentioned,
          };
          const granted = force ? true : await botCoordinator.requestFloor(botId, candidate);
          if (!granted) {
            // Lost the floor — stand down this cycle, retry soon.
            store.setBotLastAutoForgeDecision(botId, { ...decision, decision: "deliberate_silence", reason: "Lost speaker floor — another bot won the bid.", timestamp: now, activityLevel, personaFit, isMentioned });
            store.addBotAutoForgeEvent(botId, {
              timestamp: Date.now(),
              type: "silence",
              severity: "low",
              summary: `Lost speaker floor — deferring "${decision.action_payload.slice(0, 40)}"`,
              details: { decision: effectiveDecision, confidence: conf },
            });
            store.setBotAutoForgeNextActionMs(botId, Date.now() + 20_000);
            releaseFM();
            return;
          }

          // Won the floor — send via this bot's own identity.
          const sendFn = getPlatformSendFn(store.platform, botId);
          const channel = store.streamMetadata.channelName;
          playSfx("autoforge_action");
          botLimiter.recordAction(effectiveDecision);
          store.incrementBotStat(botId, "autoForgeActions");
          store.incrementStat("autoForgeActions");

          try {
            await sendFn(channel, decision.action_payload);
            store.updateBotDecisionLogEntry(botId, decisionLogId, { outcome: "sent" });
          } catch (e: any) {
            store.updateBotDecisionLogEntry(botId, decisionLogId, { outcome: "failed" });
            console.error(`[AutoForgeBot ${bot.session.username}] send failed:`, e);
            store.addBotAutoForgeEvent(botId, {
              timestamp: Date.now(),
              type: "error",
              severity: "high",
              summary: `Send failed: ${e.message || e}`,
            });
            store.setBotAutoForgeNextActionMs(botId, Date.now() + 20_000);
            releaseFM();
            return;
          }

          speakMessage(decision.action_payload);
          store.addBotSentMessage(botId, {
            message: decision.action_payload,
            channel,
            timestamp: Date.now(),
            source: "autoforge",
            botId,
          });
          store.incrementBotStat(botId, "messagesSent");
          store.incrementMessagesSent();
          store.addBotActionHistoryEntry(botId, {
            timestamp: Date.now(),
            actionType: effectiveDecision,
            message: decision.action_payload,
            provider: decision.used_fallback_provider || activeProvider,
            success: true,
          });
          // D4: Schedule post-send engagement correlation
          scheduleEngagementCheck(effectiveDecision, decision.action_payload, Date.now());
          store.setBotAutoForgeLastActionMs(botId, Date.now());
          store.addBotAutoForgeEvent(botId, {
            timestamp: Date.now(),
            type: "action_sent",
            severity: "high",
            summary: `[${bot.session.username}] ${effectiveDecision}: "${decision.action_payload}"`,
            details: { decision: effectiveDecision, confidence: conf, reason: decision.reason },
          });

          // Boost referenced memories and jokes (per-bot auto-memory).
          // Mirrors the legacy useAutoForge post-send memory boosting.
          if (runtime.autoMemoryConfig?.enabled) {
            if (decision.referenced_memory_ids) {
              for (const mid of decision.referenced_memory_ids) {
                boostMemory((store.streamMetadata.channelName || "default").toLowerCase(), mid).catch(console.error);
              }
            }
            if (decision.referenced_joke_ids) {
              for (const jid of decision.referenced_joke_ids) {
                boostJoke((store.streamMetadata.channelName || "default").toLowerCase(), jid, decision.action_payload).catch(console.error);
                recordJokeUsage((store.streamMetadata.channelName || "default").toLowerCase(), jid, decision.action_payload).catch(console.error);
              }
            }
          }
        }
        }
      } else if (decision.decision === "deliberate_silence") {
        store.incrementBotStat(botId, "silenceDecisions");
        store.incrementStat("silenceDecisions");
        consecutiveSilenceRef.current++;
        store.addBotAutoForgeEvent(botId, {
          timestamp: Date.now(),
          type: "silence",
          severity: "low",
          summary: `[${bot.session.username}] Silence: ${decision.reason}`,
          details: { decision: decision.decision, confidence: conf, reason: decision.reason },
        });
      } else {
        // Any non-silence action resets the consecutive silence counter.
        consecutiveSilenceRef.current = 0;
      }

      // First Message: release the lock for any cycle that did NOT dispatch a
      // send (silence, meta_observation, rate-limited fallthrough, or a send
      // that already completed — release is a no-op once status is "complete").
      // Skipped when a quick_followup send is still deferred (its own
      // .then/.catch handles completion/release).
      if (isFirstMessage && !firstMessageSendPending) releaseFM();

      // ── Evaluate session goals ──────────────────────────────────────────
      if (store.sessionGoals && store.sessionGoals.length > 0) {
        const results = evaluateSessionGoals(
          store.sessionGoals,
          store.enhancedStats,
          store.sentimentHistory,
        );
        useAppStore.getState().setGoalEvaluationResults(results);
      }

      // ── Schedule next check ──────────────────────────────────────────────
      let nextMin = computeNextActionMinutes(decision.estimated_next_action_minutes, activitySpike, decision.decision);
      // Adaptive backoff: lengthen the check interval during consecutive
      // silences to reduce unnecessary AI calls during dead periods.
      nextMin = computeAdaptiveBackoff(consecutiveSilenceRef.current, nextMin, isMentioned, activitySpike);

      // Supercharge mode: clamp the next-check interval short so bots re-engage
      // quickly and can hold a cross-bot conversation. The model's own
      // estimated_next_action_minutes is respected but capped at 1.5 min, and
      // the adaptive backoff is skipped (silence shouldn't lengthen the gap
      // when the user asked for maximum engagement).
      if (supercharged) {
        nextMin = Math.min(nextMin, 1.5);
      }

      // A8: Manual activity awareness — delay next AutoForge action if user
      // recently acted or is typing. Mirrors the legacy useAutoForge manual
      // cooldown. Prevents bots from stepping on the user's manual sends.
      // Supercharge mode still respects this — the user's manual sends always
      // outrank autonomous activity (realtime-first).
      const nowMs = Date.now();
      const manualCooldown = computeManualCooldown(
        useAppStore.getState().lastManualSendMs,
        useAppStore.getState().lastUserChatTypingMs,
        nowMs,
      );
      if (manualCooldown.shouldDelay && decision.decision !== "deliberate_silence") {
        const delayMin = manualCooldown.delayMs / 60000;
        store.addBotAutoForgeEvent(botId, {
          timestamp: nowMs,
          type: "silence",
          severity: "low",
          summary: `[${bot.session.username}] Delayed — manual activity detected (${Math.round(manualCooldown.msSinceManual / 1000)}s ago)`,
          details: { delayMs: manualCooldown.delayMs, msSinceManual: manualCooldown.msSinceManual },
        });
        nextMin = Math.max(nextMin, delayMin);
      }

      store.setBotAutoForgeNextActionMs(botId, nowMs + nextMin * 60 * 1000);
    } catch (e: any) {
      const errMsg = e?.message || "Unknown error";
      if (isSchedulerCancellation(e) || isQueueTimeout(e)) {
        // Intentional yield or queue timeout — not a failure. The scheduler
        // either preempted/cancelled this work for higher-priority traffic,
        // or the request waited too long for the Ollama slot (too many bots
        // queued). No error toast, retry shortly instead of +60s.
        console.log(`[AutoForgeBot ${botId}] yielded: ${errMsg}`);
        store.addBotAutoForgeEvent(botId, {
          timestamp: Date.now(),
          type: "silence",
          severity: "low",
          summary: `[${bot.session?.username ?? botId}] ${isQueueTimeout(e) ? "Queue timeout — Ollama slot busy" : "Yielded to higher-priority request"} — retrying shortly`,
          details: { reason: errMsg },
        });
        store.setBotAutoForgeNextActionMs(botId, Date.now() + 20_000);
      } else {
        if (!errMsg.includes("No API key configured")) {
          console.error(`[AutoForgeBot ${botId}] failed:`, e);
          toast.error(`AutoForge [bot] failed: ${errMsg}`);
        }
        store.setBotAutoForgeNextActionMs(botId, Date.now() + 60000);
      }
      // Safety net: if autoforgeDecide (or any pre-send step) threw while the
      // First Message lock was held, restore it to "armed" so the next cycle
      // can retry. No-op if the bot already completed or was never armed.
      useAppStore.getState().releaseFirstMessageLock(botId);
    } finally {
      isForgingRef.current = false;
      useAppStore.getState().setBotIsAutoForgeThinking(botId, false);
    }
  };

  // Lightweight mention watcher — runs when AutoForge is OFF but smart
  // replies are enabled. Detects this bot's mentions and generates smart
  // replies without the expensive AutoForge decision loop.
  const checkBotMentionsOnly = async () => {
    const store = useAppStore.getState();
    if (!store.smartRepliesEnabled || !canGenerateSmartReplies()) return;
    const bot = store.bots.find((b) => b.id === botId);
    if (!bot || !bot.active || !bot.session) return;

    const botUsername = (bot.session.username || "").toLowerCase();
    if (!botUsername) return;

    const recentMessages = store.chatLog.slice(-15).filter((m) => !m.marker);
    const mentionedLines: string[] = [];
    for (const msg of recentMessages) {
      if (isNameMentioned(msg.text, botUsername)) {
        mentionedLines.push(`${msg.user}: ${msg.text}`);
      }
    }
    const audioMentionLines: string[] = [];
    if (store.audioTranscript) {
      const audioLines = store.audioTranscript.split("\n").slice(-15);
      for (const line of audioLines) {
        if (isNameMentioned(line, botUsername)) {
          audioMentionLines.push(`[AUDIO] ${line}`);
        }
      }
    }
    const allMentionLines = [...mentionedLines, ...audioMentionLines];
    if (allMentionLines.length === 0) return;

    store.setSmartRepliesLoading(true);
    generateSmartReplies(allMentionLines, { botId })
      .then((replies) => {
        if (replies.length > 0) useAppStore.getState().setSmartReplies(replies);
        useAppStore.getState().setSmartRepliesLoading(false);
      })
      .catch((e) => {
        if (!isSchedulerCancellation(e) && !isQueueTimeout(e)) {
          console.error(`[AutoForgeBot ${bot.session.username}] Smart reply generation failed:`, e);
        }
        useAppStore.getState().setSmartRepliesLoading(false);
      });
  };

  useEffect(() => {
    // Stagger bot check intervals so they don't all fire at once and flood
    // the single Ollama slot. Each bot's tick is offset by its index in the
    // roster, distributed evenly across the 15s window. Without this, N
    // bots all queue simultaneously → queue depth N × ~10s → later bots
    // always queue-timeout.
    const computeStaggerMs = () => {
      const bots = useAppStore.getState().bots;
      const idx = bots.findIndex((b) => b.id === botId);
      const count = bots.length || 1;
      return Math.max(0, idx) * (15000 / count);
    };

    const tick = () => {
      const store = useAppStore.getState();
      if (store.multiBotEnabled && store.autoForgeEnabled && store.autoForgeAutoCheckEnabled) {
        const bot = store.bots.find((b) => b.id === botId);
        if (bot && bot.active && bot.session) checkBot();
      } else if (store.multiBotEnabled && !store.autoForgeEnabled && store.smartRepliesEnabled) {
        // AutoForge off — still detect mentions for smart replies
        checkBotMentionsOnly();
      }
    };

    // Initial staggered start — each bot waits its offset before the first
    // tick, then settles into the regular 15s cadence.
    const staggerMs = computeStaggerMs();
    let botInterval: ReturnType<typeof setInterval> | undefined;
    const startTimer = setTimeout(() => {
      tick();
      botInterval = setInterval(tick, 15000);
    }, staggerMs);

    // Clean up expired smart replies every 10 seconds (mirrors legacy loop).
    // Multiple bot loops may run this — the work is idempotent and trivial.
    const replyCleanup = setInterval(() => {
      const current = useAppStore.getState().smartReplies;
      if (current.length > 0) {
        const cleaned = cleanExpiredSmartReplies(current);
        if (cleaned.length !== current.length) {
          useAppStore.getState().setSmartReplies(cleaned);
        }
      }
    }, 10000);

    const onForce = (e: Event) => {
      const store = useAppStore.getState();
      if (!store.multiBotEnabled) return;
      // Support targeted force: if the event carries detail.botId, only the
      // matching bot loop responds. Without detail, all bots force (legacy).
      const targetBotId = (e as CustomEvent).detail?.botId;
      if (targetBotId && targetBotId !== botId) return;
      const bot = store.bots.find((b) => b.id === botId);
      if (bot && bot.active && bot.session) checkBot(true);
    };
    window.addEventListener("autoforge-force-check", onForce);

    return () => {
      clearTimeout(startTimer);
      if (botInterval) clearInterval(botInterval);
      clearInterval(replyCleanup);
      window.removeEventListener("autoforge-force-check", onForce);
      if (followupTimerRef.current) {
        clearTimeout(followupTimerRef.current);
        followupTimerRef.current = null;
      }
      engagementTimersRef.current.forEach((t) => clearTimeout(t));
      engagementTimersRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);

  return null;
}
