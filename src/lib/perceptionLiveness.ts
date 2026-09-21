/**
 * Perception Liveness — the canonical truth layer for whether MADchatter's
 * perception lanes are actually receiving usable information right now.
 *
 * Problem this module solves: "configured" is not "live". An API key, an
 * OAuth session, a granted permission, or a mounted component proves nothing
 * about whether Chat / Audio / Vision / Platform Events are currently
 * producing valid output. Conversely, silence is not failure — a healthy
 * sensor observing a quiet room must never be reported as broken.
 *
 * Separation of concerns (deliberate):
 * - RoomModel (roomModel.ts) answers "what is happening?" — semantic fusion.
 * - PerceptionLiveness answers "can we trust this sensor right now?" —
 *   pipeline truth. Room Read / AutoForge consume both.
 *
 * Architecture:
 *   raw lane facts (event/timestamp driven notes)
 *     → per-stage derivation (capture vs processing vs output)
 *     → canonical PerceptionLiveness (statuses, ages, reason codes)
 *     → PerceptionSummary (aggregate health)
 *     → consumers (Room Read, AutoForge prompt labeling, PerceptionStrip UI)
 *
 * Purity contract: no store, no React, no AI calls, no timers. All ingestion
 * is explicit `note*` calls carrying timestamps (injectable `at` for tests);
 * derivation is deterministic given (facts, now). The wiring hook
 * (usePerceptionLiveness) owns ticking + mirroring into the store.
 *
 * Liveness is runtime/session state — NEVER persisted. A reload starts from
 * truthful initialization state until current-session evidence arrives.
 * Channel switches reset all lane facts (no cross-channel freshness leaks).
 */

// ─── Canonical contract ───────────────────────────────────────────────────────

export type PerceptionLane = "chat" | "audio" | "vision" | "platform_events";

export type PerceptionStatus =
  | "disabled" // user intentionally turned the lane off
  | "unavailable" // cannot operate on this platform/browser (never an error)
  | "initializing" // startup in progress (connecting, model loading, first frame)
  | "live" // recent valid usable output
  | "quiet" // pipeline healthy, no recent signal — healthy silence
  | "stale" // expected output overdue for this lane's cadence
  | "degraded" // partial pipeline: some stage works, another fails
  | "error"; // explicit failure currently blocks expected functionality

export interface PerceptionError {
  /** Stable machine-readable code (see PERCEPTION_REASON_LABELS). */
  code: string;
  /** True when a user action (retry/permission/config) can clear it. */
  recoverable: boolean;
}

export interface PerceptionStageState {
  status: PerceptionStatus;
  lastSuccessAt?: number;
  lastErrorAt?: number;
  /** Short human detail (e.g. whisper progress, energy label, provider). */
  detail?: string;
}

export interface PerceptionLiveness {
  lane: PerceptionLane;
  status: PerceptionStatus;
  /** Lane is intentionally active (user wants this input). */
  enabled: boolean;
  /** Lane can operate on this platform/browser. */
  supported: boolean;
  /** Required configuration present (channel, key, provider…). */
  configured: boolean;
  lastInputAt?: number;
  lastAttemptAt?: number;
  lastValidOutputAt?: number;
  lastErrorAt?: number;
  /** now - lastValidOutputAt, when that metric is meaningful for the lane. */
  ageMs?: number;
  /** 0..1 — how strongly the evidence supports the status. */
  confidence: number;
  /** Stable machine-readable reason (see PERCEPTION_REASON_LABELS). */
  reasonCode?: string;
  error?: PerceptionError;
  /** Pipeline stages, only where the split is materially useful. */
  stages?: Record<string, PerceptionStageState>;
}

export type PerceptionOverall = "healthy" | "partial" | "limited" | "offline";

export interface PerceptionSummary {
  overall: PerceptionOverall;
  liveCount: number;
  degradedCount: number;
  errorCount: number;
  lanes: Record<PerceptionLane, PerceptionLiveness>;
  updatedAt: number;
}

// ─── Reason codes (stable, machine-readable) ───────────────────────────────────

export const PERCEPTION_REASON_LABELS: Record<string, string> = {
  no_channel: "No channel set",
  starting: "Starting",
  connect_timeout: "Connection timed out",
  connection_failed: "Connection failed",
  connection_closed: "Connection lost — reconnecting",
  chat_silent: "Connected — nobody is chatting",
  permission_denied: "Permission denied",
  no_audio_track: "No audio track shared",
  model_loading: "Loading speech model",
  model_load_failed: "Speech model failed to load",
  recorder_failed: "Audio recorder failed",
  ws_error: "Transcription connection error",
  transcription_stale: "No transcript recently",
  transcription_stale_speech_detected: "Speech detected but no transcript",
  intentional_stop: "Stopped",
  capture_ended: "Screen sharing ended",
  first_frame_pending: "Waiting for first frame",
  scene_unchanged: "Scene unchanged — analysis skipped",
  expected_output_overdue: "Analysis overdue",
  no_recent_events: "Connected — no raids/subs/cheers",
  unsupported_platform: "Not supported on this platform",
  no_api_key: "No API key configured",
  provider_unreachable: "Provider not responding",
  provider_auth_failed: "Provider rejected the request",
  processing_failed: "Analysis failed",
  initializing: "Initializing",
};

/** Concise recovery hints mapped from reason codes (§41). */
export const PERCEPTION_RECOVERY_HINTS: Record<string, string> = {
  permission_denied: "Re-enable the permission, then start capture again",
  no_audio_track: "Re-capture and enable \"Share system audio\"",
  model_load_failed: "Retry the Whisper download",
  ws_error: "Restart audio capture",
  capture_ended: "Start capture again",
  no_api_key: "Configure the vision provider in Settings",
  provider_unreachable: "Check the provider endpoint, then retry",
  provider_auth_failed: "Check the provider API key in Settings",
  connect_timeout: "Check the connection and channel",
};

// ─── Tuning constants (exported for tests) ─────────────────────────────────────

export const PERCEPTION_LIMITS = {
  /** Chat message recency that keeps the chat lane LIVE. */
  chatLiveWindowMs: 60_000,
  /** Connecting longer than this → degraded (connect_timeout). */
  chatConnectTimeoutMs: 30_000,
  /** Transcript recency that keeps audio transcription LIVE. */
  transcriptLiveWindowMs: 30_000,
  /** Speech-energy evidence window (useAudioEnergy ticks 1/s). */
  energyEvidenceWindowMs: 30_000,
  /** Active audio energy + no transcript for this long → degraded. */
  transcriptSpeechStaleMs: 45_000,
  /** System-audio capture (no energy probe) with no transcript this long → stale. */
  transcriptNoEnergyStaleMs: 5 * 60_000,
  /** Whisper download must show progress at least this often. */
  whisperLoadTimeoutMs: 10 * 60_000,
  /** Frames this fresh keep the vision capture stage LIVE. */
  visionFrameFreshMs: 60_000,
  /** First frame must arrive within this of capture start. */
  visionFirstFrameTimeoutMs: 30_000,
  /** Semantic analysis grace beyond the expected cadence before STALE. */
  visionCadenceGraceMs: 15_000,
  /** Vision semantic errors stop counting as errors after this (muted, not failed). */
  visionErrorDecayMs: 2 * 60_000,
  /** Permission errors decay to OFF after this (user moved on without retrying). */
  visionPermissionErrorDecayMs: 5 * 60_000,
  /** A platform event keeps the events lane LIVE this long. */
  eventLiveWindowMs: 120_000,
  /** Manual vision analysis (mobile thumbnail snap) keeps the lane LIVE this long. */
  visionManualFreshMs: 120_000,
  /** Status downgrades (quiet/stale/degraded) must persist this long to commit. */
  statusStickyMs: 8_000,
} as const;

/** Audio energy labels that count as "speech/audio present". */
const ACTIVE_ENERGY_LABELS = new Set(["normal", "loud", "spike"]);
/** Frame delta that counts as a meaningful scene change (matches frameDiff). */
const SIGNIFICANT_FRAME_DELTA = 0.02;

// ─── Lane facts (raw, event-driven) ────────────────────────────────────────────

type ChatTransport = "connected" | "connecting" | "disconnected" | "error";

interface ChatFacts {
  transport: ChatTransport;
  transportAt: number;
  everConnected: boolean;
  lastInputAt: number | null;
}

interface AudioFacts {
  capturing: boolean;
  capturingAt: number;
  mode: "deepgram" | "whisper" | null;
  /** Whisper model download in progress (progress 0..100). */
  initializing: { active: boolean; progress: number | null; at: number };
  lastEnergyAt: number | null;
  lastEnergyLabel: string | null;
  lastTranscriptAt: number | null;
  lastError: { code: string; at: number } | null;
}

interface VisionFacts {
  captureActive: boolean;
  captureAt: number;
  /** Last stop reason (intentional stop vs. code on error/ended). */
  lastStop: { at: number; intentional: boolean; code?: string } | null;
  autoCapture: boolean;
  cadenceMs: number;
  lastFrameAt: number | null;
  lastFrameDelta: number | null;
  /** Last frame whose delta passed the significance threshold. */
  significantDeltaAt: number | null;
  lastSemanticAt: number | null;
  lastSemanticOk: boolean | null;
  lastSemanticError: { code: string; at: number } | null;
  lastAttemptAt: number | null;
}

interface EventsFacts {
  lastEventAt: number | null;
}

export interface PerceptionCapabilities {
  /** getDisplayMedia available (desktop). False on mobile browsers. */
  visionCaptureSupported: boolean;
  /** Platform exposes raid/sub/cheer events (Twitch IRC; Kick/Joystick do not). */
  platformEventsSupported: boolean;
}

interface HysteresisState {
  stable: PerceptionStatus;
  stableAt: number;
  pending: PerceptionStatus | null;
  pendingAt: number;
}

function freshHysteresis(at: number): HysteresisState {
  return { stable: "initializing", stableAt: at, pending: null, pendingAt: at };
}

// ─── Error classification helpers ───────────────────────────────────────────────

/** Map a caught vision pipeline error to a stable reason code. */
export function classifyVisionError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (/No API key/i.test(msg)) return "no_api_key";
  if (/401|403|unauthorized|invalid api key|invalid_api_key/i.test(msg)) return "provider_auth_failed";
  if (/fetch|network|econnrefused|connection refused|timeout|timed out|abort/i.test(msg)) {
    return "provider_unreachable";
  }
  return "processing_failed";
}

// ─── Engine ─────────────────────────────────────────────────────────────────────

/**
 * Deterministic liveness engine. Module singleton `perception` below — mirrors
 * the roomModel pattern: pure module, no store imports, ingested from store
 * actions and capture call sites, ticked + mirrored by usePerceptionLiveness.
 */
export class PerceptionLivenessEngine {
  private channel: string | null = null;
  private capabilities: PerceptionCapabilities = {
    visionCaptureSupported: true,
    platformEventsSupported: true,
  };

  private chat: ChatFacts = { transport: "disconnected", transportAt: 0, everConnected: false, lastInputAt: null };
  private audio: AudioFacts = {
    capturing: false, capturingAt: 0, mode: null,
    initializing: { active: false, progress: null, at: 0 },
    lastEnergyAt: null, lastEnergyLabel: null, lastTranscriptAt: null, lastError: null,
  };
  private vision: VisionFacts = {
    captureActive: false, captureAt: 0, lastStop: null,
    autoCapture: false, cadenceMs: 60_000,
    lastFrameAt: null, lastFrameDelta: null, significantDeltaAt: null,
    lastSemanticAt: null, lastSemanticOk: null, lastSemanticError: null, lastAttemptAt: null,
  };
  private events: EventsFacts = { lastEventAt: null };

  private hysteresis: Record<PerceptionLane, HysteresisState> = {
    chat: freshHysteresis(0),
    audio: freshHysteresis(0),
    vision: freshHysteresis(0),
    platform_events: freshHysteresis(0),
  };

  // ─── Session binding ────────────────────────────────────────────────────────

  /** Bind to the live channel. A channel change resets all lane facts —
   *  channel A's freshness can never leak into channel B (§53/§54). */
  setChannel(channel: string | null, at: number = Date.now()): void {
    const normalized = channel ? channel.trim().toLowerCase() : null;
    if (normalized === this.channel) return;
    this.channel = normalized;
    this.resetFacts(at);
  }

  /** Full reset (channel switch, platform switch, context clear). */
  reset(at: number = Date.now()): void {
    this.resetFacts(at);
  }

  private resetFacts(at: number): void {
    const keepCaps = this.capabilities;
    this.chat = { transport: "disconnected", transportAt: at, everConnected: false, lastInputAt: null };
    this.audio = {
      capturing: false, capturingAt: at, mode: null,
      initializing: { active: false, progress: null, at: at },
      lastEnergyAt: null, lastEnergyLabel: null, lastTranscriptAt: null, lastError: null,
    };
    this.vision = {
      captureActive: false, captureAt: at, lastStop: null,
      autoCapture: false, cadenceMs: 60_000,
      lastFrameAt: null, lastFrameDelta: null, significantDeltaAt: null,
      lastSemanticAt: null, lastSemanticOk: null, lastSemanticError: null, lastAttemptAt: null,
    };
    this.events = { lastEventAt: null };
    this.hysteresis = {
      chat: freshHysteresis(at),
      audio: freshHysteresis(at),
      vision: freshHysteresis(at),
      platform_events: freshHysteresis(at),
    };
    this.capabilities = keepCaps;
  }

  setCapabilities(caps: Partial<PerceptionCapabilities>): void {
    this.capabilities = { ...this.capabilities, ...caps };
  }

  getCapabilities(): PerceptionCapabilities {
    return { ...this.capabilities };
  }

  // ─── Ingestion: chat ────────────────────────────────────────────────────────

  /** Chat read transport lifecycle (tmi/Kick/Joystick connection state). */
  noteChatTransport(transport: ChatTransport, at: number = Date.now()): void {
    if (transport === "connected") this.chat.everConnected = true;
    if (this.chat.transport !== transport || transport !== "connected") {
      this.chat.transportAt = at;
    }
    if (this.chat.transport !== transport) {
      this.chat.transport = transport;
      // Explicit transport transitions commit immediately (no hysteresis lag
      // on connect/error; §36 "explicit errors may transition immediately").
      const target: Parameters<typeof this.commit>[1] =
        transport === "connected"
          ? (this.chat.lastInputAt != null && at - this.chat.lastInputAt <= PERCEPTION_LIMITS.chatLiveWindowMs ? "live" : "quiet")
          : transport === "error"
            ? "error"
            : transport === "disconnected" && this.chat.everConnected
              ? "degraded"
              : "initializing";
      this.commit("chat", target, at, true);
    }
  }

  /** A valid inbound human/foreign chat message arrived. */
  noteChatInput(at: number = Date.now()): void {
    this.chat.lastInputAt = Math.max(this.chat.lastInputAt ?? 0, at);
    // Valid output is an immediate recovery to LIVE (§38).
    this.commit("chat", "live", at, true);
  }

  // ─── Ingestion: audio ───────────────────────────────────────────────────────

  /** Audio capture started/stopped (mic or system audio). */
  noteAudioCapture(active: boolean, at: number = Date.now(), opts?: { mode?: "deepgram" | "whisper" | null; intentional?: boolean }): void {
    if (active) {
      this.audio.capturing = true;
      this.audio.capturingAt = at;
      this.audio.lastError = null; // retry clears the previous error (§38)
      if (opts?.mode) this.audio.mode = opts.mode;
    } else {
      this.audio.capturing = false;
      this.audio.mode = opts?.mode ?? null;
      if (opts?.intentional) {
        // Intentional stop clears obsolete error state.
        this.audio.lastError = null;
      }
    }
  }

  /** Active audio pipeline (deepgram cloud WS vs local whisper) — detail only. */
  noteAudioMode(mode: "deepgram" | "whisper" | null): void {
    this.audio.mode = mode;
  }

  /** Explicit audio pipeline failure (permission, transport, model load…). */
  noteAudioError(code: string, at: number = Date.now()): void {
    this.audio.lastError = { code, at };
    this.audio.capturing = false;
    this.commit("audio", "error", at, true);
  }

  /** Whisper model download progress (null = finished/failed — see error note). */
  noteAudioInitializing(progress: number | null, at: number = Date.now()): void {
    if (progress != null) {
      this.audio.initializing = { active: true, progress, at };
    } else if (this.audio.initializing.active) {
      this.audio.initializing = { active: false, progress: null, at };
    }
  }

  /** Mic/system audio energy sample (label: silent…spike). */
  noteAudioEnergy(label: string, at: number = Date.now()): void {
    this.audio.lastEnergyAt = at;
    this.audio.lastEnergyLabel = label;
  }

  /** Valid transcript segment produced (Deepgram final or Whisper output). */
  noteTranscript(at: number = Date.now()): void {
    this.audio.lastTranscriptAt = Math.max(this.audio.lastTranscriptAt ?? 0, at);
    // Valid output is an immediate recovery to LIVE (§38) — no debounce on
    // the way back up.
    this.commit("audio", "live", at, true);
  }

  // ─── Ingestion: vision ──────────────────────────────────────────────────────

  /** Screen capture started/stopped. `code` on stop = why it ended. */
  noteVisionCapture(active: boolean, at: number = Date.now(), opts?: { intentional?: boolean; code?: string }): void {
    if (active) {
      this.vision.captureActive = true;
      this.vision.captureAt = at;
      // A fresh start clears stop reasons; a retry after permission_denied is
      // the user's recovery action.
      this.vision.lastStop = null;
    } else {
      this.vision.captureActive = false;
      this.vision.lastStop = { at, intentional: opts?.intentional ?? false, code: opts?.code };
    }
  }

  noteVisionAutoCapture(enabled: boolean): void {
    this.vision.autoCapture = enabled;
  }

  /** Expected capture/analysis cadence (smart capture adjusts this). */
  noteVisionCadence(intervalMs: number): void {
    if (intervalMs > 0) this.vision.cadenceMs = intervalMs;
  }

  /** A frame was captured (any source: screen, thumbnail snap). */
  noteVisionFrame(delta: number | null, at: number = Date.now()): void {
    this.vision.lastFrameAt = at;
    this.vision.lastFrameDelta = delta;
    if (delta != null && delta >= SIGNIFICANT_FRAME_DELTA) {
      this.vision.significantDeltaAt = at;
    }
  }

  /**
   * A vision analysis request completed. MUST only be called with
   * current-session results — call sites guard with captureSessionScope +
   * visionConfigRevision before reporting, so a stale async response can never
   * refresh current liveness (§54, explicit test coverage).
   */
  noteVisionSemantic(
    result: { ok: boolean; code?: string },
    at: number = Date.now(),
  ): void {
    this.vision.lastAttemptAt = at;
    if (result.ok) {
      this.vision.lastSemanticAt = at;
      this.vision.lastSemanticOk = true;
      this.vision.lastSemanticError = null; // recovery clears error (§38)
      this.commit("vision", "live", at, true);
    } else {
      this.vision.lastSemanticOk = false;
      this.vision.lastSemanticError = { code: result.code ?? "processing_failed", at };
      // Explicit provider failures surface immediately (§36) as DEGRADED —
      // capture survives, semantic analysis is down.
      this.commit("vision", "degraded", at, true);
    }
  }

  /**
   * Invalidate the current visual observation without resetting chat, audio,
   * platform events, capture intent, or cadence. A still-running capture goes
   * back to initializing; an idle/unsupported lane derives its honest idle
   * state until a new frame arrives.
   */
  clearVisionObservation(at: number = Date.now()): void {
    this.vision.lastFrameAt = null;
    this.vision.lastFrameDelta = null;
    this.vision.significantDeltaAt = null;
    this.vision.lastSemanticAt = null;
    this.vision.lastSemanticOk = null;
    this.vision.lastSemanticError = null;
    this.vision.lastAttemptAt = null;
    this.hysteresis.vision = freshHysteresis(at);
  }

  // ─── Ingestion: platform events ─────────────────────────────────────────────

  /** Valid platform event delivered (raid/sub/cheer/host…). */
  notePlatformEvent(at: number = Date.now()): void {
    this.events.lastEventAt = Math.max(this.events.lastEventAt ?? 0, at);
  }

  // ─── Hysteresis ────────────────────────────────────────────────────────────

  private commit(lane: PerceptionLane, status: PerceptionStatus, now: number, immediate = false): PerceptionStatus {
    const h = this.hysteresis[lane];
    if (h.stable === status) {
      h.pending = null;
      return status;
    }
    // Immediate transitions: explicit errors, recovery to live, explicit
    // lifecycle changes (init/stop). Timing-derived downgrades are debounced.
    const immediateKinds =
      immediate ||
      status === "error" ||
      status === "live" ||
      status === "initializing" ||
      status === "disabled" ||
      status === "unavailable";
    if (immediateKinds) {
      h.stable = status;
      h.stableAt = now;
      h.pending = null;
      return status;
    }
    if (h.pending === status) {
      if (now - h.pendingAt >= PERCEPTION_LIMITS.statusStickyMs) {
        h.stable = status;
        h.stableAt = now;
        h.pending = null;
      }
    } else {
      h.pending = status;
      h.pendingAt = now;
    }
    return h.stable;
  }

  // ─── Derivation ────────────────────────────────────────────────────────────

  private deriveChat(now: number): PerceptionLiveness {
    const c = this.chat;
    const configured = !!this.channel;
    const base = {
      lane: "chat" as const,
      enabled: configured,
      supported: true,
      configured,
      lastInputAt: c.lastInputAt ?? undefined,
      lastAttemptAt: c.transportAt || undefined,
      confidence: 0.5,
    };

    if (!configured) {
      return { ...base, status: "unavailable", reasonCode: "no_channel", confidence: 0 };
    }
    if (c.transport === "error") {
      return { ...base, status: "error", reasonCode: "connection_failed", lastErrorAt: c.transportAt, error: { code: "connection_failed", recoverable: true }, confidence: 0.15 };
    }
    if (c.transport === "connecting") {
      const timedOut = now - c.transportAt > PERCEPTION_LIMITS.chatConnectTimeoutMs;
      return timedOut
        ? { ...base, status: "degraded", reasonCode: "connect_timeout", confidence: 0.35 }
        : { ...base, status: "initializing", reasonCode: "starting", confidence: 0.5 };
    }
    if (c.transport === "disconnected") {
      // everConnected + disconnected = transport dropped mid-session (the
      // clients auto-reconnect; 'connecting' will follow). Never-connected
      // disconnected is the brief pre-connect moment.
      return c.everConnected
        ? { ...base, status: "degraded", reasonCode: "connection_closed", confidence: 0.3 }
        : { ...base, status: "initializing", reasonCode: "starting", confidence: 0.5 };
    }

    // Transport connected: silence is QUIET, never stale (§11, Example A).
    const lastInputAt = c.lastInputAt;
    const recent = lastInputAt != null && now - lastInputAt <= PERCEPTION_LIMITS.chatLiveWindowMs;
    return {
      ...base,
      status: recent ? "live" : "quiet",
      reasonCode: recent ? undefined : "chat_silent",
      lastValidOutputAt: lastInputAt ?? undefined,
      ageMs: lastInputAt != null ? now - lastInputAt : undefined,
      confidence: recent ? 0.95 : 0.7,
      stages: {
        transport: { status: "live", lastSuccessAt: c.transportAt },
      },
    };
  }

  private deriveAudio(now: number): PerceptionLiveness {
    const a = this.audio;
    const base = {
      lane: "audio" as const,
      enabled: a.capturing || a.initializing.active || !!a.lastError,
      supported: true,
      configured: true,
      lastInputAt: a.lastEnergyAt ?? undefined,
      lastValidOutputAt: a.lastTranscriptAt ?? undefined,
      ageMs: a.lastTranscriptAt != null ? now - a.lastTranscriptAt : undefined,
      lastErrorAt: a.lastError?.at,
      confidence: 0.5,
    };

    // Explicit error (permission denied, WS failure, model load failed…).
    if (a.lastError && !a.capturing) {
      return {
        ...base,
        status: "error",
        reasonCode: a.lastError.code,
        error: { code: a.lastError.code, recoverable: true },
        confidence: 0.15,
      };
    }

    // Whisper model downloading/loading — never LIVE while a multi-MB model
    // is still loading (§15). Progress updates refresh the timestamp so a
    // slow-but-healthy download doesn't time out.
    if (!a.capturing && a.initializing.active) {
      const timedOut = now - a.initializing.at > PERCEPTION_LIMITS.whisperLoadTimeoutMs;
      return timedOut
        ? { ...base, status: "error", reasonCode: "model_load_failed", error: { code: "model_load_failed", recoverable: true }, confidence: 0.15 }
        : {
            ...base,
            status: "initializing",
            reasonCode: "model_loading",
            confidence: 0.5,
            stages: { model: { status: "initializing", detail: a.initializing.progress != null ? `${a.initializing.progress}%` : undefined } },
          };
    }

    if (!a.capturing) {
      // Intentional stop or never started — healthy absence.
      return { ...base, status: "disabled", reasonCode: "intentional_stop", confidence: 0 };
    }

    // ── Capture stage ────────────────────────────────────────────────────────
    const energyFresh = a.lastEnergyAt != null && now - a.lastEnergyAt <= PERCEPTION_LIMITS.energyEvidenceWindowMs;
    const captureStage: PerceptionStageState = {
      status: "live",
      lastSuccessAt: a.lastEnergyAt ?? a.capturingAt,
      detail: energyFresh && a.lastEnergyLabel ? `energy: ${a.lastEnergyLabel}` : a.mode ?? undefined,
    };

    // ── Transcription stage ────────────────────────────────────────────────────
    const transcriptFresh =
      a.lastTranscriptAt != null && now - a.lastTranscriptAt <= PERCEPTION_LIMITS.transcriptLiveWindowMs;
    let transcript: PerceptionStageState;
    let overall: PerceptionStatus;
    let reasonCode: string | undefined;
    let confidence = 0.9;

    if (transcriptFresh) {
      transcript = { status: "live", lastSuccessAt: a.lastTranscriptAt! };
      overall = "live";
    } else if (energyFresh && ACTIVE_ENERGY_LABELS.has(a.lastEnergyLabel ?? "")) {
      // Audio is present but words aren't arriving — the high-value
      // distinction between healthy silence and transcription failure (§13).
      const overdue = a.lastTranscriptAt == null
        ? now - a.capturingAt > PERCEPTION_LIMITS.transcriptSpeechStaleMs
        : now - a.lastTranscriptAt > PERCEPTION_LIMITS.transcriptSpeechStaleMs;
      if (overdue) {
        transcript = { status: "stale", lastSuccessAt: a.lastTranscriptAt ?? undefined };
        overall = "degraded";
        reasonCode = "transcription_stale_speech_detected";
        confidence = 0.45;
      } else {
        transcript = { status: "quiet", lastSuccessAt: a.lastTranscriptAt ?? undefined, detail: "warming up" };
        overall = "quiet";
        confidence = 0.6;
      }
    } else if (energyFresh) {
      // Silent/quiet energy — healthy streamer silence (Example B).
      transcript = { status: "quiet", lastSuccessAt: a.lastTranscriptAt ?? undefined, detail: `energy: ${a.lastEnergyLabel}` };
      overall = "quiet";
      reasonCode = undefined;
      confidence = 0.65;
    } else {
      // No energy probe (system-audio capture has none). Music or silence can
      // legitimately produce no transcript for a long time — be conservative.
      const overdue = a.lastTranscriptAt != null
        ? now - a.lastTranscriptAt > PERCEPTION_LIMITS.transcriptNoEnergyStaleMs
        : now - a.capturingAt > PERCEPTION_LIMITS.transcriptNoEnergyStaleMs;
      if (overdue) {
        transcript = { status: "stale", lastSuccessAt: a.lastTranscriptAt ?? undefined };
        overall = "stale";
        reasonCode = "transcription_stale";
        confidence = 0.5;
      } else {
        transcript = { status: "quiet", lastSuccessAt: a.lastTranscriptAt ?? undefined };
        overall = "quiet";
        confidence = 0.6;
      }
    }

    return {
      ...base,
      status: overall,
      reasonCode,
      confidence,
      stages: {
        capture: captureStage,
        transcription: transcript,
      },
    };
  }

  private deriveVision(now: number): PerceptionLiveness {
    const v = this.vision;
    const hasEvidence = v.lastFrameAt != null || v.lastSemanticAt != null || v.lastAttemptAt != null;
    const base = {
      lane: "vision" as const,
      enabled: v.captureActive,
      supported: this.capabilities.visionCaptureSupported || hasEvidence,
      configured: true,
      lastInputAt: v.lastFrameAt ?? undefined,
      lastAttemptAt: v.lastAttemptAt ?? undefined,
      lastValidOutputAt: v.lastSemanticOk ? (v.lastSemanticAt ?? undefined) : undefined,
      ageMs: v.lastSemanticOk && v.lastSemanticAt != null ? now - v.lastSemanticAt : undefined,
      lastErrorAt: v.lastSemanticError?.at,
      confidence: 0.5,
    };

    if (!v.captureActive) {
      // Mobile / unsupported browser with zero vision evidence → honest
      // UNAVAILABLE, never an error, never an aggregate penalty (§58).
      if (!this.capabilities.visionCaptureSupported && !hasEvidence) {
        return { ...base, status: "unavailable", reasonCode: "unsupported_platform", enabled: false, confidence: 0 };
      }
      // Manual-thumbnail path (mobile SNAP): no continuous capture, but a
      // recent successful analysis proves the vision pipeline works. Only
      // applies when capture was never stopped (a desktop stop — intentional
      // or ended — is OFF regardless of old analysis results).
      const semanticRecent =
        !v.lastStop &&
        v.lastSemanticOk === true &&
        v.lastSemanticAt != null &&
        now - v.lastSemanticAt <= PERCEPTION_LIMITS.visionManualFreshMs;
      if (semanticRecent) {
        return {
          ...base,
          status: "live",
          enabled: true,
          ageMs: now - v.lastSemanticAt!,
          lastValidOutputAt: v.lastSemanticAt,
          confidence: 0.85,
          stages: {
            capture: { status: "quiet", detail: "manual" },
            semantic: { status: "live", lastSuccessAt: v.lastSemanticAt! },
          },
        };
      }
      const semanticErrorRecent =
        !v.lastStop &&
        v.lastSemanticOk === false &&
        v.lastSemanticAt == null &&
        v.lastSemanticError != null &&
        now - v.lastSemanticError.at <= PERCEPTION_LIMITS.visionErrorDecayMs;
      if (semanticErrorRecent) {
        return {
          ...base,
          status: "error",
          enabled: true,
          reasonCode: v.lastSemanticError.code,
          error: { code: v.lastSemanticError.code, recoverable: true },
          confidence: 0.2,
        };
      }
      const stop = v.lastStop;
      if (stop?.code === "permission_denied") {
        // The user attempted to start capture and the browser refused. Show
        // the error with its recovery action; decay to OFF if they move on.
        if (now - stop.at <= PERCEPTION_LIMITS.visionPermissionErrorDecayMs) {
          return { ...base, status: "error", reasonCode: "permission_denied", error: { code: "permission_denied", recoverable: true }, confidence: 0.15 };
        }
      }
      // Intentional stop or sharing ended — OFF, with the reason preserved so
      // the UI can offer "Start capture" (§19: immediate, honest, not LIVE).
      return { ...base, status: "disabled", reasonCode: stop?.code ?? "intentional_stop", confidence: 0 };
    }

    // ── Capture stage ────────────────────────────────────────────────────────
    let capture: PerceptionStageState;
    if (v.lastFrameAt != null) {
      const frameFresh = now - v.lastFrameAt <= Math.max(PERCEPTION_LIMITS.visionFrameFreshMs, v.autoCapture ? v.cadenceMs : 0);
      capture = {
        status: frameFresh ? "live" : v.autoCapture ? "stale" : "quiet",
        lastSuccessAt: v.lastFrameAt,
        detail: v.lastFrameDelta != null ? `Δ ${(v.lastFrameDelta * 100).toFixed(1)}%` : undefined,
      };
    } else if (now - v.captureAt > PERCEPTION_LIMITS.visionFirstFrameTimeoutMs) {
      capture = { status: "stale" };
    } else {
      capture = { status: "initializing", detail: "waiting for first frame" };
    }

    // ── Semantic stage ────────────────────────────────────────────────────────
    let semantic: PerceptionStageState;
    let overall: PerceptionStatus;
    let reasonCode: string | undefined;
    let confidence = 0.9;

    if (v.lastSemanticError) {
      const errAge = now - v.lastSemanticError.at;
      if (errAge <= PERCEPTION_LIMITS.visionErrorDecayMs) {
        semantic = { status: "error", lastErrorAt: v.lastSemanticError.at };
        overall = "degraded"; // capture survives; semantic analysis is down (Example E)
        reasonCode = v.lastSemanticError.code;
        confidence = 0.4;
      } else {
        // Error is old and never recovered. If the scene is still changing,
        // analysis is overdue; otherwise the lane settles to honest quiet.
        const sceneChanging =
          v.significantDeltaAt != null && now - v.significantDeltaAt <= Math.max(v.cadenceMs, PERCEPTION_LIMITS.visionFrameFreshMs);
        if (sceneChanging) {
          semantic = { status: "stale" };
          overall = "stale";
          reasonCode = "expected_output_overdue";
          confidence = 0.5;
        } else {
          semantic = { status: "quiet", detail: "analysis stopped after failure" };
          overall = "quiet";
          confidence = 0.55;
        }
      }
    } else if (v.lastSemanticOk && v.lastSemanticAt != null) {
      const expectedNext = v.lastSemanticAt + (v.autoCapture ? v.cadenceMs + PERCEPTION_LIMITS.visionCadenceGraceMs : Infinity);
      if (now <= expectedNext) {
        semantic = { status: "live", lastSuccessAt: v.lastSemanticAt };
        overall = "live";
      } else {
        // Overdue — but only STALE if the scene is actually changing (frames
        // with significant deltas are arriving). A static scene under delta
        // gating is healthy QUIET, never stale (Example D).
        const sceneChanging =
          v.significantDeltaAt != null && now - v.significantDeltaAt <= Math.max(v.cadenceMs, PERCEPTION_LIMITS.visionFrameFreshMs);
        if (sceneChanging) {
          semantic = { status: "stale", lastSuccessAt: v.lastSemanticAt };
          overall = "stale";
          reasonCode = "expected_output_overdue";
          confidence = 0.55;
        } else {
          semantic = { status: "quiet", lastSuccessAt: v.lastSemanticAt, detail: "scene unchanged" };
          overall = "quiet";
          reasonCode = "scene_unchanged";
          confidence = 0.7;
        }
      }
    } else if (v.lastFrameAt != null) {
      // Frames flowing but no semantic attempt yet — first cadence window.
      const firstWindow = v.captureAt + v.cadenceMs + PERCEPTION_LIMITS.visionCadenceGraceMs;
      if (now <= firstWindow || !v.autoCapture) {
        semantic = { status: "quiet", detail: "no analysis yet" };
        overall = "quiet";
        confidence = 0.6;
      } else {
        semantic = { status: "stale" };
        overall = "stale";
        reasonCode = "expected_output_overdue";
        confidence = 0.5;
      }
    } else {
      semantic = { status: "initializing" };
      overall = "initializing";
      reasonCode = "first_frame_pending";
      confidence = 0.5;
    }

    // Capture-level problems override the semantic read for the overall status.
    if (capture.status === "stale" && (overall === "live" || overall === "initializing")) {
      overall = "degraded";
      reasonCode = "expected_output_overdue";
    }

    return {
      ...base,
      status: overall,
      reasonCode,
      confidence,
      stages: {
        capture,
        semantic,
      },
    };
  }

  private deriveEvents(now: number): PerceptionLiveness {
    const e = this.events;
    const c = this.chat;
    const supported = this.capabilities.platformEventsSupported;
    const configured = !!this.channel;
    const base = {
      lane: "platform_events" as const,
      enabled: configured && supported,
      supported,
      configured,
      lastValidOutputAt: e.lastEventAt ?? undefined,
      ageMs: e.lastEventAt != null ? now - e.lastEventAt : undefined,
      confidence: 0.5,
    };

    if (!configured) {
      return { ...base, status: "unavailable", reasonCode: "no_channel", confidence: 0 };
    }
    if (!supported) {
      // Kick/Joystick don't expose raids/subs/cheers — platform limitation,
      // never shamed as an error (§58).
      return { ...base, status: "unavailable", reasonCode: "unsupported_platform", confidence: 0 };
    }
    // Events ride the chat transport; sparse by nature. Absence of events is
    // always QUIET while the transport is healthy (Example H) — never stale.
    if (c.transport === "error") {
      return { ...base, status: "error", reasonCode: "connection_failed", error: { code: "connection_failed", recoverable: true }, confidence: 0.15 };
    }
    if (c.transport === "connecting") {
      return { ...base, status: "initializing", reasonCode: "starting", confidence: 0.5 };
    }
    if (c.transport === "disconnected") {
      return c.everConnected
        ? { ...base, status: "degraded", reasonCode: "connection_closed", confidence: 0.3 }
        : { ...base, status: "initializing", reasonCode: "starting", confidence: 0.5 };
    }
    const recent = e.lastEventAt != null && now - e.lastEventAt <= PERCEPTION_LIMITS.eventLiveWindowMs;
    return recent
      ? { ...base, status: "live", confidence: 0.95 }
      : { ...base, status: "quiet", reasonCode: "no_recent_events", confidence: 0.7 };
  }

  // ─── Public reads ────────────────────────────────────────────────────────────

  /** Derive all lanes at `now`. Hysteresis is applied to timing-derived
   *  transitions; explicit transitions (error/recovery/lifecycle) commit
   *  immediately. */
  getLanes(now: number = Date.now()): Record<PerceptionLane, PerceptionLiveness> {
    const chat = this.deriveChat(now);
    const audio = this.deriveAudio(now);
    const vision = this.deriveVision(now);
    const events = this.deriveEvents(now);
    return {
      chat: { ...chat, status: this.commit("chat", chat.status, now) },
      audio: { ...audio, status: this.commit("audio", audio.status, now) },
      vision: { ...vision, status: this.commit("vision", vision.status, now) },
      platform_events: { ...events, status: this.commit("platform_events", events.status, now) },
    };
  }

  /** Aggregate perception health. Disabled/unavailable lanes never reduce
   *  health (§59/§66); a zero-vision chat+audio user is not "degraded". */
  getSummary(now: number = Date.now()): PerceptionSummary {
    const lanes = this.getLanes(now);
    const entries = Object.values(lanes);
    const enabledLanes = entries.filter((l) => l.enabled && l.status !== "disabled" && l.status !== "unavailable");
    const functioning = enabledLanes.filter((l) => l.status === "live" || l.status === "quiet");
    const failing = enabledLanes.filter((l) => l.status === "stale" || l.status === "degraded" || l.status === "error");

    let overall: PerceptionOverall;
    if (enabledLanes.length === 0) {
      overall = "offline";
    } else if (functioning.length === 0) {
      overall = "offline";
    } else if (failing.length === 0) {
      overall = "healthy";
    } else if (functioning.length === 1 && enabledLanes.length >= 2) {
      overall = "limited";
    } else {
      overall = "partial";
    }

    return {
      overall,
      liveCount: entries.filter((l) => l.status === "live").length,
      degradedCount: entries.filter((l) => l.status === "degraded" || l.status === "stale").length,
      errorCount: entries.filter((l) => l.status === "error").length,
      lanes,
      updatedAt: now,
    };
  }

  /** Developer-readable diagnostics (§50). No secrets — reason codes and
   *  timestamps only, never provider responses or keys. */
  exportSnapshot(now: number = Date.now()): Record<string, unknown> {
    const summary = this.getSummary(now);
    return {
      updatedAt: summary.updatedAt,
      overall: summary.overall,
      channel: this.channel,
      capabilities: this.capabilities,
      lanes: Object.fromEntries(
        Object.entries(summary.lanes).map(([lane, l]) => [
          lane,
          {
            status: l.status,
            reasonCode: l.reasonCode,
            ageMs: l.ageMs,
            stages: l.stages,
          },
        ]),
      ),
    };
  }
}

/** Module singleton — the single source of perception-liveness truth. */
export const perception = new PerceptionLivenessEngine();

// ─── Prompt context (§24/§62) ──────────────────────────────────────────────────

/**
 * Compact perception-freshness block for AI decision prompts. Empty when all
 * enabled lanes are healthy — stale-ness labeling is only injected when it
 * changes what the model should trust. AutoForge must never present stale
 * perception as current evidence.
 */
export function formatPerceptionContext(summary: PerceptionSummary | null): string {
  if (!summary) return "";
  const flagged = (Object.values(summary.lanes) as PerceptionLiveness[]).filter((l) =>
    l.status === "stale" || l.status === "degraded" || l.status === "error",
  );
  if (flagged.length === 0) return "";
  const lines = flagged.map((l) => {
    const label = PERCEPTION_REASON_LABELS[l.reasonCode ?? ""] ?? l.reasonCode ?? "";
    const age = l.ageMs != null ? ` — last valid output ${Math.round(l.ageMs / 1000)}s ago` : "";
    return `${l.lane}: ${l.status.toUpperCase()}${label ? ` (${label})` : ""}${age}`;
  });
  return [
    "[PERCEPTION HEALTH — sensor freshness. Lanes flagged below are NOT current evidence; do not comment on them in the present tense.]",
    ...lines,
  ].join("\n");
}

// ─── Presentation helpers ──────────────────────────────────────────────────────

/** Consistent status vocabulary for every surface (§33). */
export function perceptionStatusLabel(status: PerceptionStatus): string {
  switch (status) {
    case "live": return "LIVE";
    case "quiet": return "QUIET";
    case "initializing": return "STARTING";
    case "stale": return "STALE";
    case "degraded": return "DEGRADED";
    case "error": return "ERROR";
    case "disabled": return "OFF";
    case "unavailable": return "UNAVAILABLE";
  }
}

/** Short freshness copy: now / 2s / 18s / 1m (§35). */
export function perceptionAgeLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 2) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return `${m}m`;
}
