export interface ChatMessage {
  id: string;
  user: string;
  text: string;
  timestamp: number;
  platform?: string;
  marker?: "manual" | "autoforge";
  badges?: string[];
  sentiment?: SentimentLabel;
  banned?: boolean;
  dryRun?: boolean;
  /** Message was sent by the user/bot (not received from chat). Styled in gold. */
  selfSent?: boolean;
  /** Source of the self-sent message: "manual" or "autoforge". */
  selfSentSource?: "manual" | "autoforge";
  /** Twitch native emotes from IRC tags: emoteId → array of [start, end] ranges. */
  twitchEmotes?: Record<string, number[][]>;
}

export interface ForgeSuggestion {
  variant_id: number;
  profile: 'hype' | 'analyst' | 'gremlin' | 'translator' | string;
  message: string;
  why_it_fits?: string;
  confidence: number;
  tone?: string;
  best?: boolean;
}

export interface ForgeResponse {
  variants: ForgeSuggestion[];
  suggestions: ForgeSuggestion[];
  analysis: any;
  tokenUsage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ForgeConfig {
  provider: 'gemini' | 'openai' | 'anthropic';
  humorLevel: number;
  chaosLevel: number;
  customDirectives: string;
  activeProfiles: string[];
  primaryProfile: string;
  emoteDensity: "minimal" | "moderate" | "heavy" | string;
  toxicityFilter: "family" | "standard" | "unfiltered" | string;
  lengthPreference: string;
  voiceContextEnabled: boolean;
  additionalInstructions: string;
  generationMode: string;
  effortLevel?: "low" | "medium" | "high" | "smart";
  autoForgeContextTokens?: number;
}

// ─── Creative Tools Types (E1/E4) ───────────────────────────────────
export interface ForgeTemplate {
  id: string;
  name: string;
  description: string;
  directives: string;
  humorLevel: number;
  chaosLevel: number;
  emoteDensity: string;
  lengthPreference: string;
  createdAt: number;
}

export interface VisualSnapshotHistoryEntry {
  id: string;
  url: string;
  tags: string[];
  timestamp: number;
  source: "manual" | "auto";
  delta?: number;
}

export interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
  profile_image_url: string;
  username?: string;
}

export interface PinnedMemory {
  id: string;
  type: "chat" | "audio" | "visual";
  content: string;
  label: string;
  timestamp: number;
  imageUrl?: string;
}

export type AutoForgeEventType =
  | "action_sent"
  | "mention"
  | "spike"
  | "silence"
  | "error"
  | "enable_disable"
  | "metadata_change"
  | "director_note"
  | "rule_fired";

export type AutoForgeEventSeverity = "low" | "medium" | "high";

export interface AutoForgeEvent {
  id: string;
  timestamp: number;
  type: AutoForgeEventType;
  severity: AutoForgeEventSeverity;
  summary: string;
  details?: Record<string, any>;
  // Multi-bot mode: which bot account produced this event. Absent in legacy
  // single-bot mode and for global events.
  botName?: string;
}

export interface SentMessage {
  id: string;
  message: string;
  channel: string;
  timestamp: number;
  source: "manual" | "autoforge" | "followup";
  // Multi-bot mode: which bot account sent this. Absent in legacy single-bot mode.
  botId?: string;
  // Dry run: message was previewed locally, never posted to the live channel.
  dryRun?: boolean;
}

export interface SessionStats {
  sessionStart: number;
  messagesReceived: number;
  messagesSent: number;
  forgeCount: number;
}

// ─── Auto-Memory System Types ───────────────────────────────────

export interface AutoMemory {
  id: string;
  type: "fact" | "trait" | "story" | "event" | "preference" | "opinion" | "milestone";
  subject: "streamer" | "chatter" | "chat_general" | "bot_self";
  subjectUsername?: string;
  content: string;
  context: string;
  source: "chat" | "audio" | "visual" | "inferred" | "director";
  confidence: number;
  createdAt: number;
  lastReferencedAt: number;
  /** Last applied decay; absent in older saves, which start from lastReferencedAt. */
  lastDecayedAt?: number;
  referenceCount: number;
  strength: number;
  tags: string[];
  isVerified: boolean;
  // Channel scope (added in v2 schema). Set by memoryStore on write.
  channel?: string;
}

/**
 * DirectorNote — a private message from the streamer to a bot (or all bots).
 * Unlike ChatSender messages, director notes are never sent to the chat
 * channel. They are injected into the bot's AutoForge context as a
 * high-priority directive so the bot can adapt its behavior mid-stream.
 *
 * Timed notes: `expiresAt` is a Unix-ms timestamp. When set, the note is
 * filtered out of the AI context after it expires (it remains in storage
 * until cleared so the user can see what was sent). `null` / `undefined`
 * means the note lasts until manually canceled.
 */
export interface DirectorNote {
  id: string;
  text: string;
  createdAt: number;
  /** Optional Unix-ms expiry timestamp. null = until manually canceled. */
  expiresAt?: number | null;
}

export interface UserProfile {
  username: string;
  firstSeenAt: number;
  lastSeenAt: number;
  totalMessages: number;
  messagesThisSession: number;
  relationship: "stranger" | "acquaintance" | "regular" | "friend" | "inner_circle";
  rapportScore: number;
  traits: string[];
  interests: string[];
  knownFacts: string[];
  sharedJokes: string[];
  interactionHistory: {
    timestamp: number;
    type: "chat_reply" | "mention" | "joke_exchange" | "argument" | "support";
    summary: string;
  }[];
  notes: string;
  isVIP: boolean;
  isBlocked: boolean;
  // Channel scope (added in v2 schema). Set by memoryStore on write.
  channel?: string;
}

export interface InsideJoke {
  id: string;
  origin: string;
  originTimestamp: number;
  participants: string[];
  punchline: string;
  context: string;
  variations: {
    text: string;
    timestamp: number;
  }[];
  usageCount: number;
  lastUsedAt: number;
  /** Last applied decay; absent in older saves, which start from lastUsedAt. */
  lastDecayedAt?: number;
  strength: number;
  status: "active" | "fading" | "retired";
  createdAt: number;
  // Channel scope (added in v2 schema). Set by memoryStore on write.
  channel?: string;
}

export interface PersonalityState {
  mood: "chill" | "hyped" | "gremlin" | "thoughtful" | "sentimental" | "chaotic";
  comfortLevel: number;
  sessionCount: number;
  totalMessagesSent: number;
  dominantTraits: string[];
  currentSessionStart: number;
  sessionMemoriesFormed: number;
  sessionJokesCreated: number;
  relationshipProgression: {
    timestamp: number;
    stage: string;
    note: string;
  }[];
}

export interface AutoMemoryConfig {
  enabled: boolean;
  extractionIntervalMinutes: number;
  maxMemories: number;
  maxProfiles: number;
  maxJokes: number;
  decayHalfLifeDays: number;
  jokeDecayHalfLifeDays: number;
  minConfidenceToStore: number;
  autoVerifyThreshold: number;
  contextInjectionTokenBudget: number;
  relationshipProgressionEnabled: boolean;
  personalityEvolutionEnabled: boolean;
  crossSessionPersistence: boolean;
}

export interface MemoryExtractionResult {
  newMemories: Omit<AutoMemory, "id" | "createdAt" | "lastReferencedAt" | "referenceCount" | "strength" | "isVerified">[];
  updatedProfiles: { username: string; updates: Partial<UserProfile> }[];
  newJokes: Omit<InsideJoke, "id" | "createdAt" | "usageCount" | "lastUsedAt" | "strength" | "status" | "variations">[];
  personalityShift?: Partial<PersonalityState>;
  summary: string;
  tokenUsage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// ─── Analytics Types ───────────────────────────────────

export interface ActionHistoryEntry {
  id: string;
  timestamp: number;
  actionType: string;
  message: string;
  provider: string;
  success: boolean;
  // D4: Post-send engagement correlation
  engagement?: {
    chatLinesAfter: number;
    mentionsAfter: number;
    reactionsAfter: number;
    label: "ignored" | "low" | "moderate" | "high";
    evaluatedAt: number;
  };
}

export interface EnhancedSessionStats {
  sessionStart: number;
  messagesReceived: number;
  messagesSent: number;
  forgeCount: number;
  autoForgeActions: number;
  manualActions: number;
  followupActions: number;
  silenceDecisions: number;
  mentionsDetected: number;
  spikesDetected: number;
  providerFallbacks: number;
  avgResponseTimeMs: number;
  totalTokensUsed: number;
  estimatedCost: number;
  actionDistribution: Record<string, number>;
  peakChatVelocity: number;
  uniqueChatters: number;
}

export interface FeatureTokenStats {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCost: number;
  callCount: number;
  lastCallAt: number | null;
}

export type TokenFeatureKey =
  | "forge"
  | "refine"
  | "autoforge_decide"
  | "vision"
  | "briefing"
  | "memory_extraction"
  | "moment_synthesis"
  | "episode_synthesis";

export interface AutoForgeRateLimitConfig {
  maxActionsPerHour: number;
  maxActionsPerTenMinutes: number;
  minCooldownMs: number;
}

// ─── Sentiment Analysis Types ───────────────────────────────────

export type SentimentLabel = "positive" | "negative" | "hype" | "wholesome" | "toxic" | "neutral";

export interface SentimentReading {
  timestamp: number;
  label: SentimentLabel;
  score: number;
  username: string;
  text: string;
}

export interface SentimentSummary {
  current: SentimentLabel;
  distribution: Record<SentimentLabel, number>;
  trend: "rising" | "falling" | "stable";
  dominantScore: number;
  readings: SentimentReading[];
}

// ─── Message Queue Types ────────────────────────────────────────

export interface QueuedMessage {
  id: string;
  message: string;
  channel: string;
  platform: string;
  timestamp: number;
  retryCount: number;
  maxRetries: number;
  nextRetryMs: number;
  lastError?: string;
}

// ─── Chat Activity Heatmap Types ───────────────────────────────

export interface ChatActivityBucket {
  timestamp: number;
  count: number;
  autoForgeAction: boolean;
}

// ─── Smart Reply Types ─────────────────────────────────────────

export interface SmartReply {
  id: string;
  text: string;
  timestamp: number;
}

// ─── Chatter Leaderboard Types ─────────────────────────────────

export interface ChatterStats {
  username: string;
  messageCount: number;
  positiveCount: number;
  negativeCount: number;
  mentionCount: number;
  lastActive: number;
  badges: string[];
}

// ─── Decision Log Types ────────────────────────────────────────

export interface DecisionLogEntry {
  id: string;
  timestamp: number;
  decision: "action" | "silence" | "followup";
  action?: string;
  reasoning: string;
  sentimentLabel: SentimentLabel;
  sentimentScore: number;
  chatVelocity: number;
  isMentioned: boolean;
  activitySpike: boolean;
  provider: string;
  outcome?: "sent" | "failed" | "queued" | "stale" | "skipped";
  responseTimeMs?: number;
}

// ─── Persona Preset Types ──────────────────────────────────────

export interface PersonaPreset {
  id: string;
  name: string;
  icon: string;
  config: Partial<ForgeConfig>;
  custom?: boolean;
}

// ─── Keyword Trigger Rule Types ────────────────────────────────

export interface KeywordTriggerRule {
  id: string;
  label: string;
  pattern: string;
  isRegex: boolean;
  caseSensitive: boolean;
  actions: {
    notify: boolean;
    toast: boolean;
    sound: boolean;
    forceAutoForge: boolean;
  };
  enabled: boolean;
  matchCount: number;
  lastTriggeredMs: number | null;
}

// ─── Session Goal Types ────────────────────────────────────────

export type GoalType =
  | "mentionResponseRate"
  | "minActionsPerHour"
  | "positiveSentimentRatio"
  | "maxSilenceRatio"
  | "minMessagesSent"
  | "maxAvgResponseMs";

export interface SessionGoal {
  id: string;
  type: GoalType;
  label: string;
  target: number;
  enabled: boolean;
}

// ─── Goal Evaluation Types ─────────────────────────────────────

export interface GoalEvaluationResult {
  goalId: string;
  goalType: GoalType;
  label: string;
  current: number;
  target: number;
  progress: number;
  met: boolean;
  enabled: boolean;
}

// ─── Engagement Score Types ────────────────────────────────────

export interface EngagementBreakdown {
  velocityScore: number;
  sentimentScore: number;
  diversityScore: number;
  recencyScore: number;
  overall: number;
}

// ─── AutoForge Sequence Types (C3) ────────────────────────────

export interface AutoForgeSequenceStep {
  id: string;
  actionType: "full_forge" | "short_reaction" | "emote_only" | "quick_followup";
  payload?: string;
  delayMs: number;
}

export interface AutoForgeSequence {
  id: string;
  name: string;
  steps: AutoForgeSequenceStep[];
  enabled: boolean;
  createdAt: number;
}

// ─── Per-Action Rate Limit Config (C5) ─────────────────────────

export interface PerActionRateLimit {
  maxPerHour: number;
  maxPerTenMinutes: number;
  cooldownMs: number;
}

export type PerActionRateLimitConfig = Record<string, PerActionRateLimit>;

// ─── Stream Health Score (A10) ─────────────────────────────────

export interface StreamHealthScore {
  velocityScore: number;
  sentimentScore: number;
  diversityScore: number;
  mentionScore: number;
  visualScore: number;
  overall: number;
  label: "dead" | "slow" | "active" | "healthy" | "poppin";
  updatedAt: number;
}

// ─── AutoForge Accuracy Metrics (A9) ────────────────────────────

export interface ActionAccuracyEntry {
  actionType: string;
  total: number;
  engaged: number;
  ignored: number;
  accuracyPct: number;
}

// ─── AutoForge Rule Engine Types (C1) ───────────────────────────

export type RuleConditionType =
  | "chat_velocity_above"
  | "chat_velocity_below"
  | "sentiment_is"
  | "sentiment_is_not"
  | "time_since_last_action_above"
  | "time_since_last_action_below"
  | "keyword_detected"
  | "keyword_not_detected"
  | "mention_detected"
  | "activity_spike"
  | "stream_health_is"
  | "hype_level_above"
  | "hype_level_below"
  | "unique_chatters_above"
  | "viewer_count_above"
  | "viewer_count_below"
  | "audio_energy_above"
  | "audio_energy_below"
  | "time_of_day_after"
  | "time_of_day_before"
  | "autoforge_is_enabled"
  | "autoforge_is_disabled"
  | "mood_is"
  | "mood_is_not"
  | "consecutive_silence_above"
  | "active_bot_count_above"
  | "active_bot_count_below";

export type RuleConditionOperator = "and" | "or";

export interface RuleCondition {
  id: string;
  type: RuleConditionType;
  // Numeric threshold for velocity/time/chatters/viewers/audio conditions
  value?: number;
  // Sentiment label for sentiment conditions
  sentimentLabel?: SentimentLabel;
  // Stream health label for stream_health_is
  healthLabel?: "dead" | "slow" | "active" | "healthy" | "poppin";
  // Keyword string for keyword conditions
  keyword?: string;
  // Hour (0-23) for time_of_day_after / time_of_day_before conditions
  hour?: number;
  // Mood name for mood_is / mood_is_not conditions
  mood?: string;
}

export type RuleActionType =
  | "send_message"
  | "send_emote"
  | "change_mood"
  | "apply_template"
  | "trigger_full_forge"
  | "notify_user"
  | "set_hype_level"
  | "force_autoforge_check"
  | "toggle_autoforge"
  | "set_confidence_threshold"
  | "clear_mood_lock"
  | "set_length_preference";

export interface RuleAction {
  id: string;
  type: RuleActionType;
  // Message text for send_message / send_emote
  payload?: string;
  // Mood name for change_mood
  mood?: string;
  // Template ID for apply_template
  templateId?: string;
  // Notification message for notify_user
  notification?: string;
  // Hype level for set_hype_level
  hypeLevel?: number;
  // Enabled state for toggle_autoforge (true = turn on, false = turn off)
  enabled?: boolean;
  // Confidence threshold (0-1) for set_confidence_threshold
  confidenceThreshold?: number;
  // Length preference for set_length_preference
  lengthPreference?: "short" | "medium" | "long";
  // Delay before executing this action (ms)
  delayMs: number;
}

export interface AutoForgeRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  // Conditions combined with the operator
  conditions: RuleCondition[];
  conditionOperator: RuleConditionOperator;
  actions: RuleAction[];
  // Cooldown to prevent re-firing too often (ms)
  cooldownMs: number;
  // Last time this rule fired (tracked internally)
  lastFiredMs: number;
  // Fire limit (0 = unlimited)
  maxFires: number;
  // Current fire count
  fireCount: number;
  createdAt: number;
}

// Context passed to the rule engine for evaluation
export interface RuleEngineContext {
  chatVelocity: number;
  sentimentLabel: SentimentLabel | null;
  timeSinceLastActionMs: number;
  recentChatText: string;
  isMentioned: boolean;
  activitySpike: boolean;
  streamHealthLabel: string | null;
  hypeLevel: number;
  uniqueChatters: number;
  viewerCount: number;
  audioEnergyRms: number;
  // Whether AutoForge is currently enabled
  autoForgeEnabled: boolean;
  // Current mood lock state (null = no lock)
  currentMood: string | null;
  // Consecutive silence cycles (AutoForge decided "silence" N times in a row)
  consecutiveSilence: number;
  // Number of active+authenticated bots in multi-bot mode (1 in legacy mode)
  activeBotCount: number;
}

// Result of evaluating a single rule
export interface RuleEvaluationResult {
  ruleId: string;
  ruleName: string;
  fired: boolean;
  reason: string;
  actionsExecuted: number;
}

// ─── Multi-Bot Types (toggle-gated, additive) ─────────────────
// These mirror the existing global single-bot fields so each bot can carry
// its own fully independent brain. The legacy global fields remain untouched
// and are the source of truth when multiBotEnabled === false.

export type BotPlatform = "twitch" | "kick" | "joystick";

export interface BotIdentity {
  id: string;
  label: string;
  platform: BotPlatform;
  active: boolean;
  createdAt: number;
}

export interface BotPersona {
  config: ForgeConfig;
  botIdentityMode: "admit" | "custom";
  botIdentityStory: string;
  activePersonaId: string | null;
  /** Explicit spoken aliases (Spoken Callout Priority) — what the streamer
   *  may verbally call this bot besides its username/label. Bounded set,
   *  user-configured only; never auto-derived from name substrings. */
  spokenAliases?: string[];
}

export interface BotRuntime {
  // Memory
  longTermMemory: string;
  pinnedMemories: PinnedMemory[];
  goldenMemoryId: string | null;
  autoMemories: AutoMemory[];
  userProfiles: UserProfile[];
  insideJokes: InsideJoke[];
  personalityState: PersonalityState | null;
  autoMemoryConfig: AutoMemoryConfig;
  // Director notes — private streamer-to-bot directives (never sent to chat)
  directorNotes: DirectorNote[];
  // History & analytics
  sentMessages: SentMessage[];
  actionHistory: ActionHistoryEntry[];
  decisionLog: DecisionLogEntry[];
  sessionStats: SessionStats;
  enhancedStats: EnhancedSessionStats;
  sentimentHistory: SentimentReading[];
  sentimentSummary: SentimentSummary | null;
  actionAccuracy: ActionAccuracyEntry[];
  autoForgeEvents: AutoForgeEvent[];
  // AutoForge pacing / state
  lastAutoForgeDecision: import("./lib/ai").AutoForgeDecision | null;
  // Bounded history of recent decisions (last ~20). Used by the Q hotkey
  // to recover unsent messages from earlier cycles, not just the most
  // recent one. Entries are deduped against sentMessages at send time.
  autoForgeDecisionHistory: import("./lib/ai").AutoForgeDecision[];
  autoForgeLastActionMs: number | null;
  autoForgeNextActionMs: number;
  autoForgeFollowup: { message: string; deliveredAt: number } | null;
  isAutoForgeThinking: boolean;
  smartReplies: SmartReply[];
}

// A session payload for a bot — platform-specific. Kept loose to avoid
// importing platform libs into the types module.
export interface BotSessionPayload {
  accessToken: string;
  username: string;
  userId: string;
  profileImageUrl?: string;
  // Kick-specific extras (optional)
  expiresAt?: number;
  refreshToken?: string;
}

export interface Bot extends BotIdentity {
  session: BotSessionPayload | null;
  persona: BotPersona;
  runtime: BotRuntime;
}

// ─── First Message Mode (multi-bot) ────────────────────────────
// When enabled, each currently participating Multi-Bot's next successful
// outbound message is treated as a special "arrival" — the AI leans toward a
// natural conversational entrance that lightly reveals the bot's persona.
// State is split: the user preference (`firstMessageModeEnabled`) is persisted;
// the runtime cohort below is ephemeral (never persisted) so it can never leak
// across sessions, reloads, or stream/channel switches.

export type FirstMessageStatus = "armed" | "sending" | "complete";

export interface FirstMessageCohort {
  // Unique id for this activation; a fresh toggle-on creates a new id.
  id: string;
  // Bot ids that were active+authenticated at toggle-on time. This is the
  // fixed set required for completion — newly activated bots do NOT join an
  // in-progress cohort, keeping progress deterministic.
  botIds: string[];
  // Per-bot status within this cohort. Absent = not a member.
  status: Record<string, FirstMessageStatus>;
  createdAt: number;
  // Guards against duplicate confetti: set true exactly once when the cohort
  // transitions to all-complete.
  celebrated: boolean;
}
