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
}

export interface ForgeSuggestion {
  variant_id: number;
  profile: 'hype' | 'analyst' | 'gremlin' | 'translator' | string;
  message: string;
  why_it_fits?: string;
  confidence: number;
  tone?: string;
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
  effortLevel?: "low" | "medium" | "high";
  autoForgeContextTokens?: number;
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
  | "metadata_change";

export type AutoForgeEventSeverity = "low" | "medium" | "high";

export interface AutoForgeEvent {
  id: string;
  timestamp: number;
  type: AutoForgeEventType;
  severity: AutoForgeEventSeverity;
  summary: string;
  details?: Record<string, any>;
}

export interface SentMessage {
  id: string;
  message: string;
  channel: string;
  timestamp: number;
  source: "manual" | "autoforge" | "followup";
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
  source: "chat" | "audio" | "visual" | "inferred";
  confidence: number;
  createdAt: number;
  lastReferencedAt: number;
  referenceCount: number;
  strength: number;
  tags: string[];
  isVerified: boolean;
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
  strength: number;
  status: "active" | "fading" | "retired";
  createdAt: number;
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
}

// ─── Analytics Types ───────────────────────────────────

export interface ActionHistoryEntry {
  id: string;
  timestamp: number;
  actionType: string;
  message: string;
  provider: string;
  success: boolean;
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
  outcome?: "sent" | "failed" | "queued";
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
