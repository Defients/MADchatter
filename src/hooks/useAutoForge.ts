import { useEffect, useRef } from "react";
import { useAppStore } from "../store";
import { toast } from "sonner";
import { autoforgeDecide } from "../lib/ai";
import { getTwitchSession } from "../lib/twitch";
import { getKickSession } from "../lib/kick";
import { getJoystickSession } from "../lib/joystick";
import { getPlatformSendFn } from "../lib/platformSend";
import { playMessageSound } from "../lib/sound";
import { speakMessage } from "../lib/tts";
import { playSfx } from "../lib/sfx";
import { getActiveProvider, getApiKey, hasAnyApiKey, getProviderWithKey } from "../lib/keys";
import { formatChatLog } from "../lib/chatUtils";
import { retrieveRelevantMemories, formatMemoryContext } from "../lib/memoryRetrieval";
import { boostMemory, boostJoke } from "../lib/memoryEngine";
import { recordJokeUsage } from "../lib/jokeEngine";
import { analyzeRepetition, formatRepetitionContext } from "../lib/antiRepetition";
import { actionRateLimiter } from "../lib/actionRateLimiter";
import { summarizeSentiment, formatSentimentContext } from "../lib/sentiment";
import { notifyMention, notifyAutoForgeError, notifyActivitySpike } from "../lib/notifications";
import { generateSmartReplies, canGenerateSmartReplies, cleanExpiredSmartReplies } from "../lib/smartReplies";

export function useAutoForge() {
  const {
    autoForgeEnabled,
    config,
    streamMetadata,
    audioTranscript,
    chatLog,
    visualSnapshotUrl,
    visualContextTags,
    longTermMemory,
    pinnedMemories,
    goldenMemoryId,
    isForging,
    setLastAutoForgeDecision,
    autoForgeLastActionMs,
    setAutoForgeLastActionMs,
    autoForgeNextActionMs,
    setAutoForgeNextActionMs,
    r34lEnabled,
    setAutoForgeFollowup,
    addAutoForgeEvent,
    addSentMessage,
    incrementMessagesSent,
    platform,
    messageSoundEnabled,
    autoMemoryConfig,
    autoMemories,
    userProfiles,
    insideJokes,
    personalityState,
    sentMessages,
    rateLimitConfig,
    incrementStat,
    addActionHistoryEntry,
    updateEnhancedStats,
    addDecisionLogEntry,
    updateDecisionLogEntry,
    markAutoForgeActionBucket,
    smartRepliesEnabled,
    setSmartReplies,
    setSmartRepliesLoading,
    autoForgeDryRun,
    autoForgeConfidenceThreshold,
    sessionGoals,
  } = useAppStore();

  const lastChatLengthRef = useRef(0);
  const lastCheckTimeRef = useRef(Date.now());
  const lastMessagesReceivedRef = useRef(0);
  const followupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const storeRef = useRef({ config, streamMetadata, audioTranscript, chatLog, visualSnapshotUrl, visualContextTags, longTermMemory, pinnedMemories, goldenMemoryId, isForging, autoForgeEnabled, autoForgeLastActionMs, autoForgeNextActionMs, r34lEnabled, platform, autoMemoryConfig, autoMemories, userProfiles, insideJokes, personalityState, sentMessages, rateLimitConfig, autoForgeDryRun, autoForgeConfidenceThreshold, sessionGoals });

  storeRef.current = { config, streamMetadata, audioTranscript, chatLog, visualSnapshotUrl, visualContextTags, longTermMemory, pinnedMemories, goldenMemoryId, isForging, autoForgeEnabled, autoForgeLastActionMs, autoForgeNextActionMs, r34lEnabled, platform, autoMemoryConfig, autoMemories, userProfiles, insideJokes, personalityState, sentMessages, rateLimitConfig, autoForgeDryRun, autoForgeConfidenceThreshold, sessionGoals };

  // Sync rate limiter config
  actionRateLimiter.updateConfig(rateLimitConfig);
  const addEventRef = useRef(addAutoForgeEvent);
  addEventRef.current = addAutoForgeEvent;
  const addSentMsgRef = useRef(addSentMessage);
  addSentMsgRef.current = addSentMessage;
  const incrSentRef = useRef(incrementMessagesSent);
  incrSentRef.current = incrementMessagesSent;
  const addDecisionRef = useRef(addDecisionLogEntry);
  addDecisionRef.current = addDecisionLogEntry;
  const updateDecisionRef = useRef(updateDecisionLogEntry);
  updateDecisionRef.current = updateDecisionLogEntry;
  const markActionBucketRef = useRef(markAutoForgeActionBucket);
  markActionBucketRef.current = markAutoForgeActionBucket;

  const checkAutoForge = async (force = false) => {
    const state = storeRef.current;
    if (!state.autoForgeEnabled || state.isForging) return;
    
    // Only trigger if we've passed the next scheduled action time
    if (!force && Date.now() < state.autoForgeNextActionMs) return;

    try {
      const activeProvider = getActiveProvider();

      // Silently skip if no API key is configured for the active provider
      if (!getApiKey(activeProvider) && !hasAnyApiKey()) {
        setAutoForgeNextActionMs(Date.now() + 60000);
        return;
      }
      if (!getApiKey(activeProvider)) {
        // Active provider has no key, but another provider might — try to find one
        const fallbackProvider = getProviderWithKey();
        if (!fallbackProvider) {
          setAutoForgeNextActionMs(Date.now() + 60000);
          return;
        }
      }
      
      // Calculate current chat activity 0-4 using message counter (not chatLog.length which is capped)
      const currentMessagesReceived = useAppStore.getState().sessionStats.messagesReceived;
      const now = Date.now();
      const elapsedMs = now - lastCheckTimeRef.current;
      const elapsedMin = elapsedMs / 60000;
      const newMessages = Math.max(0, currentMessagesReceived - lastMessagesReceivedRef.current);
      const chatVelocity = elapsedMin > 0 ? Math.round(newMessages / elapsedMin) : 0;

      // Activity level derived from velocity (not chatLog.length which caps at 200)
      let activityLevel = 0;
      if (chatVelocity >= 30) activityLevel = 4;
      else if (chatVelocity >= 15) activityLevel = 3;
      else if (chatVelocity >= 5) activityLevel = 2;
      else if (chatVelocity >= 1) activityLevel = 1;

      // Spike = sudden burst of new messages (e.g. 10+ new lines in under 2 minutes)
      const activitySpike = newMessages >= 10 && elapsedMs < 120000;
      lastMessagesReceivedRef.current = currentMessagesReceived;
      lastCheckTimeRef.current = now;

      // Detect if the bot's own username is being mentioned or targeted in recent chat or audio
      const channelName = (state.streamMetadata.channelName || "").toLowerCase();
      const botUsername = state.platform === "kick"
        ? (getKickSession()?.username || "").toLowerCase()
        : state.platform === "joystick"
          ? (getJoystickSession()?.username || "").toLowerCase()
          : (getTwitchSession()?.username || "").toLowerCase();
      const mentionPatterns: string[] = [];
      if (botUsername) {
        mentionPatterns.push(botUsername);
        mentionPatterns.push(botUsername.replace(/[^a-z0-9]/g, ""));
      }
      // Also detect common targeting patterns: @username, direct replies, "hey [name]"
      const recentMessages = state.chatLog.slice(-15).filter(m => !m.marker);
      const mentionedLines: string[] = [];
      for (const msg of recentMessages) {
        const lower = msg.text.toLowerCase();
        if (mentionPatterns.some(p => p && lower.includes(p))) {
          mentionedLines.push(`${msg.user}: ${msg.text}`);
        }
        // Detect @mentions
        if (botUsername && lower.includes(`@${botUsername}`)) {
          if (!mentionedLines.includes(`${msg.user}: ${msg.text}`)) mentionedLines.push(`${msg.user}: ${msg.text}`);
        }
      }
      // Also check audio transcript for name mentions or references
      const audioMentionLines: string[] = [];
      if (state.audioTranscript) {
        const audioLines = state.audioTranscript.split("\n").slice(-15);
        for (const line of audioLines) {
          const lower = line.toLowerCase();
          if (mentionPatterns.some(p => p && lower.includes(p))) {
            audioMentionLines.push(`[AUDIO] ${line}`);
          }
        }
      }
      const isMentioned = mentionedLines.length > 0 || audioMentionLines.length > 0;
      const allMentionedLines = [...mentionedLines, ...audioMentionLines];

      // Track unique chatters for enhanced stats
      const uniqueChatters = new Set(state.chatLog.filter(m => !m.marker).map(m => m.user)).size;
      useAppStore.getState().updateEnhancedStats({ uniqueChatters, peakChatVelocity: Math.max(useAppStore.getState().enhancedStats.peakChatVelocity, chatVelocity) });

      // Calculate engagement score (composite metric)
      const sentimentHistoryForEngagement = useAppStore.getState().sentimentHistory;
      const recentSentiment = sentimentHistoryForEngagement.slice(-20);
      const positiveRatio = recentSentiment.length > 0
        ? recentSentiment.filter(s => s.label === "positive" || s.label === "hype" || s.label === "wholesome").length / recentSentiment.length
        : 0.5;
      const velocityScore = Math.min(1, chatVelocity / 30);
      const sentimentScore = positiveRatio;
      const diversityScore = Math.min(1, uniqueChatters / 20);
      const recencyScore = state.autoForgeLastActionMs
        ? Math.max(0, 1 - (now - state.autoForgeLastActionMs) / 600000)
        : 0;
      const engagementOverall = Math.round((velocityScore * 0.35 + sentimentScore * 0.25 + diversityScore * 0.25 + recencyScore * 0.15) * 100);
      useAppStore.getState().setEngagementScore({
        velocityScore: Math.round(velocityScore * 100),
        sentimentScore: Math.round(sentimentScore * 100),
        diversityScore: Math.round(diversityScore * 100),
        recencyScore: Math.round(recencyScore * 100),
        overall: engagementOverall,
      });

      // Detect likely offline stream: 0 viewers + no chat activity for 5+ minutes
      const viewerCount = state.streamMetadata?.viewerCount || 0;
      const noChatForLongTime = newMessages === 0 && elapsedMs > 300000;
      const likelyOffline = viewerCount === 0 && noChatForLongTime;
      useAppStore.getState().setStreamLikelyOffline(likelyOffline);
      if (likelyOffline && !force) {
        console.log("[AutoForge] Stream appears offline — skipping check");
        setAutoForgeNextActionMs(now + 120000);
        return;
      }

      // Run anti-repetition analysis
      const repetitionAnalysis = analyzeRepetition(state.sentMessages);
      const antiRepetitionContext = formatRepetitionContext(repetitionAnalysis);

      if (isMentioned) {
        incrementStat("mentionsDetected");
        if (useAppStore.getState().desktopNotificationsEnabled) {
          const firstMention = allMentionedLines[0] || "";
          const username = firstMention.split(":")[0] || "Someone";
          notifyMention(username, firstMention);
        }
        toast.warning(`You were mentioned!`, {
          description: allMentionedLines.slice(0, 2).map(l => l.length > 80 ? l.slice(0, 80) + "..." : l).join("\n"),
          id: "mention-alert",
          duration: 5000,
        });
        playSfx('mention_alert');
        addEventRef.current({
          timestamp: Date.now(),
          type: "mention",
          severity: "high",
          summary: `Mentioned by chat: ${allMentionedLines.slice(0, 3).join(" | ")}`,
          details: { mentionedLines: allMentionedLines, botUsername, channelName },
        });

        // Smart reply generation — only when AutoForge is off and smart replies are enabled
        if (smartRepliesEnabled && !state.autoForgeEnabled && canGenerateSmartReplies()) {
          setSmartRepliesLoading(true);
          generateSmartReplies(allMentionedLines)
            .then((replies) => {
              if (replies.length > 0) {
                setSmartReplies(replies);
              }
              setSmartRepliesLoading(false);
            })
            .catch((e) => {
              console.error("[AutoForge] Smart reply generation failed:", e);
              setSmartRepliesLoading(false);
            });
        }
      }

      if (activitySpike) {
        incrementStat("spikesDetected");
        if (useAppStore.getState().desktopNotificationsEnabled) {
          notifyActivitySpike(newMessages, chatVelocity);
        }
        addEventRef.current({
          timestamp: Date.now(),
          type: "spike",
          severity: "medium",
          summary: `Activity spike: ${newMessages} new lines in ${Math.round(elapsedMs / 1000)}s (velocity: ${chatVelocity}/min)`,
          details: { newMessages, elapsedMs, chatVelocity, activityLevel },
        });
      }

      // Build memory context if auto-memory is enabled
      let memoryContext = "";
      if (state.autoMemoryConfig?.enabled) {
        const retrieved = retrieveRelevantMemories(
          state.autoMemories,
          state.userProfiles,
          state.insideJokes,
          state.personalityState,
          {
            currentChatLog: state.chatLog,
            audioTranscript: state.audioTranscript,
            visualContext: state.visualContextTags.join(" "),
            streamMetadata: state.streamMetadata,
            activeUsers: [],
            tokenBudget: state.autoMemoryConfig.contextInjectionTokenBudget,
          },
        );
        memoryContext = formatMemoryContext(retrieved, {
          memoriesFormed: state.personalityState?.sessionMemoriesFormed ?? 0,
          jokesCreated: state.personalityState?.sessionJokesCreated ?? 0,
        });
      }

      // Build sentiment context
      let sentimentContext = "";
      const sentimentHistory = useAppStore.getState().sentimentHistory;
      if (sentimentHistory.length > 0) {
        const sentimentSummary = summarizeSentiment(sentimentHistory);
        sentimentContext = formatSentimentContext(sentimentSummary);
        useAppStore.getState().updateSentimentSummary(sentimentSummary);
      }

      // Check rate limits (unless forced)
      if (!force && !actionRateLimiter.canAct()) {
        const rateStats = actionRateLimiter.getStats();
        console.log(`[AutoForge] Rate limited: ${rateStats.actionsLastHour}/${rateStats.maxPerHour} per hour, ${rateStats.actionsLastTenMin}/${rateStats.maxPerTenMin} per 10min`);
        setAutoForgeNextActionMs(Date.now() + Math.max(30000, rateStats.msUntilNextAllowed));
        return;
      }

      const decisionStartTime = Date.now();

      const decision = await autoforgeDecide({
        streamMetadata: state.streamMetadata,
        visualContext: state.visualContextTags.join(" "),
        recentChatLog: formatChatLog(state.chatLog),
        audioTranscript: state.audioTranscript,
        longTermContext: state.longTermMemory || [
          ...state.pinnedMemories.filter(m => m.id !== state.goldenMemoryId).map(m => m.label),
          ...state.pinnedMemories.filter(m => m.id === state.goldenMemoryId).map(m => `[GOLDEN MEMORY — PRIORITIZE THIS]: ${m.label}`),
        ].join("\n"),
        config: state.config,
        activeProvider,
        lastActionMs: state.autoForgeLastActionMs,
        currentChatActivity: activityLevel,
        chatVelocity,
        activitySpike,
        isMentioned,
        mentionedLines: allMentionedLines,
        contextTokenLimit: state.config.autoForgeContextTokens ?? 4000,
        r34lEnabled: state.r34lEnabled,
        botUsername,
        force,
        memoryContext,
        antiRepetitionContext,
        sentimentContext,
      });
      const responseTimeMs = Date.now() - decisionStartTime;
      console.log("[AutoForge] Decision:", decision);

      // Record decision in decision log
      const sentimentSummary = useAppStore.getState().sentimentSummary;
      const decisionLogId = addDecisionRef.current({
        timestamp: Date.now(),
        decision: decision.decision === "deliberate_silence" || decision.decision === "meta_observation" ? "silence" : decision.decision === "quick_followup" ? "followup" : "action",
        action: decision.action_payload,
        reasoning: decision.reason,
        sentimentLabel: sentimentSummary?.current || "neutral",
        sentimentScore: sentimentSummary?.dominantScore || 0,
        chatVelocity,
        isMentioned,
        activitySpike,
        provider: activeProvider,
        responseTimeMs,
      });

      // Save to store for HUD
      setLastAutoForgeDecision({
        ...decision,
        timestamp: Date.now(),
        activityLevel,
      });

      // Track action distribution
      const actionDist = { ...useAppStore.getState().enhancedStats.actionDistribution };
      actionDist[decision.decision] = (actionDist[decision.decision] || 0) + 1;
      updateEnhancedStats({ actionDistribution: actionDist, avgResponseTimeMs: Math.round((useAppStore.getState().enhancedStats.avgResponseTimeMs * 0.7 + responseTimeMs * 0.3)) });

      // Track provider fallbacks
      if ((decision as any).used_fallback_provider) {
        incrementStat("providerFallbacks");
      }

      if (force && decision.decision === "deliberate_silence") {
        console.log("[AutoForge] Force override: converting deliberate_silence to full_forge");
        decision.decision = "full_forge";
        decision.reason = "Force override: user requested action despite AI recommending silence.";
      }

      // Confidence threshold check — skip autonomous actions below threshold (unless forced or full_forge)
      const confThreshold = state.autoForgeConfidenceThreshold ?? 0.5;
      if (!force && decision.confidence < confThreshold && decision.decision !== "deliberate_silence" && decision.decision !== "meta_observation") {
        console.log(`[AutoForge] Confidence ${decision.confidence.toFixed(2)} below threshold ${confThreshold} — downgrading to silence`);
        addEventRef.current({
          timestamp: Date.now(),
          type: "silence",
          severity: "low",
          summary: `Below confidence threshold (${decision.confidence.toFixed(2)} < ${confThreshold}): ${decision.reason}`,
          details: { decision: decision.decision, confidence: decision.confidence, threshold: confThreshold, reason: decision.reason },
        });
        decision.decision = "deliberate_silence";
        decision.reason = `Confidence ${decision.confidence.toFixed(2)} below threshold ${confThreshold}. Original intent: ${decision.decision}.`;
      }

      // Dry run mode — log the decision but don't send anything
      if (state.autoForgeDryRun && decision.decision !== "deliberate_silence" && decision.decision !== "meta_observation") {
        console.log(`[AutoForge] DRY RUN: would have sent ${decision.decision}: ${decision.action_payload || "(full forge)"}`);
        toast.info(`AutoForge DRY RUN: ${decision.decision}`, { description: decision.action_payload || decision.reason, icon: "🧪" });
        addEventRef.current({
          timestamp: Date.now(),
          type: "action_sent",
          severity: "medium",
          summary: `[DRY RUN] ${decision.decision}: ${decision.action_payload || "(full forge)"}`,
          details: { decision: decision.decision, confidence: decision.confidence, reason: decision.reason, action_payload: decision.action_payload, dryRun: true },
        });
        updateDecisionRef.current(decisionLogId, { outcome: "queued" });
        setAutoForgeLastActionMs(Date.now());
        let nextMinutes = decision.estimated_next_action_minutes || 1.5;
        setAutoForgeNextActionMs(Date.now() + nextMinutes * 60 * 1000);
        return;
      }

      // Message deduplication guard — check if we recently sent the exact same message
      const recentSentMessages = state.sentMessages.slice(-15).map(m => m.message.toLowerCase().trim());
      const payloadLower = (decision.action_payload || "").toLowerCase().trim();
      if (payloadLower && recentSentMessages.includes(payloadLower) && decision.decision !== "deliberate_silence" && decision.decision !== "meta_observation" && decision.decision !== "full_forge") {
        console.log(`[AutoForge] Dedup guard: message already sent recently — downgrading to silence`);
        addEventRef.current({
          timestamp: Date.now(),
          type: "silence",
          severity: "low",
          summary: `Dedup guard: "${decision.action_payload}" was already sent recently`,
          details: { decision: decision.decision, action_payload: decision.action_payload },
        });
        decision.decision = "deliberate_silence";
        decision.reason = `Message was already sent recently. Avoiding duplicate.`;
      }

      if (decision.decision === "full_forge") {
        toast.info("AutoForge triggered a full co-pilot Forge!", { description: decision.reason });
        playSfx('autoforge_action');
        actionRateLimiter.recordAction();
        incrementStat("autoForgeActions");
        markActionBucketRef.current();
        updateDecisionRef.current(decisionLogId, { outcome: "sent" });
        // dispatch custom event to trigger forge
        window.dispatchEvent(new CustomEvent("forge-trigger", { detail: { autoSend: true } }));
        setAutoForgeLastActionMs(Date.now());
        addActionHistoryEntry({
          timestamp: Date.now(),
          actionType: "full_forge",
          message: decision.action_payload || "(generating variants...)",
          provider: activeProvider,
          success: true,
        });
        addEventRef.current({
          timestamp: Date.now(),
          type: "action_sent",
          severity: "high",
          summary: `Full Forge triggered: ${decision.action_payload || "(generating variants...)"}`,
          details: { decision: decision.decision, confidence: decision.confidence, reason: decision.reason, action_payload: decision.action_payload },
        });
      } else if (decision.decision === "short_reaction" || decision.decision === "emote_only" || decision.decision === "joke_callback") {
        if (decision.action_payload) {
          toast.info(`AutoForge autonomous reaction`, { description: decision.action_payload });
          playSfx('autoforge_action');
          actionRateLimiter.recordAction();
          incrementStat("autoForgeActions");
          markActionBucketRef.current();
          
          const sendFn = getPlatformSendFn(state.platform);
          sendFn(state.streamMetadata.channelName, decision.action_payload)
            .then(() => updateDecisionRef.current(decisionLogId, { outcome: "sent" }))
            .catch((e) => {
              updateDecisionRef.current(decisionLogId, { outcome: "failed" });
              console.error(e);
            });
          if (state.messageSoundEnabled && state.platform === 'joystick') playMessageSound();
          speakMessage(decision.action_payload);
          addSentMsgRef.current({
            message: decision.action_payload,
            channel: state.streamMetadata.channelName,
            timestamp: Date.now(),
            source: "autoforge",
          });
          incrSentRef.current();

          addActionHistoryEntry({
            timestamp: Date.now(),
            actionType: decision.decision,
            message: decision.action_payload,
            provider: activeProvider,
            success: true,
          });

          // Boost referenced memories and jokes
          if (state.autoMemoryConfig?.enabled) {
            if (decision.referenced_memory_ids) {
              for (const mid of decision.referenced_memory_ids) {
                boostMemory(mid).catch(console.error);
              }
            }
            if (decision.referenced_joke_ids) {
              for (const jid of decision.referenced_joke_ids) {
                boostJoke(jid, decision.action_payload).catch(console.error);
                recordJokeUsage(jid, decision.action_payload).catch(console.error);
              }
            }
          }

          setAutoForgeLastActionMs(Date.now());
          addEventRef.current({
            timestamp: Date.now(),
            type: "action_sent",
            severity: "high",
            summary: `${decision.decision === "emote_only" ? "Emote" : decision.decision === "joke_callback" ? "Joke callback" : "Reaction"}: "${decision.action_payload}"`,
            details: { decision: decision.decision, confidence: decision.confidence, reason: decision.reason, action_payload: decision.action_payload },
          });
        }
      } else if (decision.decision === "quick_followup") {
        if (decision.action_payload) {
          const delayMs = Math.max(1500, Math.min(12000, decision.followup_delay_ms || 
            decision.action_payload.length * 65));
          toast.info(`AutoForge quick follow-up in ${(delayMs / 1000).toFixed(1)}s`, { description: decision.action_payload });
          playSfx('autoforge_action');
          actionRateLimiter.recordAction();
          incrementStat("followupActions");
          markActionBucketRef.current();
          
          followupTimerRef.current = setTimeout(() => {
            const sendFn2 = getPlatformSendFn(state.platform);
            sendFn2(state.streamMetadata.channelName, decision.action_payload)
              .then(() => updateDecisionRef.current(decisionLogId, { outcome: "sent" }))
              .catch((e) => {
                updateDecisionRef.current(decisionLogId, { outcome: "failed" });
                console.error(e);
              });
            if (state.messageSoundEnabled && state.platform === 'joystick') playMessageSound();
            speakMessage(decision.action_payload);
            addSentMsgRef.current({
              message: decision.action_payload,
              channel: state.streamMetadata.channelName,
              timestamp: Date.now(),
              source: "followup",
            });
            incrSentRef.current();
            setAutoForgeLastActionMs(Date.now());
            setAutoForgeFollowup({ message: decision.action_payload, deliveredAt: Date.now() });
            addActionHistoryEntry({
              timestamp: Date.now(),
              actionType: "quick_followup",
              message: decision.action_payload,
              provider: activeProvider,
              success: true,
            });
            addEventRef.current({
              timestamp: Date.now(),
              type: "action_sent",
              severity: "medium",
              summary: `Quick follow-up: "${decision.action_payload}"`,
              details: { decision: decision.decision, confidence: decision.confidence, reason: decision.reason, action_payload: decision.action_payload, delay_ms: delayMs },
            });
            followupTimerRef.current = null;
          }, delayMs);
        }
      } else if (decision.decision === "deliberate_silence" || decision.decision === "meta_observation") {
        if (decision.decision === "deliberate_silence") incrementStat("silenceDecisions");
        console.log(`[AutoForge] ${decision.decision}:`, decision.reason);
        addEventRef.current({
          timestamp: Date.now(),
          type: "silence",
          severity: "low",
          summary: `Silence: ${decision.reason}`,
          details: { decision: decision.decision, confidence: decision.confidence, reason: decision.reason },
        });
      }

      // Evaluate session goals
      if (state.sessionGoals && state.sessionGoals.length > 0) {
        const enhancedStats = useAppStore.getState().enhancedStats;
        const results = state.sessionGoals.filter(g => g.enabled).map(goal => {
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
              const sh = useAppStore.getState().sentimentHistory;
              const positive = sh.filter(s => s.label === "positive" || s.label === "hype" || s.label === "wholesome").length;
              current = sh.length > 0 ? Math.round((positive / sh.length) * 100) : 0;
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
        useAppStore.getState().setGoalEvaluationResults(results);
      }

      // Schedule next check — accelerate if a spike was detected
      let nextMinutes = decision.estimated_next_action_minutes || 1.5;
      if (activitySpike && decision.decision === "deliberate_silence") {
        // Even if AI chose silence, a spike means re-check sooner to catch the moment
        nextMinutes = Math.min(nextMinutes, 0.5);
      }
      setAutoForgeNextActionMs(Date.now() + nextMinutes * 60 * 1000);

    } catch (e: any) {
      const errMsg = e?.message || 'Unknown error';
      const isMissingKey = errMsg.includes('No API key configured');
      if (!isMissingKey) {
        console.error("[AutoForge] execution failed:", e);
        if (useAppStore.getState().desktopNotificationsEnabled) {
          notifyAutoForgeError(errMsg);
        }
        toast.error(`AutoForge check failed: ${errMsg}`);
        addEventRef.current({
          timestamp: Date.now(),
          type: "error",
          severity: "high",
          summary: `Error: ${errMsg}`,
          details: { error: errMsg, stack: e.stack },
        });
      }
      // Backoff on error
      setAutoForgeNextActionMs(Date.now() + 60000);
    }
  };

  useEffect(() => {
    // Run the check every 15 seconds to see if it's time to act
    const interval = setInterval(() => {
      if (storeRef.current.autoForgeEnabled) {
        checkAutoForge();
      }
    }, 15000);
    
    const onForceCheck = () => {
      if (storeRef.current.autoForgeEnabled) {
        checkAutoForge(true);
      }
    };
    window.addEventListener("autoforge-force-check", onForceCheck);

    // Clean up expired smart replies every 10 seconds
    const replyCleanup = setInterval(() => {
      const current = useAppStore.getState().smartReplies;
      if (current.length > 0) {
        const cleaned = cleanExpiredSmartReplies(current);
        if (cleaned.length !== current.length) {
          useAppStore.getState().setSmartReplies(cleaned);
        }
      }
    }, 10000);

    return () => {
      clearInterval(interval);
      clearInterval(replyCleanup);
      window.removeEventListener("autoforge-force-check", onForceCheck);
      if (followupTimerRef.current) {
        clearTimeout(followupTimerRef.current);
        followupTimerRef.current = null;
      }
    };
  }, []);

  return null;
}
