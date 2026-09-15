/**
 * Deterministic test harness for the Perception Liveness engine.
 * Run: npx tsx src/lib/perceptionLiveness.test.ts
 *
 * Covers the Perception Liveness test matrix: configured-vs-live separation,
 * quiet-vs-stale semantics per lane, pipeline stage modeling (audio capture /
 * transcription, vision capture / semantic), initialization timeouts,
 * explicit-error transitions, automatic recovery, hysteresis (no boundary
 * flicker), aggregate health (disabled/unavailable lanes never penalize),
 * channel-switch invalidation, stale-async ordering, prompt context
 * labeling, and the Room Read integration contract.
 *
 * All functions under test are pure — no store, no React, no AI calls, no
 * timers. Every timestamp is explicit (fixed T0); the engine's `at` params
 * make ingestion fully deterministic.
 */

import {
  PerceptionLivenessEngine,
  formatPerceptionContext,
  classifyVisionError,
  perceptionStatusLabel,
  perceptionAgeLabel,
  PERCEPTION_REASON_LABELS,
} from "./perceptionLiveness";
import { deriveRoomRead } from "./roomRead";
import type { RoomState, RoomMoment } from "./roomModel";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const T0 = 1_700_000_000_000;
const SEC = 1_000;
const MIN = 60_000;
/** Hysteresis models the production 1s tick: a downgrade is first observed
 *  (pending), then committed once the sticky window elapses. */
const STICKY = 9_000;

function freshEngine(channel = "chan"): PerceptionLivenessEngine {
  const e = new PerceptionLivenessEngine();
  e.setChannel(channel, T0);
  e.setCapabilities({ visionCaptureSupported: true, platformEventsSupported: true });
  return e;
}

// ─── Chat lane ─────────────────────────────────────────────────────────────────

console.log("Chat lane");

{
  // Configured but no channel — UNAVAILABLE, never error.
  const e = new PerceptionLivenessEngine();
  e.setChannel(null, T0);
  const chat = e.getSummary(T0 + SEC).lanes.chat;
  check("no channel → unavailable, not error", chat.status === "unavailable" && chat.reasonCode === "no_channel");
}

{
  // Connecting → INITIALIZING; bounded by timeout.
  const e = freshEngine();
  e.noteChatTransport("connecting", T0);
  check("connecting → initializing", e.getSummary(T0 + SEC).lanes.chat.status === "initializing");
  e.getSummary(T0 + 31_000); // first observation of the timeout (tick)
  const late = e.getSummary(T0 + 31_000 + STICKY).lanes.chat;
  check("connecting > 30s → degraded (connect_timeout)", late.status === "degraded" && late.reasonCode === "connect_timeout");
}

{
  // Connected + message → LIVE.
  const e = freshEngine();
  e.noteChatTransport("connecting", T0);
  e.noteChatTransport("connected", T0 + 2_000);
  e.noteChatInput(T0 + 3_000);
  const chat = e.getSummary(T0 + 4_000).lanes.chat;
  check("message arrives → live", chat.status === "live");
  check("chat ageMs tracks last input", chat.ageMs === 1_000, `got ${chat.ageMs}`);
}

{
  // Connected + silence → QUIET, never stale (Example A: 4 minutes, nobody types).
  const e = freshEngine();
  e.noteChatTransport("connected", T0);
  const chat = e.getSummary(T0 + 4 * MIN).lanes.chat;
  check("connected + 4min silence → quiet, not stale", chat.status === "quiet" && chat.reasonCode === "chat_silent",
    `got ${chat.status}/${chat.reasonCode}`);
}

{
  // LIVE → QUIET is debounced around the 60s boundary (no flicker).
  const e = freshEngine();
  e.noteChatTransport("connected", T0);
  e.noteChatInput(T0 + 5_000);
  check("within live window → live", e.getSummary(T0 + 30_000).lanes.chat.status === "live");
  check("just past boundary → still live (hysteresis pending)",
    e.getSummary(T0 + 66_000).lanes.chat.status === "live",
    `got ${e.getSummary(T0 + 66_000).lanes.chat.status}`);
  check("sticky window elapsed → quiet",
    e.getSummary(T0 + 80_000).lanes.chat.status === "quiet");
  // Recovery is immediate.
  e.noteChatInput(T0 + 90_000);
  check("message after quiet → live immediately", e.getSummary(T0 + 91_000).lanes.chat.status === "live");
}

{
  // Transport error → ERROR immediately.
  const e = freshEngine();
  e.noteChatTransport("connected", T0);
  e.noteChatTransport("error", T0 + 10_000);
  const chat = e.getSummary(T0 + 11_000).lanes.chat;
  check("transport error → error (immediate)", chat.status === "error" && chat.error?.code === "connection_failed");
}

{
  // Dropped mid-session → DEGRADED (reconnecting), not silent-failure.
  const e = freshEngine();
  e.noteChatTransport("connected", T0);
  e.noteChatTransport("disconnected", T0 + 10_000);
  const chat = e.getSummary(T0 + 11_000).lanes.chat;
  check("disconnect after connect → degraded (connection_closed)", chat.status === "degraded" && chat.reasonCode === "connection_closed");
}

// ─── Audio lane ────────────────────────────────────────────────────────────────

console.log("Audio lane");

{
  // Never started → disabled (intentional absence).
  const e = freshEngine();
  const audio = e.getSummary(T0).lanes.audio;
  check("not capturing → disabled", audio.status === "disabled");
}

{
  // Whisper model downloading → INITIALIZING with progress detail.
  const e = freshEngine();
  e.noteAudioInitializing(0, T0);
  e.noteAudioInitializing(64, T0 + 30_000);
  const audio = e.getSummary(T0 + 31_000).lanes.audio;
  check("whisper downloading → initializing", audio.status === "initializing" && audio.reasonCode === "model_loading");
  check("whisper progress detail surfaced", audio.stages?.model?.detail === "64%");
  // Download completes → capture starts.
  e.noteAudioInitializing(null, T0 + 60_000);
  e.noteAudioCapture(true, T0 + 61_000, { mode: "whisper" });
  e.getSummary(T0 + 62_000); // observe the transition
  check("download done + capturing → not initializing", e.getSummary(T0 + 62_000 + STICKY).lanes.audio.status !== "initializing");
}

{
  // Whisper download stalls > 10 min → ERROR, never an infinite spinner.
  const e = freshEngine();
  e.noteAudioInitializing(10, T0);
  const audio = e.getSummary(T0 + 11 * MIN).lanes.audio;
  check("whisper download timeout → error (model_load_failed)", audio.status === "error" && audio.reasonCode === "model_load_failed");
}

{
  // Capturing + fresh transcript → LIVE with both stages live.
  const e = freshEngine();
  e.noteAudioCapture(true, T0, { mode: "deepgram" });
  e.noteAudioEnergy("normal", T0 + 5_000);
  e.noteTranscript(T0 + 10_000);
  const audio = e.getSummary(T0 + 12_000).lanes.audio;
  check("transcript flowing → live", audio.status === "live");
  check("capture stage live", audio.stages?.capture?.status === "live");
  check("transcription stage live", audio.stages?.transcription?.status === "live");
}

{
  // Capturing + silent energy + old transcript → QUIET (Example B: healthy silence).
  const e = freshEngine();
  e.noteAudioCapture(true, T0, { mode: "whisper" });
  e.noteTranscript(T0 + 10_000);
  e.noteAudioEnergy("silent", T0 + 3 * MIN);
  e.getSummary(T0 + 3 * MIN + 10_000); // observe the downgrade
  const audio = e.getSummary(T0 + 3 * MIN + 10_000 + STICKY).lanes.audio;
  check("silent streamer → quiet, not stale", audio.status === "quiet",
    `got ${audio.status}`);
  check("transcription stage quiet with energy detail",
    audio.stages?.transcription?.status === "quiet");
}

{
  // Capturing + ACTIVE energy + stale transcript → DEGRADED (Example C).
  const e = freshEngine();
  e.noteAudioCapture(true, T0, { mode: "deepgram" });
  e.noteTranscript(T0 + 10_000);
  // Energy ticks 1/s in production — re-note at each observation point.
  e.noteAudioEnergy("normal", T0 + 2 * MIN);
  e.getSummary(T0 + 2 * MIN); // observe the downgrade
  e.noteAudioEnergy("normal", T0 + 2 * MIN + STICKY);
  const audio = e.getSummary(T0 + 2 * MIN + STICKY).lanes.audio;
  check("speech detected + no transcript → degraded",
    audio.status === "degraded" && audio.reasonCode === "transcription_stale_speech_detected",
    `got ${audio.status}/${audio.reasonCode}`);
  check("capture stage still live (pipeline split)",
    audio.stages?.capture?.status === "live" && audio.stages?.transcription?.status === "stale");
  // Transcript resumes → immediate recovery.
  e.noteTranscript(T0 + 3 * MIN);
  check("transcript resumes → live (recovery)", e.getSummary(T0 + 3 * MIN + 2_000).lanes.audio.status === "live");
}

{
  // System audio (no energy probe) + very old transcript → STALE (conservative).
  const e = freshEngine();
  e.noteAudioCapture(true, T0, { mode: "deepgram" });
  e.noteTranscript(T0 + 10_000);
  e.getSummary(T0 + 6 * MIN); // observe
  const audio = e.getSummary(T0 + 6 * MIN + STICKY).lanes.audio;
  check("system audio, no transcript 6min → stale", audio.status === "stale" && audio.reasonCode === "transcription_stale",
    `got ${audio.status}/${audio.reasonCode}`);
}

{
  // Permission denied → ERROR; restart clears.
  const e = freshEngine();
  e.noteAudioError("permission_denied", T0);
  const audio = e.getSummary(T0 + SEC).lanes.audio;
  check("permission denied → error", audio.status === "error" && audio.reasonCode === "permission_denied");
  e.noteAudioCapture(true, T0 + 10_000, { mode: "whisper" });
  check("capture restart clears error", e.getSummary(T0 + 11_000).lanes.audio.reasonCode !== "permission_denied");
}

{
  // Intentional stop clears obsolete error state.
  const e = freshEngine();
  e.noteAudioError("ws_error", T0);
  e.noteAudioCapture(false, T0 + 5_000, { intentional: true });
  const audio = e.getSummary(T0 + 6_000).lanes.audio;
  check("intentional stop after error → disabled, error cleared",
    audio.status === "disabled" && audio.reasonCode === "intentional_stop",
    `got ${audio.status}/${audio.reasonCode}`);
}

// ─── Vision lane ──────────────────────────────────────────────────────────────

console.log("Vision lane");

{
  // Never captured (desktop) → OFF.
  const e = freshEngine();
  check("never captured → disabled", e.getSummary(T0).lanes.vision.status === "disabled");
}

{
  // Mobile: unsupported + no evidence → UNAVAILABLE, never error.
  const e = new PerceptionLivenessEngine();
  e.setChannel("chan", T0);
  e.setCapabilities({ visionCaptureSupported: false, platformEventsSupported: true });
  const vision = e.getSummary(T0).lanes.vision;
  check("mobile unsupported capture → unavailable", vision.status === "unavailable" && vision.reasonCode === "unsupported_platform");
}

{
  // Mobile thumbnail snap: semantic success proves the pipeline even when
  // continuous capture is unsupported.
  const e = new PerceptionLivenessEngine();
  e.setChannel("chan", T0);
  e.setCapabilities({ visionCaptureSupported: false, platformEventsSupported: true });
  e.noteVisionSemantic({ ok: true }, T0 + 5_000);
  const vision = e.getSummary(T0 + 10_000).lanes.vision;
  check("mobile snap success → live", vision.status === "live", `got ${vision.status}`);
  check("mobile snap stage detail manual", vision.stages?.capture?.detail === "manual");
}

{
  // Capture active, first frame pending → INITIALIZING (bounded).
  const e = freshEngine();
  e.noteVisionCapture(true, T0);
  e.noteVisionAutoCapture(true);
  e.noteVisionCadence(10_000);
  const vision = e.getSummary(T0 + 5_000).lanes.vision;
  check("capture started, no frame → initializing", vision.status === "initializing" && vision.reasonCode === "first_frame_pending");
  e.getSummary(T0 + 31_000); // observe the timeout
  const late = e.getSummary(T0 + 31_000 + STICKY).lanes.vision;
  check("first frame overdue → not initializing", late.status !== "initializing", `got ${late.status}`);
}

{
  // Delta gating: frames flowing, low deltas, recent semantic → LIVE/QUIET —
  // smart-capture patience is never misread as stale (Example D).
  const e = freshEngine();
  e.noteVisionCapture(true, T0);
  e.noteVisionAutoCapture(true);
  e.noteVisionCadence(30_000);
  e.noteVisionFrame(0.05, T0 + 1_000); // significant first frame
  e.noteVisionSemantic({ ok: true }, T0 + 2_000);
  // Scene goes static: low-delta frames keep arriving.
  e.noteVisionFrame(0.001, T0 + 40_000);
  e.noteVisionFrame(0.001, T0 + 70_000);
  e.getSummary(T0 + 71_000); // observe the downgrade
  const vision = e.getSummary(T0 + 71_000 + STICKY).lanes.vision;
  check("static scene + gated frames → quiet (scene_unchanged)",
    vision.status === "quiet" && vision.reasonCode === "scene_unchanged",
    `got ${vision.status}/${vision.reasonCode}`);
}

{
  // Semantic overdue + scene actually changing → STALE.
  const e = freshEngine();
  e.noteVisionCapture(true, T0);
  e.noteVisionAutoCapture(true);
  e.noteVisionCadence(30_000);
  e.noteVisionFrame(0.05, T0 + 1_000);
  e.noteVisionSemantic({ ok: true }, T0 + 2_000);
  // Significant deltas keep arriving but no new analysis for 100s.
  e.noteVisionFrame(0.08, T0 + 60_000);
  e.noteVisionFrame(0.09, T0 + 90_000);
  e.getSummary(T0 + 100_000); // observe
  const vision = e.getSummary(T0 + 100_000 + STICKY).lanes.vision;
  check("changing scene + overdue analysis → stale",
    vision.status === "stale" && vision.reasonCode === "expected_output_overdue",
    `got ${vision.status}/${vision.reasonCode}`);
}

{
  // Provider failure with healthy capture → DEGRADED, stages split (Example E).
  const e = freshEngine();
  e.noteVisionCapture(true, T0);
  e.noteVisionAutoCapture(true);
  e.noteVisionCadence(30_000);
  e.noteVisionFrame(0.05, T0 + 1_000);
  e.noteVisionSemantic({ ok: true }, T0 + 2_000);
  e.noteVisionSemantic({ ok: false, code: "provider_unreachable" }, T0 + 35_000);
  const vision = e.getSummary(T0 + 36_000).lanes.vision;
  check("provider fails + capture live → degraded",
    vision.status === "degraded" && vision.reasonCode === "provider_unreachable",
    `got ${vision.status}/${vision.reasonCode}`);
  check("capture stage still live", vision.stages?.capture?.status === "live");
  check("semantic stage error", vision.stages?.semantic?.status === "error");
  // Recovery: next successful analysis clears the error.
  e.noteVisionFrame(0.06, T0 + 60_000);
  e.noteVisionSemantic({ ok: true }, T0 + 61_000);
  const recovered = e.getSummary(T0 + 62_000).lanes.vision;
  check("semantic success recovers → live", recovered.status === "live" && recovered.stages?.semantic?.status === "live");
}

{
  // Screen share ends → immediate transition, reason preserved (§19).
  const e = freshEngine();
  e.noteVisionCapture(true, T0);
  e.noteVisionFrame(0.05, T0 + 1_000);
  e.noteVisionSemantic({ ok: true }, T0 + 2_000);
  e.noteVisionCapture(false, T0 + 10_000, { code: "capture_ended" });
  const vision = e.getSummary(T0 + 11_000).lanes.vision;
  check("track ended → disabled with capture_ended reason (immediate)",
    vision.status === "disabled" && vision.reasonCode === "capture_ended",
    `got ${vision.status}/${vision.reasonCode}`);
}

{
  // Intentional stop → OFF (not an error).
  const e = freshEngine();
  e.noteVisionCapture(true, T0);
  e.noteVisionCapture(false, T0 + 10_000, { intentional: true });
  const vision = e.getSummary(T0 + 11_000).lanes.vision;
  check("intentional stop → disabled", vision.status === "disabled" && vision.reasonCode === "intentional_stop");
}

{
  // Permission denied → ERROR with recovery hint, decays to OFF.
  const e = freshEngine();
  e.noteVisionCapture(false, T0, { code: "permission_denied" });
  const recent = e.getSummary(T0 + SEC).lanes.vision;
  check("permission denied → error", recent.status === "error" && recent.reasonCode === "permission_denied");
  const decayed = e.getSummary(T0 + 6 * MIN).lanes.vision;
  check("permission error decays to off after 5min", decayed.status === "disabled", `got ${decayed.status}`);
}

// ─── Platform events lane ─────────────────────────────────────────────────────

console.log("Platform events lane");

{
  // Twitch connected, no events for 2h → QUIET (Example H).
  const e = freshEngine();
  e.noteChatTransport("connected", T0);
  e.getSummary(T0 + 2 * 60 * MIN); // observe
  const events = e.getSummary(T0 + 2 * 60 * MIN + STICKY).lanes.platform_events;
  check("2h without events → quiet, not stale", events.status === "quiet" && events.reasonCode === "no_recent_events",
    `got ${events.status}/${events.reasonCode}`);
}

{
  // Event arrives → LIVE; recedes to QUIET.
  const e = freshEngine();
  e.noteChatTransport("connected", T0);
  e.notePlatformEvent(T0 + MIN);
  check("raid arrives → events live", e.getSummary(T0 + MIN + 5_000).lanes.platform_events.status === "live");
  e.getSummary(T0 + 5 * MIN); // observe the recede
  const later = e.getSummary(T0 + 5 * MIN + STICKY).lanes.platform_events;
  check("no further events → quiet again", later.status === "quiet");
}

{
  // Kick: events unsupported → UNAVAILABLE, never error, no aggregate penalty.
  const e = new PerceptionLivenessEngine();
  e.setChannel("chan", T0);
  e.setCapabilities({ visionCaptureSupported: true, platformEventsSupported: false });
  e.noteChatTransport("connected", T0);
  const events = e.getSummary(T0 + SEC).lanes.platform_events;
  check("kick events → unavailable (unsupported_platform)", events.status === "unavailable" && events.reasonCode === "unsupported_platform");
}

{
  // Events follow chat transport health.
  const e = freshEngine();
  e.noteChatTransport("connected", T0);
  e.noteChatTransport("error", T0 + 10_000);
  const events = e.getSummary(T0 + 11_000).lanes.platform_events;
  check("chat transport error → events lane error", events.status === "error");
}

// ─── Aggregate health ─────────────────────────────────────────────────────────

console.log("Aggregate health");

{
  // Chat + audio healthy, vision OFF → HEALTHY (optional lanes never penalize).
  const e = freshEngine();
  e.noteChatTransport("connected", T0);
  e.noteChatInput(T0 + 5_000);
  e.noteAudioCapture(true, T0, { mode: "whisper" });
  e.noteTranscript(T0 + 5_000);
  const s = e.getSummary(T0 + 6_000);
  check("chat+audio live, vision off → healthy", s.overall === "healthy", `got ${s.overall}`);
  check("disabled vision not counted as error", s.errorCount === 0 && s.degradedCount === 0);
}

{
  // One enabled lane fails → PARTIAL.
  const e = freshEngine();
  e.noteChatTransport("connected", T0);
  e.noteChatInput(T0 + 5_000);
  e.noteAudioCapture(true, T0, { mode: "deepgram" });
  e.noteTranscript(T0 + 10_000);
  e.noteAudioEnergy("normal", T0 + 3 * MIN);
  e.getSummary(T0 + 3 * MIN); // observe the audio downgrade
  e.noteAudioEnergy("normal", T0 + 3 * MIN + STICKY);
  const s = e.getSummary(T0 + 3 * MIN + STICKY);
  check("audio degraded + chat live → partial", s.overall === "partial", `got ${s.overall}`);
}

{
  // Only one lane functioning → LIMITED.
  const e = freshEngine();
  e.noteChatTransport("connected", T0);
  e.noteChatInput(T0 + 5_000);
  e.noteVisionSemantic({ ok: false, code: "provider_unreachable" }, T0 + 5_000);
  e.noteVisionCapture(false, T0 + 6_000, { intentional: true });
  e.noteAudioCapture(true, T0 + 100, { mode: "deepgram" });
  e.noteAudioError("ws_error", T0 + 8_000);
  const s = e.getSummary(T0 + 10_000);
  check("only chat functioning → limited", s.overall === "limited", `got ${s.overall}`);
}

{
  // All enabled lanes fail → OFFLINE.
  const e = freshEngine();
  e.noteChatTransport("error", T0);
  e.noteAudioCapture(true, T0, { mode: "deepgram" });
  e.noteAudioError("ws_error", T0 + 5_000);
  const s = e.getSummary(T0 + 6_000);
  check("all enabled lanes failing → offline", s.overall === "offline", `got ${s.overall}`);
}

{
  // Zero enabled lanes (fresh engine, no channel) → offline.
  const e = new PerceptionLivenessEngine();
  e.setChannel(null, T0);
  check("no channel → offline", e.getSummary(T0).overall === "offline");
}

// ─── Channel switching + stale async results ─────────────────────────────────

console.log("Channel switching + async safety");

{
  // Channel A → B: A's freshness must never leak into B (Example F).
  const e = freshEngine();
  e.setChannel("alpha", T0);
  e.noteChatTransport("connected", T0 + 1_000);
  e.noteChatInput(T0 + 2_000);
  e.noteVisionCapture(true, T0 + 2_000);
  e.noteVisionSemantic({ ok: true }, T0 + 3_000);
  check("channel A: chat live", e.getSummary(T0 + 4_000).lanes.chat.status === "live");
  // Switch to B — all facts reset.
  e.setChannel("beta", T0 + 5_000);
  const s = e.getSummary(T0 + 6_000);
  check("after switch: B chat not live", s.lanes.chat.status !== "live", `got ${s.lanes.chat.status}`);
  check("after switch: B vision not live", s.lanes.vision.status !== "live", `got ${s.lanes.vision.status}`);
  check("after switch: B transcript evidence gone", s.lanes.audio.lastValidOutputAt === undefined);
  // A late vision result "arriving" for B (mis-guarded call site) must not
  // fabricate liveness on its own: only a fresh B-session capture + analysis
  // can. Simulate the correct call-site guard: no note at all. Then B's own
  // round trip marks live.
  e.noteVisionCapture(true, T0 + 10_000);
  e.noteVisionFrame(0.05, T0 + 11_000);
  e.noteVisionSemantic({ ok: true }, T0 + 12_000);
  check("B's own analysis → vision live", e.getSummary(T0 + 13_000).lanes.vision.status === "live");
}

{
  // Same channel name → no reset (A→B→A round trip uses setChannel + revision
  // at the wiring layer; engine treats a repeated bind as identity).
  const e = freshEngine("alpha");
  e.noteChatTransport("connected", T0);
  e.setChannel("alpha", T0 + 5_000); // same channel — no-op
  check("same channel rebind → facts preserved", e.getSummary(T0 + 6_000).lanes.chat.status !== "initializing");
}

// ─── Reload truthfulness ──────────────────────────────────────────────────────

console.log("Reload truthfulness");

{
  // A fresh engine never reports LIVE without evidence.
  const e = freshEngine();
  const s = e.getSummary(T0);
  const live = Object.values(s.lanes).filter((l) => l.status === "live");
  check("fresh engine: nothing live", live.length === 0, `live lanes: ${live.map((l) => l.lane).join(",")}`);
  check("fresh engine: chat initializing (not fake live)", s.lanes.chat.status === "initializing");
}

// ─── Error classification + presentation helpers ───────────────────────────────

console.log("Error classification + helpers");

check("classifyVisionError: no api key",
  classifyVisionError(new Error("No API key configured for vision provider")) === "no_api_key");
check("classifyVisionError: auth",
  classifyVisionError(new Error("401 Unauthorized")) === "provider_auth_failed");
check("classifyVisionError: network",
  classifyVisionError(new Error("Failed to fetch")) === "provider_unreachable");
check("classifyVisionError: generic",
  classifyVisionError(new Error("weird model output")) === "processing_failed");

check("status labels are stable vocabulary",
  perceptionStatusLabel("live") === "LIVE" && perceptionStatusLabel("quiet") === "QUIET" &&
  perceptionStatusLabel("stale") === "STALE" && perceptionStatusLabel("error") === "ERROR" &&
  perceptionStatusLabel("disabled") === "OFF" && perceptionStatusLabel("unavailable") === "UNAVAILABLE" &&
  perceptionStatusLabel("initializing") === "STARTING" && perceptionStatusLabel("degraded") === "DEGRADED");

check("age labels: now/2s/1m", perceptionAgeLabel(500) === "now" && perceptionAgeLabel(2_400) === "2s" && perceptionAgeLabel(61_000) === "1m");

check("every reason code has a label", (() => {
  const engine = freshEngine();
  engine.noteAudioError("ws_error", T0);
  const s = engine.getSummary(T0 + SEC);
  return Object.values(s.lanes).every((l) => !l.reasonCode || PERCEPTION_REASON_LABELS[l.reasonCode] != null);
})());

// ─── Prompt context (§24/§62) ─────────────────────────────────────────────────

console.log("Prompt context");

{
  const e = freshEngine();
  e.noteChatTransport("connected", T0);
  e.noteChatInput(T0 + 5_000);
  const healthy = e.getSummary(T0 + 6_000);
  check("healthy perception → empty context block", formatPerceptionContext(healthy) === "");
  check("null summary → empty context", formatPerceptionContext(null) === "");
}

{
  const e = freshEngine();
  e.noteChatTransport("connected", T0);
  e.noteChatInput(T0 + 5_000);
  e.noteAudioCapture(true, T0, { mode: "deepgram" });
  e.noteTranscript(T0 + 10_000);
  e.noteAudioEnergy("normal", T0 + 3 * MIN);
  e.getSummary(T0 + 3 * MIN); // observe the downgrade
  e.noteAudioEnergy("normal", T0 + 3 * MIN + STICKY);
  const degraded = e.getSummary(T0 + 3 * MIN + STICKY);
  const ctx = formatPerceptionContext(degraded);
  check("degraded perception → context block present", ctx.startsWith("[PERCEPTION HEALTH"));
  check("context names the failing lane + status", ctx.includes("audio: DEGRADED"), ctx);
  check("context includes the reason", ctx.includes("no transcript"), ctx);
  check("context instructs against present-tense claims", ctx.includes("NOT current evidence"));
}

// ─── Room Read integration (§25/§61) ─────────────────────────────────────────

console.log("Room Read integration");

const readState: RoomState = {
  channel: "chan",
  updatedAt: T0,
  activity: { level: "quiet", trend: "stable", velocity: 3 },
  platformEvents: [],
  recentMomentIds: [],
  freshness: {},
  confidence: 0.6,
  sentiment: { current: "positive", trend: "stable" },
  audio: { level: "normal", updatedAt: T0 + 3 * MIN - 30_000 },
  vision: { tags: ["defeat screen"], changedAt: T0 - 10_000, changeMagnitude: 0.2 },
};

function mkLivenessLanes(liveness: ReturnType<PerceptionLivenessEngine["getSummary"]>) {
  return Object.values(liveness.lanes);
}

{
  // Audio degraded → Room Read must not claim "Streamer talking".
  const e = freshEngine();
  e.noteChatTransport("connected", T0);
  e.noteChatInput(T0 + 5_000);
  e.noteAudioCapture(true, T0, { mode: "deepgram" });
  e.noteTranscript(T0 + 10_000);
  e.noteAudioEnergy("normal", T0 + 3 * MIN);
  e.getSummary(T0 + 3 * MIN); // observe
  e.noteAudioEnergy("normal", T0 + 3 * MIN + STICKY);
  const summary = e.getSummary(T0 + 3 * MIN + STICKY);
  const withLiveness = deriveRoomRead({ state: readState, moments: [], now: T0 + 3 * MIN + STICKY, liveness: mkLivenessLanes(summary) });
  check("audio degraded → no 'Streamer talking' chip",
    !withLiveness.chips.some((c) => c.label === "Streamer talking"));
  check("audio degraded → 'Audio degraded' warning chip",
    withLiveness.chips.some((c) => c.label === "Audio degraded"));

  const legacy = deriveRoomRead({ state: readState, moments: [], now: T0 + 3 * MIN + STICKY });
  check("legacy (no liveness) keeps 'Streamer talking' chip",
    legacy.chips.some((c) => c.label === "Streamer talking"));
}

{
  // Vision error → Room Read must not present stale visual context.
  const visionState: RoomState = {
    ...readState,
    vision: { tags: ["explosion"], changedAt: T0 - 5_000, changeMagnitude: 0.3 },
  };
  const e = freshEngine();
  e.noteChatTransport("connected", T0);
  e.noteChatInput(T0 + 5_000);
  e.noteVisionCapture(true, T0);
  e.noteVisionFrame(0.2, T0 + 1_000);
  e.noteVisionSemantic({ ok: false, code: "provider_unreachable" }, T0 + 2_000);
  const summary = e.getSummary(T0 + 3_000);
  const read = deriveRoomRead({ state: visionState, moments: [], now: T0 + 3_000, liveness: mkLivenessLanes(summary) });
  check("vision error → no 'Scene changed recently' chip",
    !read.chips.some((c) => c.label === "Scene changed recently"));
  check("vision error → warning chip present",
    read.chips.some((c) => c.label === "Vision degraded" || c.label === "Vision error"));
}

{
  // All semantic lanes healthy → Room Read renders normally.
  const e = freshEngine();
  e.noteChatTransport("connected", T0);
  e.noteChatInput(T0 + 5_000);
  e.noteAudioCapture(true, T0, { mode: "whisper" });
  e.noteTranscript(T0 + 5_000);
  e.noteVisionCapture(true, T0);
  e.noteVisionSemantic({ ok: true }, T0 + 5_000);
  const summary = e.getSummary(T0 + 6_000);
  const read = deriveRoomRead({ state: readState, moments: [], now: T0 + 6_000, liveness: mkLivenessLanes(summary) });
  check("healthy lanes → no stale warning chips",
    !read.chips.some((c) => c.kind === "stale"));
}

// ─── Observability (§50) ──────────────────────────────────────────────────────

console.log("Observability");

{
  const e = freshEngine();
  e.noteChatTransport("connected", T0);
  e.noteAudioError("ws_error", T0 + 1_000);
  const snap = e.exportSnapshot(T0 + 2_000) as { overall: string; lanes: Record<string, { status: string; reasonCode?: string }> };
  check("exportSnapshot shape: overall + lanes", typeof snap.overall === "string" && !!snap.lanes.chat);
  check("exportSnapshot has reason codes, no secrets",
    JSON.stringify(snap).indexOf("apiKey") === -1 && JSON.stringify(snap).indexOf("token") === -1);
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
