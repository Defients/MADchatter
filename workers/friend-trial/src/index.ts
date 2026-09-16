/**
 * Friend Trial Worker — main entry point.
 *
 * Routes:
 *   GET  /trial/status   — public, non-sensitive trial availability
 *   POST /trial/session   — Turnstile (+ optional invite) → signed session
 *   POST /trial/chat       — validated, rate-limited inference via Groq
 *
 * Security model:
 *   - GROQ_API_KEY exists only as a Worker secret; never in frontend/config/logs.
 *   - The Worker constructs the upstream payload entirely server-side.
 *   - CORS is strict but never the primary boundary (session + rate limits apply).
 *   - Turnstile is validated server-side through Cloudflare's siteverify.
 *   - Stateless HMAC-signed session tokens (Web Crypto); no database needed.
 *   - Fail-closed on missing/invalid security-sensitive configuration.
 */
import { parseConfig, buildStatusBody, type ParsedConfig } from "./config";
import { checkOrigin, handlePreflight, withCors } from "./cors";
import { errorResponse } from "./errors";
import {
  createSessionToken,
  verifySessionToken,
  sessionHashPrefix,
} from "./session";
import { verifyTurnstile } from "./turnstile";
import { callUpstream, getClientIp, validateChatRequest } from "./chat";
import type { TrialEnv, TrialStatusResponse, TrialSessionResponse } from "./types";

export default {
  async fetch(request: Request, env: TrialEnv): Promise<Response> {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);

    // Parse + validate configuration once per request.
    const { config, reason, available } = parseConfig(env);

    // Preflight handling (CORS). Even a disabled trial answers preflight so
    // the browser gets a clean 403 instead of a CORS error masking the real
    // status. If config is null (misconfigured), reject all.
    if (config) {
      const preflight = handlePreflight(request, config);
      if (preflight) return preflight;
    }

    // Route dispatch.
    if (url.pathname === "/trial/status" && request.method === "GET") {
      return handleStatus(request, config, reason, available, requestId);
    }
    if (url.pathname === "/trial/session" && request.method === "POST") {
      return handleSession(request, env, config, available, reason, requestId);
    }
    if (url.pathname === "/trial/chat" && request.method === "POST") {
      return handleChat(request, env, config, available, reason, requestId);
    }

    return errorResponse("INVALID_REQUEST", 404);
  },
} satisfies ExportedHandler<TrialEnv>;

function hashPrefix(s: string): string {
  return s.slice(0, 6);
}

// ── GET /trial/status ────────────────────────────────────────────────────────
function handleStatus(
  request: Request,
  config: ParsedConfig | null,
  reason: string | null,
  available: boolean,
  requestId: string,
): Response {
  // Status is public and non-sensitive. Return the body regardless of origin;
  // only attach CORS headers for validated origins so a browser on an unknown
  // origin cannot read it cross-origin (but the body truthfully reports
  // availability). This never exposes secrets — status is product availability.
  const origin = config ? checkOrigin(request, config) : null;

  const body: TrialStatusResponse = config
    ? (buildStatusBody(config, available, reason) as TrialStatusResponse)
    : {
        ok: true,
        trial: { enabled: false, reason: "MISCONFIGURED", endsAt: null, requiresTurnstile: true, requiresInviteCode: false },
      };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=30",
    "X-Content-Type-Options": "nosniff",
    "X-Request-ID": requestId,
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return new Response(JSON.stringify(body), { status: 200, headers });
}

// ── POST /trial/session ───────────────────────────────────────────────────────
async function handleSession(
  request: Request,
  env: TrialEnv,
  config: ParsedConfig | null,
  available: boolean,
  reason: string | null,
  requestId: string,
): Promise<Response> {
  // Fail closed.
  if (!config) return errorResponse("TRIAL_DISABLED", 503);
  const origin = checkOrigin(request, config);
  if (!origin) return withCors(errorResponse("ORIGIN_FORBIDDEN", 403), request.headers.get("Origin") || "");

  if (!available) {
    const code = reason === "ENDED" ? "TRIAL_EXPIRED" : "TRIAL_DISABLED";
    return withCors(errorResponse(code, 403, { origin }), origin);
  }

  // Rate limit: session bootstrap per IP.
  const clientIp = getClientIp(request);
  const ipKey = clientIp || "unknown";
  const bootstrap = await env.TRIAL_SESSION_BOOTSTRAP.limit({ key: `bootstrap:${ipKey}` });
  if (!bootstrap.success) {
    return withCors(errorResponse("RATE_LIMITED", 429, { origin, retryAfterSeconds: 60 }), origin);
  }

  // Parse body.
  let body: { turnstileToken?: string; inviteCode?: string };
  try {
    const raw = await request.text();
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return withCors(errorResponse("INVALID_REQUEST", 400, { origin }), origin);
  }
  if (!body || typeof body !== "object") {
    return withCors(errorResponse("INVALID_REQUEST", 400, { origin }), origin);
  }

  // Turnstile validation (server-side).
  const turnstileToken = body.turnstileToken;
  if (!turnstileToken || typeof turnstileToken !== "string") {
    return withCors(errorResponse("TURNSTILE_REQUIRED", 401, { origin }), origin);
  }
  const turnstile = await verifyTurnstile(env, turnstileToken, clientIp);
  if (!turnstile.success) {
    return withCors(errorResponse("TURNSTILE_FAILED", 403, { origin }), origin);
  }

  // Optional invite gate.
  if (config.requireInvite) {
    const expected = env.TRIAL_INVITE_CODE;
    const provided = typeof body.inviteCode === "string" ? body.inviteCode.trim() : "";
    if (!expected || !provided || provided !== expected.trim()) {
      return withCors(errorResponse("INVITE_INVALID", 403, { origin }), origin);
    }
  }

  // Create signed session token.
  const { token, expiresAt } = await createSessionToken(env.TRIAL_SESSION_SECRET, config.sessionTtlSeconds);
  const resBody: TrialSessionResponse = { ok: true, session: { token, expiresAt: Math.floor(expiresAt / 1000) } };
  console.log(JSON.stringify({
    requestId, route: "trial/session", status: 200, ipHash: hashPrefix(ipKey),
  }));
  return withCors(new Response(JSON.stringify(resBody), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Request-ID": requestId },
  }), origin);
}

// ── POST /trial/chat ──────────────────────────────────────────────────────────
async function handleChat(
  request: Request,
  env: TrialEnv,
  config: ParsedConfig | null,
  available: boolean,
  reason: string | null,
  requestId: string,
): Promise<Response> {
  if (!config) return errorResponse("TRIAL_DISABLED", 503);
  const origin = checkOrigin(request, config);
  if (!origin) return withCors(errorResponse("ORIGIN_FORBIDDEN", 403), request.headers.get("Origin") || "");

  if (!available) {
    const code = reason === "ENDED" ? "TRIAL_EXPIRED" : "TRIAL_DISABLED";
    return withCors(errorResponse(code, 403, { origin }), origin);
  }

  // Session verification (Authorization: Bearer <token>).
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const session = await verifySessionToken(env.TRIAL_SESSION_SECRET, token);
  if (!session.ok) {
    return withCors(errorResponse(session.code, 401, { origin }), origin);
  }
  const sid = sessionHashPrefix(session.payload);

  // Rate limit: per-session + per-IP.
  const clientIp = getClientIp(request);
  const ipKey = clientIp || "unknown";
  const [sessionRl, ipRl] = await Promise.all([
    env.TRIAL_INFERENCE_SESSION.limit({ key: `inference:sid:${session.payload.sid}` }),
    env.TRIAL_INFERENCE_IP.limit({ key: `inference:ip:${ipKey}` }),
  ]);
  if (!sessionRl.success || !ipRl.success) {
    return withCors(errorResponse("RATE_LIMITED", 429, { origin, retryAfterSeconds: 60 }), origin);
  }

  // Validate + construct upstream payload.
  const validation = await validateChatRequest(request, config);
  if (!validation.ok) {
    return withCors(errorResponse(validation.code, validation.status, { origin }), origin);
  }

  // Call upstream Groq.
  const upstream = await callUpstream(env, validation.payload);
  if (!upstream.ok) {
    console.log(JSON.stringify({
      requestId, route: "trial/chat", status: upstream.status, sid,
      error: upstream.code, ipHash: hashPrefix(ipKey),
    }));
    return withCors(
      errorResponse(upstream.code, upstream.status, { origin, retryAfterSeconds: upstream.retryAfterSeconds }),
      origin,
    );
  }

  // Pass the OpenAI-compatible response body through. Sanitize headers so no
  // upstream auth/diagnostic material leaks.
  const upstreamBody = await upstream.response.text();
  console.log(JSON.stringify({
    requestId, route: "trial/chat", status: 200, sid, ipHash: hashPrefix(ipKey),
  }));
  return withCors(new Response(upstreamBody, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Request-ID": requestId,
    },
  }), origin);
}
