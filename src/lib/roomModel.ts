/**
 * Room Model / Moment Timeline — the shared situational-awareness substrate.
 *
 * Problem: MADchatter's perception systems (chat, audio, vision, platform
 * events, threads, sentiment, agent activity) each feed independent AI calls,
 * and the assembled context is discarded afterward. Nothing answers
 * "what is happening right now?" or "what moments mattered?" without re-reading
 * raw history.
 *
 * Solution: a deterministic engine that normalizes those signals into a
 * continuous Room State plus a bounded Moment Timeline:
 *
 *   raw perception → normalized signals → deterministic event fusion
 *     → Moments (bounded episodes) → Room State (compact present)
 *     → optional sparse AI enrichment (titles/summaries only)
 *
 * Architecture rules (enforced here):
 * - FACTS FIRST, SYNTHESIS SECOND. Timestamps, velocity, significance,
 *   confidence, fusion, lifecycle, and retention are 100% deterministic —
 *   no AI in the hot path. The Room Model stays useful with no provider
 *   configured, with Ollama offline, and with most sensor lanes dark.
 * - AI can only populate semantic enrichment fields (title / summary /
 *   topicHints) on CLOSED moments, and only via applySynthesis() which is
 *   channel- and idempotence-guarded. AI can never create, extend, close,
 *   or re-score a moment.
 * - BOT ACTIVITY IS NOT HUMAN ACTIVITY. Every signal carries actor
 *   attribution; chat velocity, significance, and moment creation use human
 *   messages only. Bots talking to bots cannot manufacture a room moment.
 * - EVERYTHING IS BOUNDED. Signals, evidence refs, moments, chat lines,
 *   and platform events all have hard caps so the timeline can never grow
 *   unbounded (IndexedDB included).
 * - Significance ≠ confidence. Significance = "how much did this matter?";
 *   confidence = "how much evidence agrees that it happened at all?"
 *
 * This module is pure: no store import, no timers, no AI calls. The engine is
 * driven by explicit note*() calls from store actions / App.tsx and a tick()
 * from the useRoomModel hook. All timestamps are Unix milliseconds.
 */

import type { SentimentLabel } from "../types";
import { generateId } from "./ids";

// ─── Domain Types ─────────────────────────────────────────────────────────────

/** Perception lanes the engine tracks freshness for. */
export type RoomLane = "chat" | "audio" | "vision" | "platform" | "transcript";

export type RoomActivityLevel = "silent" | "quiet" | "normal" | "active" | "spike";
export type RoomTrend = "falling" | "stable" | "rising";

export type RoomSignalSource =
  | "chat"
  | "audio"
  | "vision"
  | "platform"
  | "sentiment"
  | "thread"
  | "memory"
  | "agent";

export type RoomActorType = "streamer" | "viewer" | "bot" | "system" | "unknown";

export interface RoomActor {
  type: RoomActorType;
  id?: string;
  displayName?: string;
}

/**
 * Normalized signal. Transient inside the engine (bounded ring); the ids are
 * referenced by moments as evidence. Not persisted as a raw stream.
 */
export interface RoomSignal {
  id: string;
  source: RoomSignalSource;
  kind: string;
  timestamp: number;
  /** 0..1 — how reliable this sensor reading is (not how important). */
  confidence: number;
  actor?: RoomActor;
  payload: Record<string, unknown>;
}

export type RoomMomentKind =
  | "conversation"
  | "reaction"
  | "stream_event"
  | "visual_event"
  | "energy_shift"
  | "agent_event"
  | "quiet"
  | "mixed";

/** A bounded episode where something meaningful changed or persisted. */
export interface RoomMoment {
  id: string;
  /** Channel (lowercased) this moment belongs to. */
  channel: string;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  status: "active" | "closed";
  kind: RoomMomentKind;
  /** 0..1 — how much this mattered. Deterministic. */
  significance: number;
  /** 0..1 — how strongly the evidence agrees this happened. Deterministic. */
  confidence: number;
  sources: RoomSignalSource[];
  signals: {
    chatActivity?: {
      level: RoomActivityLevel;
      rate?: number;
      /** Human messages only, since moment start. */
      humanMessages?: number;
      botMessages?: number;
    };
    sentiment?: { current?: SentimentLabel; trend?: RoomTrend };
    audio?: { energy?: string; delta?: number };
    vision?: { changeMagnitude?: number; tags?: string[] };
    conversation?: {
      activeThreads?: number;
      participants?: string[];
      directMention?: boolean;
    };
    platformEvents?: string[];
    agentActivity?: { botNames?: string[]; sends?: number };
    /** Confirmed spoken callout — the streamer directly addressed a bot
     *  (structured fact routed by the store's Spoken Callout layer). */
    spokenCallout?: { kind: string; targetBotId?: string };
  };
  /** Signal ids that contributed (bounded). */
  evidenceRefs: string[];
  /** Representative human chat lines (bounded, trimmed) — evidence that
   * survives interpretation without storing the whole log. */
  evidenceLines: string[];
  topicHints?: string[];
  /** AI-enriched title. Absent until synthesis (or deterministic fallback). */
  title?: string;
  /** AI-enriched summary. Absent until synthesis. */
  summary?: string;
  provenance: {
    /** Core fields are always deterministic. */
    deterministic: true;
    aiSynthesized: boolean;
    synthesizedAt?: number;
    model?: string;
  };
  updateCount: number;
}

/** Compact, continuously-updated representation of the present. */
export interface RoomState {
  channel: string;
  updatedAt: number;
  activity: {
    level: RoomActivityLevel;
    trend: RoomTrend;
    /** Human messages/min over the last 60s. */
    velocity: number;
  };
  sentiment?: { current: SentimentLabel; trend: RoomTrend };
  audio?: { level: string; updatedAt: number };
  vision?: { tags: string[]; changedAt: number; changeMagnitude?: number };
  transcript?: { updatedAt: number };
  conversation?: {
    activeThreads: number;
    participants: string[];
    streamerEngaged: boolean;
  };
  platformEvents: string[];
  activeMomentId?: string;
  /** Closed moments, newest first (bounded). */
  recentMomentIds: string[];
  freshness: Partial<Record<RoomLane, number>>;
  /** 0..1 — how many lanes have live, non-stale evidence. */
  confidence: number;
}

export type RoomLaneStatus = "unavailable" | "live" | "quiet" | "stale";

/** Structured detail a platform event may carry (parsed or caller-supplied). */
export interface RoomPlatformEventDetail {
  kind: "raid" | "sub" | "resub" | "subgift" | "cheer" | "host" | "follow" | "other";
  actor?: string;
  /** Viewers for raids/hosts, bits for cheers, months for resubs. */
  magnitude?: number;
}

export interface RoomModelSnapshot {
  state: RoomState | null;
  moments: RoomMoment[];
}

// ─── Tuning Constants (exported for tests) ────────────────────────────────────

export const ROOM_MODEL_LIMITS = {
  /** Raw signal ring — transient evidence buffer. */
  maxSignals: 150,
  /** Evidence signal ids per moment. */
  maxEvidenceRefs: 24,
  /** Representative chat lines per moment. */
  maxEvidenceLines: 6,
  /** Hard cap on retained moments per channel session. */
  maxMoments: 60,
  /** Chat line length stored as evidence. */
  maxEvidenceLineLength: 100,
  /** Platform events kept in Room State. */
  maxPlatformEvents: 5,
  /** Participants listed in Room State / moments. */
  maxParticipants: 8,
} as const;

const CHAT_BUCKET_MS = 10_000;
/** Rolling rate window for "now" velocity. */
const CHAT_RATE_WINDOW_MS = 60_000;
/** Baseline window for relative surge detection (repository-derived, per-session). */
const CHAT_BASELINE_WINDOW_MS = 5 * 60_000;
/** Baseline floor so tiny rooms don't divide by ~0. */
const CHAT_BASELINE_FLOOR = 1.5;
/** Human msgs/min considered a surge above baseline. */
const CHAT_SURGE_EXCESS = 8;
/** Human msgs in a 10s bucket that alone indicate a burst. */
const CHAT_BURST_BUCKET = 6;
/** A moment is created when computed significance crosses this. */
const MOMENT_CREATE_THRESHOLD = 0.45;
/** Default fusion window — correlated signals this close join the moment. */
const FUSION_WINDOW_MS = 9_000;
/** Late semantic vision can still enrich a visual moment this late. */
const VISION_LATE_FUSION_MS = 30_000;
/** Conversation moments evolve slowly. */
const CONVERSATION_FUSION_WINDOW_MS = 90_000;
/** Reaction moments close after this much silence. */
const REACTION_IDLE_CLOSE_MS = 60_000;
/** Conversation moments close after this much silence. */
const CONVERSATION_IDLE_CLOSE_MS = 240_000;
/** Stream-event (raid) aftermath absorption window. */
const STREAM_EVENT_FUSION_WINDOW_MS = 30_000;
/** Quiet moment forms after this much human silence (once, bounded). */
const QUIET_AFTER_MS = 5 * 60_000;
/** Minimum gap between quiet moments so silence never spams the timeline. */
const QUIET_MOMENT_COOLDOWN_MS = 10 * 60_000;
/** Platform events dedupe on content hash within this window. */
const PLATFORM_DEDUPE_MS = 15_000;
/** Identical chat lines dedupe within this window (reconnect echoes). */
const CHAT_DEDUPE_MS = 2_000;
/** Conversation heuristic: N human messages from ≥2 users in this window. */
const CONVERSATION_WINDOW_MS = 120_000;
const CONVERSATION_MIN_MESSAGES = 4;
const CONVERSATION_MIN_USERS = 2;
/** Late-arriving agent evidence window. */
const AGENT_FUSION_WINDOW_MS = 30_000;

/** Lane staleness thresholds (age of last evidence, ms). */
export const ROOM_LANE_STALE_MS: Record<RoomLane, number> = {
  chat: 120_000,
  audio: 30_000,
  vision: 120_000,
  platform: 30 * 60_000,
  transcript: 120_000,
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function boundedPush<T>(arr: T[], item: T, max: number): void {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
}

const SENTIMENT_POSITIVE: ReadonlySet<string> = new Set(["positive", "hype", "wholesome"]);
const SENTIMENT_NEGATIVE: ReadonlySet<string> = new Set(["negative", "toxic"]);

/**
 * Deterministic fallback parsing of the formatted stream-event strings
 * ("⚔️ name raided with 47 viewers") so platform events stay structured even
 * when a call site doesn't pass RoomPlatformEventDetail. Best-effort by design.
 */
export function parsePlatformEventSummary(summary: string): RoomPlatformEventDetail {
  const s = summary.toLowerCase();
  const num = (re: RegExp): number | undefined => {
    const m = s.match(re);
    return m ? Number(m[1]) : undefined;
  };
  if (s.includes("raided")) return { kind: "raid", magnitude: num(/with (\d+) viewers?/) };
  if (s.includes("hosted")) return { kind: "host", magnitude: num(/with (\d+) viewers?/) };
  if (s.includes("gifted")) return { kind: "subgift", magnitude: num(/\((\d+) months?\)/) };
  if (s.includes("resubscribed")) return { kind: "resub", magnitude: num(/(\d+) months?/) };
  if (s.includes("subscribed")) return { kind: "sub" };
  if (s.includes("cheered")) return { kind: "cheer", magnitude: num(/cheered (\d+) bits?/) };
  if (s.includes("followed") || s.includes("followed with")) return { kind: "follow" };
  return { kind: "other" };
}

const STOPWORDS = new Set([
  "the", "and", "for", "you", "your", "that", "this", "with", "was", "are", "not",
  "but", "has", "have", "had", "they", "them", "his", "her", "she", "him", "all",
  "can", "will", "just", "get", "got", "how", "what", "who", "why", "when", "out",
  "one", "two", "its", "it's", "about", "into", "from", "were", "there", "their",
  "would", "could", "should", "been", "being", "over", "than", "then", "more",
  "some", "them", "did", "does", "doing", "because", "very", "much", "lmao",
]);

/** Cheap deterministic topic hints from evidence lines + vision tags. */
function extractTopicHints(lines: string[], visionTags: string[]): string[] {
  const counts = new Map<string, number>();
  const bump = (w: string, n: number) => {
    const word = w.toLowerCase();
    if (word.length <= 3 || STOPWORDS.has(word)) return;
    counts.set(word, (counts.get(word) ?? 0) + n);
  };
  for (const tag of visionTags.slice(0, 6)) {
    for (const w of tag.split(/[^a-zA-Z0-9']+/)) bump(w, 2);
  }
  for (const line of lines.slice(0, 6)) {
    for (const w of line.split(/[^a-zA-Z0-9']+/)) bump(w, 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([w]) => w);
}

function activityLevelForRate(ratePerMin: number): RoomActivityLevel {
  if (ratePerMin >= 30) return "spike";
  if (ratePerMin >= 15) return "active";
  if (ratePerMin >= 5) return "normal";
  if (ratePerMin >= 1) return "quiet";
  return "silent";
}

/** Deterministic fallback title so a moment is always human-browsable. */
export function deterministicMomentTitle(moment: RoomMoment): string {
  const s = moment.signals;
  if (s.platformEvents && s.platformEvents.length > 0) {
    return s.platformEvents[s.platformEvents.length - 1].slice(0, 60);
  }
  switch (moment.kind) {
    case "reaction": {
      const parts: string[] = [];
      if (s.chatActivity?.level) parts.push(`chat ${s.chatActivity.level}`);
      if (s.audio?.energy) parts.push(`audio ${s.audio.energy}`);
      if (s.vision?.changeMagnitude != null) parts.push("visual change");
      return parts.length > 0 ? parts.join(" + ") + " surge" : "reaction";
    }
    case "conversation":
      return `conversation (${s.conversation?.participants?.length ?? s.chatActivity?.humanMessages ?? 0} participants)`;
    case "visual_event":
      return s.vision?.tags?.length ? `visual: ${s.vision.tags.slice(0, 2).join(", ")}` : "visual change";
    case "energy_shift":
      return `audio ${s.audio?.energy ?? "shift"}`;
    case "agent_event":
      return "bot activity";
    case "quiet":
      return "quiet period";
    default:
      return moment.kind.replace("_", " ");
  }
}

// ─── Engine ───────────────────────────────────────────────────────────────────

interface ChatBucket {
  human: number;
  bot: number;
}

interface LaneTracker {
  lastSignalAt: number | null;
}

/**
 * The deterministic Room Model engine. One instance per session; the module
 * exports a singleton (`roomModel`) because ingestion happens from store
 * actions and App.tsx which have no React scope of their own. The engine is
 * reset on channel switch (clearAllContext) and restored from channel
 * snapshots (restoreChannelSnapshot).
 */
export class RoomModelEngine {
  private channel: string | null = null;
  private startedAt = 0;

  private signals: RoomSignal[] = [];
  private signalIndex = new Map<string, RoomSignal>();

  private moments: RoomMoment[] = [];
  private activeMomentId: string | null = null;

  // Chat rolling stats (human vs bot separated).
  private chatBuckets = new Map<number, ChatBucket>();
  private humanMessageCount = 0;
  private botMessageCount = 0;
  private lastHumanChatAt: number | null = null;
  private lastChatDedupe: { key: string; at: number } | null = null;

  // Lane trackers.
  private lanes: Record<RoomLane, LaneTracker> = {
    chat: { lastSignalAt: null },
    audio: { lastSignalAt: null },
    vision: { lastSignalAt: null },
    platform: { lastSignalAt: null },
    transcript: { lastSignalAt: null },
  };
  private lastAudioEnergy: { label: string; rms?: number; at: number } | null = null;
  private lastVision: { tags: string[]; delta?: number; at: number } | null = null;
  private lastTranscriptAt: number | null = null;
  private platformEvents: { summary: string; kind: string; magnitude?: number; at: number }[] = [];
  private platformEventHashes = new Map<string, number>();
  private lastConversation: {
    activeThreads: number;
    participants: string[];
    directMention: boolean;
    at: number;
  } | null = null;

  // Human sentiment ring (recent labels for trend + shift detection).
  private sentimentRing: { label: SentimentLabel; at: number }[] = [];
  private lastSentimentShiftAt: number | null = null;
  private lastSentimentShift: { from: SentimentLabel; to: SentimentLabel } | null = null;

  // Conversation heuristic state.
  private conversationWindow: { user: string; at: number }[] = [];
  private conversationMomentOpenSince: number | null = null;

  // Quiet handling.
  private lastQuietMomentAt: number | null = null;

  // Participants (recent humans).
  private recentParticipants: { user: string; at: number }[] = [];

  // State cache + dirty flag (flushed by the hook's tick).
  private stateCache: RoomState | null = null;
  private dirty = true;

  // Closed high-significance moments queued for optional AI synthesis.
  private synthesisQueue: string[] = [];

  /** Monotonic in-session counter for signal ids (stable, cheap). */
  private signalSeq = 0;

  // ─── Session lifecycle ───────────────────────────────────────────────────

  /** Bind to a session. Called by the hook when the channel becomes known. */
  setChannel(channel: string | null): void {
    const normalized = channel ? channel.trim().toLowerCase() : null;
    if (normalized === this.channel) return;
    this.resetInternal(normalized);
  }

  getChannel(): string | null {
    return this.channel;
  }

  /** Full reset — new session, nothing survives (clearAllContext parity). */
  reset(channel?: string | null): void {
    this.resetInternal(channel ? channel.trim().toLowerCase() : null);
  }

  private resetInternal(channel: string | null): void {
    this.channel = channel;
    this.startedAt = channel ? Date.now() : 0;
    this.signals = [];
    this.signalIndex.clear();
    this.moments = [];
    this.activeMomentId = null;
    this.chatBuckets.clear();
    this.humanMessageCount = 0;
    this.botMessageCount = 0;
    this.lastHumanChatAt = null;
    this.lastChatDedupe = null;
    for (const lane of Object.keys(this.lanes) as RoomLane[]) this.lanes[lane].lastSignalAt = null;
    this.lastAudioEnergy = null;
    this.lastVision = null;
    this.lastTranscriptAt = null;
    this.platformEvents = [];
    this.platformEventHashes.clear();
    this.lastConversation = null;
    this.sentimentRing = [];
    this.lastSentimentShiftAt = null;
    this.lastSentimentShift = null;
    this.conversationWindow = [];
    this.conversationMomentOpenSince = null;
    this.lastQuietMomentAt = null;
    this.recentParticipants = [];
    this.stateCache = null;
    this.dirty = true;
    this.synthesisQueue = [];
    this.signalSeq = 0;
  }

  /**
   * Restore historical moments from a channel snapshot. Per stream-restart
   * semantics: moments survive as history (an active moment is force-closed —
   * it happened, but the live session starts fresh), and all volatile state
   * (active moment, freshness, trends, baselines) resets.
   */
  restore(channel: string, snapshot: RoomModelSnapshot | undefined | null): void {
    const normalized = channel.trim().toLowerCase();
    this.resetInternal(normalized);
    if (!snapshot?.moments) return;
    const now = Date.now();
    // Sanitize + bound: this channel only, valid entries only.
    const restored = snapshot.moments
      .filter((m) => m && typeof m.id === "string" && Number.isFinite(m.startedAt) &&
        (m.channel ?? normalized) === normalized)
      .slice(-ROOM_MODEL_LIMITS.maxMoments)
      .map((m) => ({
        ...m,
        channel: normalized,
        // Force-close: yesterday's live moment never merges into today's.
        status: "closed" as const,
        endedAt: m.endedAt ?? m.updatedAt,
        evidenceRefs: Array.isArray(m.evidenceRefs) ? m.evidenceRefs.slice(0, ROOM_MODEL_LIMITS.maxEvidenceRefs) : [],
        evidenceLines: Array.isArray(m.evidenceLines) ? m.evidenceLines.slice(0, ROOM_MODEL_LIMITS.maxEvidenceLines) : [],
        topicHints: Array.isArray(m.topicHints) ? m.topicHints.slice(0, 3) : undefined,
        // Strip any half-written synthesis state defensively.
        provenance: {
          deterministic: true as const,
          aiSynthesized: !!m.provenance?.aiSynthesized,
          synthesizedAt: m.provenance?.synthesizedAt,
          model: m.provenance?.model,
        },
      }));
    this.moments = restored;
    // Treat the restore point as "now" so quiet-moment cooldown doesn't fire
    // a fresh quiet moment immediately for restored history.
    if (restored.length > 0) this.lastQuietMomentAt = now;
    this.dirty = true;
  }

  // ─── Ingestion (sensor notes) ────────────────────────────────────────────

  /** Human or foreign chat message. `isBot` marks non-human senders. */
  noteChat(note: {
    username: string;
    text: string;
    sentimentLabel?: SentimentLabel;
    isBot?: boolean;
    /** Line mentions/targets a MADchatter bot account. */
    isMention?: boolean;
    timestamp?: number;
  }): void {
    if (!this.channel || !note.username) return;
    const at = note.timestamp ?? Date.now();
    const key = `${note.username.toLowerCase()}::${note.text}`;
    if (this.lastChatDedupe && this.lastChatDedupe.key === key && at - this.lastChatDedupe.at < CHAT_DEDUPE_MS) {
      return; // reconnect echo
    }
    this.lastChatDedupe = { key, at };

    this.trackLane("chat", at);
    if (!note.isBot) this.lastHumanChatAt = at;
    this.bumpChatBucket(at, !!note.isBot);
    if (note.isBot) {
      this.botMessageCount++;
    } else {
      // Human activity resumes → an active quiet moment ends immediately
      // (it exists only to bound silence in session history).
      const activeNow = this.getActiveMoment();
      if (activeNow && activeNow.kind === "quiet") this.closeMoment(activeNow, at);
      this.humanMessageCount++;
      boundedPush(this.recentParticipants, { user: note.username, at }, 60);
      this.recentParticipants = this.recentParticipants.filter((p) => at - p.at < CHAT_RATE_WINDOW_MS + CHAT_BASELINE_WINDOW_MS);
      if (note.sentimentLabel) {
        boundedPush(this.sentimentRing, { label: note.sentimentLabel, at }, 30);
        this.detectSentimentShift(at);
      }
      boundedPush(this.conversationWindow, { user: note.username, at }, 64);
      this.conversationWindow = this.conversationWindow.filter((m) => at - m.at < CONVERSATION_WINDOW_MS);
    }

    const signal: RoomSignal = {
      id: `sig_${++this.signalSeq}_${generateId().slice(0, 8)}`,
      source: "chat",
      kind: note.isBot ? "chat_bot" : "chat_message",
      timestamp: at,
      confidence: 0.95,
      actor: { type: note.isBot ? "bot" : "viewer", displayName: note.username },
      payload: { username: note.username, text: note.text.slice(0, 200), sentiment: note.sentimentLabel, mention: !!note.isMention },
    };
    this.pushSignal(signal);

    if (!note.isBot) {
      this.evaluateChatSurge(at);
      this.evaluateConversation(at);
    }
    this.dirty = true;
  }

  /** MADchatter's own send (any bot account, any source). Agent activity —
   *  recorded, attributed, but never able to inflate human room state. */
  noteAgentSend(note: { botName?: string; message?: string; source?: string; timestamp?: number }): void {
    if (!this.channel) return;
    const at = note.timestamp ?? Date.now();
    this.trackLane("chat", at); // bot messages are chat-lane activity, but not human
    const signal: RoomSignal = {
      id: `sig_${++this.signalSeq}_${generateId().slice(0, 8)}`,
      source: "agent",
      kind: "agent_send",
      timestamp: at,
      confidence: 1,
      actor: { type: "bot", displayName: note.botName },
      payload: { source: note.source ?? "autoforge", message: (note.message ?? "").slice(0, 120) },
    };
    this.pushSignal(signal);
    // Absorb into an active compatible moment as agent evidence; never creates.
    this.absorbIntoActive(signal, ["reaction", "conversation", "stream_event", "mixed"], AGENT_FUSION_WINDOW_MS);
    this.dirty = true;
  }

  noteAudioEnergy(note: { label: string; rms?: number; timestamp?: number }): void {
    if (!this.channel) return;
    const at = note.timestamp ?? Date.now();
    this.trackLane("audio", at);
    const prev = this.lastAudioEnergy;
    this.lastAudioEnergy = { label: note.label, rms: note.rms, at };

    // Only loud→spike transitions are events — steady "loud" is not news.
    const isSpike = note.label === "spike";
    const jumped = prev ? (prev.label === "quiet" || prev.label === "silent") && (note.label === "loud" || isSpike) : false;
    if (!isSpike && !jumped) {
      this.dirty = true;
      return;
    }
    const signal: RoomSignal = {
      id: `sig_${++this.signalSeq}_${generateId().slice(0, 8)}`,
      source: "audio",
      kind: "audio_energy_spike",
      timestamp: at,
      confidence: 0.8,
      actor: { type: "streamer" },
      payload: { label: note.label, rms: note.rms, previous: prev?.label },
    };
    this.pushSignal(signal);
    this.processEvent(signal, this.scoreAudioSpike(jumped), "energy_shift", FUSION_WINDOW_MS);
    this.dirty = true;
  }

  noteVision(note: { tags: string[]; delta?: number; source?: "manual" | "auto"; timestamp?: number }): void {
    if (!this.channel) return;
    const at = note.timestamp ?? Date.now();
    this.trackLane("vision", at);
    const prev = this.lastVision;
    const semanticChange = !prev || prev.tags.join("|") !== note.tags.join("|");
    this.lastVision = { tags: note.tags.slice(0, 12), delta: note.delta, at };

    // Frame-level change (delta) OR first semantic observation is an event.
    const bigDelta = note.delta != null && note.delta >= 0.08;
    if (!bigDelta && !semanticChange) {
      this.dirty = true;
      return;
    }
    // Stale-tag refreshes ("Unchanged frame") never create events.
    const meaningfulTags = note.tags.filter((t) => !/^unchanged frame$/i.test(t));
    if (!bigDelta && meaningfulTags.length === 0) {
      this.dirty = true;
      return;
    }
    const signal: RoomSignal = {
      id: `sig_${++this.signalSeq}_${generateId().slice(0, 8)}`,
      source: "vision",
      kind: bigDelta ? "vision_delta" : "vision_observation",
      timestamp: at,
      confidence: 0.85,
      actor: { type: "system" },
      payload: { tags: meaningfulTags.slice(0, 8), delta: note.delta, source: note.source ?? "auto" },
    };
    this.pushSignal(signal);
    // Semantic-only observations enrich but rarely create; a real frame
    // change can create a visual moment on its own.
    const score = bigDelta ? this.scoreVisionDelta(note.delta ?? 0) : 0.2;
    this.processEvent(signal, score, "visual_event", bigDelta ? FUSION_WINDOW_MS : VISION_LATE_FUSION_MS);
    this.dirty = true;
  }

  /**
   * Forget only the current/live visual observation. Historical moments and
   * every non-vision lane remain intact: deleting a screenshot changes what
   * the system may use now, not what previously happened in the room.
   */
  clearVision(): void {
    this.lastVision = null;
    this.lanes.vision.lastSignalAt = null;
    this.stateCache = null;
    this.dirty = true;
  }

  notePlatformEvent(note: {
    summary: string;
    detail?: RoomPlatformEventDetail;
    timestamp?: number;
  }): void {
    if (!this.channel) return;
    const at = note.timestamp ?? Date.now();
    // Dedupe identical events within a window (platform reconnect replays).
    const hash = `${note.detail?.kind ?? "other"}::${note.summary}`;
    const lastAt = this.platformEventHashes.get(hash);
    if (lastAt != null && at - lastAt < PLATFORM_DEDUPE_MS) return;
    this.platformEventHashes.set(hash, at);

    const detail = note.detail ?? parsePlatformEventSummary(note.summary);
    this.trackLane("platform", at);
    boundedPush(
      this.platformEvents,
      { summary: note.summary, kind: detail.kind, magnitude: detail.magnitude, at },
      ROOM_MODEL_LIMITS.maxPlatformEvents * 2,
    );
    const signal: RoomSignal = {
      id: `sig_${++this.signalSeq}_${generateId().slice(0, 8)}`,
      source: "platform",
      kind: `platform_${detail.kind}`,
      timestamp: at,
      confidence: 0.98, // platform events are deterministic facts
      actor: { type: "viewer", displayName: detail.actor },
      payload: { summary: note.summary.slice(0, 160), kind: detail.kind, magnitude: detail.magnitude },
    };
    this.pushSignal(signal);
    // Platform events anchor a moment independently of other sensors.
    this.processEvent(signal, this.scorePlatformEvent(detail), "stream_event", STREAM_EVENT_FUSION_WINDOW_MS);
    this.dirty = true;
  }

  /** Streamer speech segment (whisper/deepgram line). */
  noteTranscript(note: { text: string; timestamp?: number }): void {
    if (!this.channel) return;
    const at = note.timestamp ?? Date.now();
    this.trackLane("transcript", at);
    this.lastTranscriptAt = at;
    const signal: RoomSignal = {
      id: `sig_${++this.signalSeq}_${generateId().slice(0, 8)}`,
      source: "audio",
      kind: "transcript_line",
      timestamp: at,
      confidence: 0.85,
      actor: { type: "streamer" },
      payload: { text: note.text.slice(0, 200) },
    };
    this.pushSignal(signal);
    // Transcript alone never creates a moment; it enriches active ones
    // (a loud moment + "OH MY GOD" transcript = stronger reaction evidence).
    this.absorbIntoActive(signal, ["reaction", "conversation", "stream_event", "energy_shift", "mixed"], CONVERSATION_FUSION_WINDOW_MS);
    this.dirty = true;
  }

  /**
   * Confirmed spoken callout — a structured address fact, not prose to
   * re-derive. The store's Spoken Callout layer (spokenCallout.ts) already
   * classified, confirmed, and routed the utterance; recording it here lets
   * the active moment cite the direct address (and its target) explicitly so
   * AI synthesis never has to re-parse the raw transcript. Never creates a
   * moment on its own — chat/energy evidence must back the moment.
   */
  noteSpokenCallout(note: { targetBotId?: string; kind: string; text: string; timestamp?: number }): void {
    if (!this.channel) return;
    const at = note.timestamp ?? Date.now();
    const signal: RoomSignal = {
      id: `sig_${++this.signalSeq}_${generateId().slice(0, 8)}`,
      source: "audio",
      kind: "spoken_callout",
      timestamp: at,
      confidence: 0.9,
      actor: { type: "streamer" },
      payload: { kind: note.kind, targetBotId: note.targetBotId, text: note.text.slice(0, 200) },
    };
    this.pushSignal(signal);
    // Absorb into an active compatible moment — a callout landing during a
    // live conversation/reaction is direct-address evidence for it.
    this.absorbIntoActive(signal, ["conversation", "reaction", "stream_event", "energy_shift", "mixed"], CONVERSATION_FUSION_WINDOW_MS);
    this.dirty = true;
  }

  /** Conversation/thread facts, refreshed by the wiring hook (~1s). */
  noteConversation(note: {
    activeThreads: number;
    participants?: string[];
    directMention?: boolean;
    timestamp?: number;
  }): void {
    if (!this.channel) return;
    const at = note.timestamp ?? Date.now();
    const threadsGrew = !!this.lastConversation && note.activeThreads > this.lastConversation.activeThreads;
    this.lastConversation = {
      activeThreads: note.activeThreads,
      participants: (note.participants ?? []).slice(0, ROOM_MODEL_LIMITS.maxParticipants),
      directMention: !!note.directMention,
      at,
    };
    if (threadsGrew && note.activeThreads > 0) {
      const signal: RoomSignal = {
        id: `sig_${++this.signalSeq}_${generateId().slice(0, 8)}`,
        source: "thread",
        kind: "thread_activity",
        timestamp: at,
        confidence: 0.7,
        payload: { activeThreads: note.activeThreads },
      };
      this.pushSignal(signal);
      // Thread growth enriches an active conversation; low score so it
      // never creates a moment alone (chat evidence must back it).
      this.absorbIntoActive(signal, ["conversation", "reaction", "stream_event", "mixed"], CONVERSATION_FUSION_WINDOW_MS);
    }
    this.dirty = true;
  }

  // ─── Lifecycle / maintenance ──────────────────────────────────────────────

  /** Called ~1/s by the wiring hook. Closes idle moments, forms bounded
   *  quiet moments, enforces retention. Deterministic — no AI. */
  tick(now: number = Date.now()): void {
    if (!this.channel) return;
    let changed = false;

    // 1. Close idle active moments.
    const active = this.getActiveMoment();
    if (active) {
      const idleWindow = active.kind === "conversation" ? CONVERSATION_IDLE_CLOSE_MS : REACTION_IDLE_CLOSE_MS;
      if (now - active.updatedAt > idleWindow) {
        this.closeMoment(active, now);
        changed = true;
      }
    }

    // 2. Bounded quiet moment: silence after real activity becomes ONE
    //    quiet moment (never a stream of them).
    if (!this.activeMomentId &&
      this.humanMessageCount > 0 &&
      this.lastHumanChatAt != null &&
      now - this.lastHumanChatAt > QUIET_AFTER_MS &&
      (this.lastQuietMomentAt == null || now - this.lastQuietMomentAt > QUIET_MOMENT_COOLDOWN_MS)) {
      const quiet: RoomMoment = {
        id: `moment_${generateId()}`,
        channel: this.channel,
        startedAt: this.lastHumanChatAt,
        updatedAt: now,
        endedAt: undefined,
        status: "active",
        kind: "quiet",
        significance: 0.1,
        confidence: 0.6,
        sources: ["chat"],
        signals: { chatActivity: { level: "silent", humanMessages: 0 } },
        evidenceRefs: [],
        evidenceLines: [],
        provenance: { deterministic: true, aiSynthesized: false },
        updateCount: 0,
      };
      this.moments.push(quiet);
      this.activeMomentId = quiet.id;
      this.lastQuietMomentAt = now;
      changed = true;
    }

    // 3. Retention: hard cap + drop oldest low-significance first.
    if (this.moments.length > ROOM_MODEL_LIMITS.maxMoments) {
      // Never drop the active moment.
      const droppable = this.moments.filter((m) => m.id !== this.activeMomentId);
      while (this.moments.length > ROOM_MODEL_LIMITS.maxMoments && droppable.length > 0) {
        // Oldest first — the timeline is chronological history.
        const oldest = droppable.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b));
        this.moments = this.moments.filter((m) => m.id !== oldest.id);
        droppable.splice(droppable.indexOf(oldest), 1);
      }
      changed = true;
    }

    if (changed) this.dirty = true;
    if (this.dirty) {
      this.stateCache = this.buildState(now);
      this.dirty = false;
    }
  }

  // ─── Reads ───────────────────────────────────────────────────────────────

  /** Current Room State. Builds (and caches) on demand if a tick was missed. */
  getState(): RoomState | null {
    if (!this.channel) return null;
    if (this.dirty || !this.stateCache) {
      this.stateCache = this.buildState(Date.now());
      this.dirty = false;
    }
    return this.stateCache;
  }

  /** All retained moments, oldest → newest. Returns a frozen shallow copy. */
  getMoments(): RoomMoment[] {
    return this.moments.map((m) => ({ ...m }));
  }

  getActiveMoment(): RoomMoment | null {
    if (!this.activeMomentId) return null;
    return this.moments.find((m) => m.id === this.activeMomentId && m.status === "active") ?? null;
  }

  /** Snapshot for channel persistence (IndexedDB). Bounded by construction. */
  exportSnapshot(): RoomModelSnapshot {
    return {
      state: this.getState(),
      moments: this.getMoments(),
    };
  }

  /** Drain moments queued for optional AI synthesis (ids, newest first). */
  hasPendingSynthesis(): boolean { return this.synthesisQueue.length > 0; }

  drainSynthesisQueue(): string[] {
    const q = this.synthesisQueue;
    this.synthesisQueue = [];
    return q;
  }

  getMomentById(id: string): RoomMoment | null {
    return this.moments.find((m) => m.id === id) ?? null;
  }

  /**
   * Apply AI synthesis to a CLOSED moment. Channel-guarded and idempotent —
   * a late or stale synthesis result can only fill semantic fields on a
   * moment that still exists on the current channel, exactly once. It can
   * never touch deterministic fields (kind, significance, confidence,
   * evidence, lifecycle).
   */
  applySynthesis(
    momentId: string,
    channel: string,
    synthesis: { title?: string; summary?: string; topicHints?: string[]; model?: string },
  ): boolean {
    if (!this.channel || this.channel !== channel.trim().toLowerCase()) return false;
    const moment = this.moments.find((m) => m.id === momentId);
    if (!moment || moment.status !== "closed" || moment.provenance.aiSynthesized) return false;
    const title = synthesis.title?.trim().slice(0, 80);
    const summary = synthesis.summary?.trim().slice(0, 400);
    if (title) moment.title = title;
    if (summary) moment.summary = summary;
    if (Array.isArray(synthesis.topicHints) && synthesis.topicHints.length > 0) {
      const hints = synthesis.topicHints.map((h) => String(h).slice(0, 30)).slice(0, 5);
      moment.topicHints = [...new Set([...(moment.topicHints ?? []), ...hints])].slice(0, 5);
    }
    moment.provenance = {
      deterministic: true,
      aiSynthesized: true,
      synthesizedAt: Date.now(),
      model: synthesis.model,
    };
    this.dirty = true;
    return true;
  }

  /** Developer diagnostics (observability). Never includes raw payloads. */
  getDiagnostics(): Record<string, unknown> {
    const state = this.getState();
    const active = this.getActiveMoment();
    return {
      channel: this.channel,
      updatedAt: state?.updatedAt ?? 0,
      activity: state ? { level: state.activity.level, trend: state.activity.trend, velocity: state.activity.velocity } : null,
      freshness: state
        ? Object.fromEntries(
            Object.entries(state.freshness).map(([lane, at]) => [`${lane}Ms`, at ? state.updatedAt - at : null]),
          )
        : {},
      activeMoment: active
        ? {
            id: active.id,
            kind: active.kind,
            significance: active.significance,
            confidence: active.confidence,
            ageMs: state ? state.updatedAt - active.startedAt : 0,
            sources: active.sources,
          }
        : null,
      recentMomentCount: this.moments.length,
      humanMessages: this.humanMessageCount,
      botMessages: this.botMessageCount,
    };
  }

  // ─── Internal: signal plumbing ────────────────────────────────────────────

  private trackLane(lane: RoomLane, at: number): void {
    this.lanes[lane].lastSignalAt = at;
  }

  private pushSignal(signal: RoomSignal): void {
    this.signals.push(signal);
    this.signalIndex.set(signal.id, signal);
    if (this.signals.length > ROOM_MODEL_LIMITS.maxSignals) {
      const removed = this.signals.splice(0, this.signals.length - ROOM_MODEL_LIMITS.maxSignals);
      for (const r of removed) this.signalIndex.delete(r.id);
    }
  }

  private bumpChatBucket(at: number, isBot: boolean): void {
    const bucket = Math.floor(at / CHAT_BUCKET_MS);
    let entry = this.chatBuckets.get(bucket);
    if (!entry) {
      entry = { human: 0, bot: 0 };
      this.chatBuckets.set(bucket, entry);
    }
    if (isBot) entry.bot++;
    else entry.human++;
    // Prune buckets older than the baseline window.
    const minBucket = Math.floor((at - CHAT_BASELINE_WINDOW_MS) / CHAT_BUCKET_MS);
    for (const key of this.chatBuckets.keys()) {
      if (key < minBucket) this.chatBuckets.delete(key);
    }
  }

  private humanRate(now: number, windowMs: number): number {
    const minBucket = Math.floor((now - windowMs) / CHAT_BUCKET_MS);
    const maxBucket = Math.floor(now / CHAT_BUCKET_MS);
    let count = 0;
    for (const [bucket, entry] of this.chatBuckets) {
      if (bucket >= minBucket && bucket <= maxBucket) count += entry.human;
    }
    return windowMs > 0 ? (count / windowMs) * 60_000 : 0;
  }

  /** Repository-derived baseline: mean human msgs/min over the baseline window. */
  private chatBaseline(now: number): number {
    return this.humanRate(now, CHAT_BASELINE_WINDOW_MS);
  }

  // ─── Internal: event scoring (deterministic) ─────────────────────────────

  private scoreAudioSpike(jumpedFromQuiet: boolean): number {
    // A loud spike is meaningful but must not alone equal a major moment.
    return jumpedFromQuiet ? 0.55 : 0.5;
  }

  private scoreVisionDelta(delta: number): number {
    if (delta >= 0.35) return 0.55;
    if (delta >= 0.15) return 0.42;
    if (delta >= 0.08) return 0.3;
    return 0.15;
  }

  private scorePlatformEvent(detail: RoomPlatformEventDetail): number {
    switch (detail.kind) {
      case "raid":
        return detail.magnitude != null && detail.magnitude >= 50 ? 0.95 : 0.8;
      case "cheer":
        return detail.magnitude != null && detail.magnitude >= 1000 ? 0.8 : 0.6;
      case "sub":
      case "resub":
      case "subgift":
      case "host":
        return 0.6;
      default:
        return 0.35;
    }
  }

  /** Cross-signal confidence: distinct live lanes agreeing in the recent window. */
  private crossSignalConfidence(now: number, sources: RoomSignalSource[]): number {
    const distinct = new Set(sources).size;
    let base = 0.55 + Math.min(0.35, (distinct - 1) * 0.12);
    // Fresh evidence across lanes raises confidence.
    const liveLanes = (["chat", "audio", "vision", "platform"] as RoomLane[]).filter(
      (lane) => this.lanes[lane].lastSignalAt != null && now - this.lanes[lane].lastSignalAt! < 2 * FUSION_WINDOW_MS,
    ).length;
    base += Math.min(0.1, liveLanes * 0.025);
    // Platform events are deterministic platform facts — their occurrence
    // (not their interpretation) deserves near-certain confidence.
    if (sources.includes("platform")) base = Math.max(base, 0.95);
    return clamp01(base);
  }

  // ─── Internal: detection heuristics ──────────────────────────────────────

  /** Chat surge: human rate significantly above the session baseline. */
  private evaluateChatSurge(at: number): void {
    const recentRate = this.humanRate(at, 15_000);
    const rate = this.humanRate(at, CHAT_RATE_WINDOW_MS);
    const baseline = Math.max(this.chatBaseline(at), CHAT_BASELINE_FLOOR);
    const burstBucket = this.chatBuckets.get(Math.floor(at / CHAT_BUCKET_MS))?.human ?? 0;
    const excess = rate - baseline;
    const isSurge = excess >= CHAT_SURGE_EXCESS || burstBucket >= CHAT_BURST_BUCKET;
    if (!isSurge) return;
    // Significance from both absolute rate and relative excess over baseline.
    const score = clamp01(0.35 + 0.4 * clamp01(rate / 30) + 0.25 * clamp01(excess / 20));
    const signal: RoomSignal = {
      id: `sig_${++this.signalSeq}_${generateId().slice(0, 8)}`,
      source: "chat",
      kind: "chat_surge",
      timestamp: at,
      confidence: 0.8,
      payload: { rate, baseline: Math.round(baseline * 10) / 10, excess: Math.round(excess * 10) / 10, burstBucket, recentRate: Math.round(recentRate * 10) / 10 },
    };
    this.pushSignal(signal);
    this.processEvent(signal, score, "reaction", FUSION_WINDOW_MS);
  }

  /** Quiet-but-meaningful conversation: N human messages from ≥2 users. */
  private evaluateConversation(at: number): void {
    const window = this.conversationWindow;
    if (window.length < CONVERSATION_MIN_MESSAGES) return;
    const users = new Set(window.map((m) => m.user.toLowerCase()));
    if (users.size < CONVERSATION_MIN_USERS) return;
    // Already tracked by an active/recent conversation moment?
    if (this.conversationMomentOpenSince != null && at - this.conversationMomentOpenSince < CONVERSATION_IDLE_CLOSE_MS) {
      // Enrich the active conversation moment with new evidence.
      const active = this.getActiveMoment();
      if (active && active.kind === "conversation") {
        this.absorbIntoActive(
          { id: `sig_${++this.signalSeq}_${generateId().slice(0, 8)}`, source: "thread", kind: "conversation_heartbeat", timestamp: at, confidence: 0.7, payload: { users: users.size, messages: window.length } },
          ["conversation"],
          CONVERSATION_FUSION_WINDOW_MS,
        );
      }
      return;
    }
    const rate = this.humanRate(at, CONVERSATION_WINDOW_MS);
    const signal: RoomSignal = {
      id: `sig_${++this.signalSeq}_${generateId().slice(0, 8)}`,
      source: "chat",
      kind: "conversation_formed",
      timestamp: at,
      confidence: 0.75,
      payload: { users: users.size, messages: window.length, rate: Math.round(rate * 10) / 10 },
    };
    this.pushSignal(signal);
    // Low velocity doesn't disqualify importance — the score reflects
    // sustained multi-party exchange, not raw speed.
    const score = clamp01(0.4 + 0.15 * clamp01(users.size / 6) + 0.15 * clamp01(window.length / 20));
    this.conversationMomentOpenSince = at;
    this.processEvent(signal, score, "conversation", CONVERSATION_FUSION_WINDOW_MS);
  }

  private detectSentimentShift(at: number): void {
    const ring = this.sentimentRing;
    if (ring.length < 12) return;
    const last10 = ring.slice(-10);
    const prev10 = ring.slice(-20, -10);
    if (prev10.length < 6) return;
    const dominant = (items: { label: SentimentLabel }[]): SentimentLabel => {
      const counts = new Map<SentimentLabel, number>();
      for (const r of items) counts.set(r.label, (counts.get(r.label) ?? 0) + 1);
      return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    };
    const prevDom = dominant(prev10);
    const lastDom = dominant(last10);
    if (prevDom === lastDom) return;
    // Only meaningful flips (polarity change), not neutral label churn.
    const polarity = (l: SentimentLabel) => (SENTIMENT_POSITIVE.has(l) ? 1 : SENTIMENT_NEGATIVE.has(l) ? -1 : 0);
    if (polarity(prevDom) === polarity(lastDom)) return;
    if (this.lastSentimentShiftAt != null && at - this.lastSentimentShiftAt < 30_000) return;
    this.lastSentimentShiftAt = at;
    this.lastSentimentShift = { from: prevDom, to: lastDom };
    const signal: RoomSignal = {
      id: `sig_${++this.signalSeq}_${generateId().slice(0, 8)}`,
      source: "sentiment",
      kind: "sentiment_shift",
      timestamp: at,
      confidence: 0.7,
      payload: { from: prevDom, to: lastDom },
    };
    this.pushSignal(signal);
    // Enriches an active moment; alone it's a medium event.
    this.processEvent(signal, 0.45, "mixed", FUSION_WINDOW_MS);
  }

  // ─── Internal: fusion + moment lifecycle ─────────────────────────────────

  /**
   * The deterministic fusion core. An incoming scored event either:
   *  1. merges into the active compatible moment (fusion window),
   *  2. closes an incompatible active moment and starts a new one (when the
   *     score crosses the creation threshold), or
   *  3. updates Room State only.
   */
  private processEvent(
    signal: RoomSignal,
    score: number,
    preferredKind: RoomMomentKind,
    fusionWindowMs: number,
  ): void {
    if (!this.channel) return;
    const now = signal.timestamp;
    const active = this.getActiveMoment();

    // A quiet moment ends the moment activity resumes — it exists only to
    // bound silence in session history.
    if (active && active.kind === "quiet") {
      this.closeMoment(active, now);
    } else if (active) {
      const compatible = this.isCompatible(active, signal, now, fusionWindowMs);
      if (compatible) {
        this.mergeIntoMoment(active, signal, score, now);
        return;
      }
    }

    if (score < MOMENT_CREATE_THRESHOLD) {
      return; // Room State only — the signal is already tracked.
    }

    // Incompatible active moment + a new significant event → close old, start new.
    const stillActive = this.getActiveMoment();
    if (stillActive) this.closeMoment(stillActive, now);

    const moment = this.createMoment(signal, preferredKind, score, now);
    if (moment) {
      this.activeMomentId = moment.id;
      if (moment.kind === "conversation") this.conversationMomentOpenSince = now;
    }
  }

  /** Late-arriving evidence enriches an active moment but never creates one. */
  private absorbIntoActive(signal: RoomSignal, kinds: RoomMomentKind[], windowMs: number): void {
    const active = this.getActiveMoment();
    if (!active || !kinds.includes(active.kind)) return;
    if (signal.timestamp - active.updatedAt > windowMs && signal.timestamp - active.startedAt > windowMs) return;
    this.mergeIntoMoment(active, signal, 0.25, signal.timestamp);
  }

  private isCompatible(moment: RoomMoment, signal: RoomSignal, now: number, incomingWindowMs: number): boolean {
    const sinceUpdate = now - moment.updatedAt;
    // Stream events absorb everything nearby (raid aftermath).
    if (moment.kind === "stream_event") return sinceUpdate <= STREAM_EVENT_FUSION_WINDOW_MS;
    // Conversations evolve slowly.
    if (moment.kind === "conversation") {
      if (signal.source === "chat" || signal.source === "thread" || signal.source === "sentiment") {
        return sinceUpdate <= CONVERSATION_FUSION_WINDOW_MS;
      }
      return sinceUpdate <= FUSION_WINDOW_MS;
    }
    // Reaction / visual / energy / mixed moments fuse on the incoming window.
    return sinceUpdate <= incomingWindowMs;
  }

  private createMoment(signal: RoomSignal, kind: RoomMomentKind, score: number, now: number): RoomMoment | null {
    const moment: RoomMoment = {
      id: `moment_${generateId()}`,
      channel: this.channel!,
      startedAt: now,
      updatedAt: now,
      status: "active",
      kind,
      significance: clamp01(score),
      confidence: this.crossSignalConfidence(now, [signal.source]),
      sources: [signal.source],
      signals: {},
      evidenceRefs: [signal.id],
      evidenceLines: [],
      provenance: { deterministic: true, aiSynthesized: false },
      updateCount: 1,
    };
    this.applySignalToMomentBlocks(moment, signal, now);
    this.moments.push(moment);
    this.dirty = true;
    return moment;
  }

  private mergeIntoMoment(moment: RoomMoment, signal: RoomSignal, score: number, now: number): void {
    // Significance: max keeps the peak; the small accumulation bonus rewards
    // sustained multi-evidence moments without runaway growth.
    moment.significance = clamp01(Math.max(moment.significance, score) + 0.02 * Math.min(5, moment.updateCount));
    moment.confidence = this.crossSignalConfidence(now, [...moment.sources, signal.source]);
    moment.updatedAt = now;
    moment.updateCount++;
    if (!moment.sources.includes(signal.source)) moment.sources.push(signal.source);
    if (moment.evidenceRefs.length < ROOM_MODEL_LIMITS.maxEvidenceRefs) moment.evidenceRefs.push(signal.id);
    this.applySignalToMomentBlocks(moment, signal, now);
    this.dirty = true;
  }

  /** Merge a signal's structured facts into the moment's signal blocks. */
  private applySignalToMomentBlocks(moment: RoomMoment, signal: RoomSignal, now: number): void {
    const s = moment.signals;
    const p = signal.payload as Record<string, any>;

    if (signal.source === "chat") {
      const chat = (s.chatActivity ??= { level: "silent" });
      const rate = this.humanRate(now, CHAT_RATE_WINDOW_MS);
      chat.level = activityLevelForRate(rate);
      chat.rate = Math.round(rate);
      chat.humanMessages = (chat.humanMessages ?? 0) + (signal.kind === "chat_message" ? 1 : 0);
      chat.botMessages = (chat.botMessages ?? 0) + (signal.kind === "chat_bot" ? 1 : 0);
      // Representative evidence lines: high-value chat only (mentions,
      // reactions, high-sentiment). Never arbitrary first-N spam.
      if (signal.kind === "chat_message" && this.isHighValueChatLine(signal)) {
        const line = `${p.username}: ${String(p.text ?? "").slice(0, ROOM_MODEL_LIMITS.maxEvidenceLineLength)}`;
        if (!moment.evidenceLines.includes(line)) {
          boundedPush(moment.evidenceLines, line, ROOM_MODEL_LIMITS.maxEvidenceLines);
        }
      }
      if (p.sentiment) s.sentiment = { current: p.sentiment, trend: this.sentimentTrend() };
    } else if (signal.source === "sentiment") {
      s.sentiment = { current: p.to, trend: p.to && SENTIMENT_POSITIVE.has(p.to) ? "rising" : "falling" };
    } else if (signal.source === "audio" && signal.kind === "audio_energy_spike") {
      s.audio = { energy: String(p.label ?? "spike"), delta: p.rms };
    } else if (signal.source === "audio" && signal.kind === "transcript_line") {
      s.audio = { ...(s.audio ?? {}), };
      if (moment.evidenceLines.length < ROOM_MODEL_LIMITS.maxEvidenceLines && p.text) {
        const line = `[streamer] ${String(p.text).slice(0, ROOM_MODEL_LIMITS.maxEvidenceLineLength)}`;
        if (!moment.evidenceLines.includes(line)) boundedPush(moment.evidenceLines, line, ROOM_MODEL_LIMITS.maxEvidenceLines);
      }
    } else if (signal.source === "audio" && signal.kind === "spoken_callout") {
      s.spokenCallout = {
        kind: String(p.kind ?? "generic_address"),
        targetBotId: p.targetBotId ? String(p.targetBotId) : undefined,
      };
      if (moment.evidenceLines.length < ROOM_MODEL_LIMITS.maxEvidenceLines && p.text) {
        const line = `[streamer→bot] ${String(p.text).slice(0, ROOM_MODEL_LIMITS.maxEvidenceLineLength)}`;
        if (!moment.evidenceLines.includes(line)) boundedPush(moment.evidenceLines, line, ROOM_MODEL_LIMITS.maxEvidenceLines);
      }
    } else if (signal.source === "vision") {
      const tags = Array.isArray(p.tags) ? p.tags : [];
      s.vision = {
        changeMagnitude: p.delta ?? s.vision?.changeMagnitude,
        tags: [...new Set([...(s.vision?.tags ?? []), ...tags])].slice(0, 8),
      };
    } else if (signal.source === "platform") {
      s.platformEvents = [...new Set([...(s.platformEvents ?? []), String(p.summary ?? p.kind)])].slice(0, 5);
    } else if (signal.source === "agent") {
      const agent = (s.agentActivity ??= {});
      agent.sends = (agent.sends ?? 0) + 1;
      if (p.botName || signal.actor?.displayName) {
        agent.botNames = [...new Set([...(agent.botNames ?? []), String(p.botName ?? signal.actor?.displayName)])].slice(0, 5);
      }
    } else if (signal.source === "thread") {
      const convo = (s.conversation ??= {});
      if (p.activeThreads != null) convo.activeThreads = p.activeThreads;
      convo.participants = this.recentParticipants
        .filter((u) => now - u.at < CONVERSATION_WINDOW_MS)
        .slice(-ROOM_MODEL_LIMITS.maxParticipants)
        .map((u) => u.user);
    }

    if (!moment.topicHints || moment.topicHints.length === 0) {
      moment.topicHints = extractTopicHints(moment.evidenceLines, s.vision?.tags ?? []);
    }
  }

  /** High-value chat line filter for evidence retention (bounded sampling). */
  private isHighValueChatLine(signal: RoomSignal): boolean {
    const p = signal.payload as Record<string, any>;
    const text = String(p.text ?? "");
    if (!text) return false;
    // Direct mention of a MADchatter bot account.
    if (p.mention === true) return true;
    // Reaction-style lines: all-caps, emote-heavy, or strong sentiment.
    const label = p.sentiment as SentimentLabel | undefined;
    if (label && (label === "hype" || label === "toxic" || label === "wholesome")) return true;
    const letters = text.replace(/[^a-zA-Z]/g, "");
    if (letters.length >= 4 && letters === letters.toUpperCase()) return true;
    if ((text.match(/[!?]{2,}/g) ?? []).length > 0) return true;
    return false;
  }

  private sentimentTrend(): RoomTrend {
    const ring = this.sentimentRing;
    if (ring.length < 8) return "stable";
    const score = (l: SentimentLabel) => (SENTIMENT_POSITIVE.has(l) ? 1 : SENTIMENT_NEGATIVE.has(l) ? -1 : 0);
    const last = ring.slice(-8);
    const prev = ring.slice(-16, -8);
    if (prev.length < 4) return "stable";
    const lastAvg = last.reduce((a, r) => a + score(r.label), 0) / last.length;
    const prevAvg = prev.reduce((a, r) => a + score(r.label), 0) / prev.length;
    if (lastAvg - prevAvg > 0.15) return "rising";
    if (prevAvg - lastAvg > 0.15) return "falling";
    return "stable";
  }

  private closeMoment(moment: RoomMoment, now: number): void {
    moment.status = "closed";
    moment.endedAt = now;
    if (moment.kind === "conversation") this.conversationMomentOpenSince = null;
    if (this.activeMomentId === moment.id) this.activeMomentId = null;
    // Queue high-significance closed moments for optional sparse synthesis.
    if (moment.significance >= 0.75 && !moment.provenance.aiSynthesized) {
      boundedPush(this.synthesisQueue, moment.id, 10);
    }
    this.dirty = true;
  }

  // ─── Internal: Room State build ──────────────────────────────────────────

  private buildState(now: number): RoomState {
    const velocity = this.humanRate(now, CHAT_RATE_WINDOW_MS);
    const recentRate = this.humanRate(now, 30_000);
    const prevRate = this.humanRate(now - 30_000, 30_000);
    let trend: RoomTrend = "stable";
    if (recentRate > Math.max(prevRate * 1.5, prevRate + 3)) trend = "rising";
    else if (recentRate < Math.max(prevRate * 0.67, prevRate - 3)) trend = "falling";

    const state: RoomState = {
      channel: this.channel!,
      updatedAt: now,
      activity: { level: activityLevelForRate(velocity), trend, velocity: Math.round(velocity) },
      platformEvents: this.platformEvents.slice(-ROOM_MODEL_LIMITS.maxPlatformEvents).map((e) => e.summary),
      activeMomentId: this.activeMomentId ?? undefined,
      recentMomentIds: this.moments
        .filter((m) => m.status === "closed")
        .slice(-8)
        .reverse()
        .map((m) => m.id),
      freshness: Object.fromEntries(
        (Object.keys(this.lanes) as RoomLane[])
          .filter((lane) => this.lanes[lane].lastSignalAt != null)
          .map((lane) => [lane, this.lanes[lane].lastSignalAt!]),
      ) as Partial<Record<RoomLane, number>>,
      confidence: 0,
    };

    if (this.sentimentRing.length > 0) {
      const counts = new Map<SentimentLabel, number>();
      for (const r of this.sentimentRing.slice(-20)) counts.set(r.label, (counts.get(r.label) ?? 0) + 1);
      const current = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      state.sentiment = { current, trend: this.sentimentTrend() };
    }

    if (this.lastAudioEnergy && now - this.lastAudioEnergy.at < 10 * 60_000) {
      state.audio = { level: this.lastAudioEnergy.label, updatedAt: this.lastAudioEnergy.at };
    }
    if (this.lastVision && now - this.lastVision.at < 10 * 60_000) {
      state.vision = {
        tags: this.lastVision.tags,
        changedAt: this.lastVision.at,
        changeMagnitude: this.lastVision.delta,
      };
    }
    if (this.lastTranscriptAt != null && now - this.lastTranscriptAt < 10 * 60_000) {
      state.transcript = { updatedAt: this.lastTranscriptAt };
    }
    if (this.lastConversation && now - this.lastConversation.at < 30_000) {
      state.conversation = {
        activeThreads: this.lastConversation.activeThreads,
        participants: this.lastConversation.participants,
        streamerEngaged: this.lastTranscriptAt != null && now - this.lastTranscriptAt < 120_000,
      };
    }

    // Confidence: live-lane coverage (how much fresh evidence backs this state).
    const liveLanes = (Object.keys(this.lanes) as RoomLane[]).filter((lane) => {
      const at = this.lanes[lane].lastSignalAt;
      return at != null && now - at < ROOM_LANE_STALE_MS[lane];
    }).length;
    state.confidence = clamp01(0.3 + liveLanes * 0.14);

    return state;
  }
}

// ─── Perception liveness (freshness → status) ─────────────────────────────────

/** Classify a lane's freshness into a human-readable status. */
export function laneStatus(state: RoomState, lane: RoomLane, now: number = Date.now()): RoomLaneStatus {
  const at = state.freshness[lane];
  if (at == null) return "unavailable";
  const age = now - at;
  if (age > ROOM_LANE_STALE_MS[lane]) return "stale";
  if (lane === "chat" && state.activity.level === "silent") return "quiet";
  return "live";
}

// ─── Consumer formatters ──────────────────────────────────────────────────────

function momentAgeLabel(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/**
 * Compact Room State context block for the AutoForge decision prompt.
 * Advisory by construction: the block states its own hierarchy position —
 * raw direct evidence (mentions, transcript, recent chat) always outranks it.
 * Skips empty lanes so quiet rooms produce a tiny block, not noise.
 */
export function formatRoomStateContext(
  state: RoomState | null,
  moments: RoomMoment[],
  now: number = Date.now(),
): string {
  if (!state) return "";
  const lines: string[] = ["[ROOM STATE — deterministic situational summary. Advisory: when this conflicts with direct evidence above (mentions, transcript, recent chat), trust the direct evidence.]"];
  lines.push(`Activity: ${state.activity.level}${state.activity.trend !== "stable" ? `, ${state.activity.trend}` : ""} (~${state.activity.velocity} msgs/min)`);
  if (state.sentiment) {
    lines.push(`Sentiment: ${state.sentiment.current}${state.sentiment.trend !== "stable" ? `, ${state.sentiment.trend}` : ""}`);
  }
  if (state.audio && state.audio.level !== "silent") {
    lines.push(`Audio energy: ${state.audio.level} (${momentAgeLabel(state.audio.updatedAt, now)})`);
  }
  if (state.vision && state.vision.tags.length > 0) {
    const changed = state.vision.changeMagnitude != null && state.vision.changeMagnitude >= 0.08;
    lines.push(`Visual: ${changed ? "notable change" : "scene"} ${momentAgeLabel(state.vision.changedAt, now)} — ${state.vision.tags.slice(0, 4).join(", ")}`);
  }
  if (state.conversation && (state.conversation.activeThreads > 0 || state.conversation.participants.length > 0)) {
    lines.push(`Conversation: ${state.conversation.activeThreads} active thread${state.conversation.activeThreads === 1 ? "" : "s"}, recent participants: ${state.conversation.participants.slice(0, 5).join(", ") || "none"}`);
    if (state.conversation.streamerEngaged) lines.push("Streamer: actively speaking");
  }
  if (state.platformEvents.length > 0) {
    lines.push(`Recent platform events: ${state.platformEvents.slice(-3).join(" | ")}`);
  }

  const active = state.activeMomentId ? moments.find((m) => m.id === state.activeMomentId) : null;
  if (active) {
    lines.push(`Current moment: "${active.title ?? deterministicMomentTitle(active)}" (${active.kind}, significance ${active.significance.toFixed(2)}, ${momentAgeLabel(active.startedAt, now)}, sources: ${active.sources.join("+")})`);
  }
  const recent = moments
    .filter((m) => m.status === "closed" && (!active || m.id !== active.id))
    .slice(-3)
    .reverse();
  if (recent.length > 0) {
    lines.push(`Recent moments: ${recent.map((m) => `[${m.title ?? deterministicMomentTitle(m)} — ${momentAgeLabel(m.endedAt ?? m.updatedAt, now)}]`).join(" ")}`);
  }
  return lines.join("\n");
}

/**
 * Structured evidence block for AI moment synthesis. Facts only — the model
 * interprets, never rediscovers. Mirrors the spec's synthesis input shape.
 */
export function buildMomentSynthesisInput(moment: RoomMoment, state: RoomState | null): Record<string, unknown> {
  const s = moment.signals;
  return {
    durationSec: Math.round(((moment.endedAt ?? moment.updatedAt) - moment.startedAt) / 1000),
    chat: {
      activity: s.chatActivity?.level,
      rate: s.chatActivity?.rate,
      humanMessages: s.chatActivity?.humanMessages,
      sampleLines: moment.evidenceLines.slice(0, ROOM_MODEL_LIMITS.maxEvidenceLines),
    },
    sentiment: s.sentiment ? { current: s.sentiment.current, trend: s.sentiment.trend } : undefined,
    audio: s.audio ? { energy: s.audio.energy } : undefined,
    vision: s.vision ? { change: s.vision.changeMagnitude, tags: s.vision.tags } : undefined,
    platformEvents: s.platformEvents ?? [],
    conversation: s.conversation
      ? { activeThreads: s.conversation.activeThreads, participants: s.conversation.participants }
      : undefined,
    agentActivity: s.agentActivity ? { sends: s.agentActivity.sends, bots: s.agentActivity.botNames } : undefined,
    roomConfidence: state?.confidence,
  };
}

/** Human-readable ROOM READ (CORE surface). Concise, no machinery exposed. */
export function formatRoomRead(state: RoomState | null, moments: RoomMoment[], now: number = Date.now()): string[] {
  if (!state) return [];
  const lines: string[] = [];
  lines.push(`Activity ${state.activity.level}${state.activity.trend !== "stable" ? ` (${state.activity.trend})` : ""} · ~${state.activity.velocity} msgs/min`);
  if (state.sentiment) {
    lines.push(`Mood ${state.sentiment.current}${state.sentiment.trend !== "stable" ? `, ${state.sentiment.trend}` : ""}`);
  }
  if (state.conversation?.streamerEngaged) lines.push("Streamer engaged (speaking)");
  if (state.audio && state.audio.level !== "silent") lines.push(`Audio ${state.audio.level}`);
  if (state.vision && state.vision.tags.length > 0) {
    lines.push(`Visual: ${state.vision.tags.slice(0, 3).join(", ")}`);
  }
  if (state.conversation && state.conversation.activeThreads > 0) {
    lines.push(`${state.conversation.activeThreads} active thread${state.conversation.activeThreads === 1 ? "" : "s"}`);
  }
  if (state.platformEvents.length > 0) {
    lines.push(state.platformEvents[state.platformEvents.length - 1]);
  }
  const active = state.activeMomentId ? moments.find((m) => m.id === state.activeMomentId) : null;
  if (active) {
    lines.push(`Now: ${active.title ?? deterministicMomentTitle(active)}`);
  } else {
    const last = moments.filter((m) => m.status === "closed").slice(-1)[0];
    if (last) lines.push(`Last moment: ${last.title ?? deterministicMomentTitle(last)} (${momentAgeLabel(last.endedAt ?? last.updatedAt, now)})`);
  }
  return lines;
}

// ─── Module singleton ─────────────────────────────────────────────────────────

/**
 * One engine per live session. Store actions and App.tsx note into it; the
 * useRoomModel hook ticks it and mirrors state into the store for React
 * consumers + persistence. Reset on channel switch, restored from snapshots.
 */
export const roomModel = new RoomModelEngine();
