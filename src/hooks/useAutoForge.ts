import { useEffect, useRef } from "react";
import { useAppStore, selectMultiBotActive } from "../store";
import { toast } from "sonner";
import { autoforgeDecide } from "../lib/ai";
import { getTwitchSession } from "../lib/twitch";
import { getKickSession } from "../lib/kick";
import { getJoystickSession } from "../lib/joystick";
import { getPlatformSendFn } from "../lib/platformSend";
import { playMessageSound } from "../lib/sound";
import { speakMessage } from "../lib/tts";
import { playSfx } from "../lib/sfx";
import { getActiveProvider, getApiKey } from "../lib/keys";
import { formatChatLog } from "../lib/chatUtils";
import { retrieveRelevantMemories, formatMemoryContext, formatDirectorNotesContext } from "../lib/memoryRetrieval";
import { boostMemory, boostJoke } from "../lib/memoryEngine";
import { recordJokeUsage, getActiveJokes, scoreJokeRelevance } from "../lib/jokeEngine";
import { analyzeRepetition, formatRepetitionContext } from "../lib/antiRepetition";
import { actionRateLimiter } from "../lib/actionRateLimiter";
import { summarizeSentiment, formatSentimentContext } from "../lib/sentiment";
import { notifyMention, notifyAutoForgeError, notifyActivitySpike } from "../lib/notifications";
import { generateSmartReplies, canGenerateSmartReplies, cleanExpiredSmartReplies } from "../lib/smartReplies";
import { isSchedulerCancellation, isQueueTimeout } from "../lib/aiScheduler";
import { getAvailableEmoteNames } from "../lib/emotes";
import { evaluateAllRules } from "../lib/ruleEngine";
import { formatThreadContext } from "../lib/conversationThread";
import { createAutoForgeExecutionGuard, captureSessionScope, isSessionScopeCurrent } from "../lib/sessionScope";
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
import {
  captureAutoCheckSignal,
  evaluateAutoCheckCadence,
  hasMeaningfulContextChange,
  type AutoCheckSignal,
} from "../lib/coreAutoCheck";

// D4: Post-send engagement correlation — delay before evaluating chat response
const ENGAGEMENT_CHECK_DELAY_MS = 30_000;

// Max time a single check run (or a manual Forge) may hold its gate before
// it's considered wedged — e.g. a hung SDK call or dead-socket send whose
// promise never settles. A real forge never exceeds ~60s.
const FORGE_WATCHDOG_MS = 120_000;

export function useAutoForge() {
  const {
    autoForgeEnabled,
    autoForgeAutoCheckEnabled,
    autoForgeAutoCheckMode,
    autoForgeAutoCheckIntervalMs,
    autoForgeLastCheckMs,
    setAutoForgeLastCheckMs,
    setAutoForgeCheckArmed,
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
    perActionRateLimits,
    directorNotes,
    setIsAutoForgeThinking,
    recordActionEngagement,
    setStreamHealth,
    setHypeLevel,
  } = useAppStore();

  const lastChatLengthRef = useRef(0);
  const lastCheckTimeRef = useRef(Date.now());
  const lastMessagesReceivedRef = useRef(0);
  const consecutiveSilenceRef = useRef(0);
  // Context fingerprint of the LAST evaluation that actually ran. Smart mode
  // compares against this to decide whether a fresh model call is worthwhile.
  const autoCheckSignalRef = useRef<AutoCheckSignal | null>(null);
  const followupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Concurrency guard: prevents overlapping checkAutoForge executions
  const isAutoForgingRef = useRef(false);
  const forgingStartedAtRef = useRef(0);
  // Track engagement-check timers for cleanup on unmount
  const engagementTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const storeRef = useRef({ config, streamMetadata, audioTranscript, chatLog, visualSnapshotUrl, visualContextTags, longTermMemory, pinnedMemories, goldenMemoryId, isForging, autoForgeEnabled, autoForgeAutoCheckEnabled, autoForgeLastActionMs, autoForgeNextActionMs, r34lEnabled, platform, messageSoundEnabled, autoMemoryConfig, autoMemories, userProfiles, insideJokes, personalityState, sentMessages, rateLimitConfig, autoForgeDryRun, autoForgeConfidenceThreshold, sessionGoals, perActionRateLimits, directorNotes, smartRepliesEnabled, autoForgeAutoCheckMode, autoForgeAutoCheckIntervalMs, autoForgeLastCheckMs, audioEnergy: useAppStore.getState().audioEnergy?.label ?? null });

  storeRef.current = { config, streamMetadata, audioTranscript, chatLog, visualSnapshotUrl, visualContextTags, longTermMemory, pinnedMemories, goldenMemoryId, isForging, autoForgeEnabled, autoForgeAutoCheckEnabled, autoForgeLastActionMs, autoForgeNextActionMs, r34lEnabled, platform, messageSoundEnabled, autoMemoryConfig, autoMemories, userProfiles, insideJokes, personalityState, sentMessages, rateLimitConfig, autoForgeDryRun, autoForgeConfidenceThreshold, sessionGoals, perActionRateLimits, directorNotes, smartRepliesEnabled, autoForgeAutoCheckMode, autoForgeAutoCheckIntervalMs, autoForgeLastCheckMs, audioEnergy: useAppStore.getState().audioEnergy?.label ?? null };

  // Sync rate limiter config
  actionRateLimiter.updateConfig(rateLimitConfig);
  actionRateLimiter.updatePerActionConfig(perActionRateLimits);
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
    // Multi-bot guard: the legacy single-bot loop stands down ONLY when
    // multi-bot is actively engaged (toggle on AND ≥2 bots authenticated).
    // With 0–1 authed bots the legacy loop keeps running so there's no dead zone.
    // (Placed inside the callback so React's rules of hooks are unaffected.)
    if (selectMultiBotActive(useAppStore.getState())) return;
    // Concurrency guard: skip if a previous check is still in-flight.
    // Watchdog: if the previous run's await never settled (hung SDK call,
    // dead-socket send, etc.) the flag would wedge the loop forever.
    if (isAutoForgingRef.current) {
      if (Date.now() - forgingStartedAtRef.current > FORGE_WATCHDOG_MS) {
        console.warn(`[AutoForge] in-flight check exceeded ${FORGE_WATCHDOG_MS / 1000}s — resetting guard`);
        isAutoForgingRef.current = false;
        useAppStore.getState().setIsAutoForgeThinking(false);
      } else {
        if (force) toast.info("A check is already running — try again in a moment.");
        return;
      }
    }
    const state = storeRef.current;
    const live = useAppStore.getState();
    const supercharged = live.superchargeActive;
    // Self-heal a wedged manual-forge flag — a hung forge request would
    // otherwise gate every AutoForge check + force forever.
    if (live.isForging && (live.forgeStartedAtMs === null || Date.now() - live.forgeStartedAtMs > FORGE_WATCHDOG_MS)) {
      console.warn(`[AutoForge] isForging stuck >${FORGE_WATCHDOG_MS / 1000}s — clearing stale flag`);
      live.setIsForging(false);
    }
    if (!state.autoForgeEnabled) return;
    if (live.isForging && !force) {
      // Gated on a live manual forge — push NEXT CHECK forward so the HUD
      // countdown reflects the real deferral instead of sitting at 0s.
      setAutoForgeNextActionMs(Date.now() + 15_000);
      return;
    }
    // force bypasses the isForging gate — the scheduler arbitrates contention.

    // Only trigger if we've passed the next scheduled action time
    if (!force && Date.now() < state.autoForgeNextActionMs) return;

    isAutoForgingRef.current = true;
    forgingStartedAtRef.current = Date.now();
    setIsAutoForgeThinking(true);
    // Execution guard: invalidates in-flight work if the session context
    // changes mid-check (channel switch incl. A→B→A round-trips, platform
    // switch, AutoForge toggle, dry-run flip, multi-bot mode flip). The
    // guard subscribes to the store and flips `isCurrent()` to false on
    // any of those. Disposed in the finally below so we don't leak a
    // subscription per 15s cycle. The identity check is trivially true
    // here (the legacy loop only runs when multi-bot is NOT active).
    const guard = createAutoForgeExecutionGuard(() => !selectMultiBotActive(useAppStore.getState()));
    try {
      const activeProvider = getActiveProvider();

      // Only the user-selected provider is used — no cross-provider fallback.
      // If the selected provider isn't configured, skip quietly rather than
      // silently rerouting to another provider that happens to have a key.
      if (!getApiKey(activeProvider)) {
        setAutoForgeNextActionMs(Date.now() + 60000);
        return;
      }
      
      // Calculate current chat activity 0-4 using message counter (not chatLog.length which is capped)
      const currentMessagesReceived = useAppStore.getState().sessionStats.messagesReceived;
      const { chatVelocity, activityLevel, activitySpike, newMessages, elapsedMs, now } =
        computeChatActivity(currentMessagesReceived, lastCheckTimeRef.current, lastMessagesReceivedRef.current);
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
      const engagement = computeEngagementScores(
        chatVelocity, sentimentHistoryForEngagement, uniqueChatters, state.autoForgeLastActionMs, now,
      );
      useAppStore.getState().setEngagementScore({
        velocityScore: Math.round(engagement.velocityScore * 100),
        sentimentScore: Math.round(engagement.sentimentScore * 100),
        diversityScore: Math.round(engagement.diversityScore * 100),
        recencyScore: Math.round(engagement.recencyScore * 100),
        overall: engagement.overall,
      });

      // A10: Compute stream health score
      const es = useAppStore.getState().enhancedStats;
      const health = computeStreamHealth(
        engagement.velocityScore, engagement.sentimentScore, engagement.diversityScore,
        isMentioned, es.mentionsDetected, state.visualContextTags, now,
      );
      setStreamHealth(health);

      // B12: Set hype level based on activity spike and chat velocity
      setHypeLevel(computeHypeLevel(activitySpike, chatVelocity));

      // Detect likely offline stream: 0 viewers + no chat activity for 5+ minutes
      const viewerCount = state.streamMetadata?.viewerCount || 0;
      const likelyOffline = detectOfflineStream(viewerCount, newMessages, elapsedMs);
      useAppStore.getState().setStreamLikelyOffline(likelyOffline);
      if (likelyOffline && !force) {
        console.log("[AutoForge] Stream appears offline — skipping check");
        setAutoForgeNextActionMs(now + 120000);
        return;
      }

      // Run anti-repetition analysis
      const repetitionAnalysis = analyzeRepetition(state.sentMessages);
      const antiRepetitionContext = formatRepetitionContext(repetitionAnalysis);

      // C1: AutoForge Rule Engine — evaluate user-defined rules
      const autoForgeRules = useAppStore.getState().autoForgeRules;
      if (autoForgeRules.length > 0) {
        const ruleCtx = buildRuleEngineContext(
          chatVelocity,
          useAppStore.getState().sentimentHistory,
          state.autoForgeLastActionMs,
          state.chatLog,
          isMentioned,
          activitySpike,
          useAppStore.getState().streamHealth?.label ?? null,
          useAppStore.getState().hypeLevel,
          uniqueChatters,
          viewerCount,
          useAppStore.getState().audioEnergy?.rms ?? 0,
          now,
          useAppStore.getState().autoForgeEnabled,
          useAppStore.getState().moodLock.locked ? useAppStore.getState().moodLock.mood : null,
          consecutiveSilenceRef.current,
          useAppStore.getState().bots.filter((b) => b.active && b.session).length || 1,
        );

        const ruleResults = await evaluateAllRules(autoForgeRules, ruleCtx);
        const firedRules = ruleResults.filter((r) => r.fired);
        if (firedRules.length > 0) {
          console.log(`[AutoForge] Rule engine: ${firedRules.length} rule(s) fired`);
          // If any rule sent a message or triggered forge, record activity
          const ruleActions = firedRules.reduce((s, r) => s + r.actionsExecuted, 0);
          if (ruleActions > 0) {
            // Update last action time so manual-activity delay applies
            useAppStore.getState().setAutoForgeLastActionMs(now);
          }
        }
      }

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
        // C5: Dispatch prominent mention overlay event
        window.dispatchEvent(new CustomEvent("bot-mentioned", {
          detail: {
            lines: allMentionedLines.slice(0, 5),
            timestamp: Date.now(),
            channel: state.streamMetadata.channelName,
          },
        }));
        addEventRef.current({
          timestamp: Date.now(),
          type: "mention",
          severity: "high",
          summary: `Mentioned by chat: ${allMentionedLines.slice(0, 3).join(" | ")}`,
          details: { mentionedLines: allMentionedLines, botUsername, channelName },
        });

        // Smart reply generation — when smart replies are enabled (works alongside AutoForge)
        if (smartRepliesEnabled && canGenerateSmartReplies()) {
          setSmartRepliesLoading(true);
          generateSmartReplies(allMentionedLines)
            .then((replies) => {
              // Don't write stale replies into a new session.
              if (!guard.isCurrent()) {
                console.log("[AutoForge] Discarding stale smart replies (session changed)");
                setSmartRepliesLoading(false);
                return;
              }
              if (replies.length > 0) {
                setSmartReplies(replies);
              }
              setSmartRepliesLoading(false);
            })
            .catch((e) => {
              if (!isSchedulerCancellation(e) && !isQueueTimeout(e)) {
                console.error("[AutoForge] Smart reply generation failed:", e);
              }
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
        }, state.directorNotes);
      } else {
        // Director notes are user-authored directives, not auto-extracted
        // memories — inject them even when AutoMemory is disabled.
        memoryContext = formatDirectorNotesContext(state.directorNotes);
      }

      // Build sentiment context
      let sentimentContext = "";
      const sentimentHistory = useAppStore.getState().sentimentHistory;
      if (sentimentHistory.length > 0) {
        const sentimentSummary = summarizeSentiment(sentimentHistory);
        sentimentContext = formatSentimentContext(sentimentSummary);
        useAppStore.getState().updateSentimentSummary(sentimentSummary);
      }

      // Check rate limits (unless forced or supercharged)
      if (!force && !supercharged && !actionRateLimiter.canAct()) {
        const rateStats = actionRateLimiter.getStats();
        console.log(`[AutoForge] Rate limited: ${rateStats.actionsLastHour}/${rateStats.maxPerHour} per hour, ${rateStats.actionsLastTenMin}/${rateStats.maxPerTenMin} per 10min`);
        setAutoForgeNextActionMs(Date.now() + Math.max(30000, rateStats.msUntilNextAllowed));
        return;
      }

      // Vibe check: skip the AI call entirely when the moment is dead.
      // Cheap local heuristic — never skips mentions or spikes. Supercharge
      // mode bypasses it entirely — the user asked for maximum engagement.
      if (!force && !supercharged) {
        const vibe = vibeCheck({
          isMentioned,
          activitySpike,
          chatVelocity,
          activityLevel,
          timeSinceLastActionMs: state.autoForgeLastActionMs ? now - state.autoForgeLastActionMs : Infinity,
          viewerCount: state.streamMetadata?.viewerCount || 0,
          isForging: state.isForging,
        });
        if (vibe.shouldSkip) {
          console.log(`[AutoForge] Vibe check skip: ${vibe.reason}`);
          addEventRef.current({
            timestamp: Date.now(),
            type: "silence",
            severity: "low",
            summary: `Vibe check skip: ${vibe.reason}`,
            details: { reason: vibe.reason, chatVelocity, activityLevel },
          });
          // Record the skip as this cycle's outcome (no history append) so
          // the Last Cycle panel reflects that a check ran — otherwise a dead
          // chat would leave "Waiting for first check" up forever. Guarded:
          // a skip never overwrites a real model decision (dry-run payloads
          // must stay visible/sendable until the next real evaluation).
          const prevDecision = useAppStore.getState().lastAutoForgeDecision;
          if (!prevDecision || prevDecision.gateSkipped) {
            setLastAutoForgeDecision({
              decision: "deliberate_silence",
              confidence: 1,
              reason: `Skipped (vibe check): ${vibe.reason}`,
              estimated_next_action_minutes: Math.max(0.1, vibe.nextCheckDelayMs / 60000),
              timestamp: Date.now(),
              activityLevel,
              gateSkipped: true,
            }, false);
          }
          setAutoForgeNextActionMs(Date.now() + vibe.nextCheckDelayMs);
          return;
        }
      }

      // Auto-Check cadence gate — the user (not a hard-coded timer) decides how
      // often CORE may spend a model evaluation. Interval mode enforces the
      // chosen cadence; Smart mode requires a real context change (new chat,
      // transcript, visual frame, or bot activity). Mentions and activity
      // spikes always pass, so the bot never ignores being addressed.
      // The signal fingerprint is only advanced when a check actually runs, so
      // a change that arrives during a blocked tick stays "new" until it is
      // evaluated. Nothing is scheduled here — the 15s tick is now a cheap
      // scheduler heartbeat that this gate filters.
      if (!force && !supercharged) {
        const signal = captureAutoCheckSignal({
          chatLog: state.chatLog,
          audioTranscript: state.audioTranscript,
          visualSnapshotUrl: state.visualSnapshotUrl,
          visualSnapshotHistoryLength: useAppStore.getState().visualSnapshotHistory.length,
          sentMessagesLength: state.sentMessages.length,
          audioEnergyLabel: state.audioEnergy,
        });
        const cadence = evaluateAutoCheckCadence({
          mode: state.autoForgeAutoCheckMode,
          intervalMs: state.autoForgeAutoCheckIntervalMs,
          now: Date.now(),
          lastCheckAt: state.autoForgeLastCheckMs,
          signalsChanged: hasMeaningfulContextChange(autoCheckSignalRef.current, signal),
          urgent: isMentioned || activitySpike,
        });
        if (!cadence.run) {
          // Cheap heartbeat return — no model call, no reschedule. The tick
          // re-evaluates in 15s and runs as soon as the gate opens. Record
          // the skip (no history append, never overwrites a real decision) so
          // Last Cycle shows the loop is alive instead of looking frozen.
          const prevDecision = useAppStore.getState().lastAutoForgeDecision;
          if (!prevDecision || prevDecision.gateSkipped) {
            setLastAutoForgeDecision({
              decision: "deliberate_silence",
              confidence: 1,
              reason: `Auto-check skipped: ${cadence.reason}`,
              estimated_next_action_minutes: Math.max(0.1, (state.autoForgeNextActionMs - Date.now()) / 60000),
              timestamp: Date.now(),
              activityLevel,
              gateSkipped: true,
            }, false);
          }
          setAutoForgeCheckArmed(cadence.armed);
          return;
        }
        autoCheckSignalRef.current = signal;
        setAutoForgeCheckArmed(false);
        setAutoForgeLastCheckMs(Date.now());
      }

      const decisionStartTime = Date.now();

      const decision = await autoforgeDecide({
        streamMetadata: state.streamMetadata,
        visualContext: state.visualContextTags.join(" "),
        recentChatLog: formatChatLog(state.chatLog),
        audioTranscript: state.audioTranscript,
        longTermContext: buildLongTermMemoryContext(state.longTermMemory, state.pinnedMemories, state.goldenMemoryId),
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
        availableEmotes: useAppStore.getState().emoteAwarenessEnabled
          ? getAvailableEmoteNames(state.streamMetadata.channelName, 50)
          : undefined,
        botIdentityMode: useAppStore.getState().botIdentityMode,
        botIdentityStory: useAppStore.getState().botIdentityStory,
        audioEnergyLabel: useAppStore.getState().audioEnergy?.label,
        streamEvents: useAppStore.getState().streamEvents.slice(-5),
        superchargeMode: supercharged,
        threadContext: formatThreadContext(botUsername?.toLowerCase()),
      });
      const responseTimeMs = Date.now() - decisionStartTime;
      console.log("[AutoForge] Decision:", decision);

      // Session-scope guard: if the channel/platform/mode changed during the
      // decision AI call (incl. A→B→A round-trips), discard the result — it
      // belongs to a stale session and writing it would corrupt the new one.
      if (!guard.isCurrent()) {
        console.log("[AutoForge] Discarding stale decision (session changed mid-check)");
        return;
      }

      // Record token usage from the decision call
      if ((decision as any).tokenUsage) {
        useAppStore.getState().recordTokenUsage("autoforge_decide", (decision as any).tokenUsage);
      }

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
      const conf = normalizeConfidence(decision.confidence);
      decision.confidence = conf;
      if (!force && conf < confThreshold && decision.decision !== "deliberate_silence") {
        console.log(`[AutoForge] Confidence ${conf.toFixed(2)} below threshold ${confThreshold} — downgrading to silence`);
        addEventRef.current({
          timestamp: Date.now(),
          type: "silence",
          severity: "low",
          summary: `Below confidence threshold (${conf.toFixed(2)} < ${confThreshold}): ${decision.reason}`,
          details: { decision: decision.decision, confidence: conf, threshold: confThreshold, reason: decision.reason },
        });
        decision.decision = "deliberate_silence";
        decision.reason = `Confidence ${conf.toFixed(2)} below threshold ${confThreshold}. Original intent: ${decision.decision}.`;
      }

      // Dry run mode — log the decision but don't send anything
      if (state.autoForgeDryRun && decision.decision !== "deliberate_silence") {
        console.log(`[AutoForge] DRY RUN: would have sent ${decision.decision}: ${decision.action_payload || "(full forge)"}`);
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
        if (!Number.isFinite(nextMinutes) || nextMinutes < 0) nextMinutes = 1.5;
        // In dry-run nothing is actually sent, so the model's self-pacing
        // serves no protective purpose — clamp the next check to the user's
        // cadence so decisions visibly cycle at 30s/1m/2m/5m instead of
        // hiding for 3-5 min and looking stuck.
        const cadenceMinutes = (state.autoForgeAutoCheckIntervalMs || 30000) / 60000;
        nextMinutes = Math.min(nextMinutes, cadenceMinutes);
        setAutoForgeNextActionMs(Date.now() + nextMinutes * 60 * 1000);
        return;
      }

      // Message deduplication guard — check if we recently sent the exact same message
      const recentSentMessages = state.sentMessages.slice(-15).map(m => m.message.toLowerCase().trim());
      if (isDuplicateMessage(decision.action_payload || "", recentSentMessages) && decision.decision !== "deliberate_silence" && decision.decision !== "meta_observation" && decision.decision !== "full_forge") {
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
        // C5: Per-action rate limit check
        if (!force && !supercharged && !actionRateLimiter.canAct("full_forge")) {
          console.log("[AutoForge] full_forge rate limited — downgrading to silence");
          addEventRef.current({
            timestamp: Date.now(),
            type: "silence",
            severity: "low",
            summary: `full_forge per-action rate limited`,
          });
          decision.decision = "deliberate_silence";
          decision.reason = "full_forge per-action rate limit reached.";
        } else {
        toast.info("AutoForge triggered a full co-pilot Forge!", { description: decision.reason });
        playSfx('autoforge_action');
        actionRateLimiter.recordAction("full_forge");
        incrementStat("autoForgeActions");
        markActionBucketRef.current();

        // A3: Self-contained full_forge — generate variants, rank, and send the best one directly
        try {
          const { generateChat, rankVariants } = await import("../lib/ai");
          const memoryContextStr = memoryContext;
          const sentimentContextStr = sentimentContext;
          // Stale channel guard: capture channel before the async generation
          // so we can discard results if the user switched streamers mid-Forge.
          const forgeChannel = state.streamMetadata.channelName;

          const chatResult = await generateChat({
            streamMetadata: state.streamMetadata,
            visualContext: state.visualContextTags.join(" "),
            screenshot: state.visualSnapshotUrl || undefined,
            recentChatLog: formatChatLog(state.chatLog),
            audioTranscript: state.audioTranscript,
            longTermContext: buildLongTermMemoryContext(state.longTermMemory, state.pinnedMemories, state.goldenMemoryId),
            config: state.config,
            activeProvider,
            count: 3,
            r34lEnabled: state.r34lEnabled,
            botUsername,
            memoryContext: memoryContextStr,
            sentimentContext: sentimentContextStr,
            availableEmotes: useAppStore.getState().emoteAwarenessEnabled
              ? getAvailableEmoteNames(state.streamMetadata.channelName, 50)
              : undefined,
            // AutoForge full_forge generates the actual message to send.
            // Once the bot has decided to act, this must not be preempted by
            // vision (interactive) — otherwise the bot decides to speak but
            // the message is never sent. Use interactive priority so vision
            // queues behind it; manual Forge (critical) can still preempt.
            priority: "interactive",
          });

          // Session-scope guard: discard if the session changed during the
          // generateChat call (channel switch incl. A→B→A, platform switch,
          // mode flip). Replaces the channel-name compare which missed
          // round-trips.
          if (!guard.isCurrent()) {
            console.log(`[AutoForge] Discarding stale full_forge result (session changed)`);
            updateDecisionRef.current(decisionLogId, { outcome: "stale" });
            return;
          }

          const variants = chatResult.suggestions || [];
          if (variants.length === 0) {
            throw new Error("No variants generated");
          }

          const ranked = rankVariants(variants, {
            config: state.config,
            recentSentMessages: state.sentMessages.map(m => m.message).slice(-20),
          });
          const bestVariant = ranked.find(v => v.best) || ranked[0];
          const messageToSend = bestVariant.message;

          if (!messageToSend) {
            throw new Error("Best variant had no message");
          }

          // Send the best variant directly
          const sendFn = getPlatformSendFn(state.platform);
          // Final scope check before the send — the ranking + dedup checks
          // above may have taken time, and the session may have changed.
          if (!guard.isCurrent()) {
            console.log(`[AutoForge] Aborting full_forge send (session changed before send)`);
            updateDecisionRef.current(decisionLogId, { outcome: "stale" });
            return;
          }
          try {
            await sendFn(state.streamMetadata.channelName, messageToSend);
            updateDecisionRef.current(decisionLogId, { outcome: "sent" });
          } catch (e: any) {
            updateDecisionRef.current(decisionLogId, { outcome: "failed" });
            console.error("[AutoForge] full_forge send failed:", e);
            addEventRef.current({
              timestamp: Date.now(),
              type: "error",
              severity: "high",
              summary: `Full Forge send FAILED: ${e.message || e}`,
              details: { decision: "full_forge", message: messageToSend },
            });
            setAutoForgeNextActionMs(Date.now() + 20_000);
            return;
          }

          if (state.messageSoundEnabled && state.platform === 'joystick') playMessageSound();
          speakMessage(messageToSend);
          addSentMsgRef.current({
            message: messageToSend,
            channel: state.streamMetadata.channelName,
            timestamp: Date.now(),
            source: "autoforge",
          });
          incrSentRef.current();

          // Record token usage if available
          if (chatResult.tokenUsage) {
            useAppStore.getState().setLastTokenUsage({
              prompt_tokens: chatResult.tokenUsage.prompt_tokens,
              completion_tokens: chatResult.tokenUsage.completion_tokens,
              total_tokens: chatResult.tokenUsage.total_tokens,
              effort_given: chatResult.resolvedEffort || state.config?.effortLevel || "medium",
              feature: "forge",
            });
          }

          addActionHistoryEntry({
            timestamp: Date.now(),
            actionType: "full_forge",
            message: messageToSend,
            provider: activeProvider,
            success: true,
          });
          // D4: Schedule post-send engagement check
          const sentAt = Date.now();
          const engTimer = setTimeout(() => {
            const entries = useAppStore.getState().actionHistory;
            // Find the most recent full_forge entry matching this send
            const target = [...entries].reverse().find(e =>
              e.actionType === "full_forge" &&
              e.message === messageToSend &&
              Math.abs(e.timestamp - sentAt) < 5000
            );
            if (!target) return;
            const currentChat = useAppStore.getState().chatLog;
            const session = state.platform === 'kick' ? getKickSession() : state.platform === 'joystick' ? getJoystickSession() : getTwitchSession();
            const botName = (session?.username || "").toLowerCase();
            const eng = countPostSendEngagement(currentChat, sentAt, botName);
            const label = labelEngagement(eng.total);
            useAppStore.getState().updateActionHistoryEntry(target.id, {
              engagement: { chatLinesAfter: eng.linesAfter, mentionsAfter: eng.mentionsAfter, reactionsAfter: eng.reactionsAfter, label, evaluatedAt: Date.now() },
            });
            // A9: Record accuracy metric
            useAppStore.getState().recordActionEngagement("full_forge", label);
            engagementTimersRef.current.delete(engTimer);
          }, ENGAGEMENT_CHECK_DELAY_MS);
          engagementTimersRef.current.add(engTimer);

          // Boost referenced memories
          if (state.autoMemoryConfig?.enabled && decision.referenced_memory_ids) {
            for (const mid of decision.referenced_memory_ids) {
              boostMemory((state.streamMetadata.channelName || "default").toLowerCase(), mid).catch(console.error);
            }
          }

          setAutoForgeLastActionMs(Date.now());
          addEventRef.current({
            timestamp: Date.now(),
            type: "action_sent",
            severity: "high",
            summary: `Full Forge sent: "${messageToSend}"`,
            details: {
              decision: "full_forge",
              confidence: decision.confidence,
              reason: decision.reason,
              action_payload: messageToSend,
              variantsGenerated: variants.length,
              bestVariantId: bestVariant.variant_id,
            },
          });
        } catch (e: any) {
          // Scheduler preemption/cancellation is an intentional yield —
          // don't log as a failure or toast; let the outer catch reschedule
          // quietly.
          if (isSchedulerCancellation(e) || isQueueTimeout(e)) {
            updateDecisionRef.current(decisionLogId, { outcome: "skipped" });
            throw e;
          }
          console.error("[AutoForge] full_forge generation failed:", e);
          updateDecisionRef.current(decisionLogId, { outcome: "failed" });
          addEventRef.current({
            timestamp: Date.now(),
            type: "error",
            severity: "high",
            summary: `Full Forge generation FAILED: ${e.message || e}`,
            details: { decision: "full_forge", reason: decision.reason },
          });
          toast.error(`AutoForge full_forge failed: ${e.message || e}`);
        }
        } // end else (not rate limited)
      } else if (decision.decision === "short_reaction" || decision.decision === "emote_only" || decision.decision === "joke_callback" || decision.decision === "meta_observation") {
        if (decision.action_payload) {
          // A2: For joke_callback, consult the joke engine to verify the joke is real and active
          let effectiveDecision = decision.decision;
          if (decision.decision === "joke_callback" && state.autoMemoryConfig?.enabled) {
            try {
              const activeJokes = getActiveJokes(state.insideJokes);
              if (activeJokes.length > 0) {
                const contextText = `${state.chatLog.slice(-10).map(m => m.text).join(" ")} ${state.audioTranscript?.slice(-200) || ""} ${state.visualContextTags.join(" ")}`;
                const scored = activeJokes
                  .map(j => ({ joke: j, score: scoreJokeRelevance(j, contextText) }))
                  .sort((a, b) => b.score - a.score);
                const bestMatch = scored[0];
                // Fuzzy match: check if payload contains the joke punchline or vice versa
                const payloadLower = (decision.action_payload || "").toLowerCase();
                const punchlineLower = (bestMatch.joke.punchline || "").toLowerCase();
                const matchesJoke = bestMatch.score > 0.1 ||
                  payloadLower.includes(punchlineLower) ||
                  punchlineLower.includes(payloadLower);
                if (matchesJoke) {
                  // Record usage of the matched joke
                  recordJokeUsage((state.streamMetadata.channelName || "default").toLowerCase(), bestMatch.joke.id, decision.action_payload).catch(console.error);
                } else {
                  // No active joke matches — downgrade to short_reaction
                  console.log("[AutoForge] joke_callback payload doesn't match any active joke — downgrading to short_reaction");
                  effectiveDecision = "short_reaction";
                  updateDecisionRef.current(decisionLogId, {
                    outcome: "sent",
                    action: "short_reaction",
                    reasoning: `${decision.reason} (downgraded from joke_callback — no matching active joke)`,
                  });
                }
              } else {
                // No active jokes at all — downgrade to short_reaction
                console.log("[AutoForge] joke_callback but no active jokes — downgrading to short_reaction");
                effectiveDecision = "short_reaction";
                updateDecisionRef.current(decisionLogId, {
                  outcome: "sent",
                  action: "short_reaction",
                  reasoning: `${decision.reason} (downgraded from joke_callback — no active jokes)`,
                });
              }
            } catch (e) {
              console.error("[AutoForge] Joke engine lookup failed:", e);
            }
          }

          toast.info(`AutoForge autonomous reaction`, { description: decision.action_payload });
          playSfx('autoforge_action');
          actionRateLimiter.recordAction(effectiveDecision);
          incrementStat("autoForgeActions");
          markActionBucketRef.current();
          
          const sendFn = getPlatformSendFn(state.platform);
          // Scope check before the send — the joke-engine lookup above may
          // have taken time; don't send into a stale session.
          if (!guard.isCurrent()) {
            console.log(`[AutoForge] Aborting ${effectiveDecision} send (session changed before send)`);
            updateDecisionRef.current(decisionLogId, { outcome: "stale" });
            return;
          }
          try {
            await sendFn(state.streamMetadata.channelName, decision.action_payload);
            updateDecisionRef.current(decisionLogId, { outcome: "sent" });
          } catch (e: any) {
            updateDecisionRef.current(decisionLogId, { outcome: "failed" });
            console.error("[AutoForge] send failed:", e);
            addEventRef.current({
              timestamp: Date.now(),
              type: "error",
              severity: "high",
              summary: `Send failed: ${e.message || e}`,
            });
            setAutoForgeNextActionMs(Date.now() + 20_000);
            return;
          }
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
            actionType: effectiveDecision,
            message: decision.action_payload,
            provider: activeProvider,
            success: true,
          });

          // Boost referenced memories and jokes
          if (state.autoMemoryConfig?.enabled) {
            if (decision.referenced_memory_ids) {
              for (const mid of decision.referenced_memory_ids) {
                boostMemory((state.streamMetadata.channelName || "default").toLowerCase(), mid).catch(console.error);
              }
            }
            if (decision.referenced_joke_ids) {
              for (const jid of decision.referenced_joke_ids) {
                boostJoke((state.streamMetadata.channelName || "default").toLowerCase(), jid, decision.action_payload).catch(console.error);
                recordJokeUsage((state.streamMetadata.channelName || "default").toLowerCase(), jid, decision.action_payload).catch(console.error);
              }
            }
          }

          setAutoForgeLastActionMs(Date.now());
          const summaryPrefix = effectiveDecision === "emote_only" ? "Emote" :
            effectiveDecision === "joke_callback" ? "Joke callback" :
            effectiveDecision === "meta_observation" ? "Meta observation" : "Reaction";
          addEventRef.current({
            timestamp: Date.now(),
            type: "action_sent",
            severity: "high",
            summary: `${summaryPrefix}: "${decision.action_payload}"`,
            details: { decision: effectiveDecision, confidence: decision.confidence, reason: decision.reason, action_payload: decision.action_payload },
          });
        }
      } else if (decision.decision === "quick_followup") {
        if (decision.action_payload) {
          const delayMs = Math.max(1500, Math.min(12000, decision.followup_delay_ms || 
            decision.action_payload.length * 65));
          toast.info(`AutoForge quick follow-up in ${(delayMs / 1000).toFixed(1)}s`, { description: decision.action_payload });
          playSfx('autoforge_action');
          actionRateLimiter.recordAction("quick_followup");
          incrementStat("followupActions");
          markActionBucketRef.current();

          // Clear any pending follow-up before scheduling a new one to avoid timer leaks
          if (followupTimerRef.current) {
            clearTimeout(followupTimerRef.current);
            followupTimerRef.current = null;
          }
          // Capture the scope now so the deferred send can verify the
          // session hasn't changed by the time it fires (the execution
          // guard is disposed in the finally below, so we use a plain
          // scope snapshot here).
          const followupScope = captureSessionScope();
          followupTimerRef.current = setTimeout(() => {
            // Don't send into a stale session — the channel/platform/mode
            // may have changed during the delay.
            if (!isSessionScopeCurrent(followupScope)) {
              console.log(`[AutoForge] Aborting quick_followup send (session changed during delay)`);
              updateDecisionRef.current(decisionLogId, { outcome: "stale" });
              followupTimerRef.current = null;
              return;
            }
            const sendFn2 = getPlatformSendFn(state.platform);
            sendFn2(state.streamMetadata.channelName, decision.action_payload)
              .then(() => {
                updateDecisionRef.current(decisionLogId, { outcome: "sent" });
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
              })
              .catch((e) => {
                updateDecisionRef.current(decisionLogId, { outcome: "failed" });
                console.error("[AutoForge] quick_followup send failed:", e);
                addEventRef.current({
                  timestamp: Date.now(),
                  type: "error",
                  severity: "high",
                  summary: `Quick follow-up send FAILED: ${e.message || e}`,
                  details: { decision: "quick_followup", message: decision.action_payload },
                });
              });
            followupTimerRef.current = null;
          }, delayMs);
        }
      } else if (decision.decision === "deliberate_silence") {
        incrementStat("silenceDecisions");
        consecutiveSilenceRef.current++;
        console.log(`[AutoForge] deliberate_silence:`, decision.reason);
        addEventRef.current({
          timestamp: Date.now(),
          type: "silence",
          severity: "low",
          summary: `Silence: ${decision.reason}`,
          details: { decision: decision.decision, confidence: decision.confidence, reason: decision.reason },
        });
      } else {
        // Any non-silence action resets the consecutive silence counter.
        consecutiveSilenceRef.current = 0;
      }

      // Evaluate session goals
      if (state.sessionGoals && state.sessionGoals.length > 0) {
        const results = evaluateSessionGoals(
          state.sessionGoals,
          useAppStore.getState().enhancedStats,
          useAppStore.getState().sentimentHistory,
        );
        useAppStore.getState().setGoalEvaluationResults(results);
      }

      // Schedule next check — accelerate if a spike was detected
      let nextMinutes = computeNextActionMinutes(decision.estimated_next_action_minutes, activitySpike, decision.decision);
      // Adaptive backoff: lengthen the check interval during consecutive
      // silences to reduce unnecessary AI calls during dead periods.
      nextMinutes = computeAdaptiveBackoff(consecutiveSilenceRef.current, nextMinutes, isMentioned, activitySpike);

      // Supercharge mode: clamp the next-check interval short so the bot
      // re-engages quickly. The adaptive backoff is skipped (silence shouldn't
      // lengthen the gap when the user asked for maximum engagement).
      if (supercharged) {
        nextMinutes = Math.min(nextMinutes, 1.5);
      }

      // A8: Manual activity awareness — delay next AutoForge action if user recently acted or is typing
      const nowMs = Date.now();
      const manualCooldown = computeManualCooldown(
        useAppStore.getState().lastManualSendMs,
        useAppStore.getState().lastUserChatTypingMs,
        nowMs,
      );
      if (manualCooldown.shouldDelay && decision.decision !== "deliberate_silence") {
        const delayMin = manualCooldown.delayMs / 60000;
        console.log(`[AutoForge] Manual activity ${Math.round(manualCooldown.msSinceManual / 1000)}s ago — delaying next action by ${Math.round(manualCooldown.delayMs / 1000)}s`);
        nextMinutes = Math.max(nextMinutes, delayMin);
        addEventRef.current({
          timestamp: nowMs,
          type: "silence",
          severity: "low",
          summary: `AutoForge delayed — manual activity detected (${Math.round(manualCooldown.msSinceManual / 1000)}s ago)`,
          details: { delayMs: manualCooldown.delayMs, msSinceManual: manualCooldown.msSinceManual },
        });
      }

      setAutoForgeNextActionMs(nowMs + nextMinutes * 60 * 1000);

    } catch (e: any) {
      const errMsg = e?.message || 'Unknown error';
      const isMissingKey = errMsg.includes('No API key configured');
      if (isSchedulerCancellation(e) || isQueueTimeout(e)) {
        // Intentional yield or queue timeout — not a failure. The scheduler
        // either preempted/cancelled this work for higher-priority traffic,
        // or the request waited too long for the Ollama slot (too many bots
        // queued). No error toast, quick retry.
        console.log(`[AutoForge] yielded: ${errMsg}`);
        addEventRef.current({
          timestamp: Date.now(),
          type: "silence",
          severity: "low",
          summary: `${isQueueTimeout(e) ? "Queue timeout — Ollama slot busy" : "Yielded to higher-priority request"} — retrying shortly`,
          details: { reason: errMsg },
        });
        setAutoForgeNextActionMs(Date.now() + 20_000);
      } else {
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
    } finally {
      // Release the execution guard (prevents a subscription leak per cycle).
      guard.dispose();
      // Release concurrency guard
      isAutoForgingRef.current = false;
      setIsAutoForgeThinking(false);
    }
  };

  // Lightweight mention watcher — runs when AutoForge is OFF but smart
  // replies are enabled. Detects mentions and generates smart replies
  // without the expensive AutoForge decision loop, so the user still gets
  // reply suggestions while AutoForge is disabled.
  const checkMentionsOnly = async () => {
    const state = useAppStore.getState();
    if (!state.smartRepliesEnabled || !canGenerateSmartReplies()) return;

    const botUsername = state.platform === "kick"
      ? (getKickSession()?.username || "").toLowerCase()
      : state.platform === "joystick"
        ? (getJoystickSession()?.username || "").toLowerCase()
        : (getTwitchSession()?.username || "").toLowerCase();
    if (!botUsername) return;

    const mentionPatterns = [botUsername, botUsername.replace(/[^a-z0-9]/g, "")];
    const recentMessages = state.chatLog.slice(-15).filter(m => !m.marker);
    const mentionedLines: string[] = [];
    for (const msg of recentMessages) {
      const lower = msg.text.toLowerCase();
      if (mentionPatterns.some(p => p && lower.includes(p))) {
        mentionedLines.push(`${msg.user}: ${msg.text}`);
      }
      if (botUsername && lower.includes(`@${botUsername}`)) {
        if (!mentionedLines.includes(`${msg.user}: ${msg.text}`)) mentionedLines.push(`${msg.user}: ${msg.text}`);
      }
    }
    if (mentionedLines.length === 0) return;

    // Capture scope so the async smart-reply result doesn't write into a
    // different session if the channel switched during generation.
    const mentionScope = captureSessionScope();
    setSmartRepliesLoading(true);
    generateSmartReplies(mentionedLines)
      .then((replies) => {
        if (!isSessionScopeCurrent(mentionScope)) {
          console.log("[AutoForge] Discarding stale smart replies (session changed)");
          setSmartRepliesLoading(false);
          return;
        }
        if (replies.length > 0) setSmartReplies(replies);
        setSmartRepliesLoading(false);
      })
      .catch((e) => {
        if (!isSchedulerCancellation(e) && !isQueueTimeout(e)) {
          console.error("[AutoForge] Smart reply generation failed:", e);
        }
        setSmartRepliesLoading(false);
      });
  };

  useEffect(() => {
    // Run the check every 15 seconds to see if it's time to act
    const interval = setInterval(() => {
      if (storeRef.current.autoForgeEnabled && storeRef.current.autoForgeAutoCheckEnabled) {
        checkAutoForge();
      } else if (!storeRef.current.autoForgeEnabled && storeRef.current.smartRepliesEnabled) {
        // AutoForge off — still detect mentions for smart replies
        checkMentionsOnly();
      }
    }, 15000);
    
    const onForceCheck = () => {
      if (storeRef.current.autoForgeEnabled) {
        checkAutoForge(true);
      }
    };
    window.addEventListener("autoforge-force-check", onForceCheck);

    // Supercharge teardown — when the user disables Supercharge, reset pacing
    // state so the loop returns to normal cadence immediately instead of
    // inheriting the fast schedule + zeroed silence counter from the
    // Supercharge session. Without this, the model keeps returning low
    // estimated_next_action_minutes (it sees recent frequent activity in its
    // context) and there's no floor to stop it, so the bot keeps firing fast.
    const onSupercharge = (e: Event) => {
      const active = (e as CustomEvent).detail?.active;
      if (active) return; // only act on disable
      actionRateLimiter.reset();
      consecutiveSilenceRef.current = 0;
      setAutoForgeNextActionMs(Date.now() + 90_000);
    };
    window.addEventListener("easter-egg-supercharge", onSupercharge);

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
      window.removeEventListener("easter-egg-supercharge", onSupercharge);
      if (followupTimerRef.current) {
        clearTimeout(followupTimerRef.current);
        followupTimerRef.current = null;
      }
      // Clean up any pending engagement-check timers
      engagementTimersRef.current.forEach(t => clearTimeout(t));
      engagementTimersRef.current.clear();
    };
  }, []);

  return null;
}
