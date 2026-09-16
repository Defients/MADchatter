/**
 * Trial chat request validation + upstream Groq call.
 *
 * The Worker constructs the upstream payload entirely on the server from an
 * explicit input allowlist. The client may never control:
 *  - upstream URL (hardcoded to Groq)
 *  - model (server-controlled TRIAL_MODEL)
 *  - Authorization header (injected GROQ_API_KEY)
 *  - arbitrary headers / fields
 *  - output token ceiling (clamped to TRIAL_MAX_OUTPUT_TOKENS)
 */
import type { ParsedConfig } from "./config";
import type { TrialEnv, TrialErrorCode } from "./types";

// ── Input limits ─────────────────────────────────────────────────────────────
const MAX_BODY_BYTES = 64 * 1024; // 64 KB
const MAX_MESSAGES = 24;
const MAX_TOTAL_CHARS = 32_000;
const MAX_MESSAGE_CHARS = 16_000;
const ALLOWED_ROLES = new Set(["system", "user", "assistant"]);
const UPSTREAM_TIMEOUT_MS = 30_000;
const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";

export type ChatValidation =
  | { ok: true; payload: UpstreamPayload }
  | { ok: false; code: TrialErrorCode; status: number };

interface ValidatedMessage {
  role: string;
  content: string;
}

interface UpstreamPayload {
  model: string;
  messages: ValidatedMessage[];
  temperature: number;
  max_completion_tokens: number;
  response_format?: { type: "json_object" };
}

/** Extract the client IP from Cloudflare's connection info (never X-Forwarded-For). */
export function getClientIp(request: Request): string {
  // cf-connecting-ip is set by Cloudflare and cannot be spoofed by the client.
  return request.headers.get("cf-connecting-ip") || "";
}

/** Parse + validate the incoming chat request body. */
export async function validateChatRequest(
  request: Request,
  config: ParsedConfig,
): Promise<ChatValidation> {
  // Content-Length / body size guard.
  const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return { ok: false, code: "PAYLOAD_TOO_LARGE", status: 413 };
  }

  let raw: unknown;
  let rawText: string;
  try {
    rawText = await request.text();
  } catch {
    return { ok: false, code: "INVALID_REQUEST", status: 400 };
  }
  if (rawText.length > MAX_BODY_BYTES) {
    return { ok: false, code: "PAYLOAD_TOO_LARGE", status: 413 };
  }
  try {
    raw = JSON.parse(rawText);
  } catch {
    return { ok: false, code: "INVALID_REQUEST", status: 400 };
  }

  const body = raw as Record<string, unknown>;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, code: "INVALID_REQUEST", status: 400 };
  }

  // messages: required array
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, code: "INVALID_REQUEST", status: 400 };
  }
  if (messages.length > MAX_MESSAGES) {
    return { ok: false, code: "INVALID_REQUEST", status: 400 };
  }

  const validated: ValidatedMessage[] = [];
  let totalChars = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      return { ok: false, code: "INVALID_REQUEST", status: 400 };
    }
    const m = msg as Record<string, unknown>;
    const role = m.role;
    if (typeof role !== "string" || !ALLOWED_ROLES.has(role)) {
      return { ok: false, code: "INVALID_REQUEST", status: 400 };
    }
    // Text-only: content must be a string. Reject multimodal arrays.
    const content = m.content;
    if (typeof content !== "string") {
      return { ok: false, code: "INVALID_REQUEST", status: 400 };
    }
    if (content.length > MAX_MESSAGE_CHARS) {
      return { ok: false, code: "INVALID_REQUEST", status: 400 };
    }
    totalChars += content.length;
    if (totalChars > MAX_TOTAL_CHARS) {
      return { ok: false, code: "INVALID_REQUEST", status: 400 };
    }
    validated.push({ role, content });
  }

  // temperature: optional, bounded [0, 2]
  let temperature = 0.8;
  if (body.temperature !== undefined) {
    const t = body.temperature;
    if (typeof t !== "number" || Number.isNaN(t)) {
      return { ok: false, code: "INVALID_REQUEST", status: 400 };
    }
    temperature = Math.max(0, Math.min(2, t));
  }

  // maxTokens / max_tokens / max_completion_tokens: client may request less,
  // never more. Clamp to server ceiling.
  let requestedTokens = config.maxOutputTokens;
  for (const key of ["maxTokens", "max_tokens", "max_completion_tokens"]) {
    const v = body[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      requestedTokens = Math.min(requestedTokens, Math.floor(v));
    }
  }
  requestedTokens = Math.max(1, Math.min(requestedTokens, config.maxOutputTokens));

  // response_format: allow only { type: "json_object" }
  let responseFormat: { type: "json_object" } | undefined;
  if (body.response_format && typeof body.response_format === "object") {
    const rf = body.response_format as Record<string, unknown>;
    if (rf.type === "json_object") {
      responseFormat = { type: "json_object" };
    }
  }

  // Construct the upstream payload — server controls model + token ceiling.
  const payload: UpstreamPayload = {
    model: config.model,
    messages: validated,
    temperature,
    max_completion_tokens: requestedTokens,
    ...(responseFormat ? { response_format: responseFormat } : {}),
  };

  return { ok: true, payload };
}

/** Result of the upstream call. */
export type UpstreamResult =
  | { ok: true; response: Response }
  | { ok: false; code: TrialErrorCode; status: number; retryAfterSeconds?: number };

/**
 * Call Groq with the validated, server-constructed payload.
 * Handles timeout + error normalization. Never relays upstream diagnostic bodies.
 */
export async function callUpstream(
  env: TrialEnv,
  payload: UpstreamPayload,
): Promise<UpstreamResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const resp = await fetch(GROQ_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (resp.ok) {
      return { ok: true, response: resp };
    }

    // Sanitize upstream errors — never relay the upstream body.
    const code = resp.status === 429 ? "UPSTREAM_RATE_LIMITED" : "UPSTREAM_UNAVAILABLE";
    const retryAfter = resp.headers.get("retry-after");
    let retryAfterSeconds: number | undefined;
    if (retryAfter) {
      const n = parseInt(retryAfter, 10);
      if (Number.isFinite(n)) retryAfterSeconds = Math.min(120, n);
    }
    // Drain the body to free the connection, then discard.
    await resp.text().catch(() => {});
    return {
      ok: false,
      code,
      status: code === "UPSTREAM_RATE_LIMITED" ? 429 : 502,
      retryAfterSeconds,
    };
  } catch (e) {
    const err = e as { name?: string };
    if (err?.name === "AbortError") {
      return { ok: false, code: "UPSTREAM_TIMEOUT", status: 504 };
    }
    return { ok: false, code: "UPSTREAM_UNAVAILABLE", status: 502 };
  } finally {
    clearTimeout(timer);
  }
}
