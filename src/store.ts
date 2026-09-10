import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ForgeSuggestion, ForgeConfig, PinnedMemory, AutoForgeEvent, SentMessage, SessionStats, ChatMessage, AutoMemory, UserProfile, InsideJoke, PersonalityState, AutoMemoryConfig, ActionHistoryEntry, EnhancedSessionStats, AutoForgeRateLimitConfig, SentimentReading, SentimentSummary, QueuedMessage, ChatActivityBucket, SmartReply, ChatterStats, DecisionLogEntry, PersonaPreset, KeywordTriggerRule, SessionGoal, GoalEvaluationResult, EngagementBreakdown, ForgeTemplate, AutoForgeSequence, PerActionRateLimitConfig, StreamHealthScore, ActionAccuracyEntry, AutoForgeRule, Bot, BotIdentity, BotPersona, BotRuntime, BotSessionPayload, BotPlatform, VisualSnapshotHistoryEntry } from "./types";
import type { Platform } from "./lib/kick";
import { generateId } from "./lib/ids";
import { getFallbackHistory } from "./lib/providerFallback";
import type { AutoForgeDecision } from "./lib/ai";

/** Single source of truth for settings schema version — used by both persist and exportSettings */
const SETTINGS_VERSION = 12;

// ─── Multi-Bot factories (additive; legacy global fields remain) ────────────
// These mirror the existing global single-bot defaults so each bot carries an
// independent brain. Used only when multiBotEnabled === true.

/**
 * Read the legacy single-bot session from its localStorage key and convert it
 * to a BotSessionPayload. Used by enableMultiBot() to seed bots[0].session so
 * the primary bot shows as authenticated without a second OAuth round-trip.
 *
 * Reads localStorage directly (rather than importing twitch.ts/kick.ts) to
 * avoid a runtime circular import: twitch.ts and kick.ts both import this
 * store for their per-bot session accessors.
 */
function readLegacySession(platform: BotPlatform): BotSessionPayload | null {
  try {
    const key = platform === "kick" ? "kick_session" : platform === "joystick" ? "joystick_session" : "twitch_session";
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.accessToken && parsed.username) {
      return {
        accessToken: parsed.accessToken,
        username: parsed.username,
        userId: String(parsed.userId ?? ""),
        profileImageUrl: parsed.profileImageUrl,
        expiresAt: parsed.expiresAt,
        refreshToken: parsed.refreshToken,
      };
    }
  } catch {}
  return null;
}

/**
 * Multi-bot is only "active" (per-bot AutoForge loops + coordinator take over,
 * legacy loop stands down) when the toggle is ON and at least TWO bots are
 * authenticated. With 0–1 authed bots the app stays on the original single-bot
 * pipeline even if the toggle is on, so there's no dead zone where nothing runs.
 */
export function selectMultiBotActive(state: AppState): boolean {
  return state.multiBotEnabled && state.bots.filter((b) => b.active && b.session).length >= 2;
}

function createDefaultBotPersona(): BotPersona {
  return {
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
    botIdentityMode: "admit",
    botIdentityStory: "",
    activePersonaId: null,
  };
}

// ─── Primary bot persona (index 0) ─────────────────────────────────────────
// The primary bot always gets "The Regular" identity — a well-rounded,
// natural presence that works in any channel. Unlike the specialist bots
// (1–9), it's not defined by one trait. Config sliders (humor, chaos, etc.)
// are preserved from the user's global single-bot settings; only the identity
// story and directives are set here.
const PRIMARY_BOT_PERSONA: DefaultBotPersona = {
  customDirectives:
    "- React like a real viewer would — if nothing's happening, quiet is fine. Don't manufacture takes.\n- Vary your style: a quick reaction, a question, a joke, a read on the game state. Don't fall into a pattern.",
  botIdentityStory:
    "You're a regular in this stream — the kind who shows up most days, knows the running bits, and genuinely enjoys being here. You're not trying to be the loudest, the funniest, or the smartest in chat. You just react naturally to what's happening, ask a question when you're curious, and crack a joke when the moment calls for it. You feel like a real person, not a character.",
};

// ─── Default per-bot personas (bots 1–9) ───────────────────────────────────
// When a new bot slot is added, it gets a distinct default system directive
// (two bullet points) and a custom persona story (2–3 sentences) so the bots
// feel different but not weird. The primary bot (index 0) is seeded from the
// user's existing global single-bot persona in enableMultiBot(), so it is not
// overwritten here. Index = the bot's position in the bots array.
interface DefaultBotPersona {
  customDirectives: string;
  botIdentityStory: string;
}

const DEFAULT_BOT_PERSONAS: DefaultBotPersona[] = [
  {
    customDirectives:
      "- Lead with energy: react to big moments first, then add a short take.\n- Keep messages punchy; exclamation marks are fine but don't spam them.",
    botIdentityStory:
      "You're the resident hype engine of the chat — the first to lose your mind when something clutch happens. You genuinely love the game and root for the streamer. You're not loud for the sake of it; you're loud because you actually care.",
  },
  {
    customDirectives:
      "- Offer the why behind a play, not just the what — one observation per message.\n- Stay cool and matter-of-fact; let others do the screaming.",
    botIdentityStory:
      "You're the calm analyst who watches the macro and explains what just happened in plain terms. You don't get rattled by chaos — you break it down. You'd rather be right than loud.",
  },
  {
    customDirectives:
      "- Poke fun at mistakes and unlucky beats, but never mean — keep it playful.\n- Lean into chaos and bad takes; a little nonsense is welcome.",
    botIdentityStory:
      "You're the chat gremlin — here to meme, tease, and stir the pot when things get too serious. You're not trying to hurt anyone's feelings; you just enjoy a bit of chaos. You laugh at the streamer's pain more than their success.",
  },
  {
    customDirectives:
      "- Reference how things used to be done, framed as nostalgia rather than a lecture.\n- Keep a measured, been-around-the-block tone; fewer messages, more weight.",
    botIdentityStory:
      "You've been around long enough to remember when this was harder. You appreciate good fundamentals and quietly roll your eyes at flashy plays that lack substance. You're not grumpy — you've just seen it all before.",
  },
  {
    customDirectives:
      "- Suggest one concrete improvement at a time, framed as a friendly nudge, not a command.\n- Celebrate good decisions as loudly as you critique bad ones.",
    botIdentityStory:
      "You're the supportive backseat coach who wants the streamer to get better without making them feel bad. You spot the small things — positioning, timing, economy — and gently point them out. You cheer the good calls harder than you groan at the bad ones.",
  },
  {
    customDirectives:
      "- Match the room's tempo but stay a beat slower — don't escalate the hype.\n- One laid-back reaction per moment; brevity over volume.",
    botIdentityStory:
      "You're the chill presence who's just here for a good time. Nothing really rattles you, and you're fine with long stretches of quiet. When you do talk, it's usually to bring the vibe back down to earth.",
  },
  {
    customDirectives:
      "- Question the popular take once in a while — argue the other side fairly.\n- Only push back when you actually see another angle; never contrarian for its own sake.",
    botIdentityStory:
      "You're the one who isn't afraid to disagree with chat when everyone's piling on. You're not trying to be edgy — you just notice when the consensus is sloppy. You'll concede a good point faster than you'll back down from a bad one.",
  },
  {
    customDirectives:
      "- Reference past sessions and running jokes when they fit, but don't force callbacks.\n- Keep a light storyteller's tone; connect today's moment to the bigger arc.",
    botIdentityStory:
      "You're the chat lorekeeper — the one who remembers the running bits, the bad calls, and the arc of the streamer's improvement. You weave that history into the moment when it lands. You're not reciting trivia; you're keeping the story alive.",
  },
  {
    customDirectives:
      "- Hype the moment, then immediately offer the honest caveat.\n- Balance praise and critique in the same breath; no pure glaze, no pure doom.",
    botIdentityStory:
      "You're the hype-critic — you can scream about a clutch play and then immediately note what was sloppy about it. You hold both the excitement and the critique at once. You're the friend who cheers and keeps it real in the same sentence.",
  },
];

/** Returns the default directive + persona story for a bot at the given array
 * index (clamped to 0–8). Used by addBot() so newly added bots get a distinct,
 * not-too-weird starting personality. */
function getDefaultBotPersonaForIndex(index: number): DefaultBotPersona {
  const clamped = Math.max(0, Math.min(index, DEFAULT_BOT_PERSONAS.length - 1));
  return DEFAULT_BOT_PERSONAS[clamped];
}

function createDefaultBotRuntime(): BotRuntime {
  return {
    longTermMemory: "",
    pinnedMemories: [],
    goldenMemoryId: null,
    autoMemories: [],
    userProfiles: [],
    insideJokes: [],
    personalityState: null,
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
    sentMessages: [],
    actionHistory: [],
    decisionLog: [],
    sessionStats: { sessionStart: Date.now(), messagesReceived: 0, messagesSent: 0, forgeCount: 0 },
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
    sentimentHistory: [],
    sentimentSummary: null,
    actionAccuracy: [],
    autoForgeEvents: [],
    lastAutoForgeDecision: null,
    autoForgeLastActionMs: null,
    autoForgeNextActionMs: 0,
    autoForgeFollowup: null,
    isAutoForgeThinking: false,
    smartReplies: [],
  };
}

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
  setVisualSnapshot: (url: string | null, tags: string[], source?: "manual" | "auto", delta?: number, skipHistory?: boolean) => void;
  visualSnapshotHistory: VisualSnapshotHistoryEntry[];
  visualHistoryOpen: boolean;
  setVisualHistoryOpen: (open: boolean) => void;
  clearVisualSnapshotHistory: () => void;
  
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
  
  // ─── Manual send / typing awareness (A8) ──────────────────
  lastManualSendMs: number;
  setLastManualSendMs: (ms: number) => void;
  lastUserChatTypingMs: number;
  setLastUserChatTypingMs: (ms: number) => void;
  
  isForging: boolean;
  setIsForging: (isForging: boolean) => void;
  
  variants: ForgeSuggestion[];
  setVariants: (variants: ForgeSuggestion[]) => void;
  updateVariant: (id: number, updates: Partial<ForgeSuggestion>) => void;
  
  audioTranscript: string;
  setAudioTranscript: (transcript: string) => void;
  appendAudioTranscript: (line: string) => void;
  // C4: Audio energy awareness
  audioEnergy: { rms: number; peak: number; label: "silent" | "quiet" | "normal" | "loud" | "spike"; updatedAt: number } | null;
  setAudioEnergy: (energy: { rms: number; peak: number; label: "silent" | "quiet" | "normal" | "loud" | "spike"; updatedAt: number } | null) => void;
  // C2: Stream events
  streamEvents: string[];
  addStreamEvent: (event: string) => void;
  clearStreamEvents: () => void;
  chatLog: ChatMessage[];
  appendChatLog: (msg: ChatMessage) => void;
  appendChatLogBatch: (msgs: ChatMessage[]) => void;
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
  // One-time onboarding flag: hides the "Forge First Batch" CTA after the
  // user has forged at least once. Persisted so it survives reloads.
  hasForgedOnce: boolean;
  setHasForgedOnce: (v: boolean) => void;

  tmiReadState: "disconnected" | "connecting" | "connected" | "error";
  setTmiReadState: (state: AppState["tmiReadState"]) => void;
  tmiSendState: "disconnected" | "connecting" | "connected" | "error";
  setTmiSendState: (state: AppState["tmiSendState"]) => void;

  theme: "default" | "cosmotech" | "corrupture";
  setTheme: (theme: "default" | "cosmotech" | "corrupture") => void;
  /** @deprecated backward compat — use theme/setTheme */
  cosmotechTheme: boolean;
  /** @deprecated backward compat — use setTheme */
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

  // ─── Emote Providers (C6) ───────────────────────────────
  emoteProviders: { sevenTV: boolean; ffz: boolean; bttv: boolean };
  setEmoteProviders: (providers: { sevenTV: boolean; ffz: boolean; bttv: boolean }) => void;
  emoteAwarenessEnabled: boolean;
  setEmoteAwarenessEnabled: (enabled: boolean) => void;

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

  // ─── Bot Identity (B8) ───────────────────────────────────
  botIdentityMode: "admit" | "custom";
  setBotIdentityMode: (mode: "admit" | "custom") => void;
  botIdentityStory: string;
  setBotIdentityStory: (story: string) => void;

  // ─── Creative Tools (E1/E4) ───────────────────────────
  forgeTemplates: ForgeTemplate[];
  addForgeTemplate: (template: Omit<ForgeTemplate, "id" | "createdAt">) => void;
  removeForgeTemplate: (id: string) => void;
  applyForgeTemplate: (id: string) => void;
  moodLock: { locked: boolean; mood: string | null };
  setMoodLock: (locked: boolean, mood: string | null) => void;
  // E3: Variant history
  variantHistory: { id: string; message: string; timestamp: number; source: string; rating?: "good" | "bad" | null }[];
  addVariantHistoryEntry: (entry: { message: string; source: string; rating?: "good" | "bad" | null }) => void;
  rateVariantHistory: (id: string, rating: "good" | "bad") => void;
  clearVariantHistory: () => void;
  // E5: Reaction sequences
  reactionSequences: { id: string; name: string; reactions: string[]; createdAt: number }[];
  addReactionSequence: (seq: Omit<{ id: string; name: string; reactions: string[]; createdAt: number }, "id" | "createdAt">) => void;
  removeReactionSequence: (id: string) => void;

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
  updateActionHistoryEntry: (id: string, updates: Partial<ActionHistoryEntry>) => void;
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
  // D3: Provider fallback history (in-memory only, not persisted)
  providerFallbackHistory: { timestamp: number; fromProvider: string; toProvider: string; reason: string }[];
  refreshProviderFallbackHistory: () => void;

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

  // ─── Stream Health Score (A10) ───────────────────────────────
  streamHealth: StreamHealthScore | null;
  setStreamHealth: (score: StreamHealthScore | null) => void;

  // ─── AutoForge Sequences (C3) ────────────────────────────────
  autoForgeSequences: AutoForgeSequence[];
  addAutoForgeSequence: (seq: Omit<AutoForgeSequence, "id" | "createdAt">) => void;
  removeAutoForgeSequence: (id: string) => void;
  updateAutoForgeSequence: (id: string, updates: Partial<AutoForgeSequence>) => void;
  duplicateAutoForgeSequence: (id: string) => void;

  // ─── AutoForge Rule Engine (C1) ──────────────────────────────
  autoForgeRules: AutoForgeRule[];
  addAutoForgeRule: (rule: Omit<AutoForgeRule, "id" | "createdAt" | "lastFiredMs" | "fireCount">) => void;
  removeAutoForgeRule: (id: string) => void;
  updateAutoForgeRule: (id: string, updates: Partial<AutoForgeRule>) => void;
  duplicateAutoForgeRule: (id: string) => void;
  clearRuleFireCounts: () => void;

  // ─── Per-Action Rate Limits (C5) ─────────────────────────────
  perActionRateLimits: PerActionRateLimitConfig;
  setPerActionRateLimits: (limits: PerActionRateLimitConfig) => void;

  // ─── AutoForge Accuracy Metrics (A9) ─────────────────────────
  actionAccuracy: ActionAccuracyEntry[];
  recordActionEngagement: (actionType: string, engagementLabel: "ignored" | "low" | "moderate" | "high") => void;
  clearActionAccuracy: () => void;

  // ─── Bot Thinking State (B5) ────────────────────────────────
  isAutoForgeThinking: boolean;
  setIsAutoForgeThinking: (thinking: boolean) => void;

  // ─── Hype Mode State (B12) ───────────────────────────────────
  hypeLevel: number;
  setHypeLevel: (level: number) => void;

  // ─── Tutorial Walkthrough ────────────────────────────────
  tutorialActive: boolean;
  setTutorialActive: (active: boolean) => void;
  tutorialStep: number;
  setTutorialStep: (step: number) => void;

  // ─── Multi-Bot Mode (toggle-gated, additive) ────────────────
  // When false (default), the app runs the original single-bot flow unchanged.
  // When true, per-bot loops + BotCoordinator take over and the legacy
  // useAutoForge() short-circuits. The legacy global fields are never removed.
  multiBotEnabled: boolean;
  setMultiBotEnabled: (enabled: boolean) => void;
  enableMultiBot: () => void;
  disableMultiBot: () => void;
  bots: Bot[];
  activeBotId: string | null;
  // Which bot identity manual/Forge sends go out as (multi-bot mode only).
  // Lifted to the store so the picker (header) and the send path (TheForge) share it.
  manualSendBotId: string | null;
  setManualSendBotId: (id: string | null) => void;
  setActiveBotId: (id: string | null) => void;
  addBot: (bot: Omit<BotIdentity, "id" | "createdAt"> & { session?: BotSessionPayload | null }) => string;
  removeBot: (id: string) => void;
  updateBotPersona: (id: string, updates: Partial<BotPersona>) => void;
  updateBotRuntime: (id: string, updates: Partial<BotRuntime>) => void;
  setBotSession: (id: string, session: BotSessionPayload | null) => void;
  toggleBotActive: (id: string) => void;
  getBot: (id: string) => Bot | undefined;
  // Bot-scoped action twins (additive; only used when multiBotEnabled === true).
  // Each dispatches into bots[i].runtime. Legacy global actions remain untouched.
  addBotSentMessage: (id: string, msg: Omit<SentMessage, "id">) => void;
  addBotAutoForgeEvent: (id: string, event: Omit<AutoForgeEvent, "id">) => void;
  addBotDecisionLogEntry: (id: string, entry: Omit<DecisionLogEntry, "id">) => string;
  updateBotDecisionLogEntry: (id: string, entryId: string, updates: Partial<DecisionLogEntry>) => void;
  addBotSentimentReading: (id: string, reading: SentimentReading) => void;
  setBotLastAutoForgeDecision: (id: string, decision: AutoForgeDecision | null) => void;
  setBotAutoForgeLastActionMs: (id: string, ms: number | null) => void;
  setBotAutoForgeNextActionMs: (id: string, ms: number) => void;
  setBotIsAutoForgeThinking: (id: string, thinking: boolean) => void;
  incrementBotStat: (id: string, key: keyof EnhancedSessionStats, amount?: number) => void;
  addBotActionHistoryEntry: (id: string, entry: Omit<ActionHistoryEntry, "id">) => void;
  updateBotEnhancedStats: (id: string, updates: Partial<EnhancedSessionStats>) => void;

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
      visualSnapshotHistory: [],
      visualHistoryOpen: false,
      setVisualHistoryOpen: (open) => set({ visualHistoryOpen: open }),
      clearVisualSnapshotHistory: () => set({ visualSnapshotHistory: [] }),
      setVisualSnapshot: (url, tags, source = "auto", delta, skipHistory = false) => {
        if (!url) {
          set({ visualSnapshotUrl: null, visualContextTags: tags });
          return;
        }
        set((state) => {
          const base = {
            visualSnapshotUrl: url,
            visualContextTags: tags,
          };
          if (skipHistory) return base;
          const entry: VisualSnapshotHistoryEntry = {
            id: generateId(),
            url,
            tags: tags.length > 0 ? tags : ["Captured"],
            timestamp: Date.now(),
            source,
            delta,
          };
          return {
            ...base,
            visualSnapshotHistory: [...state.visualSnapshotHistory, entry].slice(-30),
          };
        });
      },

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

      // ─── Manual send / typing awareness (A8) ──────────────────
      lastManualSendMs: 0,
      setLastManualSendMs: (ms) => set({ lastManualSendMs: ms }),
      lastUserChatTypingMs: 0,
      setLastUserChatTypingMs: (ms) => set({ lastUserChatTypingMs: ms }),

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
      audioEnergy: null,
      setAudioEnergy: (energy) => set({ audioEnergy: energy }),
      streamEvents: [],
      addStreamEvent: (event) => set((state) => ({
        streamEvents: [...state.streamEvents, event].slice(-20),
      })),
      clearStreamEvents: () => set({ streamEvents: [] }),
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
          if (newLog.length > 150) newLog.splice(0, newLog.length - 150);
          return { chatLog: newLog };
        }),
      appendChatLogBatch: (msgs) =>
        set((state) => {
          if (msgs.length === 0) return {};
          const newLog = [...state.chatLog, ...msgs];
          if (newLog.length > 150) newLog.splice(0, newLog.length - 150);
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
          visualSnapshotHistory: [],
          longTermMemory: "",
          pinnedMemories: [],
          goldenMemoryId: null,
          lastTokenUsage: null,
        }),

      lastTokenUsage: null,
      setLastTokenUsage: (usage) =>
        set((state) => {
          if (!usage) return { lastTokenUsage: usage };
          // Accumulate into enhanced stats for the Analytics Dashboard.
          const totalTokens = usage.total_tokens || (usage.prompt_tokens + usage.completion_tokens);
          // Rough cost estimate: $0.075/1M input + $0.30/1M output (Gemini Flash tier).
          const cost = (usage.prompt_tokens / 1_000_000) * 0.075 + (usage.completion_tokens / 1_000_000) * 0.30;
          return {
            lastTokenUsage: usage,
            enhancedStats: {
              ...state.enhancedStats,
              totalTokensUsed: state.enhancedStats.totalTokensUsed + totalTokens,
              estimatedCost: state.enhancedStats.estimatedCost + cost,
            },
          };
        }),

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
        set((state) => ({
          sessionStats: { ...state.sessionStats, messagesReceived: state.sessionStats.messagesReceived + 1 },
          enhancedStats: { ...state.enhancedStats, messagesReceived: state.enhancedStats.messagesReceived + 1 },
        })),
      incrementMessagesSent: () =>
        set((state) => ({
          sessionStats: { ...state.sessionStats, messagesSent: state.sessionStats.messagesSent + 1 },
          enhancedStats: { ...state.enhancedStats, messagesSent: state.enhancedStats.messagesSent + 1 },
        })),
      incrementForgeCount: () =>
        set((state) => ({
          sessionStats: { ...state.sessionStats, forgeCount: state.sessionStats.forgeCount + 1 },
          enhancedStats: { ...state.enhancedStats, forgeCount: state.enhancedStats.forgeCount + 1 },
        })),
      resetSessionStats: () =>
        set({ sessionStats: { sessionStart: Date.now(), messagesReceived: 0, messagesSent: 0, forgeCount: 0 } }),

      hasForgedOnce: false,
      setHasForgedOnce: (v) => set({ hasForgedOnce: v }),

      tmiReadState: "disconnected",
      setTmiReadState: (state) => set({ tmiReadState: state }),
      tmiSendState: "disconnected",
      setTmiSendState: (state) => set({ tmiSendState: state }),

      theme: "default",
      setTheme: (theme) => set({ theme, cosmotechTheme: theme === "cosmotech" }),
      cosmotechTheme: false,
      setCosmotechTheme: (enabled) => set({ cosmotechTheme: enabled, theme: enabled ? "cosmotech" : "default" }),

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

      // ─── Emote Providers (C6) ───────────────────────────────
      emoteProviders: { sevenTV: true, ffz: true, bttv: true },
      setEmoteProviders: (providers) => set({ emoteProviders: providers }),
      emoteAwarenessEnabled: true,
      setEmoteAwarenessEnabled: (enabled) => set({ emoteAwarenessEnabled: enabled }),

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

      // ─── Bot Identity (B8) ───────────────────────────────────
      botIdentityMode: "admit",
      setBotIdentityMode: (mode) => set({ botIdentityMode: mode }),
      botIdentityStory: "",
      setBotIdentityStory: (story) => set({ botIdentityStory: story }),

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
      updateActionHistoryEntry: (id, updates) =>
        set((state) => ({
          actionHistory: state.actionHistory.map(e => e.id === id ? { ...e, ...updates } : e),
        })),
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
          return {
            chatterStats: pruned,
            enhancedStats: { ...state.enhancedStats, uniqueChatters: Object.keys(pruned).length },
          };
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

      // ─── Creative Tools (E1/E4) ─────────────────────────────
      forgeTemplates: [],
      addForgeTemplate: (template) =>
        set((state) => ({
          forgeTemplates: [...state.forgeTemplates, { ...template, id: generateId(), createdAt: Date.now() }],
        })),
      removeForgeTemplate: (id) =>
        set((state) => ({ forgeTemplates: state.forgeTemplates.filter((t) => t.id !== id) })),
      applyForgeTemplate: (id) => {
        const template = get().forgeTemplates.find((t) => t.id === id);
        if (template) {
          set((state) => ({
            config: {
              ...state.config,
              customDirectives: template.directives,
              humorLevel: template.humorLevel,
              chaosLevel: template.chaosLevel,
              emoteDensity: template.emoteDensity,
              lengthPreference: template.lengthPreference,
            },
          }));
        }
      },
      moodLock: { locked: false, mood: null },
      setMoodLock: (locked, mood) => set({ moodLock: { locked, mood } }),
      // E3: Variant history
      variantHistory: [],
      addVariantHistoryEntry: (entry) =>
        set((state) => {
          const history = [...state.variantHistory, { ...entry, id: generateId(), timestamp: Date.now() }];
          if (history.length > 100) history.splice(0, history.length - 100);
          return { variantHistory: history };
        }),
      rateVariantHistory: (id, rating) =>
        set((state) => ({
          variantHistory: state.variantHistory.map(v => v.id === id ? { ...v, rating } : v),
        })),
      clearVariantHistory: () => set({ variantHistory: [] }),
      // E5: Reaction sequences
      reactionSequences: [],
      addReactionSequence: (seq) =>
        set((state) => ({
          reactionSequences: [...state.reactionSequences, { ...seq, id: generateId(), createdAt: Date.now() }],
        })),
      removeReactionSequence: (id) =>
        set((state) => ({ reactionSequences: state.reactionSequences.filter(s => s.id !== id) })),

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
      providerFallbackHistory: [],
      refreshProviderFallbackHistory: () => {
        set({ providerFallbackHistory: getFallbackHistory() });
      },

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

      // ─── Stream Health Score (A10) ───────────────────────────
      streamHealth: null,
      setStreamHealth: (score) => set({ streamHealth: score }),

      // ─── AutoForge Sequences (C3) ────────────────────────────
      autoForgeSequences: [],
      addAutoForgeSequence: (seq) =>
        set((state) => ({
          autoForgeSequences: [...state.autoForgeSequences, { ...seq, id: generateId(), createdAt: Date.now() }],
        })),
      removeAutoForgeSequence: (id) =>
        set((state) => ({ autoForgeSequences: state.autoForgeSequences.filter((s) => s.id !== id) })),
      updateAutoForgeSequence: (id, updates) =>
        set((state) => ({
          autoForgeSequences: state.autoForgeSequences.map((s) => (s.id === id ? { ...s, ...updates } : s)),
        })),
      duplicateAutoForgeSequence: (id) =>
        set((state) => {
          const orig = state.autoForgeSequences.find((s) => s.id === id);
          if (!orig) return {};
          return {
            autoForgeSequences: [...state.autoForgeSequences, {
              ...orig,
              id: generateId(),
              name: `${orig.name} (copy)`,
              createdAt: Date.now(),
              steps: orig.steps.map((step) => ({ ...step, id: generateId() })),
            }],
          };
        }),

      // ─── AutoForge Rule Engine (C1) ──────────────────────────
      autoForgeRules: [],
      addAutoForgeRule: (rule) =>
        set((state) => ({
          autoForgeRules: [...state.autoForgeRules, {
            ...rule,
            id: generateId(),
            createdAt: Date.now(),
            lastFiredMs: 0,
            fireCount: 0,
          }],
        })),
      removeAutoForgeRule: (id) =>
        set((state) => ({ autoForgeRules: state.autoForgeRules.filter((r) => r.id !== id) })),
      updateAutoForgeRule: (id, updates) =>
        set((state) => ({
          autoForgeRules: state.autoForgeRules.map((r) => (r.id === id ? { ...r, ...updates } : r)),
        })),
      duplicateAutoForgeRule: (id) =>
        set((state) => {
          const orig = state.autoForgeRules.find((r) => r.id === id);
          if (!orig) return {};
          return {
            autoForgeRules: [...state.autoForgeRules, {
              ...orig,
              id: generateId(),
              name: `${orig.name} (copy)`,
              createdAt: Date.now(),
              lastFiredMs: 0,
              fireCount: 0,
              conditions: orig.conditions.map((c) => ({ ...c, id: generateId() })),
              actions: orig.actions.map((a) => ({ ...a, id: generateId() })),
            }],
          };
        }),
      clearRuleFireCounts: () =>
        set((state) => ({
          autoForgeRules: state.autoForgeRules.map((r) => ({ ...r, fireCount: 0, lastFiredMs: 0 })),
        })),

      // ─── Per-Action Rate Limits (C5) ────────────────────────
      perActionRateLimits: {
        full_forge: { maxPerHour: 10, maxPerTenMinutes: 3, cooldownMs: 30_000 },
        short_reaction: { maxPerHour: 20, maxPerTenMinutes: 6, cooldownMs: 15_000 },
        emote_only: { maxPerHour: 30, maxPerTenMinutes: 8, cooldownMs: 10_000 },
        quick_followup: { maxPerHour: 15, maxPerTenMinutes: 4, cooldownMs: 20_000 },
      },
      setPerActionRateLimits: (limits) => set({ perActionRateLimits: limits }),

      // ─── AutoForge Accuracy Metrics (A9) ────────────────────
      actionAccuracy: [],
      recordActionEngagement: (actionType, engagementLabel) =>
        set((state) => {
          const existing = state.actionAccuracy.find((e) => e.actionType === actionType);
          if (existing) {
            const updated = state.actionAccuracy.map((e) => {
              if (e.actionType !== actionType) return e;
              const total = e.total + 1;
              const engaged = e.engaged + (engagementLabel !== "ignored" ? 1 : 0);
              const ignored = e.ignored + (engagementLabel === "ignored" ? 1 : 0);
              return { ...e, total, engaged, ignored, accuracyPct: Math.round((engaged / total) * 100) };
            });
            return { actionAccuracy: updated };
          }
          return {
            actionAccuracy: [...state.actionAccuracy, {
              actionType,
              total: 1,
              engaged: engagementLabel !== "ignored" ? 1 : 0,
              ignored: engagementLabel === "ignored" ? 1 : 0,
              accuracyPct: engagementLabel !== "ignored" ? 100 : 0,
            }],
          };
        }),
      clearActionAccuracy: () => set({ actionAccuracy: [] }),

      // ─── Bot Thinking State (B5) ────────────────────────────
      isAutoForgeThinking: false,
      setIsAutoForgeThinking: (thinking) => set({ isAutoForgeThinking: thinking }),

      // ─── Hype Mode State (B12) ───────────────────────────────
      hypeLevel: 0,
      setHypeLevel: (level) => set({ hypeLevel: level }),

      // ─── Tutorial Walkthrough ────────────────────────────────
      tutorialActive: false,
      setTutorialActive: (active) => set({ tutorialActive: active }),
      tutorialStep: 0,
      setTutorialStep: (step) => set({ tutorialStep: step }),

      // ─── Multi-Bot Mode (toggle-gated, additive) ────────────────
      multiBotEnabled: false,
      setMultiBotEnabled: (enabled) => {
        if (enabled) get().enableMultiBot();
        else get().disableMultiBot();
      },
      enableMultiBot: () => {
        const state = get();
        if (state.multiBotEnabled) return;
        // Seed bots[0] (primary) from the current global single-bot state — COPY, not move.
        // The legacy global fields remain intact for when the toggle is turned off.
        const primaryId = generateId();
        const persona: BotPersona = {
          config: { ...state.config, customDirectives: PRIMARY_BOT_PERSONA.customDirectives },
          botIdentityMode: "custom",
          botIdentityStory: PRIMARY_BOT_PERSONA.botIdentityStory,
          activePersonaId: state.activePersonaId,
        };
        const runtime: BotRuntime = {
          ...createDefaultBotRuntime(),
          longTermMemory: state.longTermMemory,
          pinnedMemories: [...state.pinnedMemories],
          goldenMemoryId: state.goldenMemoryId,
          autoMemories: [...state.autoMemories],
          userProfiles: [...state.userProfiles],
          insideJokes: [...state.insideJokes],
          personalityState: state.personalityState,
          autoMemoryConfig: { ...state.autoMemoryConfig },
          sentMessages: [...state.sentMessages],
          actionHistory: [...state.actionHistory],
          decisionLog: [...state.decisionLog],
          sessionStats: { ...state.sessionStats },
          enhancedStats: { ...state.enhancedStats, actionDistribution: { ...state.enhancedStats.actionDistribution } },
          sentimentHistory: [...state.sentimentHistory],
          sentimentSummary: state.sentimentSummary,
          actionAccuracy: [...state.actionAccuracy],
          autoForgeEvents: [...state.autoForgeEventLog],
          lastAutoForgeDecision: state.lastAutoForgeDecision,
          autoForgeLastActionMs: state.autoForgeLastActionMs,
          autoForgeNextActionMs: state.autoForgeNextActionMs,
          autoForgeFollowup: state.autoForgeFollowup,
        };
        const primaryBot: Bot = {
          id: primaryId,
          label: "Primary",
          platform: state.platform as BotPlatform,
          active: true,
          createdAt: Date.now(),
          // Seed from the legacy single-bot session so the primary bot shows as
          // authenticated immediately (no second OAuth needed). If the user
          // isn't logged in yet, this is null and they can auth via Add Bot.
          session: readLegacySession(state.platform as BotPlatform),
          persona,
          runtime,
        };
        set({ multiBotEnabled: true, bots: [primaryBot], activeBotId: primaryId });
      },
      disableMultiBot: () => {
        const state = get();
        if (!state.multiBotEnabled) return;
        // Sync bots[0] runtime/persona back into the global fields so nothing
        // learned as the primary bot is lost, then deactivate multi-bot mode.
        const primary = state.bots[0];
        if (primary) {
          set({
            // Sync back config sliders (humor, chaos, emote density, etc.) but
            // preserve the original global customDirectives — the primary bot's
            // directives were set to "The Regular" on enable, not user-chosen.
            config: { ...primary.persona.config, customDirectives: state.config.customDirectives },
            // Don't sync back botIdentityMode/botIdentityStory — they were set to
            // "The Regular" on enable. The global fields were never overwritten
            // so they still hold the user's original single-bot identity.
            activePersonaId: primary.persona.activePersonaId,
            longTermMemory: primary.runtime.longTermMemory,
            pinnedMemories: [...primary.runtime.pinnedMemories],
            goldenMemoryId: primary.runtime.goldenMemoryId,
            autoMemories: [...primary.runtime.autoMemories],
            userProfiles: [...primary.runtime.userProfiles],
            insideJokes: [...primary.runtime.insideJokes],
            personalityState: primary.runtime.personalityState,
            autoMemoryConfig: { ...primary.runtime.autoMemoryConfig },
            sentMessages: [...primary.runtime.sentMessages],
            actionHistory: [...primary.runtime.actionHistory],
            decisionLog: [...primary.runtime.decisionLog],
            sessionStats: { ...primary.runtime.sessionStats },
            enhancedStats: { ...primary.runtime.enhancedStats, actionDistribution: { ...primary.runtime.enhancedStats.actionDistribution } },
            sentimentHistory: [...primary.runtime.sentimentHistory],
            sentimentSummary: primary.runtime.sentimentSummary,
            actionAccuracy: [...primary.runtime.actionAccuracy],
            autoForgeEventLog: [...primary.runtime.autoForgeEvents],
            lastAutoForgeDecision: primary.runtime.lastAutoForgeDecision,
            autoForgeLastActionMs: primary.runtime.autoForgeLastActionMs,
            autoForgeNextActionMs: primary.runtime.autoForgeNextActionMs,
            autoForgeFollowup: primary.runtime.autoForgeFollowup,
          });
          // Sync the primary bot's session back into the legacy localStorage
          // key so the legacy single-bot login uses the (possibly re-authed)
          // token rather than a stale one. Direct localStorage write avoids a
          // circular import with twitch.ts/kick.ts.
          if (primary.session) {
            const key = primary.platform === "kick" ? "kick_session" : primary.platform === "joystick" ? "joystick_session" : "twitch_session";
            try {
              localStorage.setItem(key, JSON.stringify({
                accessToken: primary.session.accessToken,
                username: primary.session.username,
                userId: primary.session.userId,
                profileImageUrl: primary.session.profileImageUrl,
                expiresAt: primary.session.expiresAt,
                refreshToken: primary.session.refreshToken,
              }));
            } catch {}
          }
        }
        set({ multiBotEnabled: false, bots: [], activeBotId: null, manualSendBotId: null });
      },
      bots: [],
      activeBotId: null,
      manualSendBotId: null,
      setManualSendBotId: (id) => set({ manualSendBotId: id }),
      setActiveBotId: (id) => set({ activeBotId: id }),
      addBot: (bot) => {
        const id = generateId();
        // Give each newly added bot a distinct default persona (directive +
        // custom story) based on its position in the bots array, so bots 1–9
        // feel different but not too weird. The primary (index 0) is seeded
        // from the user's global persona in enableMultiBot(), not here.
        const index = get().bots.length;
        const defaults = getDefaultBotPersonaForIndex(index);
        const persona = createDefaultBotPersona();
        persona.botIdentityMode = "custom";
        persona.botIdentityStory = defaults.botIdentityStory;
        persona.config = { ...persona.config, customDirectives: defaults.customDirectives };
        const newBot: Bot = {
          id,
          label: bot.label,
          platform: bot.platform,
          active: bot.active,
          createdAt: Date.now(),
          session: bot.session ?? null,
          persona,
          runtime: createDefaultBotRuntime(),
        };
        set((state) => ({ bots: [...state.bots, newBot] }));
        return id;
      },
      removeBot: (id) =>
        set((state) => ({
          bots: state.bots.filter((b) => b.id !== id),
          activeBotId: state.activeBotId === id ? (state.bots.find((b) => b.id !== id)?.id ?? null) : state.activeBotId,
        })),
      updateBotPersona: (id, updates) =>
        set((state) => ({
          bots: state.bots.map((b) => (b.id === id ? { ...b, persona: { ...b.persona, ...updates } } : b)),
        })),
      updateBotRuntime: (id, updates) =>
        set((state) => ({
          bots: state.bots.map((b) => (b.id === id ? { ...b, runtime: { ...b.runtime, ...updates } } : b)),
        })),
      setBotSession: (id, session) =>
        set((state) => ({
          bots: state.bots.map((b) => (b.id === id ? { ...b, session } : b)),
        })),
      toggleBotActive: (id) =>
        set((state) => ({
          bots: state.bots.map((b) => (b.id === id ? { ...b, active: !b.active } : b)),
        })),
      getBot: (id) => get().bots.find((b) => b.id === id),

      // ─── Bot-scoped action twins (additive) ───────────────────────────────
      addBotSentMessage: (id, msg) =>
        set((state) => ({
          bots: state.bots.map((b) =>
            b.id === id
              ? { ...b, runtime: { ...b.runtime, sentMessages: [...b.runtime.sentMessages, { ...msg, id: generateId() }].slice(-100) } }
              : b
          ),
        })),
      addBotAutoForgeEvent: (id, event) =>
        set((state) => ({
          bots: state.bots.map((b) => {
            if (b.id !== id) return b;
            const log = [...b.runtime.autoForgeEvents, { ...event, id: generateId() }];
            if (log.length > 500) log.splice(0, log.length - 500);
            return { ...b, runtime: { ...b.runtime, autoForgeEvents: log } };
          }),
        })),
      addBotDecisionLogEntry: (id, entry) => {
        const entryId = generateId();
        set((state) => ({
          bots: state.bots.map((b) => {
            if (b.id !== id) return b;
            const log = [...b.runtime.decisionLog, { ...entry, id: entryId }];
            if (log.length > 200) log.splice(0, log.length - 200);
            return { ...b, runtime: { ...b.runtime, decisionLog: log } };
          }),
        }));
        return entryId;
      },
      updateBotDecisionLogEntry: (id, entryId, updates) =>
        set((state) => ({
          bots: state.bots.map((b) =>
            b.id === id
              ? { ...b, runtime: { ...b.runtime, decisionLog: b.runtime.decisionLog.map((e) => (e.id === entryId ? { ...e, ...updates } : e)) } }
              : b
          ),
        })),
      addBotSentimentReading: (id, reading) =>
        set((state) => ({
          bots: state.bots.map((b) => {
            if (b.id !== id) return b;
            const updated = [...b.runtime.sentimentHistory, reading];
            if (updated.length > 100) updated.splice(0, updated.length - 100);
            return { ...b, runtime: { ...b.runtime, sentimentHistory: updated } };
          }),
        })),
      setBotLastAutoForgeDecision: (id, decision) =>
        set((state) => ({
          bots: state.bots.map((b) => (b.id === id ? { ...b, runtime: { ...b.runtime, lastAutoForgeDecision: decision } } : b)),
        })),
      setBotAutoForgeLastActionMs: (id, ms) =>
        set((state) => ({
          bots: state.bots.map((b) => (b.id === id ? { ...b, runtime: { ...b.runtime, autoForgeLastActionMs: ms } } : b)),
        })),
      setBotAutoForgeNextActionMs: (id, ms) =>
        set((state) => ({
          bots: state.bots.map((b) => (b.id === id ? { ...b, runtime: { ...b.runtime, autoForgeNextActionMs: ms } } : b)),
        })),
      setBotIsAutoForgeThinking: (id, thinking) =>
        set((state) => ({
          bots: state.bots.map((b) => (b.id === id ? { ...b, runtime: { ...b.runtime, isAutoForgeThinking: thinking } } : b)),
        })),
      incrementBotStat: (id, key, amount = 1) =>
        set((state) => ({
          bots: state.bots.map((b) => {
            if (b.id !== id) return b;
            const stats = { ...b.runtime.enhancedStats };
            if (typeof (stats as any)[key] === "number") (stats as any)[key] = (stats as any)[key] + amount;
            return { ...b, runtime: { ...b.runtime, enhancedStats: stats } };
          }),
        })),
      addBotActionHistoryEntry: (id, entry) =>
        set((state) => ({
          bots: state.bots.map((b) => {
            if (b.id !== id) return b;
            const history = [...b.runtime.actionHistory, { ...entry, id: generateId() }];
            if (history.length > 200) history.splice(0, history.length - 200);
            return { ...b, runtime: { ...b.runtime, actionHistory: history } };
          }),
        })),
      updateBotEnhancedStats: (id, updates) =>
        set((state) => ({
          bots: state.bots.map((b) =>
            b.id === id ? { ...b, runtime: { ...b.runtime, enhancedStats: { ...b.runtime.enhancedStats, ...updates } } } : b
          ),
        })),

      exportSettings: () => {
        const state = get();
        const settings = {
          config: state.config,
          platform: state.platform,
          r34lEnabled: state.r34lEnabled,
          cosmotechTheme: state.cosmotechTheme,
        theme: state.theme,
          messageSoundEnabled: state.messageSoundEnabled,
          sfxEnabled: state.sfxEnabled,
          sfxVolume: state.sfxVolume,
          emoteProviders: state.emoteProviders,
          emoteAwarenessEnabled: state.emoteAwarenessEnabled,
          ttsEnabled: state.ttsEnabled,
          ttsProvider: state.ttsProvider,
          ttsVoice: state.ttsVoice,
          ttsRate: state.ttsRate,
          ttsVolume: state.ttsVolume,
          ttsAudioOutputDeviceId: state.ttsAudioOutputDeviceId,
        botIdentityMode: state.botIdentityMode,
        botIdentityStory: state.botIdentityStory,
          forgeTemplates: state.forgeTemplates,
          moodLock: state.moodLock,
          variantHistory: state.variantHistory,
          reactionSequences: state.reactionSequences,
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
          autoForgeSequences: state.autoForgeSequences,
          autoForgeRules: state.autoForgeRules,
          perActionRateLimits: state.perActionRateLimits,
          // Multi-bot: export personas + memory but NEVER sessions (tokens stay local).
          multiBotEnabled: state.multiBotEnabled,
          activeBotId: state.activeBotId,
          bots: state.multiBotEnabled
            ? state.bots.map((b) => ({ ...b, session: null }))
            : [],
          exportedAt: new Date().toISOString(),
          version: SETTINGS_VERSION,
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
          if (data.theme) set({ theme: data.theme, cosmotechTheme: data.theme === "cosmotech" });
          if (data.messageSoundEnabled !== undefined) set({ messageSoundEnabled: data.messageSoundEnabled });
          if (data.sfxEnabled !== undefined) set({ sfxEnabled: data.sfxEnabled });
          if (data.sfxVolume !== undefined) set({ sfxVolume: data.sfxVolume });
          if (data.emoteProviders) set({ emoteProviders: data.emoteProviders });
          if (data.emoteAwarenessEnabled !== undefined) set({ emoteAwarenessEnabled: data.emoteAwarenessEnabled });
          if (data.ttsEnabled !== undefined) set({ ttsEnabled: data.ttsEnabled });
          if (data.ttsProvider) set({ ttsProvider: data.ttsProvider });
          if (data.ttsVoice !== undefined) set({ ttsVoice: data.ttsVoice });
          if (data.ttsRate !== undefined) set({ ttsRate: data.ttsRate });
          if (data.ttsVolume !== undefined) set({ ttsVolume: data.ttsVolume });
          if (data.elevenlabsApiKey !== undefined) set({ elevenlabsApiKey: data.elevenlabsApiKey });
          if (data.ttsAudioOutputDeviceId !== undefined) set({ ttsAudioOutputDeviceId: data.ttsAudioOutputDeviceId });
          if (data.botIdentityMode) set({ botIdentityMode: data.botIdentityMode });
          if (data.botIdentityStory !== undefined) set({ botIdentityStory: data.botIdentityStory });
          if (data.forgeTemplates) set({ forgeTemplates: data.forgeTemplates });
          if (data.moodLock) set({ moodLock: data.moodLock });
          if (data.variantHistory) set({ variantHistory: data.variantHistory });
          if (data.reactionSequences) set({ reactionSequences: data.reactionSequences });
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
          if (data.autoForgeSequences) set({ autoForgeSequences: data.autoForgeSequences });
          if (data.autoForgeRules) set({ autoForgeRules: data.autoForgeRules });
          if (data.perActionRateLimits) set({ perActionRateLimits: data.perActionRateLimits });
          // Multi-bot: restore personas + memory (sessions intentionally absent
          // in exports — user must re-auth each bot after import).
          if (data.multiBotEnabled !== undefined) set({ multiBotEnabled: data.multiBotEnabled });
          if (data.activeBotId !== undefined) set({ activeBotId: data.activeBotId });
          if (data.bots) set({ bots: data.bots });
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
        theme: state.theme,
        messageSoundEnabled: state.messageSoundEnabled,
        audioOutputDeviceId: state.audioOutputDeviceId,
        customSoundUrl: state.customSoundUrl,
        soundVolume: state.soundVolume,
        sfxEnabled: state.sfxEnabled,
        sfxVolume: state.sfxVolume,
        emoteProviders: state.emoteProviders,
        emoteAwarenessEnabled: state.emoteAwarenessEnabled,
        ttsEnabled: state.ttsEnabled,
        ttsProvider: state.ttsProvider,
        ttsVoice: state.ttsVoice,
        ttsRate: state.ttsRate,
        ttsVolume: state.ttsVolume,
        elevenlabsApiKey: state.elevenlabsApiKey,
        ttsAudioOutputDeviceId: state.ttsAudioOutputDeviceId,
        botIdentityMode: state.botIdentityMode,
        botIdentityStory: state.botIdentityStory,
        forgeTemplates: state.forgeTemplates,
        moodLock: state.moodLock,
        variantHistory: state.variantHistory,
        reactionSequences: state.reactionSequences,
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
        autoForgeSequences: state.autoForgeSequences,
        autoForgeRules: state.autoForgeRules,
        perActionRateLimits: state.perActionRateLimits,
        // Multi-bot (additive): persisted so multi-bot state survives reload.
        // Sessions live here too (same localStorage risk profile as the legacy
        // twitch_session/kick_session keys); they are stripped from exportSettings.
        multiBotEnabled: state.multiBotEnabled,
        bots: state.bots,
        activeBotId: state.activeBotId,
        hasForgedOnce: state.hasForgedOnce,
      }),
      version: SETTINGS_VERSION,
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
        if (version < 8 && persistedState) {
          // Migrate cosmotechTheme boolean → theme string
          if (!persistedState.theme) {
            persistedState.theme = persistedState.cosmotechTheme ? "cosmotech" : "default";
          }
          if (persistedState.emoteProviders === undefined) {
            persistedState.emoteProviders = { sevenTV: true, ffz: true, bttv: true };
          }
          if (persistedState.emoteAwarenessEnabled === undefined) {
            persistedState.emoteAwarenessEnabled = true;
          }
          if (persistedState.botIdentityMode === undefined) {
            persistedState.botIdentityMode = "admit";
          }
          if (persistedState.botIdentityStory === undefined) {
            persistedState.botIdentityStory = "";
          }
        }
        if (version < 9 && persistedState) {
          if (!persistedState.forgeTemplates) persistedState.forgeTemplates = [];
          if (!persistedState.moodLock) persistedState.moodLock = { locked: false, mood: null };
          if (!persistedState.variantHistory) persistedState.variantHistory = [];
          if (!persistedState.reactionSequences) persistedState.reactionSequences = [];
        }
        if (version < 10 && persistedState) {
          if (!persistedState.autoForgeSequences) persistedState.autoForgeSequences = [];
          if (!persistedState.autoForgeRules) persistedState.autoForgeRules = [];
          if (!persistedState.perActionRateLimits) persistedState.perActionRateLimits = {
            full_forge: { maxPerHour: 10, maxPerTenMinutes: 3, cooldownMs: 30_000 },
            short_reaction: { maxPerHour: 20, maxPerTenMinutes: 6, cooldownMs: 15_000 },
            emote_only: { maxPerHour: 30, maxPerTenMinutes: 8, cooldownMs: 10_000 },
            quick_followup: { maxPerHour: 15, maxPerTenMinutes: 4, cooldownMs: 20_000 },
          };
        }
        // v12: Multi-bot mode (additive). Only inject defaults — never touch
        // legacy fields. The original single-bot flow stays fully intact.
        if (version < 12 && persistedState) {
          if (persistedState.multiBotEnabled === undefined) persistedState.multiBotEnabled = false;
          if (!persistedState.bots) persistedState.bots = [];
          if (persistedState.activeBotId === undefined) persistedState.activeBotId = null;
        }
        return persistedState;
      },
    }
  )
);
