/**
 * Room Read — the human-facing semantic contract over the Room Model.
 *
 * Problem: the Room Model (roomModel.ts) is a deterministic engine with a
 * telemetry-shaped Room State ("spike", 0.72 confidence, 14 msgs/min). That
 * is machine truth, not human meaning. The Room Read Card must answer
 * "what is happening right now?" in one sentence a streamer trusts.
 *
 * Solution: one pure derivation layer between the canonical Room Model and
 * every presentation surface (CORE, STUDIO, mobile):
 *
 *   RoomModelEngine → store mirror (roomState/roomMoments)
 *     → deriveRoomRead() ← contextual facts (bot activity, streamer callout)
 *       → stabilizeRoomRead() (hysteresis + minimum display lifetime)
 *         → RoomReadCard (CORE / compact / studio variants)
 *
 * Truth contract enforced here:
 * - NEVER overclaims. Confidence bands scale the language: high → assertive
 *   copy, medium → "seems/appears", low → factual fallback only.
 * - Semantic claims expire. A moment only anchors the headline while its
 *   evidence is fresh; stale vision/audio never appear in present-tense claims.
 * - Bots are not humans. Human/bot attribution comes from the engine (chat
 *   velocity is human-only) plus `botsActiveRecent` — bot-only chatter can
 *   never manufacture a "busy room" and is named explicitly when it is all
 *   there is.
 * - Quiet is valid. A silent room renders as a quiet room, never as broken.
 * - No AI required. Every headline is deterministic; AI-synthesized moment
 *   summaries are used only when the engine already produced them.
 *
 * This module is pure: no store, no React, no AI calls, no timers. All
 * timestamps are explicit parameters. Testable deterministically.
 */

import {
  laneStatus,
  parsePlatformEventSummary,
  type RoomActivityLevel,
  type RoomLane,
  type RoomLaneStatus,
  type RoomMoment,
  type RoomState,
  type RoomTrend,
} from "./roomModel";
import type { PerceptionLiveness, PerceptionLane } from "./perceptionLiveness";
import type { SentimentLabel } from "../types";

// ─── Contract ─────────────────────────────────────────────────────────────────

export type RoomReadStatus = "observing" | "ready" | "quiet" | "partial" | "stale";
export type RoomReadBand = "high" | "medium" | "low";

export interface RoomReadChip {
  kind: "activity" | "mood" | "streamer" | "threads" | "vision" | "platform" | "callout" | "bots" | "stale";
  label: string;
  emphasis: "high" | "normal" | "dim";
}

export interface RoomReadEvidenceGroup {
  source: string;
  lines: string[];
}

export interface RoomReadLaneInfo {
  lane: RoomLane;
  status: RoomLaneStatus;
  ageMs: number | null;
}

/** The single canonical derived read. All surfaces consume this shape. */
export interface RoomReadState {
  status: RoomReadStatus;
  headline: string;
  band: RoomReadBand;
  /** 0..1 — how strongly current evidence supports the headline. */
  confidence: number;
  activityLevel: RoomActivityLevel;
  activityTrend: RoomTrend;
  chips: RoomReadChip[];
  evidence: RoomReadEvidenceGroup[];
  lanes: RoomReadLaneInfo[];
  momentId: string | null;
  /** Identity of the semantic anchor — stability comparisons use this. */
  semanticKey: string;
  /** Anchor strength: callout(4) > platform event(3) > moment(2) > ambient(1) > fallback(0). */
  priority: number;
  /** When the current headline was first displayed (set by stabilizeRoomRead). */
  headlineAt: number;
  updatedAt: number;
}

export interface RoomReadInput {
  state: RoomState | null;
  moments: RoomMoment[];
  now: number;
  /** MADchatter bots sent/marked lines recently — never human room activity. */
  botsActiveRecent?: boolean;
  /** Streamer said a bot name in the transcript recently (fuzzy matched upstream). */
  streamerCallout?: { name: string; text: string; at: number } | null;
  /** Canonical Perception Liveness lanes (perceptionLiveness engine). When
   *  present they override the Room-Model freshness heuristic for lane
   *  status and gate semantic chips — the Room Read must never present
   *  stale perception as current truth. Null keeps legacy behavior. */
  liveness?: PerceptionLiveness[] | null;
}

// ─── Tuning constants (exported for tests) ────────────────────────────────────

export const ROOM_READ_LIMITS = {
  /** Streamer callout is prominent only this long. */
  calloutWindowMs: 60_000,
  /** A platform event anchors the read only this long after it happened. */
  platformAnchorWindowMs: 120_000,
  /** Active moment anchors the headline only while its evidence is this fresh. */
  momentFreshnessMs: 90_000,
  conversationFreshnessMs: 240_000,
  /** Vision counts as "changed recently" only inside this window. */
  visionChangedWindowMs: 45_000,
  /** Minimum time a semantic headline stays on screen (anti-flicker). */
  minHeadlineLifetimeMs: 10_000,
  /** Semantic confidence decay: after this age a moment anchor decays one band. */
  momentAgeSoftCapMs: 120_000,
  maxChips: 5,
} as const;

const ACTIVITY_LEVEL_RANK: Record<RoomActivityLevel, number> = {
  silent: 0, quiet: 1, normal: 2, active: 3, spike: 4,
};

const MOOD_LABELS: Record<SentimentLabel, string> = {
  positive: "Positive",
  negative: "Negative",
  hype: "Hyped",
  wholesome: "Wholesome",
  toxic: "Toxic",
  neutral: "Neutral",
};

const ACTIVITY_LABELS: Record<RoomActivityLevel, string> = {
  silent: "Silent",
  quiet: "Quiet",
  normal: "Chat active",
  active: "High activity",
  spike: "Activity spike",
};

function trendArrow(trend: RoomTrend): string {
  return trend === "rising" ? " ↑" : trend === "falling" ? " ↓" : "";
}

function bandFor(confidence: number): RoomReadBand {
  if (confidence >= 0.65) return "high";
  if (confidence >= 0.4) return "medium";
  return "low";
}

/** Age-decay a moment's confidence: fresh evidence keeps it, age erodes it. */
function agedConfidence(moment: RoomMoment, now: number): number {
  const age = now - moment.updatedAt;
  if (age <= ROOM_READ_LIMITS.momentAgeSoftCapMs) return moment.confidence;
  // One halving per additional soft-cap elapsed — old anchors decay fast.
  const periods = age / ROOM_READ_LIMITS.momentAgeSoftCapMs;
  return moment.confidence * Math.pow(0.5, periods - 1);
}

function momentIsFresh(moment: RoomMoment, now: number): boolean {
  const window = moment.kind === "conversation"
    ? ROOM_READ_LIMITS.conversationFreshnessMs
    : ROOM_READ_LIMITS.momentFreshnessMs;
  return now - moment.updatedAt <= window;
}

// ─── Headline templates (deterministic, confidence-scaled) ────────────────────

function platformHeadline(kind: string, magnitude?: number): string {
  switch (kind) {
    case "raid":
      return magnitude != null && magnitude >= 10
        ? `A ${magnitude}-viewer raid just jolted the room awake.`
        : "A raid just landed.";
    case "cheer":
      return magnitude != null && magnitude >= 100
        ? `Someone just cheered ${magnitude.toLocaleString()} bits.`
        : "Someone just cheered.";
    case "sub":
      return "A new subscription just happened.";
    case "resub":
      return magnitude != null && magnitude >= 6
        ? `A ${magnitude}-month resub just happened.`
        : "Someone just resubscribed.";
    case "subgift":
      return "A gifted sub just landed.";
    case "host":
      return "A host just brought viewers over.";
    default:
      return "A stream event just happened.";
  }
}

function momentHeadline(moment: RoomMoment, band: RoomReadBand, now: number): string {
  const s = moment.signals;
  // AI-synthesized summary: the engine only fills these on verified, closed
  // moments; an active moment carrying one was restored/synthesized upstream.
  if (moment.summary && moment.provenance.aiSynthesized) return moment.summary;

  switch (moment.kind) {
    case "conversation": {
      const topic = moment.topicHints?.[0];
      const useTopic = topic && moment.confidence >= 0.6;
      if (useTopic) return `A conversation about ${topic} is carrying the room.`;
      const n = s.conversation?.participants?.length ?? s.chatActivity?.humanMessages ?? 0;
      return n >= 3
        ? `${n} viewers are chatting together.`
        : "A small conversation is carrying the room.";
    }
    case "reaction": {
      const visionTag = s.vision?.tags?.[0];
      if (visionTag) {
        return band === "high"
          ? `Chat is reacting to the ${visionTag}.`
          : `Chat seems to be reacting to a ${visionTag}.`;
      }
      return band === "high"
        ? "Chat just erupted."
        : band === "medium"
          ? "Chat seems to be reacting to something."
          : "Chat activity just picked up.";
    }
    case "stream_event": {
      const summary = s.platformEvents?.[s.platformEvents.length - 1];
      if (summary) {
        const detail = parsePlatformEventSummary(summary);
        return platformHeadline(detail.kind, detail.magnitude);
      }
      return "A stream event just happened.";
    }
    case "visual_event": {
      const tag = s.vision?.tags?.[0];
      return tag
        ? band === "low" ? `The scene may have changed — ${tag}.` : `The scene just changed — ${tag}.`
        : "Something big just changed on stream.";
    }
    case "energy_shift":
      return "Streamer audio just spiked.";
    case "quiet":
      return "The room has gone quiet.";
    default:
      return band === "low" ? "Chat activity just picked up." : "Chat is reacting right now.";
  }
}

// ─── Chips ────────────────────────────────────────────────────────────────────

function buildChips(
  state: RoomState,
  activeMoment: RoomMoment | null,
  input: RoomReadInput,
  lanes: RoomReadLaneInfo[],
): RoomReadChip[] {
  const chips: RoomReadChip[] = [];
  const now = input.now;
  const callout = input.streamerCallout;
  const liveness = input.liveness ?? null;
  const laneOf = (lane: PerceptionLane) => liveness?.find((l) => l.lane === lane) ?? null;
  // Liveness gates: semantic chips may only claim what living sensors can
  // support. Without liveness input the legacy behavior stands (§25 keeps
  // the Room Read honest when its evidence has died).
  const audioUsable = !laneOf("audio") || laneOf("audio")!.status === "live" || laneOf("audio")!.status === "quiet";
  const visionUsable = !laneOf("vision") || laneOf("vision")!.status === "live" || laneOf("vision")!.status === "quiet";

  if (callout && now - callout.at <= ROOM_READ_LIMITS.calloutWindowMs) {
    chips.push({ kind: "callout", label: "Direct callout", emphasis: "high" });
    chips.push({ kind: "activity", label: "Response opportunity", emphasis: "high" });
  }

  const platform = latestPlatformEvent(state);
  if (platform) {
    chips.push({ kind: "platform", label: platform.label, emphasis: "high" });
  }

  const level = state.activity.level;
  if (level !== "silent") {
    chips.push({
      kind: "activity",
      label: ACTIVITY_LABELS[level] + trendArrow(state.activity.trend),
      emphasis: level === "spike" || level === "active" ? "high" : "normal",
    });
  } else if (input.botsActiveRecent) {
    chips.push({ kind: "bots", label: "MADchatter bots active", emphasis: "dim" });
  } else {
    chips.push({ kind: "activity", label: "Quiet", emphasis: "dim" });
  }

  if (state.sentiment && level !== "silent") {
    chips.push({ kind: "mood", label: MOOD_LABELS[state.sentiment.current] ?? "Mixed", emphasis: "normal" });
  }

  if (state.conversation?.streamerEngaged) {
    chips.push({ kind: "streamer", label: "Streamer engaged", emphasis: "normal" });
  } else if (audioUsable && state.audio && state.audio.level !== "silent" && state.audio.level !== "quiet" && now - state.audio.updatedAt < 60_000) {
    chips.push({ kind: "streamer", label: "Streamer talking", emphasis: "normal" });
  }

  const threads = state.conversation?.activeThreads ?? activeMoment?.signals.conversation?.activeThreads ?? 0;
  if (threads > 0) {
    chips.push({ kind: "threads", label: `${threads} active thread${threads === 1 ? "" : "s"}`, emphasis: "normal" });
  }

  if (visionUsable && state.vision) {
    const changedRecently =
      now - state.vision.changedAt <= ROOM_READ_LIMITS.visionChangedWindowMs &&
      (state.vision.changeMagnitude == null || state.vision.changeMagnitude >= 0.08);
    if (changedRecently) {
      chips.push({ kind: "vision", label: "Scene changed recently", emphasis: "normal" });
    } else {
      const visionLane = lanes.find((l) => l.lane === "vision");
      if (visionLane?.status === "stale") {
        chips.push({ kind: "stale", label: "Vision stale", emphasis: "dim" });
      } else if (state.vision.tags.length > 0) {
        chips.push({ kind: "vision", label: state.vision.tags[0].slice(0, 40), emphasis: "dim" });
      }
    }
  }

  // Unhealthy lanes surface as dim warnings (surviving lanes stay useful).
  if (liveness) {
    const LANE_NAMES: Record<PerceptionLane, string> = {
      chat: "Chat", audio: "Audio", vision: "Vision", platform_events: "Events",
    };
    for (const l of liveness) {
      if (l.status !== "stale" && l.status !== "degraded" && l.status !== "error") continue;
      const label = `${LANE_NAMES[l.lane]} ${l.status === "error" ? "error" : l.status}`;
      if (!chips.some((c) => c.label === label)) {
        chips.push({ kind: "stale", label, emphasis: l.status === "error" ? "normal" : "dim" });
      }
    }
  } else {
    for (const lane of lanes) {
      if (lane.status !== "stale" || lane.lane === "vision") continue;
      const label = lane.lane === "audio" || lane.lane === "transcript" ? "Audio stale" : "Events stale";
      if (!chips.some((c) => c.label === label)) {
        chips.push({ kind: "stale", label, emphasis: "dim" });
      }
    }
  }

  return chips.slice(0, ROOM_READ_LIMITS.maxChips);
}

function latestPlatformEvent(state: RoomState): { label: string; kind: string } | null {
  // Platform events in Room State are summaries (newest last). We only know
  // their content, not their timestamp — freshness comes from the platform
  // lane + any anchoring moment, so the label is chip-only (never a headline
  // by itself unless the engine made it a moment).
  const last = state.platformEvents[state.platformEvents.length - 1];
  if (!last) return null;
  const detail = parsePlatformEventSummary(last);
  const labels: Record<string, string> = {
    raid: "Raid", cheer: "Cheer", sub: "Sub", resub: "Resub",
    subgift: "Gifted sub", host: "Host", follow: "Follow", other: "Event",
  };
  return { label: labels[detail.kind] ?? "Event", kind: detail.kind };
}

// ─── Evidence (Why? panel) ─────────────────────────────────────────────────────

function ageWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return `${m}m`;
}

function buildEvidence(
  state: RoomState,
  activeMoment: RoomMoment | null,
  now: number,
): RoomReadEvidenceGroup[] {
  const groups: RoomReadEvidenceGroup[] = [];

  const chatLines: string[] = [];
  if (activeMoment) {
    const chat = activeMoment.signals.chatActivity;
    if (chat?.humanMessages) chatLines.push(`${chat.humanMessages} human message${chat.humanMessages === 1 ? "" : "s"} since the moment began`);
    if (chat?.botMessages) chatLines.push(`${chat.botMessages} bot message${chat.botMessages === 1 ? "" : "s"} (attributed, not room activity)`);
  } else {
    chatLines.push(`~${state.activity.velocity} human msgs/min over the last minute`);
  }
  for (const line of activeMoment?.evidenceLines ?? []) {
    if (!line.startsWith("[streamer]")) chatLines.push(line);
  }
  if (chatLines.length > 0) groups.push({ source: "Chat", lines: chatLines.slice(0, 6) });

  if (activeMoment) {
    const s = activeMoment.signals;
    if (s.audio) {
      const lines: string[] = [`Streamer audio: ${s.audio.energy ?? "active"}`];
      for (const line of activeMoment.evidenceLines) {
        if (line.startsWith("[streamer]")) lines.push(`Streamer said: ${line.slice("[streamer] ".length)}`);
      }
      groups.push({ source: "Audio", lines: lines.slice(0, 4) });
    }
    if (s.vision) {
      const lines: string[] = [];
      if (s.vision.changeMagnitude != null) {
        lines.push(s.vision.changeMagnitude >= 0.15 ? "Large visual change" : "Visual change detected");
      }
      if (s.vision.tags?.length) lines.push(`Vision: ${s.vision.tags.slice(0, 3).join(", ")}`);
      if (lines.length > 0) groups.push({ source: "Vision", lines });
    }
    if (s.conversation && (s.conversation.activeThreads || s.conversation.participants?.length)) {
      const lines: string[] = [];
      if (s.conversation.activeThreads) lines.push(`${s.conversation.activeThreads} active reply thread${s.conversation.activeThreads === 1 ? "" : "s"}`);
      if (s.conversation.participants?.length) lines.push(`Participants: ${s.conversation.participants.slice(0, 5).join(", ")}`);
      groups.push({ source: "Conversation", lines });
    }
    if (s.platformEvents?.length) {
      groups.push({ source: "Platform", lines: s.platformEvents.slice(-3) });
    }
  } else {
    if (state.conversation?.activeThreads) {
      groups.push({ source: "Conversation", lines: [`${state.conversation.activeThreads} active reply thread${state.conversation.activeThreads === 1 ? "" : "s"}`] });
    }
    if (state.vision?.tags.length) {
      groups.push({ source: "Vision", lines: [`Scene: ${state.vision.tags.slice(0, 3).join(", ")} (updated ${ageWords(now - state.vision.changedAt)} ago)`] });
    }
  }

  return groups;
}

// ─── Canonical liveness → Room Read lanes (§25) ────────────────────────────────

const LIVENESS_LANE_MAP: Record<PerceptionLane, RoomLane> = {
  chat: "chat",
  audio: "audio",
  vision: "vision",
  platform_events: "platform",
};

/** Map a canonical PerceptionStatus onto the Room Read lane vocabulary. */
function livenessToLaneStatus(status: PerceptionLiveness["status"]): RoomLaneStatus {
  switch (status) {
    case "live": return "live";
    case "quiet": return "quiet";
    default: return "stale"; // stale / degraded / error / initializing all mean
    // "do not trust this lane as current" for semantic claims.
  }
}

function livenessLaneInfo(l: PerceptionLiveness, now: number): RoomReadLaneInfo {
  return {
    lane: LIVENESS_LANE_MAP[l.lane],
    status: livenessToLaneStatus(l.status),
    ageMs: l.ageMs ?? (l.lastValidOutputAt != null ? now - l.lastValidOutputAt : null),
  };
}

// ─── Derivation ────────────────────────────────────────────────────────────────

/**
 * Derive the canonical Room Read from the Room Model mirror + contextual
 * facts. Pure and deterministic: the same input always yields the same read.
 *
 * Headline priority (spec §9): streamer callout > platform event anchor >
 * high-confidence active Moment > contextual synthesis from Room State >
 * factual fallback. Nothing here calls AI or invents evidence.
 */
export function deriveRoomRead(input: RoomReadInput): RoomReadState {
  const { state, moments, now } = input;
  if (!state) {
    return {
      status: "observing",
      headline: "Getting oriented — collecting enough context.",
      band: "low",
      confidence: 0,
      activityLevel: "silent",
      activityTrend: "stable",
      chips: [],
      evidence: [],
      lanes: [],
      momentId: null,
      semanticKey: "observing",
      priority: 0,
      headlineAt: 0,
      updatedAt: now,
    };
  }

  let lanes: RoomReadLaneInfo[] = (["chat", "audio", "vision", "platform", "transcript"] as RoomLane[]).map((lane) => {
    const status = laneStatus(state, lane, now);
    const at = state.freshness[lane];
    return { lane, status, ageMs: at != null ? now - at : null };
  });
  // Canonical Perception Liveness overrides the freshness heuristic: the
  // liveness engine knows transport health, pipeline stages, and quiet-vs-
  // stale semantics the raw timestamps cannot express.
  if (input.liveness && input.liveness.length > 0) {
    const audioLane = input.liveness.find((l) => l.lane === "audio");
    lanes = input.liveness.map((l) => livenessLaneInfo(l, now));
    // Transcript lane follows the audio transcription stage (same pipeline).
    const transcriptStage = audioLane?.stages?.transcription;
    if (transcriptStage) {
      lanes.push({
        lane: "transcript",
        status: livenessToLaneStatus(transcriptStage.status),
        ageMs: audioLane?.lastValidOutputAt != null ? now - audioLane.lastValidOutputAt : null,
      });
    }
  }
  const anyLive = lanes.some((l) => l.status === "live");
  const anyStale = lanes.some((l) => l.status === "stale");

  const activeMoment = state.activeMomentId
    ? moments.find((m) => m.id === state.activeMomentId && m.status === "active") ?? null
    : null;

  // ── Headline selection ──────────────────────────────────────────────────
  let headline = "";
  let band: RoomReadBand = "low";
  let confidence = 0;
  let momentId: string | null = null;
  let semanticKey = "";
  let priority = 0;

  const callout = input.streamerCallout;
  const calloutFresh = callout && now - callout.at <= ROOM_READ_LIMITS.calloutWindowMs;

  // Recent platform fact (deterministic, near-certain) anchors the read even
  // if the engine's moment already idle-closed.
  const platformSummary = state.platformEvents[state.platformEvents.length - 1];
  const platformFresh = state.freshness.platform != null &&
    now - state.freshness.platform <= ROOM_READ_LIMITS.platformAnchorWindowMs;
  const platformDetail = platformSummary ? parsePlatformEventSummary(platformSummary) : null;

  if (calloutFresh && callout) {
    headline = `The streamer just called for ${callout.name}.`;
    band = "high";
    confidence = 0.72; // transcript + fuzzy name match: strong but not certain
    semanticKey = `callout:${callout.name}:${callout.at}`;
    priority = 4;
  } else if (platformFresh && platformDetail && platformDetail.kind !== "other" && platformDetail.kind !== "follow") {
    headline = platformHeadline(platformDetail.kind, platformDetail.magnitude);
    band = "high";
    confidence = 0.95; // platform events are deterministic facts
    semanticKey = `platform:${platformDetail.kind}`;
    priority = 3;
    momentId = activeMoment?.id ?? null;
  } else if (activeMoment && momentIsFresh(activeMoment, now)) {
    confidence = agedConfidence(activeMoment, now);
    band = bandFor(confidence);
    headline = momentHeadline(activeMoment, band, now);
    momentId = activeMoment.id;
    semanticKey = `moment:${activeMoment.id}`;
    priority = 2;
  } else {
    // Contextual synthesis from reliable live signals — factual fallbacks only.
    const level = state.activity.level;
    const streamerTalking = state.conversation?.streamerEngaged ?? false;
    const threads = state.conversation?.activeThreads ?? 0;
    if (level === "spike" || (level === "active" && state.activity.trend === "rising")) {
      headline = "Chat activity is spiking.";
      confidence = state.confidence * 0.8;
      semanticKey = "ambient:spike";
      priority = 1;
    } else if (streamerTalking && (level === "silent" || level === "quiet")) {
      headline = "The streamer is talking while chat stays quiet.";
      confidence = state.confidence * 0.8;
      semanticKey = "ambient:streamer-talking";
      priority = 1;
    } else if (threads > 0 && level !== "silent") {
      headline = `${threads} conversation${threads === 1 ? " is" : "s are"} underway.`;
      confidence = state.confidence * 0.8;
      semanticKey = "ambient:threads";
      priority = 1;
    } else if (state.activity.trend === "rising" && level !== "silent") {
      headline = "Chat activity is rising.";
      confidence = state.confidence * 0.8;
      semanticKey = "ambient:rising";
      priority = 1;
    } else if (level === "silent" || level === "quiet") {
      headline = input.botsActiveRecent
        ? "Chat is quiet — MADchatter bots are currently active."
        : "The room is quiet.";
      confidence = state.confidence * 0.7;
      semanticKey = input.botsActiveRecent ? "ambient:quiet-bots" : "ambient:quiet";
      priority = 0;
    } else {
      headline = level === "active" ? "Chat is busy." : "Chat is active.";
      confidence = state.confidence * 0.7;
      semanticKey = `ambient:${level}`;
      priority = 0;
    }
    band = bandFor(confidence);
  }

  // ── Status selection ─────────────────────────────────────────────────────
  const level = state.activity.level;
  let status: RoomReadStatus;
  if (!anyLive && !anyStale && state.activity.velocity === 0 && moments.length === 0 && !input.botsActiveRecent) {
    status = "observing";
  } else if (!anyLive && level !== "silent" && anyStale) {
    // Perception stopped while the room was demonstrably not silent — the
    // read may no longer describe the present. Say so instead of pretending.
    status = "stale";
    headline = "Context may be stale — perception stopped updating.";
    semanticKey = "stale";
    priority = 0;
    band = "low";
    confidence = Math.min(confidence, 0.3);
  } else if ((level === "silent" || level === "quiet") && (!activeMoment || activeMoment.kind === "quiet")) {
    status = "quiet";
  } else if (anyStale && anyLive) {
    status = "partial";
  } else {
    status = "ready";
  }

  const chips = buildChips(state, activeMoment, input, lanes);
  const evidence = buildEvidence(state, activeMoment, now);

  return {
    status,
    headline,
    band,
    confidence,
    activityLevel: level,
    activityTrend: state.activity.trend,
    chips,
    evidence,
    lanes,
    momentId,
    semanticKey,
    priority,
    headlineAt: 0,
    updatedAt: now,
  };
}

// ─── Stabilization (hysteresis + minimum display lifetime) ─────────────────────

/**
 * Keep the semantic read stable without freezing the fast deterministic
 * layers. Rules:
 * - Same semantic anchor → keep the displayed headline (no synonym roulette;
 *   chips/freshness/confidence still update every derivation).
 * - A new anchor waits MIN_LIFETIME unless it outranks the current one
 *   (a raid preempts a conversation immediately; a topic tweak does not).
 * - Truthfulness always wins: stale/observing transitions apply instantly.
 * - Activity-status hysteresis: quiet ↔ ready flapping around 1–5 msgs/min
 *   never toggles the status more than once per anchor change.
 */
export function stabilizeRoomRead(next: RoomReadState, prev: RoomReadState | null, now: number): RoomReadState {
  if (!prev) return { ...next, headlineAt: now };

  if (next.semanticKey === prev.semanticKey) {
    return { ...next, headline: prev.headline, headlineAt: prev.headlineAt };
  }

  const truthfulnessWin =
    next.status === "stale" || next.status === "observing" || prev.status === "stale" ||
    prev.semanticKey.startsWith("callout:");
  const higherPriority = next.priority > prev.priority;
  const lifetimeElapsed = now - prev.headlineAt >= ROOM_READ_LIMITS.minHeadlineLifetimeMs;

  if (!truthfulnessWin && !higherPriority && !lifetimeElapsed) {
    // Defer the new semantic anchor; keep everything else current.
    return {
      ...next,
      headline: prev.headline,
      semanticKey: prev.semanticKey,
      priority: prev.priority,
      headlineAt: prev.headlineAt,
    };
  }

  // Activity hysteresis between ambient (non-moment) reads only: a moment
  // anchor always reflects real evidence and is exempt.
  let status = next.status;
  const bothAmbient = !prev.momentId && !next.momentId;
  if (bothAmbient) {
    if (prev.status === "quiet" && next.status === "ready" &&
      ACTIVITY_LEVEL_RANK[next.activityLevel] < ACTIVITY_LEVEL_RANK.normal) {
      status = "quiet";
    } else if (prev.status === "ready" && next.status === "quiet" &&
      ACTIVITY_LEVEL_RANK[next.activityLevel] > ACTIVITY_LEVEL_RANK.silent) {
      status = "ready";
    }
  }

  return { ...next, status, headlineAt: now };
}

// ─── Observability ────────────────────────────────────────────────────────────

/** Developer-readable snapshot (diagnostics). No secrets, no raw prompts. */
export function debugRoomRead(read: RoomReadState): Record<string, unknown> {
  return {
    status: read.status,
    headline: read.headline,
    band: read.band,
    confidence: Number(read.confidence.toFixed(2)),
    updatedAt: read.updatedAt,
    sourceMomentId: read.momentId,
    semanticKey: read.semanticKey,
    signals: {
      activity: read.activityLevel,
      trend: read.activityTrend,
      chips: read.chips.map((c) => c.label),
    },
    freshness: Object.fromEntries(
      read.lanes.map((l) => [l.lane, l.ageMs != null ? `${l.status} ${ageWords(l.ageMs)}` : l.status]),
    ),
  };
}
