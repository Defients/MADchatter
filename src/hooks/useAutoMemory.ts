import { useEffect, useRef, useCallback } from "react";
import { useAppStore } from "../store";
import { getActiveProvider } from "../lib/keys";
import { formatChatLog } from "../lib/chatUtils";
import {
  extractMemories,
  applyExtractionResults,
  runDecayCycle,
  type ExtractionParams,
} from "../lib/memoryEngine";
import { isSchedulerCancellation, isSchedulerTimeout } from "../lib/aiScheduler";
import { retrieveRelevantMemories, formatMemoryContext } from "../lib/memoryRetrieval";
import { startNewSession, saveSessionEnd, detectMoodWithLock, evolveTraits, updateComfortLevel, addRelationshipMilestone } from "../lib/personalityEngine";
import * as memoryStore from "../lib/memoryStore";
import type { PersonalityState } from "../types";

export function useAutoMemory() {
  const {
    autoMemoryConfig,
    chatLog,
    audioTranscript,
    streamMetadata,
    autoMemories,
    userProfiles,
    insideJokes,
    personalityState,
    setAutoMemories,
    setUserProfiles,
    setInsideJokes,
    setPersonalityState,
  } = useAppStore();

  const lastExtractionRef = useRef<number>(Date.now());
  const lastDecayRef = useRef<number>(Date.now());
  const initializedRef = useRef(false);
  const initializedChannelRef = useRef<string>("");
  // Re-entrance guard: prevents overlapping extraction/decay cycles
  const busyRef = useRef(false);
  // Tracks action history length for comfort-level delta calculation
  const lastComfortActionCountRef = useRef<number>(0);
  // Tracks sentiment history length for comfort-level delta calculation
  const lastComfortSentimentCountRef = useRef<number>(0);
  // Tracks messages received for comfort-level chat activity delta
  const lastComfortMessagesReceivedRef = useRef<number>(0);
  const chatLogRef = useRef(chatLog);
  chatLogRef.current = chatLog;

  // ── AutoMemory hardening: extraction cursor, dedup, backoff ──────────────
  // Watermark: the chatLog length at the last SUCCESSFUL extraction. We only
  // extract when there's enough new chat since the last extraction.
  const extractionCursorRef = useRef<number>(0);
  // Backoff: after a real failure (timeout or provider error), wait longer
  // before retrying. Preemption does NOT trigger backoff.
  const backoffUntilRef = useRef<number>(0);
  const consecutiveFailuresRef = useRef<number>(0);
  // Stale channel guard: capture the channel at extraction start so we can
  // discard results if the user switches streamers mid-extraction.
  const extractionChannelRef = useRef<string>("");

  const channel = (streamMetadata?.channelName || "default").toLowerCase();

  // Load from IndexedDB on mount + start session. Re-runs when the channel
  // changes so auto-memory is reloaded for the new streamer.
  useEffect(() => {
    if (!autoMemoryConfig.enabled) return;
    if (initializedRef.current && initializedChannelRef.current === channel) return;
    initializedRef.current = true;
    initializedChannelRef.current = channel;

    (async () => {
      try {
        const [memories, profiles, jokes] = await Promise.all([
          memoryStore.getAllMemories(channel),
          memoryStore.getAllProfiles(channel),
          memoryStore.getAllJokes(channel),
        ]);
        setAutoMemories(memories);
        setUserProfiles(profiles);
        setInsideJokes(jokes);

        // Start new session
        if (autoMemoryConfig.crossSessionPersistence) {
          const personality = await startNewSession(channel);
          setPersonalityState(personality);
        } else {
          const fresh: PersonalityState = {
            mood: "chill",
            comfortLevel: 20,
            sessionCount: 1,
            totalMessagesSent: 0,
            dominantTraits: [],
            currentSessionStart: Date.now(),
            sessionMemoriesFormed: 0,
            sessionJokesCreated: 0,
            relationshipProgression: [],
          };
          setPersonalityState(fresh);
        }

        // Run initial decay
        await runDecayCycle(autoMemoryConfig, channel);

        if (memories.length || profiles.length || jokes.length) {
          console.log("[AutoMemory] Initialized from IndexedDB:", {
            channel,
            memories: memories.length,
            profiles: profiles.length,
            jokes: jokes.length,
          });
        }
      } catch (e) {
        console.error("[AutoMemory] Failed to initialize:", e);
      }
    })();
  }, [autoMemoryConfig.enabled, channel]);

  // Save personality on unmount
  useEffect(() => {
    return () => {
      if (personalityState && autoMemoryConfig.crossSessionPersistence) {
        saveSessionEnd((streamMetadata?.channelName || "default").toLowerCase(), personalityState).catch(console.error);
      }
    };
  }, [personalityState, autoMemoryConfig.crossSessionPersistence, streamMetadata?.channelName]);

  // Extraction + decay loop
  useEffect(() => {
    if (!autoMemoryConfig.enabled) return;

    const interval = setInterval(async () => {
      // Re-entrance guard: skip if previous cycle is still running
      if (busyRef.current) return;
      busyRef.current = true;
      try {
      const now = Date.now();
      const state = useAppStore.getState();

      if (!state.autoMemoryConfig.enabled) return;

      // Check if it's time for extraction
      const extractionInterval = state.autoMemoryConfig.extractionIntervalMinutes * 60 * 1000;
      const timeSinceExtraction = now - lastExtractionRef.current;

      if (timeSinceExtraction >= extractionInterval) {
        const recentChat = chatLogRef.current;
        const nonMarkerCount = recentChat.filter((m) => !m.marker).length;
        const hasEnoughData = nonMarkerCount >= 10 || state.audioTranscript.length > 100;

        // ── Extraction cursor: only extract if there's enough NEW chat since
        // the last successful extraction. Prevents reprocessing the same
        // chat window repeatedly.
        const newMessagesSinceCursor = nonMarkerCount - extractionCursorRef.current;
        const minNewMessages = 5; // minimum new signal to justify extraction

        // ── Backoff: after real failures, wait before retrying.
        // Preemption does NOT trigger backoff (it's intentional, not a failure).
        const inBackoff = now < backoffUntilRef.current;

        if (hasEnoughData && !inBackoff && newMessagesSinceCursor >= minNewMessages) {
          // Capture channel at extraction start for stale-result guard.
          const extractionChannel = channel;
          extractionChannelRef.current = extractionChannel;
          try {
            const params: ExtractionParams = {
              chatLog: recentChat,
              audioTranscript: state.audioTranscript,
              streamMetadata: state.streamMetadata,
              existingMemories: state.autoMemories,
              existingProfiles: state.userProfiles,
              existingJokes: state.insideJokes,
              config: state.autoMemoryConfig,
            };

            const result = await extractMemories(params);

            // ── Stale channel guard: discard results if the user switched
            // streamers while extraction was in flight.
            const currentChannel = (useAppStore.getState().streamMetadata?.channelName || "default").toLowerCase();
            if (currentChannel !== extractionChannel) {
              console.log(`[AutoMemory] Discarding stale extraction result (channel changed: ${extractionChannel} → ${currentChannel})`);
              lastExtractionRef.current = now;
              extractionCursorRef.current = nonMarkerCount;
              consecutiveFailuresRef.current = 0;
              return;
            }

            if (result.tokenUsage) {
              useAppStore.getState().recordTokenUsage("memory_extraction", result.tokenUsage);
            }
            const stats = await applyExtractionResults(result, state.autoMemoryConfig, extractionChannel);

            if (stats.memoriesAdded > 0 || stats.profilesUpdated > 0 || stats.jokesCreated > 0) {
              // Reload from IndexedDB
              const [memories, profiles, jokes] = await Promise.all([
                memoryStore.getAllMemories(extractionChannel),
                memoryStore.getAllProfiles(extractionChannel),
                memoryStore.getAllJokes(extractionChannel),
              ]);
              setAutoMemories(memories);
              setUserProfiles(profiles);
              setInsideJokes(jokes);

              // Update personality session counters
              if (state.personalityState) {
                const updated: PersonalityState = {
                  ...state.personalityState,
                  sessionMemoriesFormed: state.personalityState.sessionMemoriesFormed + stats.memoriesAdded,
                  sessionJokesCreated: state.personalityState.sessionJokesCreated + stats.jokesCreated,
                };
                setPersonalityState(updated);
                await memoryStore.savePersonality(extractionChannel, updated);
              }

              console.log("[AutoMemory] Extraction complete:", stats, result.summary);

              // Dispatch event for UI
              window.dispatchEvent(
                new CustomEvent("memory-extraction-complete", {
                  detail: { ...stats, summary: result.summary },
                }),
              );
            }

            lastExtractionRef.current = now;
            extractionCursorRef.current = nonMarkerCount;
            consecutiveFailuresRef.current = 0;
          } catch (e) {
            // ── Preemption-aware error handling ────────────────────────────
            // Intentional preemption/cancellation: NOT a failure. No backoff.
            // The scheduler cancelled us because a higher-priority request
            // (e.g. manual Forge) needed the GPU. We'll try again next cycle.
            if (isSchedulerCancellation(e)) {
              console.log(`[AutoMemory] Extraction cancelled (preempted) — will retry next cycle`);
              // Reset the extraction timer so we retry soon, but don't backoff.
              lastExtractionRef.current = now;
              // Don't update the cursor — we didn't process anything.
            } else if (isSchedulerTimeout(e)) {
              // Timeout: real failure. Backoff with exponential delay.
              consecutiveFailuresRef.current++;
              const backoffMs = Math.min(300_000, 30_000 * Math.pow(2, consecutiveFailuresRef.current - 1));
              backoffUntilRef.current = Date.now() + backoffMs;
              console.error(`[AutoMemory] Extraction timed out — backing off for ${backoffMs / 1000}s (failure #${consecutiveFailuresRef.current})`);
              lastExtractionRef.current = now;
            } else {
              // Genuine provider error: backoff but less aggressively.
              consecutiveFailuresRef.current++;
              const backoffMs = Math.min(120_000, 15_000 * consecutiveFailuresRef.current);
              backoffUntilRef.current = Date.now() + backoffMs;
              console.error(`[AutoMemory] Extraction failed — backing off for ${backoffMs / 1000}s:`, e);
              lastExtractionRef.current = now;
            }
          }
        }
      }

      // Run decay every 30 minutes
      const decayInterval = 30 * 60 * 1000;
      if (now - lastDecayRef.current >= decayInterval) {
        try {
          await runDecayCycle(state.autoMemoryConfig, channel);
          const [memories, jokes] = await Promise.all([
            memoryStore.getAllMemories(channel),
            memoryStore.getAllJokes(channel),
          ]);
          setAutoMemories(memories);
          setInsideJokes(jokes);
          lastDecayRef.current = now;
          console.log("[AutoMemory] Decay cycle complete");
        } catch (e) {
          console.error("[AutoMemory] Decay failed:", e);
        }
      }

      // Update mood + evolve personality based on current context
      if (state.personalityState && state.autoMemoryConfig.personalityEvolutionEnabled) {
        let updated: PersonalityState = { ...state.personalityState };

        // Mood detection
        const detectedMood = detectMoodWithLock(chatLogRef.current, state.audioTranscript, state.streamMetadata.viewerCount, useAppStore.getState().moodLock);
        if (detectedMood !== updated.mood) {
          updated = { ...updated, mood: detectedMood };
        }

        // Trait evolution from recent action history
        const recentActions = state.actionHistory
          .slice(-50)
          .map((a) => ({ type: a.actionType, success: a.success }));
        if (recentActions.length >= 5) {
          const newTraits = evolveTraits(updated.dominantTraits, recentActions);
          if (newTraits.length > 0 && newTraits.join(",") !== updated.dominantTraits.join(",")) {
            updated = { ...updated, dominantTraits: newTraits };
          }
        }

        // Comfort level growth from recent bot actions + positive sentiment + chat activity
        const actionDelta = Math.max(0, state.actionHistory.length - lastComfortActionCountRef.current);
        lastComfortActionCountRef.current = state.actionHistory.length;
        // Use delta of positive sentiment readings (not cumulative count) so
        // comfort grows from NEW positive readings, not the same ones every tick
        const positiveTotal = state.sentimentHistory
          .filter((s) => s.label === "positive" || s.label === "wholesome" || s.label === "hype")
          .length;
        const positiveDelta = Math.max(0, positiveTotal - lastComfortSentimentCountRef.current);
        lastComfortSentimentCountRef.current = positiveTotal;
        // Chat activity delta — any new messages keep comfort drifting up
        const messagesReceived = state.sessionStats.messagesReceived;
        const messagesDelta = Math.max(0, messagesReceived - lastComfortMessagesReceivedRef.current);
        lastComfortMessagesReceivedRef.current = messagesReceived;
        if (actionDelta > 0 || positiveDelta > 0 || messagesDelta > 0) {
          const newComfort = updateComfortLevel(updated.comfortLevel, actionDelta, positiveDelta, messagesDelta);
          if (newComfort !== updated.comfortLevel) {
            updated = { ...updated, comfortLevel: newComfort };
          }
        }

        // Relationship milestones — fire once per threshold
        const milestones: { threshold: number; stage: string; note: string }[] = [
          { threshold: 50, stage: "acquainted", note: "Comfort level reached 50 — bot feels settled in" },
          { threshold: 75, stage: "comfortable", note: "Comfort level reached 75 — bot is relaxed with chat" },
          { threshold: 100, stage: "bonded", note: "Comfort level maxed — bot feels deeply connected" },
        ];
        for (const m of milestones) {
          if (updated.comfortLevel >= m.threshold && !updated.relationshipProgression.some((r) => r.stage === m.stage)) {
            updated = addRelationshipMilestone(updated, m.stage, m.note);
          }
        }
        const sessionMilestones: { threshold: number; stage: string; note: string }[] = [
          { threshold: 5, stage: "regular_viewer", note: "5th session — bot recognizes you as a regular" },
          { threshold: 10, stage: "veteran", note: "10th session — bot considers you a veteran chatter" },
          { threshold: 25, stage: "old_friend", note: "25th session — bot considers you an old friend" },
        ];
        for (const m of sessionMilestones) {
          if (updated.sessionCount >= m.threshold && !updated.relationshipProgression.some((r) => r.stage === m.stage)) {
            updated = addRelationshipMilestone(updated, m.stage, m.note);
          }
        }

        // Track total messages sent
        const totalSent = state.sentMessages.length;
        if (totalSent !== updated.totalMessagesSent) {
          updated = { ...updated, totalMessagesSent: totalSent };
        }

        // Persist if anything changed
        if (updated !== state.personalityState) {
          setPersonalityState(updated);
          memoryStore.savePersonality(channel, updated).catch(() => {});
        }
      }
      } finally {
        busyRef.current = false;
      }
    }, 30000); // Check every 30 seconds

    return () => clearInterval(interval);
  }, [autoMemoryConfig.enabled, channel, setAutoMemories, setUserProfiles, setInsideJokes, setPersonalityState]);

  // Expose memory context builder for other hooks to use
  const buildMemoryContext = useCallback((): string => {
    const state = useAppStore.getState();
    if (!state.autoMemoryConfig.enabled) return "";

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

    return formatMemoryContext(retrieved, {
      memoriesFormed: state.personalityState?.sessionMemoriesFormed ?? 0,
      jokesCreated: state.personalityState?.sessionJokesCreated ?? 0,
    });
  }, []);

  return { buildMemoryContext };
}
