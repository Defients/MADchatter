/**
 * Focused test harness for the Room Model / Moment Timeline engine.
 * Run: npx tsx src/lib/roomModel.test.ts
 *
 * Covers the Room Model test matrix: low-value signals, chat spikes, multi-
 * signal fusion, fusion windows, dedup, quiet rooms, bounded quiet moments,
 * sustained conversations, topic shifts, platform-event anchoring, bot-only
 * bursts, late vision enrichment, stale async discard, AI-synthesis guards,
 * channel isolation + A→B→A restore, retention bounds, bounded scores,
 * deterministic ordering, and concurrent-input safety.
 *
 * All functions under test are pure — no store, no timers, no AI calls.
 * Every timestamp is explicit (fixed T0); the engine never sees the real
 * clock because every read goes through tick(T).
 */

import {
  RoomModelEngine,
  ROOM_MODEL_LIMITS,
  parsePlatformEventSummary,
  laneStatus,
  formatRoomStateContext,
  formatRoomRead,
  deterministicMomentTitle,
  type RoomState,
} from "./roomModel";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const T0 = 1_700_000_000_000;
const SEC = 1_000;
const MIN = 60_000;

function freshEngine(channel = "testchannel"): RoomModelEngine {
  const e = new RoomModelEngine();
  e.setChannel(channel);
  return e;
}

/** Read state deterministically: force a build at time T via tick. */
function stateAt(e: RoomModelEngine, t: number): RoomState | null {
  e.tick(t);
  return e.getState();
}

/** Send N human chat messages from one user inside one 10s bucket. */
function burst(e: RoomModelEngine, count: number, at: number, user = "viewer1", text = "message") {
  for (let i = 0; i < count; i++) {
    e.noteChat({ username: user, text: `${text} ${i}`, timestamp: at + i * 100 });
  }
}

// ─── 1. Single low-value signal ───────────────────────────────────────────────

{
  const e = freshEngine();
  e.noteChat({ username: "a", text: "hello", sentimentLabel: "neutral", timestamp: T0 });
  const s = stateAt(e, T0 + 5_000);
  check("low-value signal updates Room State", s !== null && s.activity.velocity >= 1, `velocity=${s?.activity.velocity}`);
  check("low-value signal creates no moment", e.getMoments().length === 0, `moments=${e.getMoments().length}`);
  check("chat lane freshness tracked", s?.freshness.chat === T0);
}

// ─── 2. Chat spike → moment ───────────────────────────────────────────────────

{
  const e = freshEngine();
  burst(e, 7, T0); // 7 human msgs in one 10s bucket → burst surge
  const moments = e.getMoments();
  check("high chat spike begins a moment", moments.length === 1, `moments=${moments.length}`);
  check("spike moment is a reaction", moments[0]?.kind === "reaction", moments[0]?.kind);
  check("spike moment is active", moments[0]?.status === "active");
  check("moment channel is scoped", moments[0]?.channel === "testchannel");
  check("significance within bounds", (moments[0]?.significance ?? -1) >= 0.45 && moments[0].significance <= 1);
}

// ─── 3. Chat + audio spike fuse ──────────────────────────────────────────────

{
  const e = freshEngine();
  burst(e, 7, T0);
  e.noteAudioEnergy({ label: "normal", timestamp: T0 + 500 });
  e.noteAudioEnergy({ label: "spike", timestamp: T0 + 1_000 });
  const moments = e.getMoments();
  check("chat + audio fuse into ONE moment", moments.length === 1, `moments=${moments.length}`);
  check("fused moment records both sources", moments[0]?.sources.includes("chat") && moments[0].sources.includes("audio"), JSON.stringify(moments[0]?.sources));
  check("fused moment keeps reaction kind", moments[0]?.kind === "reaction");
  check("audio energy recorded as evidence", moments[0]?.signals.audio?.energy === "spike");
}

// ─── 4. Chat + audio + vision → one higher-confidence fused moment ───────────

{
  const e = freshEngine();
  burst(e, 7, T0);
  const singleConf = e.getMoments()[0]?.confidence ?? 0;
  e.noteAudioEnergy({ label: "spike", timestamp: T0 + 1_000 });
  e.noteVision({ delta: 0.3, tags: ["defeat screen"], timestamp: T0 + 2_000 });
  const moments = e.getMoments();
  check("chat + audio + vision fuse into ONE moment", moments.length === 1, `moments=${moments.length}`);
  check("all three sources recorded", moments[0]?.sources.length === 3, JSON.stringify(moments[0]?.sources));
  check("cross-signal agreement raises confidence", (moments[0]?.confidence ?? 0) > singleConf, `${moments[0]?.confidence} vs ${singleConf}`);
  check("vision evidence retained", moments[0]?.signals.vision?.tags?.includes("defeat screen"));
}

// ─── 5. Signals outside the fusion window → separate moments ─────────────────

{
  const e = freshEngine();
  burst(e, 7, T0);
  const firstId = e.getMoments()[0].id;
  // Audio spike 30s after the last moment update — outside the 9s window.
  e.noteAudioEnergy({ label: "spike", timestamp: T0 + 30_000 });
  const moments = e.getMoments();
  check("signals outside fusion window create separate moments", moments.length === 2, `moments=${moments.length}`);
  check("first moment closed by the new significant event", e.getMomentById(firstId)?.status === "closed" && e.getMomentById(firstId)?.endedAt != null);
  check("second moment is an energy shift", moments[1]?.kind === "energy_shift");
  check("timeline order is deterministic (chronological)", moments[0].startedAt <= moments[1].startedAt);
}

// ─── 6. Duplicate events deduplicate ─────────────────────────────────────────

{
  const e = freshEngine();
  e.notePlatformEvent({ summary: "⚔️someone raided with 100 viewers", detail: { kind: "raid", magnitude: 100 }, timestamp: T0 });
  e.notePlatformEvent({ summary: "⚔️someone raided with 100 viewers", detail: { kind: "raid", magnitude: 100 }, timestamp: T0 + 5_000 });
  const s = stateAt(e, T0 + 6_000);
  check("duplicate platform event deduplicated", s?.platformEvents.length === 1, `events=${s?.platformEvents.length}`);
  check("one platform moment only", e.getMoments().length === 1);
  // Same event well past the dedupe window AND the stream-event fusion
  // window → a second, distinct raid moment.
  e.notePlatformEvent({ summary: "⚔️someone raided with 100 viewers", detail: { kind: "raid", magnitude: 100 }, timestamp: T0 + 60_000 });
  check("platform event after both windows starts a new moment", e.getMoments().length === 2, `moments=${e.getMoments().length}`);
}

{
  const e = freshEngine();
  e.noteChat({ username: "a", text: "echo", timestamp: T0 });
  e.noteChat({ username: "a", text: "echo", timestamp: T0 + 500 }); // reconnect echo
  const s = stateAt(e, T0 + SEC);
  check("identical chat line within 2s deduplicated", s?.activity.velocity === 1, `velocity=${s?.activity.velocity}`);
}

// ─── 7. Quiet room is valid ──────────────────────────────────────────────────

{
  const e = freshEngine(); // no signals at all
  const s = stateAt(e, T0);
  check("quiet room: valid Room State", s !== null);
  check("quiet room: activity silent", s?.activity.level === "silent");
  check("quiet room: no active moment", s?.activeMomentId === undefined);
  check("quiet room: no fake moments", e.getMoments().length === 0);
  check("quiet room: sentiment absent (no evidence)", s?.sentiment === undefined);
  check("lane unavailable before any evidence", laneStatus(s!, "vision") === "unavailable");
}

// ─── 8. Long quiet period → ONE bounded quiet moment, no spam ─────────────────

{
  const e = freshEngine();
  e.noteChat({ username: "a", text: "hi", timestamp: T0 });
  stateAt(e, T0 + SEC);
  // 6 minutes of silence — one quiet moment forms.
  stateAt(e, T0 + 6 * MIN);
  check("quiet moment forms after sustained silence", e.getMoments().some((m) => m.kind === "quiet" && m.status === "active"));
  stateAt(e, T0 + 7 * MIN); // quiet moment idle-closes after 60s
  stateAt(e, T0 + 8 * MIN);
  stateAt(e, T0 + 9 * MIN);
  const quietMoments = e.getMoments().filter((m) => m.kind === "quiet");
  check("no minute-by-minute silence spam", quietMoments.length === 1, `quiet=${quietMoments.length}`);
  // Activity resumes → quiet ends immediately.
  e.noteChat({ username: "b", text: "back", timestamp: T0 + 9 * MIN + SEC });
  const activeQuiet = e.getMoments().find((m) => m.kind === "quiet" && m.status === "active");
  check("quiet moment closes when activity resumes", activeQuiet === undefined);
}

// ─── 9. Sustained conversation → one evolving conversation moment ────────────

{
  const e = freshEngine();
  // 6 messages from 3 users over 2 minutes — low velocity, real conversation.
  for (let i = 0; i < 6; i++) {
    e.noteChat({ username: `user${i % 3}`, text: `chat line ${i}`, sentimentLabel: "neutral", timestamp: T0 + i * 20_000 });
  }
  const moments = e.getMoments();
  const convo = moments.find((m) => m.kind === "conversation");
  check("sustained multi-user chat forms a conversation moment", convo !== undefined, `kinds=${moments.map((m) => m.kind).join(",")}`);
  check("conversation moment stays single (evolving, not fragmented)", moments.filter((m) => m.kind === "conversation").length === 1);
  check("conversation moment has participants", (convo?.signals.conversation?.participants?.length ?? 0) >= 2);
  check("conversation significance is real but modest", (convo?.significance ?? 0) >= 0.4 && (convo?.significance ?? 1) < 0.9, `sig=${convo?.significance}`);
}

// ─── 10. Topic shift → previous moment closes ────────────────────────────────

{
  const e = freshEngine();
  burst(e, 7, T0); // reaction moment #1
  e.tick(T0 + 120_000); // idle-close window passes
  e.notePlatformEvent({ summary: "🎁gifter gifted a sub to someone", detail: { kind: "subgift" }, timestamp: T0 + 125_000 });
  const moments = e.getMoments();
  check("topic shift: old moment closed", moments[0]?.status === "closed");
  check("topic shift: new moment started", moments[1]?.status === "active" && moments[1].kind === "stream_event");
}

// ─── 11. Raid + chat spike → one anchored stream-event moment ────────────────

{
  const e = freshEngine();
  e.notePlatformEvent({ summary: "⚔️raider raided with 214 viewers", detail: { kind: "raid", magnitude: 214 }, timestamp: T0 });
  burst(e, 7, T0 + 3_000); // chat erupts right after the raid
  e.noteAudioEnergy({ label: "spike", timestamp: T0 + 5_000 });
  const moments = e.getMoments();
  check("raid anchors ONE moment (no fragmenting)", moments.length === 1, `moments=${moments.length}`);
  check("raid moment kind is stream_event", moments[0]?.kind === "stream_event");
  check("raid aftermath absorbed (chat + audio + platform)", moments[0]?.sources.length === 3, JSON.stringify(moments[0]?.sources));
  check("raid moment confidence very high", (moments[0]?.confidence ?? 0) >= 0.9);
  check("raid established without any AI", moments[0]?.provenance.deterministic === true && !moments[0].provenance.aiSynthesized);
}

// ─── 12. Bot-only burst cannot manufacture human room state ───────────────────

{
  const e = freshEngine();
  for (let i = 0; i < 20; i++) {
    e.noteChat({ username: `bot${i % 3}`, text: "bots talking to bots", isBot: true, timestamp: T0 + i * 500 });
    e.noteAgentSend({ botName: `bot${i % 3}`, message: "beep", source: "autoforge", timestamp: T0 + i * 500 });
  }
  const s = stateAt(e, T0 + 11_000);
  check("bot-only burst: human activity stays silent", s?.activity.level === "silent", `level=${s?.activity.level}`);
  check("bot-only burst: no moments manufactured", e.getMoments().length === 0, `moments=${e.getMoments().length}`);
  check("bot-only burst: agent sends recorded without inflation", (e.getDiagnostics().botMessages as number) >= 20);
}

// ─── 13. Late vision result enriches; stale vision does not ──────────────────

{
  const e = freshEngine();
  burst(e, 7, T0);
  // Semantic vision arrives 20s later (analysis latency) → late fusion enriches.
  e.noteVision({ delta: 0.01, tags: ["game over screen"], timestamp: T0 + 20_000 });
  let moments = e.getMoments();
  check("late semantic vision enriches the SAME moment", moments.length === 1 && moments[0].signals.vision?.tags?.includes("game over screen"));
  // Vision from 90s later (outside even the late window) → no new moment.
  e.noteVision({ delta: 0.01, tags: ["much later scene"], timestamp: T0 + 90_000 });
  moments = e.getMoments();
  check("stale-late vision does not create a moment", moments.length === 1, `moments=${moments.length}`);
}

// ─── 14. AI synthesis guards ─────────────────────────────────────────────────

{
  const e = freshEngine();
  e.notePlatformEvent({ summary: "⚔️raider raided with 500 viewers", detail: { kind: "raid", magnitude: 500 }, timestamp: T0 });
  e.tick(T0 + 90_000); // idle-close the raid moment
  const closed = e.getMoments().find((m) => m.status === "closed");
  check("high-significance closed moment queued for synthesis", e.drainSynthesisQueue().includes(closed!.id));

  // Wrong channel → discarded (stale async result protection).
  check(
    "synthesis from a different channel is discarded",
    e.applySynthesis(closed!.id, "otherchannel", { title: "Fake", summary: "Fake" }) === false,
  );
  check("no synthesis applied from wrong channel", closed!.title === undefined && closed!.summary === undefined);

  // Correct channel → semantic fields only.
  check(
    "synthesis applies on the right channel",
    e.applySynthesis(closed!.id, "testchannel", { title: "Big raid", summary: "A large raid arrived.", topicHints: ["raid"], model: "test" }) === true,
  );
  const applied = e.getMomentById(closed!.id)!;
  check("synthesis filled title/summary", applied.title === "Big raid" && applied.summary === "A large raid arrived.");
  check("deterministic fields untouched by synthesis", applied.kind === "stream_event" && applied.significance >= 0.9);
  check(
    "synthesis is idempotent (second apply rejected)",
    e.applySynthesis(closed!.id, "testchannel", { title: "Again" }) === false,
  );

  // AI synthesis failure path: a moment that was never synthesized stays valid.
  const e2 = freshEngine();
  e2.notePlatformEvent({ summary: "💎user cheered 5000 bits", detail: { kind: "cheer", magnitude: 5000 }, timestamp: T0 });
  const m = e2.getMoments()[0];
  check("moment remains valid without any synthesis", m !== undefined && m.provenance.aiSynthesized === false && m.title === undefined);
  check("deterministic fallback title always available", typeof deterministicMomentTitle(m!) === "string" && deterministicMomentTitle(m!).length > 0);
}

// ─── 15. Provider unavailable → Room Model still works ───────────────────────

{
  const e = freshEngine();
  burst(e, 7, T0);
  const s = stateAt(e, T0 + 2_000);
  const ctx = formatRoomStateContext(s, e.getMoments());
  check("Room State context renders without any AI provider", ctx.includes("[ROOM STATE") && ctx.includes("Activity:"));
  check("context declares its advisory hierarchy", ctx.includes("Advisory"));
  const read = formatRoomRead(s, e.getMoments());
  check("Room Read renders without any AI provider", read.some((l) => l.includes("msgs/min")));
}

// ─── 16. Channel isolation: A → B ────────────────────────────────────────────

{
  const e = freshEngine("channela");
  burst(e, 7, T0);
  check("channel A has moments", e.getMoments().length === 1);
  e.setChannel("channelb");
  check("switch to B wipes A state (no leak)", e.getMoments().length === 0 && e.getState()?.channel === "channelb");
  const s = stateAt(e, T0 + 10_000);
  check("B state is fresh", s?.activeMomentId === undefined && s.activity.level === "silent");
  // A bot message arriving "for A" after the switch cannot resurrect state.
  e.noteChat({ username: "late", text: "stale A message", timestamp: T0 + 11_000 });
  check("late A-channel activity only feeds B (no A moments return)", e.getMoments().length === 0);
}

// ─── 17. A → B → A restore ───────────────────────────────────────────────────

{
  const e = freshEngine("channela");
  burst(e, 7, T0);
  const snapshot = e.exportSnapshot();
  check("snapshot captures the moment", snapshot.moments.length === 1);
  e.setChannel("channelb");
  e.setChannel("channela");
  check("switch-back without snapshot starts fresh", e.getMoments().length === 0);
  e.restore("channela", snapshot);
  const restored = e.getMoments();
  check("restore re-populates moments", restored.length === 1);
  check("restore forces closed (volatile active dropped)", restored[0].status === "closed");
  const s = stateAt(e, T0 + 60_000);
  check("restored state is not live-stale (fresh room state)", s?.activity.level === "silent" && s.activeMomentId === undefined);
  // Restore with a foreign-channel snapshot is rejected.
  e.restore("channela", { state: null, moments: [{ ...restored[0], channel: "other" }] as never });
  check("foreign-channel moments are not restored", e.getMoments().length === 0 || e.getMoments()[0].channel === "channela");
}

// ─── 18. Session restart: volatile resets, history survives ───────────────────

{
  const e = freshEngine();
  burst(e, 7, T0);
  e.noteAudioEnergy({ label: "spike", timestamp: T0 + 1_000 });
  const snapshot = e.exportSnapshot();
  const e2 = freshEngine(); // "next day" — same channel, new session
  e2.restore("testchannel", snapshot);
  const restored = e2.getMoments();
  check("history survives a restart", restored.length === 1 && restored[0].sources.length === 2);
  check("restart drops the active moment (fresh live state)", restored[0].status === "closed");
  const s = stateAt(e2, T0 + 24 * 60 * MIN);
  check("restart resets volatile freshness/trends", s?.freshness.chat === undefined && s.activity.level === "silent");
}

// ─── 19. Retention: bounded timeline ─────────────────────────────────────────

{
  const e = freshEngine();
  // 100 raids, each outside the previous stream-event fusion window (60s).
  for (let i = 0; i < 100; i++) {
    e.notePlatformEvent({ summary: `⚔️raider${i} raided with 10 viewers`, detail: { kind: "raid", magnitude: 10 }, timestamp: T0 + i * 60_000 });
  }
  e.tick(T0 + 100 * 60_000);
  const moments = e.getMoments();
  check("timeline bounded at max moments", moments.length <= ROOM_MODEL_LIMITS.maxMoments, `moments=${moments.length}`);
  check("retention keeps the most recent history", moments[moments.length - 1].startedAt === T0 + 99 * 60_000);
  check("retained moments keep evidence bounds", moments.every((m) => m.evidenceRefs.length <= ROOM_MODEL_LIMITS.maxEvidenceRefs && m.evidenceLines.length <= ROOM_MODEL_LIMITS.maxEvidenceLines));
  check("significance always bounded after fusion", moments.every((m) => m.significance >= 0 && m.significance <= 1 && m.confidence >= 0 && m.confidence <= 1));
}

// ─── 20. Concurrent inputs: no duplicate-moment race ──────────────────────────

{
  const e = freshEngine();
  // 40 messages in the same instant from many users — a synchronous flood.
  for (let i = 0; i < 40; i++) {
    e.noteChat({ username: `user${i}`, text: "FLOOD", sentimentLabel: "hype", timestamp: T0 });
  }
  const moments = e.getMoments();
  check("concurrent flood creates ONE moment (no race duplicates)", moments.length === 1, `moments=${moments.length} (${moments.map((m) => m.kind).join(",")})`);
  check("flood moment absorbs every surge (evolving, not fragmenting)", (moments[0]?.updateCount ?? 0) >= 5, `updates=${moments[0]?.updateCount}`);
  check("flood evidence lines are bounded", (moments[0]?.evidenceLines.length ?? 99) <= ROOM_MODEL_LIMITS.maxEvidenceLines);
}

// ─── 21. Perception liveness ──────────────────────────────────────────────────

{
  const e = freshEngine();
  e.noteChat({ username: "a", text: "hi", timestamp: T0 });
  const sLive = stateAt(e, T0 + SEC)!;
  check("fresh chat lane is live", laneStatus(sLive, "chat", T0 + SEC) === "live");
  check("unused vision lane is unavailable", laneStatus(sLive, "vision", T0 + SEC) === "unavailable");
  const sStale = stateAt(e, T0 + 10 * MIN)!;
  check("old chat evidence is stale (never presented as live)", laneStatus(sStale, "chat", T0 + 10 * MIN) === "stale");
}

// ─── 22. Platform event parsing + context formatting ──────────────────────────

{
  check("raid summary parses", parsePlatformEventSummary("⚔️ someone raided with 47 viewers").kind === "raid" && parsePlatformEventSummary("⚔️ someone raided with 47 viewers").magnitude === 47);
  check("cheer summary parses", parsePlatformEventSummary("💎 user cheered 500 bits").kind === "cheer");
  check("sub summary parses", parsePlatformEventSummary("🔔 user subscribed (Tier 1)").kind === "sub");
  check("fallback kind for unknown text", parsePlatformEventSummary("something happened").kind === "other");

  const e = freshEngine();
  burst(e, 7, T0);
  const s = stateAt(e, T0 + 2_000);
  const ctx = formatRoomStateContext(s, e.getMoments());
  check("context names the current moment", ctx.includes("Current moment"));
  check("context includes sources", ctx.includes("chat"));
  e.tick(T0 + 90_000);
  const s2 = e.getState()!;
  const ctx2 = formatRoomStateContext(s2, e.getMoments());
  check("closed moment moves to recent moments", ctx2.includes("Recent moments"));
  check("quiet state yields a compact context (no noise lines)", !ctx2.includes("Sentiment:") || s2.sentiment !== undefined);
}

// ─── 23. Sentiment shift enriches but does not invent ─────────────────────────

{
  const e = freshEngine();
  // 12 neutral messages then a polarity flip to hype — a sentiment shift fires.
  for (let i = 0; i < 12; i++) e.noteChat({ username: `u${i % 3}`, text: "meh", sentimentLabel: "neutral", timestamp: T0 + i * 1_000 });
  for (let i = 0; i < 12; i++) e.noteChat({ username: `u${i % 3}`, text: "LETS GO", sentimentLabel: "hype", timestamp: T0 + 20_000 + i * 1_000 });
  const s = stateAt(e, T0 + 40_000);
  check("sentiment state reflects the flip", s?.sentiment?.current === "hype", s?.sentiment?.current);
  const shiftMoments = e.getMoments().filter((m) => m.sources.includes("sentiment"));
  check("sentiment shift recorded as evidence", shiftMoments.length >= 1, `shift=${shiftMoments.length}`);
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nRoom Model engine: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
