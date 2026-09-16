/**
 * MADchatter Local Bridge — typed client + event contracts.
 *
 * The Bridge is a local Python service (local-bridge/) that captures livestream
 * or system audio, transcribes it locally with faster-whisper, and streams
 * timestamped transcript segments to MADchatter over a loopback-only HTTP/SSE
 * API. This module owns the typed contracts and the fetch/EventSource client.
 *
 * Security: the Bridge binds to 127.0.0.1 only and requires a local session
 * token on privileged routes. The token is provided by the user (copied from
 * the Bridge console on first run). CORS uses an explicit allowlist — never
 * "*". The browser's Private Network Access / Local Network Access policy may
 * require a user permission prompt for localhost fetch from an HTTPS origin;
 * the hook detects this and surfaces an actionable error.
 */

// ── Bridge API types ────────────────────────────────────────────────────

export type LocalAudioSource = "stream" | "system";
export type BridgeDevice = "auto" | "cuda" | "cpu";

export interface BridgeCapabilities {
  streamlink: boolean;
  ffmpeg: boolean;
  wasapi: boolean;
  cuda: boolean;
}

export interface BridgeHealth {
  service: string;
  serviceVersion: string;
  apiVersion: string;
  status: string;
  transcription: {
    state: string;
    device: string | null;
    computeType: string | null;
    model: string;
  };
  capabilities: BridgeCapabilities;
}

export interface BridgeTranscriptionState {
  state: string;
  source: LocalAudioSource | null;
  url: string | null;
  deviceId: string | null;
  model: string | null;
  device: string | null;
  computeType: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
  retryCount: number;
  latencyMs: number | null;
}

export interface BridgeModelStatus {
  state: string;
  model: string | null;
  device: string | null;
  computeType: string | null;
  progress: number | null;
  error: string | null;
}

export interface BridgeStatus {
  service: string;
  serviceVersion: string;
  apiVersion: string;
  transcription: BridgeTranscriptionState;
  model: BridgeModelStatus;
}

export interface BridgeDeviceEntry {
  id: string;
  name: string;
  sampleRate: number;
  channels: number;
}

export interface BridgeDevicesResponse {
  devices: BridgeDeviceEntry[];
  wasapi: boolean;
}

export interface StartRequest {
  source: LocalAudioSource;
  url?: string;
  deviceId?: string;
  model?: string;
  device?: BridgeDevice;
  language?: string;
}

export interface TranscriptSegment {
  id: string;
  text: string;
  startedAt: string;
  endedAt: string;
  source: LocalAudioSource;
  final: boolean;
  confidence?: number;
}

export interface BridgeErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

// ── Discriminated event union (SSE) ──────────────────────────────────────

export type BridgeEvent =
  | { type: "bridge.status"; data: BridgeTranscriptionState }
  | { type: "model.status"; data: BridgeModelStatus }
  | { type: "source.status"; data: { state: string; retry?: number; max?: number } }
  | { type: "transcript.partial"; data: TranscriptSegment }
  | { type: "transcript.final"; data: TranscriptSegment }
  | { type: "transcription.error"; data: BridgeErrorPayload }
  | { type: "transcription.stopped"; data: Record<string, never> };

// ── Connection state (frontend-side) ────────────────────────────────────

export type BridgeConnectionState =
  | "checking"
  | "connected"
  | "not_running"
  | "permission_required"
  | "version_mismatch"
  | "error";

export const BRIDGE_API_VERSION = "1";
export const DEFAULT_BRIDGE_BASE_URL = "http://127.0.0.1:8765";

// ── Error codes (mirror the Bridge's error contract) ────────────────────

export const BRIDGE_ERROR_CODES = {
  INVALID_REQUEST: "INVALID_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  TRANSCRIPTION_ALREADY_ACTIVE: "TRANSCRIPTION_ALREADY_ACTIVE",
  STREAM_UNSUPPORTED: "STREAM_UNSUPPORTED",
  STREAM_OFFLINE: "STREAM_OFFLINE",
  STREAM_RESOLUTION_FAILED: "STREAM_RESOLUTION_FAILED",
  FFMPEG_NOT_FOUND: "FFMPEG_NOT_FOUND",
  STREAMLINK_NOT_FOUND: "STREAMLINK_NOT_FOUND",
  AUDIO_DEVICE_NOT_FOUND: "AUDIO_DEVICE_NOT_FOUND",
  MODEL_LOAD_FAILED: "MODEL_LOAD_FAILED",
  CUDA_UNAVAILABLE: "CUDA_UNAVAILABLE",
  TRANSCRIPTION_FAILED: "TRANSCRIPTION_FAILED",
  SOURCE_DISCONNECTED: "SOURCE_DISCONNECTED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

// ── Human-readable error messages ───────────────────────────────────────

const ERROR_MESSAGES: Record<string, string> = {
  [BRIDGE_ERROR_CODES.FFMPEG_NOT_FOUND]: "FFmpeg was not found. Install FFmpeg or add it to PATH.",
  [BRIDGE_ERROR_CODES.STREAMLINK_NOT_FOUND]: "Streamlink was not found. Install Streamlink or add it to PATH.",
  [BRIDGE_ERROR_CODES.STREAM_OFFLINE]: "The selected stream appears to be offline.",
  [BRIDGE_ERROR_CODES.STREAM_UNSUPPORTED]: "Streamlink couldn't resolve this stream. Try System Audio instead.",
  [BRIDGE_ERROR_CODES.STREAM_RESOLUTION_FAILED]: "Streamlink couldn't resolve this stream. Try System Audio instead.",
  [BRIDGE_ERROR_CODES.AUDIO_DEVICE_NOT_FOUND]: "No system audio loopback device was found.",
  [BRIDGE_ERROR_CODES.MODEL_LOAD_FAILED]: "The transcription model could not be loaded.",
  [BRIDGE_ERROR_CODES.CUDA_UNAVAILABLE]: "CUDA wasn't available, so transcription switched to CPU.",
  [BRIDGE_ERROR_CODES.TRANSCRIPTION_FAILED]: "Transcription failed. Check the Bridge logs for details.",
  [BRIDGE_ERROR_CODES.SOURCE_DISCONNECTED]: "The audio source disconnected.",
  [BRIDGE_ERROR_CODES.TRANSCRIPTION_ALREADY_ACTIVE]: "A transcription session is already running.",
  [BRIDGE_ERROR_CODES.UNAUTHORIZED]: "Missing or invalid local bridge token.",
  [BRIDGE_ERROR_CODES.INTERNAL_ERROR]: "An internal error occurred in the Local Bridge.",
};

export function bridgeErrorMessage(code: string, fallback?: string): string {
  return ERROR_MESSAGES[code] || fallback || "An unexpected error occurred.";
}

// ── Client ──────────────────────────────────────────────────────────────

export class LocalBridgeClient {
  private baseUrl: string;
  private token: string | null;

  constructor(baseUrl: string = DEFAULT_BRIDGE_BASE_URL, token: string | null = null) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  setToken(token: string | null) {
    this.token = token;
  }

  private authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  /** GET /v1/health — unauthenticated, short timeout. */
  async checkHealth(timeoutMs = 2500): Promise<BridgeHealth> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/v1/health`, {
        signal: ctrl.signal,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`health ${res.status}`);
      return (await res.json()) as BridgeHealth;
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET /v1/status — authenticated. */
  async getStatus(): Promise<BridgeStatus> {
    const res = await fetch(`${this.baseUrl}/v1/status`, {
      headers: { ...this.authHeaders(), Accept: "application/json" },
    });
    if (!res.ok) throw await bridgeError(res);
    return (await res.json()) as BridgeStatus;
  }

  /** GET /v1/devices — authenticated. */
  async getDevices(): Promise<BridgeDevicesResponse> {
    const res = await fetch(`${this.baseUrl}/v1/devices`, {
      headers: { ...this.authHeaders(), Accept: "application/json" },
    });
    if (!res.ok) throw await bridgeError(res);
    return (await res.json()) as BridgeDevicesResponse;
  }

  /** POST /v1/transcription/start — authenticated. */
  async start(req: StartRequest): Promise<{ started: boolean; state: BridgeTranscriptionState }> {
    const res = await fetch(`${this.baseUrl}/v1/transcription/start`, {
      method: "POST",
      headers: { ...this.authHeaders(), "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw await bridgeError(res);
    return (await res.json()) as { started: boolean; state: BridgeTranscriptionState };
  }

  /** POST /v1/transcription/stop — authenticated, idempotent. */
  async stop(): Promise<{ stopped: boolean; state: BridgeTranscriptionState }> {
    const res = await fetch(`${this.baseUrl}/v1/transcription/stop`, {
      method: "POST",
      headers: { ...this.authHeaders(), Accept: "application/json" },
    });
    if (!res.ok) throw await bridgeError(res);
    return (await res.json()) as { stopped: boolean; state: BridgeTranscriptionState };
  }

  /** Open the SSE event stream. Returns an EventSource (token via query param). */
  openEventStream(onEvent: (evt: BridgeEvent) => void, onError?: (e: Event) => void): EventSource {
    const url = new URL(`${this.baseUrl}/v1/transcription/stream`);
    if (this.token) url.searchParams.set("token", this.token);
    const es = new EventSource(url.toString());
    es.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as BridgeEvent;
        onEvent(parsed);
      } catch {
        // Ignore malformed events — the Bridge sends compact JSON.
      }
    };
    if (onError) es.onerror = onError;
    return es;
  }
}

// ── Error parsing ────────────────────────────────────────────────────────

async function bridgeError(res: Response): Promise<Error> {
  let code = "INTERNAL_ERROR";
  let message = `Bridge request failed (${res.status})`;
  try {
    const body = await res.json();
    const err = body?.detail?.error || body?.error;
    if (err?.code) code = err.code;
    if (err?.message) message = err.message;
  } catch {
    // Non-JSON error body — use the status-based message.
  }
  const e = new Error(message) as Error & { code?: string };
  e.code = code;
  return e;
}

// ── Connection probing ──────────────────────────────────────────────────

/**
 * Probe the Bridge and classify the connection state.
 * Distinguishes: not running, permission required, version mismatch, connected.
 */
export async function probeBridge(
  baseUrl: string,
  token: string | null,
  timeoutMs = 2500,
): Promise<{ state: BridgeConnectionState; health?: BridgeHealth; error?: string }> {
  const client = new LocalBridgeClient(baseUrl, token);
  try {
    const health = await client.checkHealth(timeoutMs);
    // Version handshake: reject incompatible major API versions.
    if (health.apiVersion !== BRIDGE_API_VERSION) {
      return { state: "version_mismatch", health, error: `Bridge API v${health.apiVersion} is incompatible with MADchatter (expects v${BRIDGE_API_VERSION}).` };
    }
    return { state: "connected", health };
  } catch (e: unknown) {
    const err = e as Error & { name?: string };
    // Abort = timeout → Bridge not running.
    if (err.name === "AbortError") {
      return { state: "not_running", error: "Local Bridge is not running on this computer." };
    }
    // TypeError = network error (fetch failed). On a secure context, this
    // may be a Private Network Access permission denial rather than the
    // Bridge being down.
    if (err.name === "TypeError") {
      // If the page is HTTPS and the Bridge is HTTP, the browser may block
      // mixed content or require a Local Network Access permission.
      const isSecure = typeof window !== "undefined" && window.isSecureContext;
      if (isSecure && baseUrl.startsWith("http://")) {
        return { state: "permission_required", error: "Browser blocked localhost access. Allow Local Network Access for this site." };
      }
      return { state: "not_running", error: "Local Bridge is not running on this computer." };
    }
    return { state: "error", error: err.message || "Failed to connect to Local Bridge." };
  }
}

// ── Stream URL construction ─────────────────────────────────────────────

/**
 * Build a stream URL from the active platform + channel name.
 * The Bridge validates the URL against its own allowlist (Twitch/Kick only).
 */
export function buildStreamUrl(platform: string, channelName: string): string | null {
  const ch = channelName?.trim();
  if (!ch) return null;
  if (platform === "twitch") return `https://www.twitch.tv/${ch}`;
  if (platform === "kick") return `https://kick.com/${ch}`;
  return null;
}
