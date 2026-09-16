/**
 * Friend Trial — frontend client.
 *
 * Provides a "trial" provider that routes AI requests through the Friend Trial
 * Cloudflare Worker using a server-held Groq key. The user never sees, holds,
 * or controls the Groq credential.
 *
 * Integration model:
 *  - Trial is a separate provider ("trial") in the existing provider system.
 *  - When active, `createTrialFetch()` intercepts OpenAI SDK chat-completions
 *    requests and rewrites them to the Worker's POST /trial/chat endpoint.
 *  - The Worker returns an OpenAI-compatible response, so the entire existing
 *    AI pipeline (scheduler, response parsing, token usage) works unchanged.
 *  - BYOK is untouched — trial never reads or overwrites the user's own keys.
 *  - The trial session token (a disposable HMAC credential, NOT the Groq key)
 *    lives in sessionStorage and is sent as `Authorization: Bearer <token>`.
 *
 * Text-only: trial strips image parts from multimodal message content before
 * forwarding, so no image ever leaves the browser in trial mode. The Worker
 * also rejects multimodal content as defense-in-depth.
 *
 * Vision support: when the Worker reports `supportsVision: true` (a
 * `TRIAL_VISION_MODEL` is configured server-side), the trial stops stripping
 * images and forwards multimodal content to the Worker, which routes
 * image-bearing requests to the vision model. The vision capability is
 * cached per-Worker-URL and refreshed on each status fetch.
 */

/** Provider id for the Friend Trial transport. */
export const TRIAL_PROVIDER = "trial";

const TRIAL_TOKEN_KEY = "madchatter_trial_token";
const TRIAL_EXPIRY_KEY = "madchatter_trial_expiry";
const TRIAL_WORKER_URL_KEY = "madchatter_trial_worker_url";
const TRIAL_TURNSTILE_SITE_KEY_KEY = "madchatter_trial_turnstile_site_key";

/** Default Worker URL — override via VITE_TRIAL_WORKER_URL or localStorage. */
const VITE_ENV = (import.meta as any).env || {};
const DEFAULT_WORKER_URL = VITE_ENV.VITE_TRIAL_WORKER_URL || "";
/** Default Turnstile site key — override via VITE_TURNSTILE_SITE_KEY or localStorage. */
const DEFAULT_TURNSTILE_SITE_KEY = VITE_ENV.VITE_TURNSTILE_SITE_KEY || "";

// ── Worker URL + Turnstile site key (public, non-secret) ──────────────────────

export function getTrialWorkerUrl(): string {
  return (localStorage.getItem(TRIAL_WORKER_URL_KEY) || DEFAULT_WORKER_URL || "").trim().replace(/\/+$/, "");
}

export function setTrialWorkerUrl(url: string): void {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (trimmed) localStorage.setItem(TRIAL_WORKER_URL_KEY, trimmed);
  else localStorage.removeItem(TRIAL_WORKER_URL_KEY);
}

export function getTrialTurnstileSiteKey(): string {
  return (localStorage.getItem(TRIAL_TURNSTILE_SITE_KEY_KEY) || DEFAULT_TURNSTILE_SITE_KEY || "").trim();
}

export function setTrialTurnstileSiteKey(key: string): void {
  const trimmed = key.trim();
  if (trimmed) localStorage.setItem(TRIAL_TURNSTILE_SITE_KEY_KEY, trimmed);
  else localStorage.removeItem(TRIAL_TURNSTILE_SITE_KEY_KEY);
}

export function isTrialConfigured(): boolean {
  return getTrialWorkerUrl().length > 0;
}

// ── Session token management (sessionStorage) ───────────────────────────────

/** The trial session token — a disposable HMAC credential, NOT the Groq key. */
export function getTrialToken(): string | null {
  try {
    return sessionStorage.getItem(TRIAL_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getTrialExpiry(): number {
  try {
    const raw = sessionStorage.getItem(TRIAL_EXPIRY_KEY);
    return raw ? parseInt(raw, 10) : 0;
  } catch {
    return 0;
  }
}

export function setTrialSession(token: string, expiresAt: number): void {
  try {
    sessionStorage.setItem(TRIAL_TOKEN_KEY, token);
    sessionStorage.setItem(TRIAL_EXPIRY_KEY, String(expiresAt));
  } catch {}
}

export function clearTrialSession(): void {
  try {
    sessionStorage.removeItem(TRIAL_TOKEN_KEY);
    sessionStorage.removeItem(TRIAL_EXPIRY_KEY);
  } catch {}
}

/** Client-side precheck — the server is authoritative on expiry. */
export function isTrialSessionValid(): boolean {
  const token = getTrialToken();
  if (!token) return false;
  const exp = getTrialExpiry();
  if (exp && Date.now() >= exp * 1000) return false;
  return true;
}

// ── Worker API client ─────────────────────────────────────────────────────────

export interface TrialStatus {
  enabled: boolean;
  reason?: string;
  endsAt?: string;
  requiresTurnstile: boolean;
  requiresInviteCode: boolean;
  modelLabel?: string;
  supportsVision?: boolean;
  visionModelLabel?: string;
}

export async function fetchTrialStatus(workerUrl: string): Promise<TrialStatus> {
  const resp = await fetch(`${workerUrl}/trial/status`, { method: "GET" });
  const data = await resp.json().catch(() => ({ ok: false }));
  if (data.ok && data.trial) {
    const trial = data.trial as TrialStatus;
    // Cache the vision capability so createTrialFetch can decide whether to
    // strip images without an async status lookup on every request.
    cacheTrialVisionCapability(workerUrl, !!trial.supportsVision);
    return trial;
  }
  return { enabled: false, requiresTurnstile: true, requiresInviteCode: false };
}

export interface CreateSessionResult {
  ok: boolean;
  token?: string;
  expiresAt?: number;
  error?: string;
}

export async function createTrialSession(
  workerUrl: string,
  turnstileToken: string,
  inviteCode?: string,
): Promise<CreateSessionResult> {
  try {
    const resp = await fetch(`${workerUrl}/trial/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turnstileToken, ...(inviteCode ? { inviteCode } : {}) }),
    });
    const data = await resp.json().catch(() => ({ ok: false }));
    if (data.ok && data.session) {
      return { ok: true, token: data.session.token, expiresAt: data.session.expiresAt };
    }
    return { ok: false, error: data?.error?.code || data?.error?.message || "SESSION_FAILED" };
  } catch {
    return { ok: false, error: "NETWORK_ERROR" };
  }
}

// ── Trial fetch override ──────────────────────────────────────────────────────

/**
 * Cached vision capability per Worker URL. Updated by `fetchTrialStatus`.
 * When true, `createTrialFetch` forwards multimodal content unchanged; when
 * false/unknown, it strips image parts (text-only trial).
 */
let cachedVisionCapability: { url: string; supportsVision: boolean } | null = null;

function cacheTrialVisionCapability(workerUrl: string, supportsVision: boolean): void {
  cachedVisionCapability = { url: workerUrl, supportsVision };
}

/** Reset the cached vision capability (for tests). */
export function resetTrialVisionCapability(): void {
  cachedVisionCapability = null;
}

/** Returns true if the configured Worker supports vision (multimodal) requests. */
export function trialSupportsVision(): boolean {
  const workerUrl = getTrialWorkerUrl();
  if (!workerUrl) return false;
  return cachedVisionCapability?.url === workerUrl && cachedVisionCapability.supportsVision;
}

/**
 * Create a custom `fetch` for the OpenAI client when the provider is trial.
 *
 * Intercepts chat-completions requests and forwards them to the Worker's
 * POST /trial/chat endpoint with the trial session token. When the Worker
 * supports vision (TRIAL_VISION_MODEL configured), multimodal content is
 * forwarded unchanged. When vision is not supported, image parts are stripped
 * (text-only trial) so no image leaves the browser.
 *
 * On 401 (expired/invalid session), clears the stale session so the UI can
 * offer reactivation.
 */
export function createTrialFetch(): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);

    // Only intercept chat-completions; pass through anything else (e.g. /models).
    if (!url.pathname.endsWith("/chat/completions")) {
      return fetch(input, init);
    }

    const workerUrl = getTrialWorkerUrl();
    if (!workerUrl) {
      throw new Error("Friend Trial is not configured. Set the Worker URL in Settings.");
    }

    const token = getTrialToken();
    if (!token) {
      throw new Error("Friend Trial session expired. Please reactivate Friend Trial.");
    }

    // Parse the OpenAI-format body. Forward multimodal content unchanged when
    // the Worker supports vision; otherwise strip images (text-only trial).
    const rawBody = init?.body ? JSON.parse(init.body as string) : {};
    const forwardedBody = trialSupportsVision()
      ? rawBody
      : stripImagesFromMessages(rawBody);

    const resp = await fetch(`${workerUrl}/trial/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(forwardedBody),
    });

    // On 401, clear the stale session so the UI can offer reactivation.
    if (resp.status === 401) {
      clearTrialSession();
      // Bump the store's trialTick so components re-evaluate trial readiness.
      try {
        const { useAppStore } = await import("../store");
        useAppStore.getState().bumpTrialTick();
      } catch {}
    }

    return resp;
  };
}

/**
 * Convert multimodal message content (array of text + image parts) to text-only
 * by concatenating text parts and dropping image parts. String content is
 * passed through unchanged. This ensures no image ever leaves the browser in
 * trial mode.
 */
function stripImagesFromMessages(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body;
  const messages = body.messages.map((msg: Record<string, unknown>) => {
    const content = msg.content;
    if (typeof content === "string") return msg;
    if (!Array.isArray(content)) return { ...msg, content: "" };
    let text = "";
    for (const part of content as Array<Record<string, unknown>>) {
      if (part.type === "text" && typeof part.text === "string") {
        text += part.text;
      }
    }
    return { ...msg, content: text };
  });
  return { ...body, messages };
}

// ── Turnstile widget integration ──────────────────────────────────────────────

/** The Cloudflare Turnstile script URL. */
export const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js";

/** Turnstile test site key (always passes) for development. */
export const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";

let turnstileLoaded = false;

/** Load the Turnstile script once. Safe to call multiple times. */
export function loadTurnstileScript(): void {
  if (turnstileLoaded) return;
  if (document.querySelector(`script[src="${TURNSTILE_SCRIPT_URL}"]`)) {
    turnstileLoaded = true;
    return;
  }
  const script = document.createElement("script");
  script.src = TURNSTILE_SCRIPT_URL;
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
  turnstileLoaded = true;
}

/** Render a Turnstile widget into a container element. Returns a promise that
 *  resolves with the turnstile token, or rejects on error/timeout. */
export function renderTurnstile(
  container: HTMLElement,
  siteKey: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const w = (window as any).turnstile;
    if (!w) {
      reject(new Error("Turnstile script not loaded"));
      return;
    }
    const id = w.render(container, {
      sitekey: siteKey,
      callback: (token: string) => resolve(token),
      "error-callback": () => reject(new Error("Turnstile error")),
      "expired-callback": () => reject(new Error("Turnstile expired")),
      "timeout-callback": () => reject(new Error("Turnstile timeout")),
    });
    // Store id for cleanup.
    (container as any)._turnstileId = id;
  });
}

/** Remove a rendered Turnstile widget. */
export function removeTurnstile(container: HTMLElement): void {
  const w = (window as any).turnstile;
  const id = (container as any)._turnstileId;
  if (w && id !== undefined) {
    try { w.remove(id); } catch {}
  }
  (container as any)._turnstileId = undefined;
}
