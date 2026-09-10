import { useEffect, useRef } from "react";
import { useAppStore } from "../store";
import { toast } from "sonner";
import { autoforgeDecide } from "../lib/ai";
import { getPlatformSendFn } from "../lib/platformSend";
import { botCoordinator, type BotCandidate } from "../lib/botCoordinator";
import { playSfx } from "../lib/sfx";
import { speakMessage } from "../lib/tts";
import { getActiveProvider, getApiKey, hasAnyApiKey, getProviderWithKey } from "../lib/keys";
import { formatChatLog } from "../lib/chatUtils";
import { retrieveRelevantMemories, formatMemoryContext } from "../lib/memoryRetrieval";
import { analyzeRepetition, formatRepetitionContext } from "../lib/antiRepetition";
import { actionRateLimiter } from "../lib/actionRateLimiter";
import { summarizeSentiment, formatSentimentContext } from "../lib/sentiment";
import { getAvailableEmoteNames } from "../lib/emotes";

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
 * v1 scope: core decide → coordinate → send → record cycle. Advanced features
 * from the legacy loop (rule engine, smart replies, post-send engagement
 * correlation, session goals) are deferred for per-bot mode and can be layered
 * onto this loop later.
 */
export function useAutoForgeBot(botId: string) {
  const isForgingRef = useRef(false);
  const lastChatLengthRef = useRef(0);
  const lastCheckTimeRef = useRef(Date.now());
  const lastMessagesReceivedRef = useRef(0);

  const checkBot = async (force = false) => {
    if (isForgingRef.current) return;
    const store = useAppStore.getState();
    if (!store.multiBotEnabled) return;
    const bot = store.bots.find((b) => b.id === botId);
    if (!bot || !bot.active || !bot.session) return;
    if (!store.autoForgeEnabled || store.isForging) return;

    const runtime = bot.runtime;
    if (!force && Date.now() < runtime.autoForgeNextActionMs) return;

    isForgingRef.current = true;
    store.setBotIsAutoForgeThinking(botId, true);
    try {
      const activeProvider = getActiveProvider();
      if (!getApiKey(activeProvider) && !hasAnyApiKey()) {
        store.setBotAutoForgeNextActionMs(botId, Date.now() + 60000);
        return;
      }
      if (!getApiKey(activeProvider)) {
        const fallback = getProviderWithKey();
        if (!fallback) {
          store.setBotAutoForgeNextActionMs(botId, Date.now() + 60000);
          return;
        }
      }

      // ── Activity metrics (from shared chat) ──────────────────────────────
      const currentMessagesReceived = store.sessionStats.messagesReceived;
      const now = Date.now();
      const elapsedMs = now - lastCheckTimeRef.current;
      const elapsedMin = elapsedMs / 60000;
      const newMessages = Math.max(0, currentMessagesReceived - lastMessagesReceivedRef.current);
      const chatVelocity = elapsedMin > 0 ? Math.round(newMessages / elapsedMin) : 0;
      let activityLevel = 0;
      if (chatVelocity >= 30) activityLevel = 4;
      else if (chatVelocity >= 15) activityLevel = 3;
      else if (chatVelocity >= 5) activityLevel = 2;
      else if (chatVelocity >= 1) activityLevel = 1;
      const activitySpike = newMessages >= 10 && elapsedMs < 120000;
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
      const sentimentHistoryForEngagement = store.sentimentHistory;
      const recentSentiment = sentimentHistoryForEngagement.slice(-20);
      const positiveRatio = recentSentiment.length > 0
        ? recentSentiment.filter((s) => s.label === "positive" || s.label === "hype" || s.label === "wholesome").length / recentSentiment.length
        : 0.5;
      const velocityScore = Math.min(1, chatVelocity / 30);
      const sentimentScore = positiveRatio;
      const diversityScore = Math.min(1, uniqueChatters / 20);
      const recencyScore = runtime.autoForgeLastActionMs
        ? Math.max(0, 1 - (now - runtime.autoForgeLastActionMs) / 600000)
        : 0;
      const engagementOverall = Math.round((velocityScore * 0.35 + sentimentScore * 0.25 + diversityScore * 0.25 + recencyScore * 0.15) * 100);
      store.setEngagementScore({
        velocityScore: Math.round(velocityScore * 100),
        sentimentScore: Math.round(sentimentScore * 100),
        diversityScore: Math.round(diversityScore * 100),
        recencyScore: Math.round(recencyScore * 100),
        overall: engagementOverall,
      });

      // ── Mention detection for THIS bot's username ────────────────────────
      const botUsername = (bot.session.username || "").toLowerCase();
      const recentMessages = store.chatLog.slice(-15).filter((m) => !m.marker);
      const mentionedLines: string[] = [];
      if (botUsername) {
        for (const msg of recentMessages) {
          const lower = msg.text.toLowerCase();
          if (lower.includes(botUsername) || lower.includes(`@${botUsername}`)) {
            mentionedLines.push(`${msg.user}: ${msg.text}`);
          }
        }
      }
      const isMentioned = mentionedLines.length > 0;

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
        });
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

      // ── Rate limit (shared action limiter; v1 simplification) ────────────
      if (!force && !actionRateLimiter.canAct()) {
        const rateStats = actionRateLimiter.getStats();
        store.setBotAutoForgeNextActionMs(botId, Date.now() + Math.max(30000, rateStats.msUntilNextAllowed));
        return;
      }

      // ── Decide ───────────────────────────────────────────────────────────
      const decision = await autoforgeDecide({
        streamMetadata: store.streamMetadata,
        visualContext: store.visualContextTags.join(" "),
        recentChatLog: formatChatLog(store.chatLog),
        audioTranscript: store.audioTranscript,
        longTermContext: runtime.longTermMemory || [
          ...runtime.pinnedMemories.filter((m) => m.id !== runtime.goldenMemoryId).map((m) => m.label),
          ...runtime.pinnedMemories.filter((m) => m.id === runtime.goldenMemoryId).map((m) => `[GOLDEN MEMORY — PRIORITIZE THIS]: ${m.label}`),
        ].join("\n"),
        config: bot.persona.config,
        activeProvider,
        lastActionMs: runtime.autoForgeLastActionMs,
        currentChatActivity: activityLevel,
        chatVelocity,
        activitySpike,
        isMentioned,
        mentionedLines,
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
      });

      store.setBotLastAutoForgeDecision(botId, { ...decision, timestamp: now, activityLevel, personaFit, isMentioned });

      // Confidence threshold (unless forced)
      const conf = typeof decision.confidence === "number" && !isNaN(decision.confidence)
        ? decision.confidence
        : Number(decision.confidence) || 0;
      const threshold = store.autoForgeConfidenceThreshold ?? 0.5;
      if (!force && conf < threshold && decision.decision !== "deliberate_silence") {
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
        store.setBotAutoForgeLastActionMs(botId, Date.now());
        let nextMin = decision.estimated_next_action_minutes || 1.5;
        if (!Number.isFinite(nextMin) || nextMin < 0) nextMin = 1.5;
        store.setBotAutoForgeNextActionMs(botId, Date.now() + nextMin * 60 * 1000);
        return;
      }

      // ── Act (only non-silence, with a payload) ───────────────────────────
      const isActing =
        decision.decision !== "deliberate_silence" &&
        decision.decision !== "meta_observation" &&
        !!decision.action_payload;

      if (isActing && decision.action_payload) {
        // Dedup guard (per-bot sent history)
        const recentSent = runtime.sentMessages.slice(-15).map((m) => m.message.toLowerCase().trim());
        const payloadLower = decision.action_payload.toLowerCase().trim();
        if (recentSent.includes(payloadLower)) {
          decision.decision = "deliberate_silence";
          decision.reason = "Duplicate of recently sent message.";
        } else {
          // Request the speaker floor from the coordinator (unless forced).
          const candidate: BotCandidate = {
            decision: decision.decision,
            confidence: conf,
            payload: decision.action_payload,
            personaFit,
          };
          const granted = force ? true : await botCoordinator.requestFloor(botId, candidate);
          if (!granted) {
            // Lost the floor — stand down this cycle, retry soon.
            store.addBotAutoForgeEvent(botId, {
              timestamp: Date.now(),
              type: "silence",
              severity: "low",
              summary: `Lost speaker floor — deferring "${decision.action_payload.slice(0, 40)}"`,
              details: { decision: decision.decision, confidence: conf },
            });
            store.setBotAutoForgeNextActionMs(botId, Date.now() + 20_000);
            return;
          }

          // Won the floor — send via this bot's own identity.
          const sendFn = getPlatformSendFn(store.platform, botId);
          const channel = store.streamMetadata.channelName;
          playSfx("autoforge_action");
          actionRateLimiter.recordAction(decision.decision);
          store.incrementBotStat(botId, "autoForgeActions");

          sendFn(channel, decision.action_payload).catch((e) => {
            console.error(`[AutoForgeBot ${bot.session.username}] send failed:`, e);
            store.addBotAutoForgeEvent(botId, {
              timestamp: Date.now(),
              type: "error",
              severity: "high",
              summary: `Send failed: ${e.message || e}`,
            });
          });

          speakMessage(decision.action_payload);
          store.addBotSentMessage(botId, {
            message: decision.action_payload,
            channel,
            timestamp: Date.now(),
            source: "autoforge",
            botId,
          });
          store.incrementBotStat(botId, "messagesSent");
          store.addBotActionHistoryEntry(botId, {
            timestamp: Date.now(),
            actionType: decision.decision,
            message: decision.action_payload,
            provider: activeProvider,
            success: true,
          });
          store.setBotAutoForgeLastActionMs(botId, Date.now());
          store.addBotAutoForgeEvent(botId, {
            timestamp: Date.now(),
            type: "action_sent",
            severity: "high",
            summary: `[${bot.session.username}] ${decision.decision}: "${decision.action_payload}"`,
            details: { decision: decision.decision, confidence: conf, reason: decision.reason },
          });
        }
      } else if (decision.decision === "deliberate_silence") {
        store.incrementBotStat(botId, "silenceDecisions");
        store.addBotAutoForgeEvent(botId, {
          timestamp: Date.now(),
          type: "silence",
          severity: "low",
          summary: `[${bot.session.username}] Silence: ${decision.reason}`,
          details: { decision: decision.decision, confidence: conf, reason: decision.reason },
        });
      }

      // ── Schedule next check ──────────────────────────────────────────────
      let nextMin = decision.estimated_next_action_minutes || 1.5;
      if (!Number.isFinite(nextMin) || nextMin < 0) nextMin = 1.5;
      if (activitySpike && decision.decision === "deliberate_silence") {
        nextMin = Math.min(nextMin, 0.5);
      }
      store.setBotAutoForgeNextActionMs(botId, Date.now() + nextMin * 60 * 1000);
    } catch (e: any) {
      const errMsg = e?.message || "Unknown error";
      if (!errMsg.includes("No API key configured")) {
        console.error(`[AutoForgeBot ${botId}] failed:`, e);
        toast.error(`AutoForge [bot] failed: ${errMsg}`);
      }
      store.setBotAutoForgeNextActionMs(botId, Date.now() + 60000);
    } finally {
      isForgingRef.current = false;
      useAppStore.getState().setBotIsAutoForgeThinking(botId, false);
    }
  };

  useEffect(() => {
    const interval = setInterval(() => {
      const store = useAppStore.getState();
      if (store.multiBotEnabled && store.autoForgeEnabled) {
        const bot = store.bots.find((b) => b.id === botId);
        if (bot && bot.active && bot.session) checkBot();
      }
    }, 15000);

    const onForce = () => {
      const store = useAppStore.getState();
      if (store.multiBotEnabled) {
        const bot = store.bots.find((b) => b.id === botId);
        if (bot && bot.active && bot.session) checkBot(true);
      }
    };
    window.addEventListener("autoforge-force-check", onForce);

    return () => {
      clearInterval(interval);
      window.removeEventListener("autoforge-force-check", onForce);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);

  return null;
}
