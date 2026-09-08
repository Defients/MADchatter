import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ForgeSuggestion, ForgeConfig, PinnedMemory, AutoForgeEvent, SentMessage, SessionStats, ChatMessage, AutoMemory, UserProfile, InsideJoke, PersonalityState, AutoMemoryConfig, ActionHistoryEntry, EnhancedSessionStats, AutoForgeRateLimitConfig, SentimentReading, SentimentSummary, QueuedMessage, ChatActivityBucket, SmartReply, ChatterStats, DecisionLogEntry, PersonaPreset, KeywordTriggerRule, SessionGoal, GoalEvaluationResult, EngagementBreakdown } from "./types";
import type { Platform } from "./lib/kick";
import { generateId } from "./lib/ids";
import type { AutoForgeDecision } from "./lib/ai";

interface AppState {
  platform: Platform;
  setPlatform: (platform: Platform) => void;

  authTick: number;
  bumpAuthTick: () => void;

  streamMetadata: {
    channelName: string;
    title: string;
    category: string;
    viewerCount: number;
  };
  updateStreamMetadata: (updates: Partial<AppState["streamMetadata"]>) => void;
  
  visualSnapshotUrl: string | null;
  visualContextTags: string[];
  setVisualSnapshot: (url: string | null, tags: string[]) => void;
  
  config: ForgeConfig;
  updateConfig: (updates: Partial<ForgeConfig>) => void;
  
  autoForgeEnabled: boolean;
  setAutoForgeEnabled: (enabled: boolean) => void;

  r34lEnabled: boolean;
  setR34lEnabled: (enabled: boolean) => void;
  
  isAutoForgeHUDOpen: boolean;
  setIsAutoForgeHUDOpen: (isOpen: boolean) => void;
  lastAutoForgeDecision: AutoForgeDecision | null;
  setLastAutoForgeDecision: (decision: AutoForgeDecision | null) => void;

  autoForgeFollowup: { message: string; deliveredAt: number } | null;
  setAutoForgeFollowup: (followup: { message: string; deliveredAt: number } | null) => void;
  
  autoForgeLastActionMs: number | null;
  setAutoForgeLastActionMs: (ms: number | null) => void;
  autoForgeNextActionMs: number;
  setAutoForgeNextActionMs: (ms: number) => void;
  
  isForging: boolean;
  setIsForging: (isForging: boolean) => void;
  
  variants: ForgeSuggestion[];
  setVariants: (variants: ForgeSuggestion[]) => void;
  updateVariant: (id: number, updates: Partial<ForgeSuggestion>) => void;
  
  audioTranscript: string;
  setAudioTranscript: (transcript: string) => void;
  appendAudioTranscript: (line: string) => void;
  chatLog: ChatMessage[];
  appendChatLog: (msg: ChatMessage) => void;
  markUserBanned: (username: string) => void;
  
  longTermMemory: string;
  setLongTermMemory: (memory: string) => void;
  pinnedMemories: PinnedMemory[];
  addPinnedMemory: (item: Omit<PinnedMemory, "id">) => void;
  removePinnedMemory: (id: string) => void;
  clearPinnedMemories: () => void;
  goldenMemoryId: string | null;
  setGoldenMemory: (id: string | null) => void;
  
  clearAllContext: () => void;

  lastTokenUsage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    effort_given: "low" | "medium" | "high";
  } | null;
  setLastTokenUsage: (usage: AppState["lastTokenUsage"]) => void;

  autoForgeEventLog: AutoForgeEvent[];
  addAutoForgeEvent: (event: Omit<AutoForgeEvent, "id">) => void;
  clearAutoForgeEvents: () => void;

  isAutoForgeReportOpen: boolean;
  setIsAutoForgeReportOpen: (isOpen: boolean) => void;

  sentMessages: SentMessage[];
  addSentMessage: (msg: Omit<SentMessage, "id">) => void;
  clearSentMessages: () => void;

  sessionStats: SessionStats;
  incrementMessagesReceived: () => void;
  incrementMessagesSent: () => void;
  incrementForgeCount: () => void;
  resetSessionStats: () => void;

  tmiReadState: "disconnected" | "connecting" | "connected" | "error";
  setTmiReadState: (state: AppState["tmiReadState"]) => void;
  tmiSendState: "disconnected" | "connecting" | "connected" | "error";
  setTmiSendState: (state: AppState["tmiSendState"]) => void;

  cosmotechTheme: boolean;
  setCosmotechTheme: (enabled: boolean) => void;

  streamCaptureActive: boolean;
  setStreamCaptureActive: (active: boolean) => void;

  messageSoundEnabled: boolean;
  setMessageSoundEnabled: (enabled: boolean) => void;

  audioOutputDeviceId: string | null;
  setAudioOutputDeviceId: (id: string | null) => void;

  customSoundUrl: string | null;
  setCustomSoundUrl: (url: string | null) => void;

  soundVolume: number;
  setSoundVolume: (vol: number) => void;

  sfxEnabled: boolean;
  setSfxEnabled: (enabled: boolean) => void;
  sfxVolume: number;
  setSfxVolume: (volume: number) => void;

  ttsEnabled: boolean;
  setTtsEnabled: (enabled: boolean) => void;
  ttsProvider: "web" | "elevenlabs";
  setTtsProvider: (provider: "web" | "elevenlabs") => void;
  ttsVoice: string | null;
  setTtsVoice: (voice: string | null) => void;
  ttsRate: number;
  setTtsRate: (rate: number) => void;
  ttsVolume: number;
  setTtsVolume: (vol: number) => void;
  elevenlabsApiKey: string;
  setElevenlabsApiKey: (key: string) => void;
  ttsAudioOutputDeviceId: string | null;
  setTtsAudioOutputDeviceId: (id: string | null) => void;

  // ─── Auto-Memory System ───────────────────────────────────
  autoMemories: AutoMemory[];
  setAutoMemories: (memories: AutoMemory[]) => void;
  addAutoMemory: (memory: AutoMemory) => void;
  updateAutoMemory: (id: string, updates: Partial<AutoMemory>) => void;
  removeAutoMemory: (id: string) => void;
  clearAutoMemories: () => void;

  userProfiles: UserProfile[];
  setUserProfiles: (profiles: UserProfile[]) => void;
  upsertUserProfile: (profile: UserProfile) => void;
  removeUserProfile: (username: string) => void;
  clearUserProfiles: () => void;

  insideJokes: InsideJoke[];
  setInsideJokes: (jokes: InsideJoke[]) => void;
  addInsideJoke: (joke: InsideJoke) => void;
  updateInsideJoke: (id: string, updates: Partial<InsideJoke>) => void;
  removeInsideJoke: (id: string) => void;
  clearInsideJokes: () => void;

  personalityState: PersonalityState | null;
  setPersonalityState: (state: PersonalityState) => void;

  autoMemoryConfig: AutoMemoryConfig;
  updateAutoMemoryConfig: (updates: Partial<AutoMemoryConfig>) => void;

  memoryPanelOpen: boolean;
  setMemoryPanelOpen: (open: boolean) => void;

  // ─── Analytics ───────────────────────────────────
  actionHistory: ActionHistoryEntry[];
  addActionHistoryEntry: (entry: Omit<ActionHistoryEntry, "id">) => void;
  clearActionHistory: () => void;

  enhancedStats: EnhancedSessionStats;
  updateEnhancedStats: (updates: Partial<EnhancedSessionStats>) => void;
  incrementStat: (key: keyof EnhancedSessionStats, amount?: number) => void;
  resetEnhancedStats: () => void;

  rateLimitConfig: AutoForgeRateLimitConfig;
  updateRateLimitConfig: (updates: Partial<AutoForgeRateLimitConfig>) => void;

  analyticsPanelOpen: boolean;
  setAnalyticsPanelOpen: (open: boolean) => void;

  // ─── Sentiment Analysis ───────────────────────────────────
  sentimentHistory: SentimentReading[];
  addSentimentReading: (reading: SentimentReading) => void;
  sentimentSummary: SentimentSummary | null;
  updateSentimentSummary: (summary: SentimentSummary) => void;

  // ─── Desktop Notifications ───────────────────────────────
  desktopNotificationsEnabled: boolean;
  setDesktopNotificationsEnabled: (enabled: boolean) => void;

  // ─── Message Queue ────────────────────────────────────────
  messageQueueDepth: number;
  setMessageQueueDepth: (depth: number) => void;

  // ─── Chat Search ──────────────────────────────────────────
  chatSearchQuery: string;
  setChatSearchQuery: (query: string) => void;

  // ─── Chat Activity Heatmap ───────────────────────────────
  chatActivityBuckets: ChatActivityBucket[];
  recordChatActivity: () => void;
  markAutoForgeActionBucket: () => void;

  // ─── Smart Replies ───────────────────────────────────────
  smartReplies: SmartReply[];
  setSmartReplies: (replies: SmartReply[]) => void;
  smartRepliesLoading: boolean;
  setSmartRepliesLoading: (loading: boolean) => void;
  smartRepliesEnabled: boolean;
  setSmartRepliesEnabled: (enabled: boolean) => void;

  // ─── Chatter Leaderboard ─────────────────────────────────
  chatterStats: Record<string, ChatterStats>;
  updateChatterStats: (username: string, sentiment: string, isMention: boolean, badges?: string[]) => void;
  clearChatterStats: () => void;

  // ─── Decision Log ────────────────────────────────────────
  decisionLog: DecisionLogEntry[];
  addDecisionLogEntry: (entry: Omit<DecisionLogEntry, "id">) => string;
  updateDecisionLogEntry: (id: string, updates: Partial<DecisionLogEntry>) => void;
  clearDecisionLog: () => void;

  // ─── Persona Presets ─────────────────────────────────────
  personaPresets: PersonaPreset[];
  activePersonaId: string | null;
  applyPersonaPreset: (id: string) => void;
  saveCustomPersonaPreset: (name: string, icon: string) => void;
  deleteCustomPersonaPreset: (id: string) => void;

  // ─── Keyword Trigger Rules ───────────────────────────────
  keywordTriggerRules: KeywordTriggerRule[];
  addKeywordTriggerRule: (rule: Omit<KeywordTriggerRule, "id" | "matchCount" | "lastTriggeredMs">) => void;
  updateKeywordTriggerRule: (id: string, updates: Partial<KeywordTriggerRule>) => void;
  removeKeywordTriggerRule: (id: string) => void;
  clearKeywordTriggerRules: () => void;
  incrementTriggerMatch: (id: string) => void;

  // ─── Session Goals ───────────────────────────────────────
  sessionGoals: SessionGoal[];
  addSessionGoal: (goal: Omit<SessionGoal, "id">) => void;
  updateSessionGoal: (id: string, updates: Partial<SessionGoal>) => void;
  removeSessionGoal: (id: string) => void;
  clearSessionGoals: () => void;
  goalEvaluationResults: GoalEvaluationResult[];
  setGoalEvaluationResults: (results: GoalEvaluationResult[]) => void;

  // ─── AutoForge Advanced ───────────────────────────────────
  autoForgeDryRun: boolean;
  setAutoForgeDryRun: (enabled: boolean) => void;
  autoForgeConfidenceThreshold: number;
  setAutoForgeConfidenceThreshold: (threshold: number) => void;

  // ─── Engagement & Stream Status ───────────────────────────
  engagementScore: EngagementBreakdown | null;
  setEngagementScore: (score: EngagementBreakdown | null) => void;
  streamLikelyOffline: boolean;
  setStreamLikelyOffline: (offline: boolean) => void;

  // ─── Tutorial Walkthrough ────────────────────────────────
  tutorialActive: boolean;
  setTutorialActive: (active: boolean) => void;
  tutorialStep: number;
  setTutorialStep: (step: number) => void;

  exportSettings: () => string;
  importSettings: (json: string) => boolean;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      platform: "twitch",
      setPlatform: (platform) => set({ platform }),

      authTick: 0,
      bumpAuthTick: () => set((state) => ({ authTick: state.authTick + 1 })),

      streamMetadata: {
        channelName: "",
        title: "",
        category: "",
        viewerCount: 0,
      },
      updateStreamMetadata: (updates) =>
        set((state) => ({
          streamMetadata: { ...state.streamMetadata, ...updates },
        })),

      visualSnapshotUrl: null,
      visualContextTags: [],
      setVisualSnapshot: (url, tags) =>
        set({ visualSnapshotUrl: url, visualContextTags: tags }),

      config: {
        provider: "gemini",
        humorLevel: 50,
        chaosLevel: 50,
        customDirectives: "",
        activeProfiles: ["hype", "analyst", "gremlin"],
        primaryProfile: "hype",
        emoteDensity: "moderate",
        toxicityFilter: "standard",
        lengthPreference: "short",
        voiceContextEnabled: false,
        additionalInstructions: "",
        generationMode: "chat",
        effortLevel: "medium",
        autoForgeContextTokens: 4000,
      },
      updateConfig: (updates) =>
        set((state) => ({
          config: { ...state.config, ...updates },
        })),

      autoForgeEnabled: false,
      setAutoForgeEnabled: (enabled) => set({ autoForgeEnabled: enabled }),

      r34lEnabled: false,
      setR34lEnabled: (enabled) => set({ r34lEnabled: enabled }),

      isAutoForgeHUDOpen: false,
      setIsAutoForgeHUDOpen: (isOpen) => set({ isAutoForgeHUDOpen: isOpen }),
      lastAutoForgeDecision: null,
      setLastAutoForgeDecision: (decision) => set({ lastAutoForgeDecision: decision }),

      autoForgeFollowup: null,
      setAutoForgeFollowup: (followup) => set({ autoForgeFollowup: followup }),
      
      autoForgeLastActionMs: null,
      setAutoForgeLastActionMs: (ms) => set({ autoForgeLastActionMs: ms }),
      autoForgeNextActionMs: 0,
      setAutoForgeNextActionMs: (ms) => set({ autoForgeNextActionMs: ms }),

      isForging: false,
      setIsForging: (isForging) => set({ isForging }),

      variants: [],
      setVariants: (variants) => set({ variants }),
      updateVariant: (id, updates) =>
        set((state) => ({
          variants: state.variants.map((v) =>
            v.variant_id === id ? { ...v, ...updates } : v
          ),
        })),

      audioTranscript: "",
      setAudioTranscript: (transcript) => set({ audioTranscript: transcript }),
      appendAudioTranscript: (line) =>
        set((state) => ({
          audioTranscript: state.audioTranscript
            ? state.audioTranscript + "\n" + line
            : line,
        })),
      chatLog: [],
      appendChatLog: (msg) =>
        set((state) => {
          const newLog = [...state.chatLog, msg];
          if (newLog.length > 200) newLog.splice(0, newLog.length - 200);
          return { chatLog: newLog };
        }),
      markUserBanned: (username) =>
        set((state) => ({
          chatLog: state.chatLog.map((m) =>
            m.user === username ? { ...m, banned: true } : m
          ),
        })),

      longTermMemory: "",
      setLongTermMemory: (memory) => set({ longTermMemory: memory }),
      pinnedMemories: [],
      addPinnedMemory: (item) =>
        set((state) => ({
          pinnedMemories: [...state.pinnedMemories, { ...item, id: generateId() }],
        })),
      removePinnedMemory: (id) =>
        set((state) => ({
          pinnedMemories: state.pinnedMemories.filter((m) => m.id !== id),
        })),
      clearPinnedMemories: () =>
        set({ pinnedMemories: [], longTermMemory: "", goldenMemoryId: null }),
      goldenMemoryId: null,
      setGoldenMemory: (id) => set({ goldenMemoryId: id }),

      clearAllContext: () =>
        set({
          chatLog: [],
          audioTranscript: "",
          visualSnapshotUrl: null,
          visualContextTags: [],
          longTermMemory: "",
          pinnedMemories: [],
          goldenMemoryId: null,
          lastTokenUsage: null,
        }),

      lastTokenUsage: null,
      setLastTokenUsage: (usage) => set({ lastTokenUsage: usage }),

      autoForgeEventLog: [],
      addAutoForgeEvent: (event) =>
        set((state) => {
          const newEvent: AutoForgeEvent = {
            ...event,
            id: generateId(),
          };
          const log = [...state.autoForgeEventLog, newEvent];
          if (log.length > 500) log.splice(0, log.length - 500);
          return { autoForgeEventLog: log };
        }),
      clearAutoForgeEvents: () => set({ autoForgeEventLog: [] }),

      isAutoForgeReportOpen: false,
      setIsAutoForgeReportOpen: (isOpen) => set({ isAutoForgeReportOpen: isOpen }),

      sentMessages: [],
      addSentMessage: (msg) =>
        set((state) => ({
          sentMessages: [...state.sentMessages, { ...msg, id: generateId() }].slice(-100),
        })),
      clearSentMessages: () => set({ sentMessages: [] }),

      sessionStats: {
        sessionStart: Date.now(),
        messagesReceived: 0,
        messagesSent: 0,
        forgeCount: 0,
      },
      incrementMessagesReceived: () =>
        set((state) => ({ sessionStats: { ...state.sessionStats, messagesReceived: state.sessionStats.messagesReceived + 1 } })),
      incrementMessagesSent: () =>
        set((state) => ({ sessionStats: { ...state.sessionStats, messagesSent: state.sessionStats.messagesSent + 1 } })),
      incrementForgeCount: () =>
        set((state) => ({ sessionStats: { ...state.sessionStats, forgeCount: state.sessionStats.forgeCount + 1 } })),
      resetSessionStats: () =>
        set({ sessionStats: { sessionStart: Date.now(), messagesReceived: 0, messagesSent: 0, forgeCount: 0 } }),

      tmiReadState: "disconnected",
      setTmiReadState: (state) => set({ tmiReadState: state }),
      tmiSendState: "disconnected",
      setTmiSendState: (state) => set({ tmiSendState: state }),

      cosmotechTheme: false,
      setCosmotechTheme: (enabled) => set({ cosmotechTheme: enabled }),

      streamCaptureActive: false,
      setStreamCaptureActive: (active) => set({ streamCaptureActive: active }),

      messageSoundEnabled: false,
      setMessageSoundEnabled: (enabled) => set({ messageSoundEnabled: enabled }),

      audioOutputDeviceId: null,
      setAudioOutputDeviceId: (id) => set({ audioOutputDeviceId: id }),

      customSoundUrl: null,
      setCustomSoundUrl: (url) => set({ customSoundUrl: url }),

      soundVolume: 1,
      setSoundVolume: (vol) => set({ soundVolume: vol }),

      sfxEnabled: true,
      setSfxEnabled: (enabled) => set({ sfxEnabled: enabled }),
      sfxVolume: 0.3,
      setSfxVolume: (volume) => set({ sfxVolume: volume }),

      ttsEnabled: false,
      setTtsEnabled: (enabled) => set({ ttsEnabled: enabled }),
      ttsProvider: "web",
      setTtsProvider: (provider) => set({ ttsProvider: provider }),
      ttsVoice: null,
      setTtsVoice: (voice) => set({ ttsVoice: voice }),
      ttsRate: 1,
      setTtsRate: (rate) => set({ ttsRate: rate }),
      ttsVolume: 1,
      setTtsVolume: (vol) => set({ ttsVolume: vol }),
      elevenlabsApiKey: "",
      setElevenlabsApiKey: (key) => set({ elevenlabsApiKey: key }),
      ttsAudioOutputDeviceId: null,
      setTtsAudioOutputDeviceId: (id) => set({ ttsAudioOutputDeviceId: id }),

      // ─── Auto-Memory System ───────────────────────────────────
      autoMemories: [],
      setAutoMemories: (memories) => set({ autoMemories: memories }),
      addAutoMemory: (memory) => set((state) => ({ autoMemories: [...state.autoMemories, memory] })),
      updateAutoMemory: (id, updates) => set((state) => ({
        autoMemories: state.autoMemories.map((m) => (m.id === id ? { ...m, ...updates } : m)),
      })),
      removeAutoMemory: (id) => set((state) => ({
        autoMemories: state.autoMemories.filter((m) => m.id !== id),
      })),
      clearAutoMemories: () => set({ autoMemories: [] }),

      userProfiles: [],
      setUserProfiles: (profiles) => set({ userProfiles: profiles }),
      upsertUserProfile: (profile) => set((state) => ({
        userProfiles: state.userProfiles.some((p) => p.username === profile.username)
          ? state.userProfiles.map((p) => (p.username === profile.username ? profile : p))
          : [...state.userProfiles, profile],
      })),
      removeUserProfile: (username) => set((state) => ({
        userProfiles: state.userProfiles.filter((p) => p.username !== username),
      })),
      clearUserProfiles: () => set({ userProfiles: [] }),

      insideJokes: [],
      setInsideJokes: (jokes) => set({ insideJokes: jokes }),
      addInsideJoke: (joke) => set((state) => ({ insideJokes: [...state.insideJokes, joke] })),
      updateInsideJoke: (id, updates) => set((state) => ({
        insideJokes: state.insideJokes.map((j) => (j.id === id ? { ...j, ...updates } : j)),
      })),
      removeInsideJoke: (id) => set((state) => ({
        insideJokes: state.insideJokes.filter((j) => j.id !== id),
      })),
      clearInsideJokes: () => set({ insideJokes: [] }),

      personalityState: null,
      setPersonalityState: (state) => set({ personalityState: state }),

      autoMemoryConfig: {
        enabled: false,
        extractionIntervalMinutes: 10,
        maxMemories: 500,
        maxProfiles: 100,
        maxJokes: 50,
        decayHalfLifeDays: 30,
        jokeDecayHalfLifeDays: 14,
        minConfidenceToStore: 0.4,
        autoVerifyThreshold: 0.85,
        contextInjectionTokenBudget: 800,
        relationshipProgressionEnabled: true,
        personalityEvolutionEnabled: true,
        crossSessionPersistence: true,
      },
      updateAutoMemoryConfig: (updates) => set((state) => ({
        autoMemoryConfig: { ...state.autoMemoryConfig, ...updates },
      })),

      memoryPanelOpen: false,
      setMemoryPanelOpen: (open) => set({ memoryPanelOpen: open }),

      // ─── Analytics ───────────────────────────────────
      actionHistory: [],
      addActionHistoryEntry: (entry) =>
        set((state) => {
          const history = [...state.actionHistory, { ...entry, id: generateId() }];
          if (history.length > 200) history.splice(0, history.length - 200);
          return { actionHistory: history };
        }),
      clearActionHistory: () => set({ actionHistory: [] }),

      enhancedStats: {
        sessionStart: Date.now(),
        messagesReceived: 0,
        messagesSent: 0,
        forgeCount: 0,
        autoForgeActions: 0,
        manualActions: 0,
        followupActions: 0,
        silenceDecisions: 0,
        mentionsDetected: 0,
        spikesDetected: 0,
        providerFallbacks: 0,
        avgResponseTimeMs: 0,
        totalTokensUsed: 0,
        estimatedCost: 0,
        actionDistribution: {},
        peakChatVelocity: 0,
        uniqueChatters: 0,
      },
      updateEnhancedStats: (updates) =>
        set((state) => ({ enhancedStats: { ...state.enhancedStats, ...updates } })),
      incrementStat: (key, amount = 1) =>
        set((state) => {
          const stats = { ...state.enhancedStats };
          if (typeof stats[key] === "number") {
            (stats as any)[key] = (stats as any)[key] + amount;
          }
          return { enhancedStats: stats };
        }),
      resetEnhancedStats: () =>
        set({
          enhancedStats: {
            sessionStart: Date.now(),
            messagesReceived: 0,
            messagesSent: 0,
            forgeCount: 0,
            autoForgeActions: 0,
            manualActions: 0,
            followupActions: 0,
            silenceDecisions: 0,
            mentionsDetected: 0,
            spikesDetected: 0,
            providerFallbacks: 0,
            avgResponseTimeMs: 0,
            totalTokensUsed: 0,
            estimatedCost: 0,
            actionDistribution: {},
            peakChatVelocity: 0,
            uniqueChatters: 0,
          },
        }),

      rateLimitConfig: {
        maxActionsPerHour: 30,
        maxActionsPerTenMinutes: 8,
        minCooldownMs: 15_000,
      },
      updateRateLimitConfig: (updates) =>
        set((state) => ({ rateLimitConfig: { ...state.rateLimitConfig, ...updates } })),

      analyticsPanelOpen: false,
      setAnalyticsPanelOpen: (open) => set({ analyticsPanelOpen: open }),

      // ─── Sentiment Analysis ───────────────────────────────────
      sentimentHistory: [],
      addSentimentReading: (reading) =>
        set((state) => {
          const updated = [...state.sentimentHistory, reading];
          if (updated.length > 100) updated.splice(0, updated.length - 100);
          return { sentimentHistory: updated };
        }),
      sentimentSummary: null,
      updateSentimentSummary: (summary) => set({ sentimentSummary: summary }),

      // ─── Desktop Notifications ───────────────────────────────
      desktopNotificationsEnabled: false,
      setDesktopNotificationsEnabled: (enabled) => set({ desktopNotificationsEnabled: enabled }),

      // ─── Message Queue ────────────────────────────────────────
      messageQueueDepth: 0,
      setMessageQueueDepth: (depth) => set({ messageQueueDepth: depth }),

      // ─── Chat Search ──────────────────────────────────────────
      chatSearchQuery: "",
      setChatSearchQuery: (query) => set({ chatSearchQuery: query }),

      // ─── Chat Activity Heatmap ───────────────────────────────
      chatActivityBuckets: [],
      recordChatActivity: () =>
        set((state) => {
          const now = Date.now();
          const bucketMs = 60_000;
          const currentBucket = Math.floor(now / bucketMs) * bucketMs;
          const buckets = [...state.chatActivityBuckets];
          const last = buckets[buckets.length - 1];
          if (last && last.timestamp === currentBucket) {
            buckets[buckets.length - 1] = { ...last, count: last.count + 1 };
          } else {
            buckets.push({ timestamp: currentBucket, count: 1, autoForgeAction: false });
          }
          if (buckets.length > 60) buckets.splice(0, buckets.length - 60);
          return { chatActivityBuckets: buckets };
        }),
      markAutoForgeActionBucket: () =>
        set((state) => {
          const now = Date.now();
          const bucketMs = 60_000;
          const currentBucket = Math.floor(now / bucketMs) * bucketMs;
          const buckets = [...state.chatActivityBuckets];
          const last = buckets[buckets.length - 1];
          if (last && last.timestamp === currentBucket) {
            buckets[buckets.length - 1] = { ...last, autoForgeAction: true };
          }
          return { chatActivityBuckets: buckets };
        }),

      // ─── Smart Replies ───────────────────────────────────────
      smartReplies: [],
      setSmartReplies: (replies) => set({ smartReplies: replies }),
      smartRepliesLoading: false,
      setSmartRepliesLoading: (loading) => set({ smartRepliesLoading: loading }),
      smartRepliesEnabled: false,
      setSmartRepliesEnabled: (enabled) => set({ smartRepliesEnabled: enabled }),

      // ─── Chatter Leaderboard ─────────────────────────────────
      chatterStats: {},
      updateChatterStats: (username, sentiment, isMention, badges) =>
        set((state) => {
          const existing = state.chatterStats[username];
          const updated: ChatterStats = existing
            ? {
                ...existing,
                messageCount: existing.messageCount + 1,
                positiveCount: existing.positiveCount + (sentiment === "positive" || sentiment === "hype" || sentiment === "wholesome" ? 1 : 0),
                negativeCount: existing.negativeCount + (sentiment === "negative" || sentiment === "toxic" ? 1 : 0),
                mentionCount: existing.mentionCount + (isMention ? 1 : 0),
                lastActive: Date.now(),
                badges: badges || existing.badges,
              }
            : {
                username,
                messageCount: 1,
                positiveCount: sentiment === "positive" || sentiment === "hype" || sentiment === "wholesome" ? 1 : 0,
                negativeCount: sentiment === "negative" || sentiment === "toxic" ? 1 : 0,
                mentionCount: isMention ? 1 : 0,
                lastActive: Date.now(),
                badges: badges || [],
              };
          const now = Date.now();
          const pruned: Record<string, ChatterStats> = {};
          for (const [name, stats] of Object.entries(state.chatterStats)) {
            if (now - stats.lastActive < 30 * 60_000 || name === username) {
              pruned[name] = name === username ? updated : stats;
            }
          }
          return { chatterStats: pruned };
        }),
      clearChatterStats: () => set({ chatterStats: {} }),

      // ─── Decision Log ────────────────────────────────────────
      decisionLog: [],
      addDecisionLogEntry: (entry) => {
        const id = generateId();
        set((state) => {
          const log = [...state.decisionLog, { ...entry, id }];
          if (log.length > 200) log.splice(0, log.length - 200);
          return { decisionLog: log };
        });
        return id;
      },
      updateDecisionLogEntry: (id, updates) =>
        set((state) => ({
          decisionLog: state.decisionLog.map((e) => (e.id === id ? { ...e, ...updates } : e)),
        })),
      clearDecisionLog: () => set({ decisionLog: [] }),

      // ─── Persona Presets ───────────────────────────────────
      personaPresets: [
        { id: "chill-vibe", name: "Chill Vibe", icon: "Leaf", config: { primaryProfile: "Support", humorLevel: 30, chaosLevel: 15, emoteDensity: "minimal", lengthPreference: "short", effortLevel: "low" } },
        { id: "hype-gremlin", name: "Hype Gremlin", icon: "Flame", config: { primaryProfile: "Gremlin", humorLevel: 80, chaosLevel: 90, emoteDensity: "heavy", lengthPreference: "short", effortLevel: "medium" } },
        { id: "analyst", name: "Analyst", icon: "Brain", config: { primaryProfile: "Analyst", humorLevel: 40, chaosLevel: 20, emoteDensity: "minimal", lengthPreference: "long", effortLevel: "high" } },
        { id: "balanced", name: "Balanced", icon: "Scale", config: { primaryProfile: "none", humorLevel: 50, chaosLevel: 50, emoteDensity: "moderate", lengthPreference: "medium", effortLevel: "medium" } },
        { id: "chaos-mode", name: "Chaos Mode", icon: "Zap", config: { primaryProfile: "Gremlin", humorLevel: 70, chaosLevel: 100, emoteDensity: "heavy", lengthPreference: "short", effortLevel: "low" } },
        { id: "storyteller", name: "Storyteller", icon: "BookOpen", config: { primaryProfile: "Questioner", humorLevel: 60, chaosLevel: 30, emoteDensity: "minimal", lengthPreference: "long", effortLevel: "high" } },
      ],
      activePersonaId: null,
      applyPersonaPreset: (id) => {
        const preset = get().personaPresets.find((p) => p.id === id);
        if (preset) {
          set((state) => ({ config: { ...state.config, ...preset.config }, activePersonaId: id }));
        }
      },
      saveCustomPersonaPreset: (name, icon) => {
        const id = generateId();
        const currentConfig = get().config;
        const preset: PersonaPreset = {
          id,
          name,
          icon,
          custom: true,
          config: {
            primaryProfile: currentConfig.primaryProfile,
            humorLevel: currentConfig.humorLevel,
            chaosLevel: currentConfig.chaosLevel,
            emoteDensity: currentConfig.emoteDensity,
            lengthPreference: currentConfig.lengthPreference,
            toxicityFilter: currentConfig.toxicityFilter,
            effortLevel: currentConfig.effortLevel,
          },
        };
        set((state) => ({ personaPresets: [preset, ...state.personaPresets], activePersonaId: id }));
      },
      deleteCustomPersonaPreset: (id) =>
        set((state) => ({
          personaPresets: state.personaPresets.filter((p) => p.id !== id || !p.custom),
          activePersonaId: state.activePersonaId === id ? null : state.activePersonaId,
        })),

      // ─── Keyword Trigger Rules ─────────────────────────────
      keywordTriggerRules: [],
      addKeywordTriggerRule: (rule) =>
        set((state) => ({
          keywordTriggerRules: [...state.keywordTriggerRules, { ...rule, id: generateId(), matchCount: 0, lastTriggeredMs: null }],
        })),
      updateKeywordTriggerRule: (id, updates) =>
        set((state) => ({
          keywordTriggerRules: state.keywordTriggerRules.map((r) => (r.id === id ? { ...r, ...updates } : r)),
        })),
      removeKeywordTriggerRule: (id) =>
        set((state) => ({
          keywordTriggerRules: state.keywordTriggerRules.filter((r) => r.id !== id),
        })),
      clearKeywordTriggerRules: () => set({ keywordTriggerRules: [] }),
      incrementTriggerMatch: (id) =>
        set((state) => ({
          keywordTriggerRules: state.keywordTriggerRules.map((r) =>
            r.id === id ? { ...r, matchCount: r.matchCount + 1, lastTriggeredMs: Date.now() } : r
          ),
        })),

      // ─── Session Goals ─────────────────────────────────────
      sessionGoals: [],
      addSessionGoal: (goal) =>
        set((state) => ({ sessionGoals: [...state.sessionGoals, { ...goal, id: generateId() }] })),
      updateSessionGoal: (id, updates) =>
        set((state) => ({
          sessionGoals: state.sessionGoals.map((g) => (g.id === id ? { ...g, ...updates } : g)),
        })),
      removeSessionGoal: (id) =>
        set((state) => ({ sessionGoals: state.sessionGoals.filter((g) => g.id !== id) })),
      clearSessionGoals: () => set({ sessionGoals: [] }),

      goalEvaluationResults: [],
      setGoalEvaluationResults: (results) => set({ goalEvaluationResults: results }),

      // ─── AutoForge Advanced ───────────────────────────────
      autoForgeDryRun: false,
      setAutoForgeDryRun: (enabled) => set({ autoForgeDryRun: enabled }),
      autoForgeConfidenceThreshold: 0.5,
      setAutoForgeConfidenceThreshold: (threshold) => set({ autoForgeConfidenceThreshold: threshold }),

      // ─── Engagement & Stream Status ───────────────────────
      engagementScore: null,
      setEngagementScore: (score) => set({ engagementScore: score }),
      streamLikelyOffline: false,
      setStreamLikelyOffline: (offline) => set({ streamLikelyOffline: offline }),

      // ─── Tutorial Walkthrough ────────────────────────────────
      tutorialActive: false,
      setTutorialActive: (active) => set({ tutorialActive: active }),
      tutorialStep: 0,
      setTutorialStep: (step) => set({ tutorialStep: step }),

      exportSettings: () => {
        const state = get();
        const settings = {
          config: state.config,
          platform: state.platform,
          r34lEnabled: state.r34lEnabled,
          cosmotechTheme: state.cosmotechTheme,
          messageSoundEnabled: state.messageSoundEnabled,
          sfxEnabled: state.sfxEnabled,
          sfxVolume: state.sfxVolume,
          ttsEnabled: state.ttsEnabled,
          ttsProvider: state.ttsProvider,
          ttsVoice: state.ttsVoice,
          ttsRate: state.ttsRate,
          ttsVolume: state.ttsVolume,
          ttsAudioOutputDeviceId: state.ttsAudioOutputDeviceId,
          soundVolume: state.soundVolume,
          autoMemoryConfig: state.autoMemoryConfig,
          rateLimitConfig: state.rateLimitConfig,
          desktopNotificationsEnabled: state.desktopNotificationsEnabled,
          smartRepliesEnabled: state.smartRepliesEnabled,
          keywordTriggerRules: state.keywordTriggerRules,
          sessionGoals: state.sessionGoals,
          customPersonaPresets: state.personaPresets.filter((p) => p.custom),
          activePersonaId: state.activePersonaId,
          autoForgeDryRun: state.autoForgeDryRun,
          autoForgeConfidenceThreshold: state.autoForgeConfidenceThreshold,
          exportedAt: new Date().toISOString(),
          version: 7,
        };
        return JSON.stringify(settings, null, 2);
      },

      importSettings: (json: string) => {
        try {
          const data = JSON.parse(json);
          if (data.config) set((state) => ({ config: { ...state.config, ...data.config } }));
          if (data.platform) set({ platform: data.platform });
          if (data.r34lEnabled !== undefined) set({ r34lEnabled: data.r34lEnabled });
          if (data.cosmotechTheme !== undefined) set({ cosmotechTheme: data.cosmotechTheme });
          if (data.messageSoundEnabled !== undefined) set({ messageSoundEnabled: data.messageSoundEnabled });
          if (data.sfxEnabled !== undefined) set({ sfxEnabled: data.sfxEnabled });
          if (data.sfxVolume !== undefined) set({ sfxVolume: data.sfxVolume });
          if (data.ttsEnabled !== undefined) set({ ttsEnabled: data.ttsEnabled });
          if (data.ttsProvider) set({ ttsProvider: data.ttsProvider });
          if (data.ttsVoice !== undefined) set({ ttsVoice: data.ttsVoice });
          if (data.ttsRate !== undefined) set({ ttsRate: data.ttsRate });
          if (data.ttsVolume !== undefined) set({ ttsVolume: data.ttsVolume });
          if (data.elevenlabsApiKey !== undefined) set({ elevenlabsApiKey: data.elevenlabsApiKey });
          if (data.ttsAudioOutputDeviceId !== undefined) set({ ttsAudioOutputDeviceId: data.ttsAudioOutputDeviceId });
          if (data.soundVolume !== undefined) set({ soundVolume: data.soundVolume });
          if (data.autoMemoryConfig) set((state) => ({ autoMemoryConfig: { ...state.autoMemoryConfig, ...data.autoMemoryConfig } }));
          if (data.rateLimitConfig) set((state) => ({ rateLimitConfig: { ...state.rateLimitConfig, ...data.rateLimitConfig } }));
          if (data.desktopNotificationsEnabled !== undefined) set({ desktopNotificationsEnabled: data.desktopNotificationsEnabled });
          if (data.smartRepliesEnabled !== undefined) set({ smartRepliesEnabled: data.smartRepliesEnabled });
          if (data.keywordTriggerRules) set({ keywordTriggerRules: data.keywordTriggerRules });
          if (data.sessionGoals) set({ sessionGoals: data.sessionGoals });
          if (data.customPersonaPresets) set((state) => ({ personaPresets: [...data.customPersonaPresets, ...state.personaPresets] }));
          if (data.activePersonaId !== undefined) set({ activePersonaId: data.activePersonaId });
          if (data.autoForgeDryRun !== undefined) set({ autoForgeDryRun: data.autoForgeDryRun });
          if (data.autoForgeConfidenceThreshold !== undefined) set({ autoForgeConfidenceThreshold: data.autoForgeConfidenceThreshold });
          return true;
        } catch {
          return false;
        }
      },
      }),
    {
      name: "madchatter-storage",
      partialize: (state) => ({
        streamMetadata: { channelName: state.streamMetadata.channelName, title: state.streamMetadata.title, category: state.streamMetadata.category, viewerCount: state.streamMetadata.viewerCount },
        platform: state.platform,
        config: state.config,
        longTermMemory: state.longTermMemory,
        pinnedMemories: state.pinnedMemories,
        goldenMemoryId: state.goldenMemoryId,
        r34lEnabled: state.r34lEnabled,
        autoForgeEventLog: state.autoForgeEventLog,
        cosmotechTheme: state.cosmotechTheme,
        messageSoundEnabled: state.messageSoundEnabled,
        audioOutputDeviceId: state.audioOutputDeviceId,
        customSoundUrl: state.customSoundUrl,
        soundVolume: state.soundVolume,
        sfxEnabled: state.sfxEnabled,
        sfxVolume: state.sfxVolume,
        ttsEnabled: state.ttsEnabled,
        ttsProvider: state.ttsProvider,
        ttsVoice: state.ttsVoice,
        ttsRate: state.ttsRate,
        ttsVolume: state.ttsVolume,
        elevenlabsApiKey: state.elevenlabsApiKey,
        ttsAudioOutputDeviceId: state.ttsAudioOutputDeviceId,
        autoMemoryConfig: state.autoMemoryConfig,
        rateLimitConfig: state.rateLimitConfig,
        desktopNotificationsEnabled: state.desktopNotificationsEnabled,
        smartRepliesEnabled: state.smartRepliesEnabled,
        keywordTriggerRules: state.keywordTriggerRules,
        sessionGoals: state.sessionGoals,
        personaPresets: state.personaPresets,
        activePersonaId: state.activePersonaId,
        autoForgeDryRun: state.autoForgeDryRun,
        autoForgeConfidenceThreshold: state.autoForgeConfidenceThreshold,
      }),
      version: 7,
      migrate: (persistedState: any, version: number) => {
        // v1 -> v2: chatLog changed from string[] to ChatMessage[]
        // chatLog is not persisted (not in partialize) so no data migration needed
        // but we ensure autoMemoryConfig exists with defaults if upgrading
        if (version < 2 && persistedState) {
          if (!persistedState.autoMemoryConfig) {
            persistedState.autoMemoryConfig = {
              enabled: false,
              extractionIntervalMinutes: 10,
              maxMemories: 500,
              maxProfiles: 100,
              maxJokes: 50,
              decayHalfLifeDays: 30,
              jokeDecayHalfLifeDays: 14,
              minConfidenceToStore: 0.4,
              autoVerifyThreshold: 0.85,
              contextInjectionTokenBudget: 800,
              relationshipProgressionEnabled: true,
              personalityEvolutionEnabled: true,
              crossSessionPersistence: true,
            };
          }
        }
        if (version < 3 && persistedState) {
          if (!persistedState.rateLimitConfig) {
            persistedState.rateLimitConfig = {
              maxActionsPerHour: 30,
              maxActionsPerTenMinutes: 8,
              minCooldownMs: 15_000,
            };
          }
        }
        if (version < 4 && persistedState) {
          if (persistedState.desktopNotificationsEnabled === undefined) {
            persistedState.desktopNotificationsEnabled = false;
          }
        }
        if (version < 5 && persistedState) {
          if (persistedState.smartRepliesEnabled === undefined) {
            persistedState.smartRepliesEnabled = false;
          }
        }
        if (version < 6 && persistedState) {
          if (!persistedState.keywordTriggerRules) persistedState.keywordTriggerRules = [];
          if (!persistedState.sessionGoals) persistedState.sessionGoals = [];
          if (persistedState.activePersonaId === undefined) persistedState.activePersonaId = null;
        }
        if (version < 7 && persistedState) {
          if (persistedState.autoForgeDryRun === undefined) persistedState.autoForgeDryRun = false;
          if (persistedState.autoForgeConfidenceThreshold === undefined) persistedState.autoForgeConfidenceThreshold = 0.5;
        }
        return persistedState;
      },
    }
  )
);
