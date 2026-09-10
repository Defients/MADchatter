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
import { retrieveRelevantMemories, formatMemoryContext } from "../lib/memoryRetrieval";
import { startNewSession, saveSessionEnd, detectMoodWithLock } from "../lib/personalityEngine";
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
  // Re-entrance guard: prevents overlapping extraction/decay cycles
  const busyRef = useRef(false);
  const chatLogRef = useRef(chatLog);
  chatLogRef.current = chatLog;

  // Load from IndexedDB on mount + start session
  useEffect(() => {
    if (initializedRef.current) return;
    if (!autoMemoryConfig.enabled) return;
    initializedRef.current = true;

    (async () => {
      try {
        const [memories, profiles, jokes] = await Promise.all([
          memoryStore.getAllMemories(),
          memoryStore.getAllProfiles(),
          memoryStore.getAllJokes(),
        ]);
        setAutoMemories(memories);
        setUserProfiles(profiles);
        setInsideJokes(jokes);

        // Start new session
        if (autoMemoryConfig.crossSessionPersistence) {
          const personality = await startNewSession();
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
        await runDecayCycle(autoMemoryConfig);

        console.log("[AutoMemory] Initialized from IndexedDB:", {
          memories: memories.length,
          profiles: profiles.length,
          jokes: jokes.length,
        });
      } catch (e) {
        console.error("[AutoMemory] Failed to initialize:", e);
      }
    })();
  }, [autoMemoryConfig.enabled]);

  // Save personality on unmount
  useEffect(() => {
    return () => {
      if (personalityState && autoMemoryConfig.crossSessionPersistence) {
        saveSessionEnd(personalityState).catch(console.error);
      }
    };
  }, [personalityState, autoMemoryConfig.crossSessionPersistence]);

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
        const hasEnoughData = recentChat.filter((m) => !m.marker).length >= 10 || state.audioTranscript.length > 100;

        if (hasEnoughData) {
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
            const stats = await applyExtractionResults(result, state.autoMemoryConfig);

            if (stats.memoriesAdded > 0 || stats.profilesUpdated > 0 || stats.jokesCreated > 0) {
              // Reload from IndexedDB
              const [memories, profiles, jokes] = await Promise.all([
                memoryStore.getAllMemories(),
                memoryStore.getAllProfiles(),
                memoryStore.getAllJokes(),
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
                await memoryStore.savePersonality(updated);
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
          } catch (e) {
            console.error("[AutoMemory] Extraction failed:", e);
          }
        }
      }

      // Run decay every 30 minutes
      const decayInterval = 30 * 60 * 1000;
      if (now - lastDecayRef.current >= decayInterval) {
        try {
          await runDecayCycle(state.autoMemoryConfig);
          const [memories, jokes] = await Promise.all([
            memoryStore.getAllMemories(),
            memoryStore.getAllJokes(),
          ]);
          setAutoMemories(memories);
          setInsideJokes(jokes);
          lastDecayRef.current = now;
          console.log("[AutoMemory] Decay cycle complete");
        } catch (e) {
          console.error("[AutoMemory] Decay failed:", e);
        }
      }

      // Update mood based on current context
      if (state.personalityState && state.autoMemoryConfig.personalityEvolutionEnabled) {
        const detectedMood = detectMoodWithLock(chatLogRef.current, state.audioTranscript, state.streamMetadata.viewerCount, useAppStore.getState().moodLock);
        if (detectedMood !== state.personalityState.mood) {
          const updated: PersonalityState = {
            ...state.personalityState,
            mood: detectedMood,
          };
          setPersonalityState(updated);
        }
      }
      } finally {
        busyRef.current = false;
      }
    }, 30000); // Check every 30 seconds

    return () => clearInterval(interval);
  }, [autoMemoryConfig.enabled, setAutoMemories, setUserProfiles, setInsideJokes, setPersonalityState]);

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
