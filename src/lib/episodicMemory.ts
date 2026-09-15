/**
 * Episodic Memory — the canonical "what happened?" layer.
 *
 * Problem: MADchatter's semantic memory (AutoMemory: facts, traits, jokes,
 * profiles) answers "what is generally true?" and the Room Model answers
 * "what is happening right now?" — but shared *experiences* fall between
 * them. "ViewerX challenged the haste build and chat turned it into a
 * running joke" is an EVENT with temporal and social context, not a fact.
 *
 * Solution: a deterministic consolidation engine that turns the Room
 * Model's closed Moments into a bounded, provenance-aware store of
 * Episodes — coherent experiences with boundaries, participants, topics,
 * significance, and confidence — plus a contextual retrieval layer that
 * feeds the most relevant past episodes into Forge / AutoForge prompts.
 *
 * Memory taxonomy (enforced, never collapsed):
 * - WORKING  (Room Model): what is happening right now.
 * - EPISODIC (this module): what happened — bounded experiences.
 * - SEMANTIC (AutoMemory): what is generally true.
 *
 * Architecture rules (mirrors roomModel.ts):
 * - FACTS FIRST, SYNTHESIS SECOND. Boundaries, participants, topics,
 *   significance, confidence, lifecycle, and retention are 100%
 *   deterministic — no AI in the hot path. Episodic memory works with no
 *   provider configured. AI can only fill semantic fields (title /
 *   summary / topicHints) on CLOSED episodes via applySynthesis(), which
 *   is channel- and idempotence-guarded and can never touch deterministic
 *   fields.
 * - EPISODES ARE EVENTS, NOT LOGS. Only significant, coherent Moment
 *   clusters become episodes; candidates below the retention threshold
 *   are discarded. Bot-only activity is hard-capped at low significance
 *   and cannot become shared community history.
 * - SIGNIFICANCE ≠ CONFIDENCE. Significance = "how much did this matter?";
 *   confidence = "how strongly does the evidence agree it happened?"
 * - EVERYTHING IS BOUNDED. Participants, topics, evidence refs, episodes,
 *   and the processed-moment dedupe set all have hard caps.
 * - PAST ≠ PRESENT. The prompt block built by formatEpisodicContext
 *   declares its hierarchy position and carries explicit temporal framing.
 *
 * This module is pure: no store import, no timers, no AI calls. The engine
 * is driven by noteMoments() calls from the useEpisodicMemory wiring hook
 * (fed by the Room Model's closed moments) and a tick() for lifecycle
 * maintenance. All timestamps are Unix milliseconds.
 */

import type { RoomMoment } from "./roomModel";
import { generateId } from "./ids";

// ─── Domain Types ─────────────────────────────────────────────────────────────

export type EpisodeKind =
  | "conversation"
  | "shared_joke"
  | "milestone"
  | "conflict"
  | "achievement"
  | "callback"
  | "stream_event"
  | "relationship"
  | "agent_interaction"
  | "other";

export interface EpisodeParticipant {
  type: "streamer" | "viewer" | "bot" | "system";
  /** Normalized (lowercase) display name. */
  displayName: string;
}

export type EpisodeState = "open" | "retained" | "compacted" | "archived";

export interface Episode {
  id: string;
  /** Channel (lowercased) this episode belongs to. */
  channel: string;
  /** Identity of the session that produced the episode (engine session id). */
  sessionId: string;
  startedAt: number;
  endedAt: number;
  title: string;
  summary: string;
  participants: EpisodeParticipant[];
  topics: string[];
  kind: EpisodeKind;
  /** 0..1 — how much this mattered. Deterministic. */
  significance: number;
  /** 0..1 — how strongly the evidence agrees this happened. Deterministic. */
  confidence: number;
  /** True when at least one contributing moment carries human evidence. */
  humanEvidence: boolean;
  /** True when the streamer participated (transcript/audio evidence). */
  streamerInvolved: boolean;
  agentRole?: { botNames: string[]; sends: number };
  /** Moment ids that contributed (bounded) — mandatory provenance. */
  evidenceMomentIds: string[];
  /** Representative human evidence lines (bounded, trimmed). */
  evidenceLines: string[];
  relatedEpisodeIds: string[];
  createdAt: number;
  lastRecalledAt?: number;
  recallCount: number;
  pinned: boolean;
  /** session = useful only within the producing stream; persistent = survives. */
  retention: "session" | "persistent";
  state: EpisodeState;
  provenance: {
    deterministic: true;
    aiSynthesized: boolean;
    synthesizedAt?: number;
    model?: string;
    userEdited?: boolean;
  };
}

export interface EpisodicMemorySnapshot {
  episodes: Episode[];
}

// ─── Limits + Tuning Constants (exported for tests) ─────────────────────────

export const EPISODIC_LIMITS = {
  maxParticipants: 8,
  maxTopics: 6,
  maxEvidenceMomentIds: 24,
  maxEvidenceLines: 6,
  maxEvidenceLineLength: 100,
  /** Persistent episodes (retained + compacted) per channel. */
  maxPersistentEpisodes: 100,
  /** Simultaneously open candidates. */
  maxOpenCandidates: 4,
  maxRelatedLinks: 4,
  /** Processed-moment dedupe set size (FIFO beyond this). */
  maxProcessedMomentIds: 2000,
} as const;

/** Moment significance required to open/enrich an episode candidate. */
export const EPISODE_CANDIDATE_THRESHOLD = 0.55;
/** Closed-candidate significance required to persist across sessions. */
export const EPISODE_RETAIN_PERSISTENT_THRESHOLD = 0.62;
/** Closed-candidate significance required to keep even session-locally. */
export const EPISODE_RETAIN_SESSION_THRESHOLD = 0.5;
/** Bot-only episodes can never claim human-level significance. */
export const BOT_ONLY_SIGNIFICANCE_CAP = 0.3;
/** A moment must land within this window of candidate activity to merge. */
export const EPISODE_FUSION_WINDOW_MS = 10 * 60_000;
/** A candidate closes after this much time without new moment evidence. */
export const EPISODE_IDLE_CLOSE_MS = 5 * 60_000;
/** Age after which a persistent episode compacts (drops fine evidence). */
export const EPISODE_COMPACT_AGE_MS = 14 * 24 * 60 * 60_000;
/** Age after which a low-value persistent episode archives out of retrieval. */
export const EPISODE_ARCHIVE_AGE_MS = 90 * 24 * 60 * 60_000;
/** Retrieval: recently-recalled episodes are suppressed for this long. */
export const EPISODE_REUSE_PENALTY_MS = 30 * 60_000;
/** Retrieval score floor for inclusion in a prompt. */
export const EPISODE_RETRIEVAL_THRESHOLD = 0.45;
/** Retrieval: max episodes injected into any prompt (sparse by design). */
export const EPISODE_MAX_RETRIEVED = 3;
/** AI synthesis queue cap (episode ids awaiting enrichment). */
export const EPISODE_MAX_SYNTHESIS_QUEUE = 10;

// ─── Internal helpers ─────────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function boundedPush<T>(arr: T[], item: T, max: number): void {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
}

const STOPWORDS = new Set([
  "the", "and", "for", "you", "your", "that", "this", "with", "was", "are", "not",
  "but", "has", "have", "had", "they", "them", "his", "her", "she", "him", "all",
  "can", "will", "just", "get", "got", "how", "what", "who", "why", "when", "out",
  "one", "two", "its", "about", "into", "from", "were", "there", "their",
  "would", "could", "should", "been", "being", "over", "than", "then", "more",
  "some", "did", "does", "doing", "because", "very", "much", "lmao", "lol",
  "yeah", "like", "stream", "chat",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
}

const KIND_LABELS: Record<EpisodeKind, string> = {
  conversation: "conversation",
  shared_joke: "running joke",
  milestone: "milestone",
  conflict: "disagreement",
  achievement: "achievement",
  callback: "callback",
  stream_event: "stream event",
  relationship: "relationship moment",
  agent_interaction: "bot interaction",
  other: "moment",
};

/** Map Room Model moment kinds to episode kinds (deterministic). */
function momentKindToEpisodeKind(moment: RoomMoment): EpisodeKind {
  if (moment.kind === "stream_event") return "stream_event";
  if (moment.kind === "conversation") {
    // A sustained multi-party exchange with playful evidence is treated as a
    // conversation; finer "shared_joke" classification is AI-synthesis-only.
    return "conversation";
  }
  if (moment.kind === "agent_event") return "agent_interaction";
  if (moment.kind === "quiet") return "other";
  return "other";
}

/** Human-readable participant label ("viewer_x and the streamer"). */
export function participantListLabel(participants: EpisodeParticipant[]): string {
  if (participants.length === 0) return "unknown participants";
  return participants.slice(0, 3).map((p) => p.displayName).join(", ");
}

/** Deterministic fallback title — an episode is always human-browsable. */
export function deterministicEpisodeTitle(episode: Pick<Episode, "kind" | "participants" | "topics">): string {
  const who = participantListLabel(episode.participants);
  const topic = episode.topics[0] ? ` about ${episode.topics.slice(0, 2).join("/")}` : "";
  return `${KIND_LABELS[episode.kind]} with ${who}${topic}`.slice(0, 80);
}

/** Safe temporal label from real timestamps — never vague when precise is available. */
export function episodeTemporalLabel(episode: Pick<Episode, "endedAt" | "sessionId">, currentSessionId: string, now: number = Date.now()): string {
  if (episode.sessionId === currentSessionId) return "earlier this session";
  const age = now - episode.endedAt;
  const minutes = Math.floor(age / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}

// ─── Engine ───────────────────────────────────────────────────────────────────

/**
 * Internal aggregation state for an open episode candidate. The candidate
 * accumulates moments; on closure it is evaluated for retention and either
 * becomes a persisted Episode or is discarded.
 */
interface EpisodeCandidate {
  id: string;
  startedAt: number;
  lastActivityAt: number;
  kind: EpisodeKind;
  /** Peak moment significance observed. */
  peakSignificance: number;
  moments: RoomMoment[];
  participants: Map<string, EpisodeParticipant>;
  topics: Set<string>;
  humanEvidence: boolean;
  streamerInvolved: boolean;
  platformAnchored: boolean;
  agentBots: Set<string>;
  agentSends: number;
  humanMessages: number;
}

/**
 * The deterministic Episodic Memory engine. One instance per live session;
 * the module exports a singleton (`episodicMemory`) because moment feeding
 * happens from the useEpisodicMemory hook (store/App scope, no React
 * render scope of its own). Retained episodes survive channel switches via
 * channel snapshots (restore) — the same lifecycle as the Room Model.
 */
export class EpisodicMemoryEngine {
  private channel: string | null = null;
  /** Stable per-session identity (timestamp of session start). */
  private sessionId = "";
  private sessionStartedAt = 0;

  private episodes: Episode[] = [];
  private candidates: EpisodeCandidate[] = [];

  /** Moment ids already evaluated — duplicate processing cannot create
   *  duplicate retained episodes (FIFO-bounded). */
  private processedMomentIds: Set<string> = new Set();

  /** Closed retained episodes queued for optional AI synthesis. */
  private synthesisQueue: string[] = [];

  private dirty = true;

  // ─── Session lifecycle ───────────────────────────────────────────────────

  setChannel(channel: string | null): void {
    const normalized = channel ? channel.trim().toLowerCase() : null;
    if (normalized === this.channel && this.sessionId) return;
    this.resetInternal(normalized);
  }

  getChannel(): string | null {
    return this.channel;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /** Full reset — new session. Candidates die; retained episodes are
   *  re-populated afterwards by restore() from the channel snapshot. */
  reset(channel?: string | null): void {
    this.resetInternal(channel ? channel.trim().toLowerCase() : null);
  }

  private resetInternal(channel: string | null): void {
    this.channel = channel;
    const now = Date.now();
    this.sessionStartedAt = channel ? now : 0;
    this.sessionId = channel ? `session_${now}` : "";
    this.episodes = [];
    this.candidates = [];
    this.processedMomentIds = new Set();
    this.synthesisQueue = [];
    this.dirty = true;
  }

  /**
   * Restore retained episodes from a channel snapshot. Stream-restart
   * semantics: persistent episodes survive as history; an open candidate
   * from the previous session is force-closed (it happened, but never
   * continues into today's stream); session-retention episodes are dropped
   * (they only ever lived inside their producing session).
   */
  restore(channel: string, snapshot: EpisodicMemorySnapshot | undefined | null): void {
    const normalized = channel.trim().toLowerCase();
    this.resetInternal(normalized);
    if (!snapshot?.episodes) return;
    const restored: Episode[] = [];
    for (const e of snapshot.episodes) {
      if (!e || typeof e.id !== "string" || !Number.isFinite(e.startedAt)) continue;
      if ((e.channel ?? normalized) !== normalized) continue; // channel isolation
      if (e.retention !== "persistent") continue; // session episodes die with their session
      if (e.state === "archived") continue; // archived history is not re-loaded
      if (e.state === "open") {
        // Force-close: yesterday's open candidate never continues today.
        if ((e.significance ?? 0) < EPISODE_RETAIN_PERSISTENT_THRESHOLD) continue;
      }
      const episode: Episode = {
        ...e,
        channel: normalized,
        state: e.state === "open" ? "retained" : e.state,
        endedAt: e.endedAt ?? e.startedAt,
        participants: Array.isArray(e.participants) ? e.participants.slice(0, EPISODIC_LIMITS.maxParticipants) : [],
        topics: Array.isArray(e.topics) ? e.topics.slice(0, EPISODIC_LIMITS.maxTopics) : [],
        evidenceMomentIds: Array.isArray(e.evidenceMomentIds) ? e.evidenceMomentIds.slice(0, EPISODIC_LIMITS.maxEvidenceMomentIds) : [],
        evidenceLines: Array.isArray(e.evidenceLines) ? e.evidenceLines.slice(0, EPISODIC_LIMITS.maxEvidenceLines) : [],
        relatedEpisodeIds: Array.isArray(e.relatedEpisodeIds) ? e.relatedEpisodeIds.slice(0, EPISODIC_LIMITS.maxRelatedLinks) : [],
        pinned: !!e.pinned,
        recallCount: Number.isFinite(e.recallCount) ? e.recallCount : 0,
        significance: clamp01(e.significance ?? 0),
        confidence: clamp01(e.confidence ?? 0),
        provenance: {
          deterministic: true as const,
          aiSynthesized: !!e.provenance?.aiSynthesized,
          synthesizedAt: e.provenance?.synthesizedAt,
          model: e.provenance?.model,
          userEdited: !!e.provenance?.userEdited,
        },
      };
      restored.push(episode);
      // Dedupe set: restored episodes' moments must never re-create episodes.
      for (const mid of episode.evidenceMomentIds) this.markProcessed(mid);
    }
    restored.sort((a, b) => a.startedAt - b.startedAt);
    this.episodes = restored.slice(-EPISODIC_LIMITS.maxPersistentEpisodes);
    this.dirty = true;
  }

  // ─── Candidate generation (moment ingestion) ─────────────────────────────

  /**
   * Feed closed Room Model moments. Idempotent per moment id; only moments
   * that closed during THIS session are eligible (restored history is
   * context, not new evidence — a new stream never reprocesses yesterday).
   */
  noteMoments(moments: RoomMoment[]): void {
    if (!this.channel) return;
    for (const m of moments) {
      if (!m || m.status !== "closed") continue;
      if (m.channel?.trim().toLowerCase() !== this.channel) continue;
      if (this.processedMomentIds.has(m.id)) continue;
      this.markProcessed(m.id);
      // Restored history guard: moments that ended before this session began
      // were already evaluated (or deliberately not retained) last session.
      if (m.endedAt == null || m.endedAt < this.sessionStartedAt) continue;
      if (m.significance < EPISODE_CANDIDATE_THRESHOLD) continue;
      this.absorbMoment(m);
    }
    this.dirty = true;
  }

  private markProcessed(momentId: string): void {
    this.processedMomentIds.add(momentId);
    if (this.processedMomentIds.size > EPISODIC_LIMITS.maxProcessedMomentIds) {
      // FIFO trim — the set only needs to cover live-session moments plus
      // restored episodes' evidence, both bounded.
      const excess = this.processedMomentIds.size - EPISODIC_LIMITS.maxProcessedMomentIds;
      let removed = 0;
      for (const id of this.processedMomentIds) {
        this.processedMomentIds.delete(id);
        if (++removed >= excess) break;
      }
    }
  }

  /** Merge a significant closed moment into a compatible candidate, or open one. */
  private absorbMoment(moment: RoomMoment): void {
    // Bot-only moments cannot open a candidate — they may only enrich an
    // existing human-anchored one (bot chatter is not community history).
    const human = this.momentHasHumanEvidence(moment);
    if (!human && this.candidates.length === 0) return;

    const compatible = this.findCompatibleCandidate(moment);
    if (compatible) {
      this.mergeIntoCandidate(compatible, moment);
      return;
    }
    if (!human) return;
    if (this.candidates.length >= EPISODIC_LIMITS.maxOpenCandidates) {
      // Close the stalest candidate to make room.
      const stalest = this.candidates.reduce((a, b) => (a.lastActivityAt <= b.lastActivityAt ? a : b));
      this.closeCandidate(stalest, stalest.lastActivityAt + EPISODE_IDLE_CLOSE_MS);
    }
    const candidate: EpisodeCandidate = {
      id: `ep_${generateId()}`,
      startedAt: moment.startedAt,
      lastActivityAt: moment.endedAt ?? moment.updatedAt,
      kind: momentKindToEpisodeKind(moment),
      peakSignificance: moment.significance,
      moments: [],
      participants: new Map(),
      topics: new Set(),
      humanEvidence: false,
      streamerInvolved: false,
      platformAnchored: false,
      agentBots: new Set(),
      agentSends: 0,
      humanMessages: 0,
    };
    this.candidates.push(candidate);
    this.mergeIntoCandidate(candidate, moment);
  }

  /** Moment carries human (non-bot) evidence: human chat, streamer speech,
   *  or a platform event attributable to a real person. */
  private momentHasHumanEvidence(moment: RoomMoment): boolean {
    if ((moment.signals.chatActivity?.humanMessages ?? 0) > 0) return true;
    if (moment.evidenceLines.some((l) => !l.startsWith("["))) return true; // "user: ..." lines are human chat
    if (moment.sources.includes("platform")) return true; // raid/sub/etc. are platform facts
    return false;
  }

  /**
   * Coherence: a moment merges into a candidate when they share a dominant
   * relationship — same participants, same topic, or the same platform
   * anchor (raid aftermath) — within the fusion window. Nearby-but-
   * unrelated moments stay separate episodes.
   */
  private findCompatibleCandidate(moment: RoomMoment): EpisodeCandidate | null {
    const momentEnd = moment.endedAt ?? moment.updatedAt;
    const momentUsers = this.momentHumanParticipants(moment);
    const momentTopics = new Set((moment.topicHints ?? []).map((t) => t.toLowerCase()));
    const isPlatform = moment.sources.includes("platform");

    let best: EpisodeCandidate | null = null;
    let bestScore = 0;
    for (const c of this.candidates) {
      const withinWindow = momentEnd >= c.startedAt - EPISODE_FUSION_WINDOW_MS &&
        momentEnd <= c.lastActivityAt + EPISODE_FUSION_WINDOW_MS;
      if (!withinWindow) continue;
      let score = 0;
      // Participant overlap — the strongest coherence signal.
      for (const u of momentUsers) {
        if (c.participants.has(u)) { score += 0.6; break; }
      }
      // Topic overlap.
      let topicOverlap = 0;
      for (const t of momentTopics) if (c.topics.has(t)) topicOverlap++;
      if (momentTopics.size > 0) score += 0.4 * (topicOverlap / momentTopics.size);
      // Same platform anchor (raid → reaction → aftermath is ONE event).
      if (isPlatform && c.platformAnchored) score += 0.5;
      // A stream_event candidate absorbs its own aftermath.
      if (c.platformAnchored && momentEnd >= c.startedAt && momentEnd <= c.lastActivityAt + EPISODE_FUSION_WINDOW_MS) score += 0.3;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return bestScore >= 0.4 ? best : null;
  }

  /** Human participants in a moment, lowercase-normalized. */
  private momentHumanParticipants(moment: RoomMoment): string[] {
    const users = new Set<string>();
    for (const p of moment.signals.conversation?.participants ?? []) {
      if (p) users.add(p.toLowerCase());
    }
    // Evidence lines: "username: text" (bot lines are never stored as
    // evidence by the Room Model; "[streamer]" marks transcript lines).
    for (const line of moment.evidenceLines) {
      const m = line.match(/^([a-zA-Z0-9_]{2,30}): /);
      if (m) users.add(m[1].toLowerCase());
    }
    return [...users];
  }

  private mergeIntoCandidate(candidate: EpisodeCandidate, moment: RoomMoment): void {
    candidate.moments.push(moment);
    if (candidate.moments.length > EPISODIC_LIMITS.maxEvidenceMomentIds) {
      candidate.moments.splice(0, candidate.moments.length - EPISODIC_LIMITS.maxEvidenceMomentIds);
    }
    candidate.lastActivityAt = Math.max(candidate.lastActivityAt, moment.endedAt ?? moment.updatedAt);
    candidate.peakSignificance = Math.max(candidate.peakSignificance, moment.significance);
    if (moment.sources.includes("platform")) candidate.platformAnchored = true;

    const human = this.momentHasHumanEvidence(moment);
    if (human) candidate.humanEvidence = true;
    if (this.momentInvolvesStreamer(moment)) candidate.streamerInvolved = true;

    // Participants.
    const addParticipant = (p: EpisodeParticipant) => {
      if (!p.displayName || candidate.participants.has(p.displayName)) return;
      if (candidate.participants.size >= EPISODIC_LIMITS.maxParticipants) return;
      candidate.participants.set(p.displayName, p);
    };
    for (const u of this.momentHumanParticipants(moment)) addParticipant({ type: "viewer", displayName: u });
    if (this.momentInvolvesStreamer(moment)) addParticipant({ type: "streamer", displayName: "streamer" });
    for (const b of moment.signals.agentActivity?.botNames ?? []) {
      if (b) {
        addParticipant({ type: "bot", displayName: b.toLowerCase() });
        candidate.agentBots.add(b.toLowerCase());
      }
    }
    for (const ev of moment.signals.platformEvents ?? []) {
      // "⚔️ name raided with 47 viewers" — best-effort actor extraction.
      const m = ev.match(/(?:^|\s)([a-zA-Z0-9_]{2,30})\s+(?:raided|hosted|subscribed|gifted|cheered|resubscribed|followed)/);
      if (m) addParticipant({ type: "viewer", displayName: m[1].toLowerCase() });
    }

    // Topics.
    for (const t of moment.topicHints ?? []) candidate.topics.add(t.toLowerCase());
    if (candidate.topics.size > EPISODIC_LIMITS.maxTopics) {
      // Keep the first N (deterministic insertion order).
      const kept = [...candidate.topics].slice(0, EPISODIC_LIMITS.maxTopics);
      candidate.topics = new Set(kept);
    }

    // Agent + human counts.
    candidate.agentSends += moment.signals.agentActivity?.sends ?? 0;
    candidate.humanMessages += moment.signals.chatActivity?.humanMessages ?? 0;
    this.dirty = true;
  }

  private momentInvolvesStreamer(moment: RoomMoment): boolean {
    if (moment.evidenceLines.some((l) => l.startsWith("[streamer]"))) return true;
    if (moment.sources.includes("audio") && (moment.signals.audio?.energy ?? "") !== "") return true;
    return false;
  }

  // ─── Lifecycle / maintenance ──────────────────────────────────────────────

  /** Called ~1/s by the wiring hook. Closes idle candidates, enforces
   *  retention, compaction, archival, and caps. Deterministic — no AI. */
  tick(now: number = Date.now()): void {
    if (!this.channel) return;

    // 1. Close idle candidates → retention evaluation.
    for (const c of [...this.candidates]) {
      if (now - c.lastActivityAt > EPISODE_IDLE_CLOSE_MS) this.closeCandidate(c, now);
    }

    // 2. Compaction: old persistent episodes become cheaper, but keep
    //    provenance (moment ids + a representative evidence sample).
    for (const e of this.episodes) {
      if (e.state !== "retained" || e.pinned) continue;
      if (now - e.endedAt > EPISODE_COMPACT_AGE_MS) {
        e.state = "compacted";
        e.evidenceLines = e.evidenceLines.slice(0, 2);
        e.topics = e.topics.slice(0, 4);
        this.dirty = true;
      }
    }

    // 3. Archival: old + low-value episodes leave the retrieval pool
    //    (they remain in storage as history until the cap evicts them).
    for (const e of this.episodes) {
      if (e.state === "archived" || e.pinned) continue;
      const age = now - e.endedAt;
      if (age > EPISODE_ARCHIVE_AGE_MS && e.recallCount === 0 && e.significance < 0.75) {
        e.state = "archived";
        this.dirty = true;
      }
    }

    // 4. Hard cap: evict lowest-value non-pinned persistent episodes first.
    const persistent = this.episodes.filter((e) => e.retention === "persistent");
    if (persistent.length > EPISODIC_LIMITS.maxPersistentEpisodes) {
      const value = (e: Episode) => (e.pinned ? Infinity : e.significance * 0.7 + clamp01(e.recallCount / 5) * 0.15 + clamp01(1 - (now - e.endedAt) / EPISODE_ARCHIVE_AGE_MS) * 0.15);
      const sorted = [...persistent].sort((a, b) => value(a) - value(b)); // lowest value first
      const evict = sorted.slice(0, persistent.length - EPISODIC_LIMITS.maxPersistentEpisodes);
      const evictIds = new Set(evict.map((e) => e.id));
      this.episodes = this.episodes.filter((e) => !evictIds.has(e.id));
      // Clean dangling related links.
      for (const e of this.episodes) {
        if (e.relatedEpisodeIds.some((id) => evictIds.has(id))) {
          e.relatedEpisodeIds = e.relatedEpisodeIds.filter((id) => !evictIds.has(id));
        }
      }
      this.dirty = true;
    }
  }

  /**
   * Close a candidate and evaluate retention. Significance is recomputed
   * from the full aggregation (not just the peak moment) so quiet-but-
   * meaningful conversations can outrank loud-but-empty spikes.
   */
  private closeCandidate(candidate: EpisodeCandidate, now: number): void {
    const idx = this.candidates.indexOf(candidate);
    if (idx === -1) return;
    this.candidates.splice(idx, 1);

    const significance = this.computeSignificance(candidate);
    const confidence = this.computeConfidence(candidate);
    const startedAt = candidate.moments.length > 0
      ? Math.min(...candidate.moments.map((m) => m.startedAt))
      : candidate.startedAt;
    const endedAt = Math.max(candidate.lastActivityAt, ...candidate.moments.map((m) => m.endedAt ?? m.updatedAt));

    // Retention evaluation (decision tree): below session threshold → discard.
    if (significance < EPISODE_RETAIN_SESSION_THRESHOLD) return;
    const retention: Episode["retention"] = significance >= EPISODE_RETAIN_PERSISTENT_THRESHOLD ? "persistent" : "session";

    const participants = [...candidate.participants.values()].slice(0, EPISODIC_LIMITS.maxParticipants);
    const topics = [...candidate.topics].slice(0, EPISODIC_LIMITS.maxTopics);
    const evidenceLines = candidate.moments
      .flatMap((m) => m.evidenceLines)
      .filter((l, i, arr) => arr.indexOf(l) === i)
      .slice(0, EPISODIC_LIMITS.maxEvidenceLines)
      .map((l) => l.slice(0, EPISODIC_LIMITS.maxEvidenceLineLength));

    const episode: Episode = {
      id: candidate.id,
      channel: this.channel!,
      sessionId: this.sessionId,
      startedAt,
      endedAt,
      title: "",
      summary: "",
      participants,
      topics,
      kind: candidate.kind,
      significance,
      confidence,
      humanEvidence: candidate.humanEvidence,
      streamerInvolved: candidate.streamerInvolved,
      agentRole: candidate.agentSends > 0 || candidate.agentBots.size > 0
        ? { botNames: [...candidate.agentBots].slice(0, 5), sends: candidate.agentSends }
        : undefined,
      evidenceMomentIds: candidate.moments.map((m) => m.id).slice(0, EPISODIC_LIMITS.maxEvidenceMomentIds),
      evidenceLines,
      relatedEpisodeIds: [],
      createdAt: now,
      recallCount: 0,
      pinned: false,
      retention,
      state: "retained",
      provenance: { deterministic: true, aiSynthesized: false },
    };
    // Deterministic fallback narrative — valid with zero AI involvement.
    episode.title = deterministicEpisodeTitle(episode);
    episode.summary = this.deterministicSummary(candidate, episode);

    // Link to strongly-related prior episodes (recurring jokes/rivalries).
    episode.relatedEpisodeIds = this.findRelatedEpisodes(episode);

    this.episodes.push(episode);
    // Synthesis queue: only high-significance, provider-worthy episodes.
    if (significance >= 0.75) {
      boundedPush(this.synthesisQueue, episode.id, EPISODE_MAX_SYNTHESIS_QUEUE);
    }
    this.dirty = true;
  }

  /** Deterministic significance from the aggregation — bounded, AI-free. */
  private computeSignificance(candidate: EpisodeCandidate): number {
    let score = candidate.peakSignificance;
    // Human + streamer participation outweigh raw volume.
    if (candidate.streamerInvolved) score += 0.08;
    const humanParticipants = [...candidate.participants.values()].filter((p) => p.type === "viewer" || p.type === "streamer").length;
    score += 0.06 * Math.min(1, humanParticipants / 3);
    // Sustained exchange (duration) — a quiet 3-minute back-and-forth beats
    // a 5-second spam spike; high chat volume alone does NOT equal importance.
    const durationSec = Math.max(0, (candidate.lastActivityAt - candidate.startedAt) / 1000);
    score += 0.05 * clamp01(durationSec / 600);
    if (candidate.platformAnchored) score += 0.05;
    if (candidate.humanMessages >= 10) score += 0.04;
    // Bot-only activity is never allowed to become shared human history.
    if (!candidate.humanEvidence) score = Math.min(score, BOT_ONLY_SIGNIFICANCE_CAP);
    return clamp01(score);
  }

  /** Deterministic confidence: distinct evidence sources agreeing. */
  private computeConfidence(candidate: EpisodeCandidate): number {
    const sources = new Set<string>();
    let momentCount = 0;
    let platform = false;
    for (const m of candidate.moments) {
      momentCount++;
      for (const s of m.sources) sources.add(s);
      if (m.sources.includes("platform")) platform = true;
      if (m.confidence >= 0.9) sources.add("highAgreement");
    }
    let base = 0.5 + Math.min(0.3, (sources.size - 1) * 0.08);
    if (momentCount >= 3) base += 0.08;
    if (candidate.humanMessages >= 5) base += 0.06;
    if (platform) base = Math.max(base, 0.95); // platform facts are near-certain
    return clamp01(base);
  }

  /** Deterministic fallback summary (no AI required). */
  private deterministicSummary(candidate: EpisodeCandidate, episode: Episode): string {
    const durationSec = Math.max(1, Math.round((episode.endedAt - episode.startedAt) / 1000));
    const who = participantListLabel(episode.participants);
    const parts = [
      `${KIND_LABELS[episode.kind]} involving ${who} over ${durationSec}s`,
    ];
    if (candidate.humanMessages > 0) parts.push(`${candidate.humanMessages} human messages`);
    if (episode.streamerInvolved) parts.push("the streamer participated");
    if (candidate.platformAnchored) parts.push("included a platform event");
    if (candidate.agentSends > 0) parts.push(`bot sent ${candidate.agentSends} message${candidate.agentSends === 1 ? "" : "s"}`);
    if (episode.topics.length > 0) parts.push(`topics: ${episode.topics.slice(0, 3).join(", ")}`);
    return parts.join("; ").slice(0, 400) + ".";
  }

  /** Lightweight episode linking — recurring themes become arcs, not blobs. */
  private findRelatedEpisodes(episode: Episode): string[] {
    const related: string[] = [];
    const topicSet = new Set(episode.topics);
    for (const other of this.episodes) {
      if (other.id === episode.id || other.state === "archived") continue;
      if (related.length >= EPISODIC_LIMITS.maxRelatedLinks) break;
      let topicOverlap = 0;
      for (const t of other.topics) if (topicSet.has(t)) topicOverlap++;
      const participantOverlap = episode.participants.some((p) =>
        other.participants.some((q) => q.displayName === p.displayName && p.type !== "system"),
      );
      if (topicOverlap >= 2 || (topicOverlap >= 1 && participantOverlap)) related.push(other.id);
    }
    return related;
  }

  // ─── Reads ───────────────────────────────────────────────────────────────

  /** All episodes (open candidates excluded), oldest → newest. Frozen copies. */
  getEpisodes(): Episode[] {
    return this.episodes.map((e) => ({ ...e }));
  }

  getEpisodeById(id: string): Episode | null {
    const e = this.episodes.find((x) => x.id === id);
    return e ? { ...e } : null;
  }

  exportSnapshot(): EpisodicMemorySnapshot {
    return { episodes: this.getEpisodes() };
  }

  /** Drain episodes queued for optional AI synthesis (ids). */
  hasPendingSynthesis(): boolean { return this.synthesisQueue.length > 0; }

  drainSynthesisQueue(): string[] {
    const q = this.synthesisQueue;
    this.synthesisQueue = [];
    return q;
  }

  /** Re-queue an episode for synthesis (e.g. rate-limit deferral). Bounded. */
  requeueSynthesis(id: string): void {
    if (!this.synthesisQueue.includes(id)) {
      boundedPush(this.synthesisQueue, id, EPISODE_MAX_SYNTHESIS_QUEUE);
    }
  }

  /** Record that an episode was recalled into a prompt (callback-fatigue
   *  accounting). Modest, non-circular: recall never raises significance. */
  markRecalled(id: string, now: number = Date.now()): boolean {
    const e = this.episodes.find((x) => x.id === id);
    if (!e) return false;
    e.lastRecalledAt = now;
    e.recallCount += 1;
    this.dirty = true;
    return true;
  }

  // ─── User actions (Memory UI) ────────────────────────────────────────────

  /** Delete an episode. Removes it from retrieval and cleans dangling links. */
  deleteEpisode(id: string): boolean {
    const before = this.episodes.length;
    this.episodes = this.episodes.filter((e) => e.id !== id);
    if (this.episodes.length === before) return false;
    for (const e of this.episodes) {
      if (e.relatedEpisodeIds.includes(id)) {
        e.relatedEpisodeIds = e.relatedEpisodeIds.filter((rid) => rid !== id);
      }
    }
    this.dirty = true;
    return true;
  }

  setPinned(id: string, pinned: boolean): boolean {
    const e = this.episodes.find((x) => x.id === id);
    if (!e) return false;
    e.pinned = pinned;
    if (pinned && e.state === "archived") e.state = "retained"; // pin revives
    this.dirty = true;
    return true;
  }

  /** User edits — title/summary only. Never IDs, evidence, or provenance. */
  updateUserFields(id: string, patch: { title?: string; summary?: string }): boolean {
    const e = this.episodes.find((x) => x.id === id);
    if (!e) return false;
    if (patch.title != null) e.title = patch.title.trim().slice(0, 80);
    if (patch.summary != null) e.summary = patch.summary.trim().slice(0, 400);
    e.provenance = { ...e.provenance, userEdited: true };
    this.dirty = true;
    return true;
  }

  // ─── AI synthesis (guarded, semantic fields only) ─────────────────────────

  /**
   * Apply AI synthesis to a CLOSED episode. Channel-guarded and idempotent —
   * a late or stale synthesis can only fill semantic fields (title / summary /
   * topics / kind) on an episode that still exists on the current channel.
   * It can never touch deterministic fields (participants, timestamps,
   * evidence, significance, confidence, lifecycle).
   */
  applySynthesis(
    episodeId: string,
    channel: string,
    synthesis: { title?: string; summary?: string; topics?: string[]; kind?: string; model?: string },
  ): boolean {
    if (!this.channel || this.channel !== channel.trim().toLowerCase()) return false;
    const e = this.episodes.find((x) => x.id === episodeId);
    if (!e || e.state === "open" || e.provenance.aiSynthesized) return false;
    const title = synthesis.title?.trim().slice(0, 80);
    const summary = synthesis.summary?.trim().slice(0, 400);
    if (title) e.title = title;
    if (summary) e.summary = summary;
    if (Array.isArray(synthesis.topics) && synthesis.topics.length > 0) {
      const hints = synthesis.topics.map((t) => String(t).toLowerCase().slice(0, 30)).slice(0, 5);
      e.topics = [...new Set([...e.topics, ...hints])].slice(0, EPISODIC_LIMITS.maxTopics);
    }
    // Kind suggestion must map to the enum — anything else is ignored.
    if (synthesis.kind && (KIND_LABELS as Record<string, string>)[synthesis.kind]) {
      e.kind = synthesis.kind as EpisodeKind;
    }
    e.provenance = {
      deterministic: true,
      aiSynthesized: true,
      synthesizedAt: Date.now(),
      model: synthesis.model,
      userEdited: e.provenance.userEdited,
    };
    this.dirty = true;
    return true;
  }

  /** Developer diagnostics. Never includes raw evidence payloads. */
  getDiagnostics(): Record<string, unknown> {
    return {
      channel: this.channel,
      sessionId: this.sessionId,
      totalEpisodes: this.episodes.length,
      openCandidates: this.candidates.length,
      retained: this.episodes.filter((e) => e.state === "retained").length,
      compacted: this.episodes.filter((e) => e.state === "compacted").length,
      archived: this.episodes.filter((e) => e.state === "archived").length,
      pinned: this.episodes.filter((e) => e.pinned).length,
      sessionRetention: this.episodes.filter((e) => e.retention === "session").length,
      processedMoments: this.processedMomentIds.size,
    };
  }
}

// ─── Retrieval ────────────────────────────────────────────────────────────────

export interface EpisodeRetrievalQuery {
  channel: string;
  /** Lowercased human participants in the current conversation. */
  participants: string[];
  /** Topic keywords from current chat / moment / thread. */
  topics: string[];
  /** Free text of the recent conversation (tokenized for semantic fit). */
  text: string;
  /** Active thread participants (thread-aware retrieval). */
  threadParticipants?: string[];
  /** Whether recent messages contain explicit callback language. */
  explicitCallback: boolean;
  now?: number;
}

export interface EpisodeRetrievalResult {
  episode: Episode;
  score: number;
  reasons: string[];
}

/** Explicit callback language detection (deterministic phrase list). */
export function detectCallbackLanguage(text: string): boolean {
  const t = text.toLowerCase();
  if (t.includes("remember when") || t.includes("remember that") || t.includes("remember last")) return true;
  if (t.includes("not this again") || /not this \w+ again/.test(t)) return true;
  if (t.includes("same as last time") || t.includes("like last time")) return true;
  if (t.includes("last stream") || t.includes("yesterday") || t.includes("last time")) return true;
  if (t.includes("round two") || t.includes("round 2")) return true;
  if (/\bagain\b/.test(t)) return true;
  return false;
}

/**
 * Deterministic relevance scoring. Participant overlap is the strongest
 * feature; a single keyword match alone never surfaces an episode.
 *
 *   score = 0.30·participantFit + 0.25·topicFit + 0.10·threadFit
 *         + 0.10·callbackFit + 0.10·recency + 0.10·significance
 *         + 0.03·pinned − repetitionPenalty
 *
 * All components bounded; explicit callbacks soften the repetition penalty
 * (a human explicitly returning to the memory may retrieve it again).
 */
export function scoreEpisode(episode: Episode, query: EpisodeRetrievalQuery): EpisodeRetrievalResult {
  const now = query.now ?? Date.now();
  const reasons: string[] = [];

  // Participant fit — strongest signal.
  const queryParticipants = new Set([...(query.participants ?? []), ...(query.threadParticipants ?? [])].map((p) => p.toLowerCase()));
  let participantFit = 0;
  if (queryParticipants.size > 0) {
    let hits = 0;
    for (const p of episode.participants) {
      if (p.type === "system") continue;
      if (queryParticipants.has(p.displayName)) hits++;
    }
    participantFit = hits > 0 ? 0.6 + 0.4 * Math.min(1, hits / Math.max(1, Math.min(queryParticipants.size, 3))) : 0;
    if (hits > 0) reasons.push("same participant" + (hits > 1 ? "s" : ""));
  }

  // Topic + semantic fit — token overlap over topics/title/summary.
  const episodeTokens = new Set([
    ...tokenize(episode.topics.join(" ")),
    ...tokenize(episode.title),
    ...tokenize(episode.summary),
  ]);
  const queryTopics = (query.topics ?? []).map((t) => t.toLowerCase());
  const queryTokens = new Set([...tokenize(query.text ?? ""), ...queryTopics]);
  let overlap = 0;
  for (const t of queryTokens) if (episodeTokens.has(t)) overlap++;
  const topicFit = queryTokens.size > 0 ? Math.min(1, (overlap / 3) * 0.8 + (overlap > 0 ? 0.2 : 0)) : 0;
  if (overlap > 0) reasons.push(`${overlap} topic match${overlap === 1 ? "" : "es"}`);

  // Thread fit.
  let threadFit = 0;
  if (query.threadParticipants && query.threadParticipants.length > 0) {
    const threadSet = new Set(query.threadParticipants.map((p) => p.toLowerCase()));
    if (episode.participants.some((p) => threadSet.has(p.displayName))) {
      threadFit = 1;
      reasons.push("active thread");
    }
  }

  // Callback fit — explicit callback language AND topical connection.
  const callbackFit = query.explicitCallback && (overlap > 0 || participantFit > 0) ? 1 : 0;
  if (callbackFit) reasons.push("explicit callback");

  // Recency — recent episodes matter more, but old canonical events stay
  // reachable (floor, not zero) so "remember that raid six months ago?" works.
  const ageDays = Math.max(0, (now - episode.endedAt) / 86_400_000);
  const recency = Math.max(0.2, 1 - ageDays / 30);

  // Significance prior.
  const significancePrior = episode.significance;

  let score =
    0.30 * participantFit +
    0.25 * topicFit +
    0.10 * threadFit +
    0.10 * callbackFit +
    0.10 * recency +
    0.10 * significancePrior;
  if (episode.pinned) score += 0.03; // pinned = preserved, not injected everywhere

  // Repetition penalty — callback fatigue guard. An explicit human callback
  // softens it so the memory can return when genuinely re-invoked.
  if (episode.lastRecalledAt != null && now - episode.lastRecalledAt < EPISODE_REUSE_PENALTY_MS) {
    score -= query.explicitCallback ? 0.05 : 0.25;
    reasons.push("recently recalled");
  }

  // Bot-only episodes are strongly de-prioritized for human conversations.
  if (!episode.humanEvidence) score -= 0.2;

  return { episode, score: clamp01(score), reasons };
}

/**
 * Retrieve the most relevant episodes for the current context. Returns AT
 * MOST EPISODE_MAX_RETRIEVED results above the threshold — an empty result
 * is valid and common ("no relevant memory" is a correct answer). PURE:
 * takes the episode list + current session id, never mutates recall state.
 */
export function retrieveEpisodes(
  episodes: Episode[],
  query: EpisodeRetrievalQuery,
  currentSessionId: string,
): EpisodeRetrievalResult[] {
  const eligible = episodes.filter((e) =>
    e.retention === "persistent" || (e.retention === "session" && e.sessionId === currentSessionId),
  );
  return eligible
    .filter((e) => e.state === "retained" || e.state === "compacted")
    .map((e) => scoreEpisode(e, query))
    .filter((r) => r.score >= EPISODE_RETRIEVAL_THRESHOLD)
    .sort((a, b) => b.score - a.score || b.episode.endedAt - a.episode.endedAt)
    .slice(0, EPISODE_MAX_RETRIEVED);
}

/** Engine-backed retrieval — scores, marks recall, returns top matches. */
export function retrieveFromEngine(query: EpisodeRetrievalQuery): EpisodeRetrievalResult[] {
  const now = query.now ?? Date.now();
  const results = retrieveEpisodes(episodicMemory.getEpisodes(), query, episodicMemory.getSessionId());
  // Mark recall on the episodes that actually reach a prompt.
  for (const r of results) {
    episodicMemory.markRecalled(r.episode.id, now);
    r.episode.recallCount += 1;
    r.episode.lastRecalledAt = now;
  }
  return results;
}

// ─── Prompt formatting ────────────────────────────────────────────────────────

/**
 * Compact episodic context block for Forge / AutoForge prompts. Bounded
 * (≤3 episodes), explicitly framed as PAST EVENTS with temporal labels,
 * and self-declaring its hierarchy position (current evidence wins).
 */
export function formatEpisodicContext(
  results: EpisodeRetrievalResult[],
  currentSessionId: string,
  now: number = Date.now(),
): string {
  if (results.length === 0) return "";
  const lines: string[] = [
    "[PAST EPISODES — shared history from earlier streams/sessions. These are PAST EVENTS, not current facts. Use them only when genuinely relevant to the present conversation; do not mention them merely because they were retrieved; never invent details beyond what is written; if current evidence contradicts them, current evidence wins.]",
  ];
  for (const r of results) {
    const e = r.episode;
    const when = episodeTemporalLabel(e, currentSessionId, now);
    lines.push(`${when} — "${e.title}" (${KIND_LABELS[e.kind]}, significance ${e.significance.toFixed(2)})`);
    lines.push(e.summary);
    const who = e.participants.filter((p) => p.type !== "system").map((p) => p.displayName).slice(0, 4);
    if (who.length > 0) lines.push(`Participants: ${who.join(" · ")}`);
    if (e.agentRole && e.agentRole.botNames.length > 0) {
      lines.push(`MADchatter involvement: ${e.agentRole.botNames.join(", ")} (${e.agentRole.sends} send${e.agentRole.sends === 1 ? "" : "s"})`);
    }
    if (r.reasons.length > 0) lines.push(`Retrieved because: ${r.reasons.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

/** Query inputs gathered by call sites (kept pure — no store import). */
export interface EpisodicQueryInputs {
  channel: string;
  /** Recent chat messages (user + text), most recent last. */
  recentMessages: { user: string; text: string }[];
  /** Streamer transcript tail. */
  transcriptTail?: string;
  /** Current Room Moment topic hints. */
  currentTopics?: string[];
  /** Active thread participants. */
  threadParticipants?: string[];
  now?: number;
}

/** Build a retrieval query from live context (deterministic). */
export function buildEpisodeQuery(inputs: EpisodicQueryInputs): EpisodeRetrievalQuery {
  const now = inputs.now ?? Date.now();
  const recent = inputs.recentMessages.filter((m) => m.user && m.text);
  const participants = [...new Set(recent.slice(-12).map((m) => m.user.toLowerCase()))];
  const text = recent.slice(-12).map((m) => `${m.user} ${m.text}`).join(" ");
  const callback = detectCallbackLanguage(text);
  const topics = [...new Set([...(inputs.currentTopics ?? []).map((t) => t.toLowerCase()), ...tokenize(text).slice(0, 6)])];
  return {
    channel: inputs.channel.trim().toLowerCase(),
    participants,
    topics,
    text: `${text} ${inputs.transcriptTail ?? ""}`.slice(-2000),
    threadParticipants: inputs.threadParticipants,
    explicitCallback: callback,
    now,
  };
}

/**
 * One-shot prompt context builder for call sites (TheForge / AutoForge /
 * Multi-Bot): gather live inputs → retrieve → format. Returns "" when the
 * engine is unbound, the channel differs, or nothing is relevant — an
 * empty result is a valid result (memory is never forced into a prompt).
 */
export function buildEpisodicPromptContext(inputs: EpisodicQueryInputs): string {
  const boundChannel = episodicMemory.getChannel();
  if (!boundChannel) return "";
  const query = buildEpisodeQuery(inputs);
  if (query.channel !== boundChannel) return ""; // never leak across channels
  const results = retrieveFromEngine(query);
  return formatEpisodicContext(results, episodicMemory.getSessionId(), query.now);
}

/**
 * Live-input adapter shared by both AutoForge loops (legacy + per-bot).
 * Reads plain snapshots (never the store — keeps this module pure) and
 * returns the bounded episodic prompt block, or undefined when disabled,
 * unbound, or nothing is relevant — all valid outcomes (memory is never
 * forced into a prompt). Human chat only: the bots' own lines must never
 * skew retrieval topics (same attribution rule as the Room Model).
 */
export function buildAutoForgeEpisodicContext(inputs: {
  enabled: boolean;
  channelName: string;
  chatLog: { user: string; text: string; selfSent?: boolean }[];
  audioTranscript: string;
  activeMomentTopicHints?: string[];
}): string | undefined {
  if (!inputs.enabled || !inputs.channelName) return undefined;
  const block = buildEpisodicPromptContext({
    channel: inputs.channelName,
    recentMessages: inputs.chatLog
      .filter((m) => !m.selfSent && m.user && m.text)
      .slice(-25)
      .map((m) => ({ user: m.user, text: m.text })),
    transcriptTail: inputs.audioTranscript ? inputs.audioTranscript.slice(-400) : undefined,
    currentTopics: inputs.activeMomentTopicHints,
  });
  return block || undefined;
}

// ─── Module singleton ─────────────────────────────────────────────────────────

/**
 * One engine per live session. The useEpisodicMemory hook feeds it closed
 * Room Model moments, ticks lifecycle maintenance, and mirrors the episode
 * store into the app store for React consumers + persistence. Reset on
 * channel switch, restored from channel snapshots.
 */
export const episodicMemory = new EpisodicMemoryEngine();
