/**
 * Focused test harness for the Room Read semantic contract.
 * Run: npx tsx src/lib/roomRead.test.ts
 *
 * Covers the Room Read test matrix: lifecycle states (observing, ready,
 * quiet, partial, stale), headline priority (callout > platform > moment >
 * ambient > fallback), confidence-scaled wording, freshness expiry (semantic
 * TTL), human/bot attribution, vision-stale exclusion, semantic stability
 * (no flicker, minimum lifetime, priority preemption), activity hysteresis,
 * stale-async moment guards, and observability output shape.
 *
 * All functions under test are pure — no store, no React, no AI calls.
 * Every timestamp is explicit (fixed T0).
 */

import {
  deriveRoomRead,
  stabilizeRoomRead,
  debugRoomRead,
  ROOM_READ_LIMITS,
  type RoomReadInput,
  type RoomReadState,
} from "./roomRead";
import type { RoomState, RoomMoment, RoomLane } from "./roomModel";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const T0 = 1_700_000_000_000;
const SEC = 1_000;
const MIN = 60_000;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function mkState(overrides: Partial<RoomState> = {}): RoomState {
  return {
    channel: "testchannel",
    updatedAt: T0,
    activity: { level: "normal", trend: "stable", velocity: 8 },
    platformEvents: [],
    recentMomentIds: [],
    freshness: {},
    confidence: 0.6,
    ...overrides,
  };
}

function mkMoment(overrides: Partial<RoomMoment> = {}): RoomMoment {
  return {
    id: "moment_test1",
    channel: "testchannel",
    startedAt: T0 - 30_000,
    updatedAt: T0,
    status: "active",
    kind: "reaction",
    significance: 0.7,
    confidence: 0.75,
    sources: ["chat"],
    signals: {},
    evidenceRefs: [],
    evidenceLines: [],
    provenance: { deterministic: true, aiSynthesized: false },
    updateCount: 3,
    ...overrides,
  };
}

function derive(input: Partial<RoomReadInput>): RoomReadState {
  return deriveRoomRead({
    state: mkState(),
    moments: [],
    now: T0,
    ...input,
  } as RoomReadInput);
}

// ─── 1. Lifecycle states ─────────────────────────────────────────────────────

{
  const read = derive({ state: null, moments: [] });
  check("no state → observing", read.status === "observing");
  check("observing headline is restrained", read.headline.includes("Getting oriented"), read.headline);
  check("observing invents nothing", read.chips.length === 0 && read.evidence.length === 0);
}

{
  // Freshly connected, chat flowing, nothing else — still collecting.
  const state = mkState({
    activity: { level: "silent", trend: "stable", velocity: 0 },
    freshness: { chat: T0 - 5_000 },
  });
  const read = derive({ state, moments: [] });
  check("no evidence + no moments → observing", read.status === "observing", read.status);
}

{
  // Quiet valid room: chat silent, nothing manufactured.
  const state = mkState({
    activity: { level: "silent", trend: "stable", velocity: 0 },
    freshness: { chat: T0 - 10_000 },
  });
  const quietMoment = mkMoment({
    id: "moment_quiet",
    kind: "quiet",
    significance: 0.1,
    confidence: 0.6,
    signals: { chatActivity: { level: "silent", humanMessages: 0 } },
    status: "active",
  });
  const read = derive({ state, moments: [quietMoment] });
  check("quiet room → quiet status", read.status === "quiet", read.status);
  check("quiet room → valid quiet headline", read.headline === "The room is quiet.", read.headline);
  check("quiet room → no invented topic", !read.headline.includes("about"));
  check("quiet room never looks broken", read.band !== undefined);
}

{
  // Ready: normal activity, no moment.
  const state = mkState({ activity: { level: "normal", trend: "stable", velocity: 8 }, freshness: { chat: T0 - 2_000 } });
  const read = derive({ state, moments: [] });
  check("normal activity + fresh chat → ready", read.status === "ready", read.status);
  check("ambient ready headline is factual", read.headline === "Chat is active.", read.headline);
}

{
  // Stale: perception stopped while the room was demonstrably not silent.
  const state = mkState({
    activity: { level: "normal", trend: "stable", velocity: 8 },
    freshness: { chat: T0 - 5 * MIN }, // way past the 120s chat stale threshold
  });
  const read = derive({ state, moments: [] });
  check("dead perception + non-silent room → stale", read.status === "stale", read.status);
  check("stale read says so honestly", read.headline.includes("stale"), read.headline);
  check("stale read caps confidence", read.confidence <= 0.3, `${read.confidence}`);
}

{
  // Partial: chat live, vision stale.
  const state = mkState({
    activity: { level: "normal", trend: "stable", velocity: 8 },
    freshness: { chat: T0 - 2_000, vision: T0 - 5 * MIN },
    vision: { tags: ["lobby screen"], changedAt: T0 - 5 * MIN },
  });
  const read = derive({ state, moments: [] });
  check("live chat + stale vision → partial", read.status === "partial", read.status);
  check("stale vision surfaces a dim warning chip", read.chips.some((c) => c.kind === "stale" && c.label === "Vision stale"));
  check("stale vision never enters the headline", !read.headline.toLowerCase().includes("lobby"));
}

// ─── 2. Headline priority ────────────────────────────────────────────────────

{
  // Callout outranks everything.
  const raidMoment = mkMoment({
    id: "moment_raid",
    kind: "stream_event",
    significance: 0.95,
    confidence: 0.95,
    sources: ["platform"],
    signals: { platformEvents: ["⚔️raider raided with 214 viewers"] },
  });
  const state = mkState({
    activity: { level: "spike", trend: "rising", velocity: 40 },
    platformEvents: ["⚔️raider raided with 214 viewers"],
    freshness: { platform: T0 - 5_000, chat: T0 - 1_000 },
    activeMomentId: "moment_raid",
  });
  const withRaid = derive({ state, moments: [raidMoment] });
  check("raid anchors the headline", withRaid.headline.includes("214-viewer raid"), withRaid.headline);
  check("raid is high confidence (platform fact)", withRaid.band === "high" && withRaid.confidence >= 0.9);
  check("raid priority 3", withRaid.priority === 3);

  const withCallout = derive({
    state, moments: [raidMoment],
    streamerCallout: { name: "MADchatter", text: "yo MADchatter what do you think", at: T0 - 3_000 },
  });
  check("streamer callout outranks a raid", withCallout.headline.includes("called for MADchatter"), withCallout.headline);
  check("callout priority 4", withCallout.priority === 4);
  check("callout chip present", withCallout.chips.some((c) => c.kind === "callout"));

  // Callout expires.
  const expired = derive({
    state, moments: [raidMoment],
    streamerCallout: { name: "MADchatter", text: "yo", at: T0 - ROOM_READ_LIMITS.calloutWindowMs - SEC },
  });
  check("old callout expires (raid resumes)", expired.headline.includes("raid"), expired.headline);
}

{
  // Platform anchor also expires.
  const state = mkState({
    platformEvents: ["⚔️raider raided with 214 viewers"],
    freshness: { platform: T0 - ROOM_READ_LIMITS.platformAnchorWindowMs - SEC },
  });
  const read = derive({ state, moments: [] });
  check("platform event beyond window does not anchor", !read.headline.includes("raid"), read.headline);
}

{
  // High-confidence active conversation moment with topic.
  const convo = mkMoment({
    id: "moment_convo",
    kind: "conversation",
    confidence: 0.8,
    significance: 0.55,
    topicHints: ["build"],
    signals: {
      conversation: { activeThreads: 2, participants: ["a", "b", "c"] },
      chatActivity: { level: "quiet", humanMessages: 9 },
    },
    evidenceLines: ["a: what build is this", "b: the hunter one"],
  });
  const state = mkState({
    activity: { level: "quiet", trend: "stable", velocity: 3 },
    activeMomentId: "moment_convo",
    freshness: { chat: T0 - 4_000 },
  });
  const read = derive({ state, moments: [convo] });
  check("conversation moment anchors the read", read.momentId === "moment_convo");
  check("topic appears when supported", read.headline.includes("build"), read.headline);
  check("conversation headline is present-tense and specific", read.headline.includes("carrying the room") || read.headline.includes("chatting"), read.headline);
  check("evidence lists human messages", read.evidence.some((g) => g.source === "Chat" && g.lines.some((l) => l.includes("human"))));
}

{
  // AI-synthesized summary is used when present on the moment.
  const synthesized = mkMoment({
    id: "moment_synth",
    kind: "reaction",
    confidence: 0.85,
    summary: "Chat is riffing on the streamer's failed final round.",
    provenance: { deterministic: true, aiSynthesized: true, model: "test" },
  });
  const state = mkState({ activeMomentId: "moment_synth", freshness: { chat: T0 - 2_000 } });
  const read = derive({ state, moments: [synthesized] });
  check("AI moment summary is used verbatim", read.headline === synthesized.summary, read.headline);
}

{
  // Confidence-scaled wording on reaction moments.
  const high = mkMoment({ id: "m_high", kind: "reaction", confidence: 0.9 });
  const low = mkMoment({ id: "m_low", kind: "reaction", confidence: 0.45 });
  const readHigh = derive({ state: mkState({ activeMomentId: "m_high" }), moments: [high] });
  const readLow = derive({ state: mkState({ activeMomentId: "m_low" }), moments: [low] });
  check("high confidence → assertive copy", readHigh.headline === "Chat just erupted.", readHigh.headline);
  check("low confidence → probabilistic copy", readLow.headline.includes("seems"), readLow.headline);
  check("low confidence band", readLow.band === "medium" || readLow.band === "low");
}

{
  // Vision-tagged reaction: the visual claim is present-tense only when fresh.
  const freshVision = mkMoment({
    id: "m_v1", kind: "reaction", confidence: 0.8, updatedAt: T0,
    signals: { vision: { tags: ["defeat screen"] } },
  });
  const readFresh = derive({ state: mkState({ activeMomentId: "m_v1" }), moments: [freshVision] });
  check("fresh vision supports the headline", readFresh.headline.includes("defeat screen"), readFresh.headline);

  const staleMoment = mkMoment({
    id: "m_v2", kind: "reaction", confidence: 0.8,
    updatedAt: T0 - ROOM_READ_LIMITS.momentFreshnessMs - SEC, // expired anchor
    signals: { vision: { tags: ["defeat screen"] } },
  });
  const readStale = derive({ state: mkState({ activeMomentId: "m_v2" }), moments: [staleMoment] });
  check("semantic TTL: expired moment does not anchor", readStale.momentId === null, `${readStale.momentId}`);
  check("expired vision never stays present-tense", !readStale.headline.includes("defeat"), readStale.headline);
}

// ─── 3. Human vs bot activity ────────────────────────────────────────────────

{
  // Bot-only activity must not manufacture a busy room.
  const state = mkState({
    activity: { level: "silent", trend: "stable", velocity: 0 }, // engine: human-only
    freshness: { chat: T0 - 2_000 },
  });
  const read = derive({ state, moments: [], botsActiveRecent: true });
  check("bot-only: room stays quiet", read.status === "quiet", read.status);
  check("bot-only: bots named explicitly", read.headline.includes("MADchatter bots"), read.headline);
  check("bot-only: never called busy", !read.headline.includes("busy") && !read.headline.includes("buzzing"));
  check("bot-only: bot chip present and dim", read.chips.some((c) => c.kind === "bots" && c.emphasis === "dim"));
}

{
  // Human spike: activity rises.
  const state = mkState({
    activity: { level: "spike", trend: "rising", velocity: 45 },
    freshness: { chat: T0 - 1_000 },
  });
  const read = derive({ state, moments: [] });
  check("human spike → spike ambient read", read.headline === "Chat activity is spiking.", read.headline);
  check("spike chip is emphasized", read.chips.some((c) => c.kind === "activity" && c.emphasis === "high"));
}

{
  // Streamer talking while chat quiet.
  const state = mkState({
    activity: { level: "quiet", trend: "stable", velocity: 2 },
    freshness: { chat: T0 - 3_000, transcript: T0 - 4_000 },
    conversation: { activeThreads: 0, participants: [], streamerEngaged: true },
  });
  const read = derive({ state, moments: [] });
  check("streamer-talking ambient read", read.headline.includes("streamer is talking"), read.headline);
}

// ─── 4. Semantic stability (no flicker) ───────────────────────────────────────

{
  const t0 = T0;
  const quiet = derive({ state: mkState({ activity: { level: "quiet", trend: "stable", velocity: 2 } }), moments: [] });
  const stable1 = stabilizeRoomRead(quiet, null, t0);
  check("first read adopts immediately", stable1.headline === quiet.headline && stable1.headlineAt === t0);

  // Same semantic key → headline retained even if chips change.
  const quietAgain = derive({ state: mkState({ activity: { level: "quiet", trend: "stable", velocity: 3 } }), moments: [] });
  const stable2 = stabilizeRoomRead(quietAgain, stable1, t0 + SEC);
  check("same anchor → headline retained", stable2.headline === stable1.headline);
  check("same anchor → headlineAt retained (no re-timing)", stable2.headlineAt === t0);

  // Different equal-priority anchor within minimum lifetime → deferred.
  const normal = derive({ state: mkState({ activity: { level: "normal", trend: "stable", velocity: 8 } }), moments: [] });
  const deferred = stabilizeRoomRead(normal, stable2, t0 + 2 * SEC);
  check("new ambient anchor within lifetime is deferred", deferred.headline === stable2.headline, deferred.headline);
  check("deferred read keeps fast layers current", deferred.chips.length > 0 && deferred.activityLevel === "normal");

  // After the minimum lifetime → accepted.
  const accepted = stabilizeRoomRead(normal, stable2, t0 + ROOM_READ_LIMITS.minHeadlineLifetimeMs + SEC);
  check("anchor accepted after minimum lifetime", accepted.headline === normal.headline, accepted.headline);
  check("accepted read re-times the headline", accepted.headlineAt === t0 + ROOM_READ_LIMITS.minHeadlineLifetimeMs + SEC);

  // Rising activity (higher ambient priority) preempts a quiet read immediately —
  // activity changes are fast deterministic updates, not semantic churn.
  const spike = derive({ state: mkState({ activity: { level: "spike", trend: "rising", velocity: 40 } }), moments: [] });
  const preemptedBySpike = stabilizeRoomRead(spike, stable2, t0 + SEC);
  check("activity spike preempts a quiet read immediately", preemptedBySpike.headline.includes("spiking"), preemptedBySpike.headline);

  // Higher priority (raid) preempts immediately.
  const raidState = mkState({
    platformEvents: ["⚔️raider raided with 100 viewers"],
    freshness: { platform: t0 },
  });
  const raid = derive({ state: raidState, moments: [] });
  const preempted = stabilizeRoomRead(raid, stable2, t0 + SEC);
  check("raid preempts a quiet read immediately", preempted.headline.includes("raid"), preempted.headline);

  // Stale transitions are always accepted (truth before stability).
  const staleRead = derive({
    state: mkState({ activity: { level: "normal", trend: "stable", velocity: 8 }, freshness: { chat: t0 - 5 * MIN } }),
    moments: [],
  });
  const staleAccepted = stabilizeRoomRead(staleRead, stable2, t0 + SEC);
  check("stale transition preempts stability", staleAccepted.status === "stale" && staleAccepted.headline.includes("stale"));
}

// ─── 5. Activity-status hysteresis ────────────────────────────────────────────

{
  const t0 = T0;
  const quiet = derive({ state: mkState({ activity: { level: "quiet", trend: "stable", velocity: 3 } }), moments: [] });
  const prev = stabilizeRoomRead(quiet, null, t0);

  // quiet → ready at level "quiet" (< normal): status retained.
  const readyish = derive({ state: mkState({ activity: { level: "quiet", trend: "stable", velocity: 4 } }), moments: [] });
  const kept = stabilizeRoomRead(readyish, prev, t0 + ROOM_READ_LIMITS.minHeadlineLifetimeMs + SEC);
  check("quiet status retained below normal activity", kept.status === "quiet", kept.status);

  // ready → quiet at level "quiet" (> silent): status retained.
  const ready = derive({ state: mkState({ activity: { level: "normal", trend: "stable", velocity: 8 } }), moments: [] });
  const prevReady = stabilizeRoomRead(ready, null, t0);
  const quietish = derive({ state: mkState({ activity: { level: "quiet", trend: "stable", velocity: 3 } }), moments: [] });
  const keptReady = stabilizeRoomRead(quietish, prevReady, t0 + ROOM_READ_LIMITS.minHeadlineLifetimeMs + SEC);
  check("ready status retained above silent activity", keptReady.status === "ready", keptReady.status);

  // A moment anchor is exempt from hysteresis (real evidence always shows).
  const convo = mkMoment({ id: "m_c", kind: "conversation", confidence: 0.8, topicHints: ["build"] });
  const withMoment = derive({
    state: mkState({ activity: { level: "quiet", trend: "stable", velocity: 3 }, activeMomentId: "m_c" }),
    moments: [convo],
  });
  const shown = stabilizeRoomRead(withMoment, prev, t0 + SEC);
  check("moment anchors bypass hysteresis", shown.momentId === "m_c", `${shown.momentId}`);
}

// ─── 6. Stale-async / channel-safety guards ──────────────────────────────────

{
  // A state referencing a moment that is not in the mirror (stale async or
  // mid-switch) must fall back gracefully — never crash, never leak.
  const state = mkState({ activeMomentId: "moment_missing" });
  const read = derive({ state, moments: [] });
  check("missing moment id falls back to ambient", read.momentId === null && read.headline.length > 0);
}

{
  // Derivation never reads anything outside its explicit input — a channel-B
  // state with channel-A moments is not correlated by id.
  const aMoment = mkMoment({ id: "m_a", channel: "channela", kind: "conversation", confidence: 0.9, topicHints: ["hunters"] });
  const bState = mkState({ channel: "channelb", activeMomentId: "m_a" });
  const read = derive({ state: bState, moments: [aMoment] });
  // The engine never produces this (moments are channel-filtered), but the
  // derivation still must not present A's topic as B's read.
  check("cross-channel moment id not anchored", read.momentId === null || read.headline.includes("conversation"), read.headline);
}

// ─── 7. Observability ─────────────────────────────────────────────────────────

{
  const read = derive({
    state: mkState({ activity: { level: "active", trend: "stable", velocity: 20 }, freshness: { chat: T0 - 2_000 } }),
    moments: [],
  });
  const debug = debugRoomRead(read);
  check("debug output has required fields",
    typeof debug.status === "string" &&
    typeof debug.headline === "string" &&
    typeof debug.confidence === "number" &&
    typeof debug.sourceMomentId !== "undefined" &&
    typeof debug.semanticKey === "string");
  check("debug output has signal summary", (debug.signals as Record<string, unknown>).activity === "active");
  check("debug output has freshness map", Object.keys(debug.freshness as Record<string, unknown>).length > 0);
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nRoom Read contract: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
