/**
 * Friend Trial Worker — main entry point.
 *
 * Routes:
 *   GET  /trial/status   — public, non-sensitive trial availability
 *   POST /trial/session   — Turnstile (+ optional invite) → signed session
 *   GET  /trial/usage     — authenticated authoritative mobile allowance
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
  classifyTrialClient,
  deriveQuotaId,
  verifySessionToken,
  sessionHashPrefix,
} from "./session";
import { verifyTurnstile } from "./turnstile";
import { callUpstream, getClientIp, validateChatRequest } from "./chat";
import { TRIAL_TEXT_COST, TRIAL_VISION_COST } from "./quota";
import type { TrialEnv, TrialStatusResponse, TrialSessionResponse, TrialUsage, TrialUsageResponse } from "./types";

export { TrialUsageDurableObject } from "./usageDurableObject";

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
    if (url.pathname === "/trial/usage" && request.method === "GET") {
      return handleUsage(request, env, config, requestId);
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
  let body: { turnstileToken?: string; inviteCode?: string; clientId?: string };
  try {
    const raw = await request.text();
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return withCors(errorResponse("INVALID_REQUEST", 400, { origin }), origin);
  }
  if (!body || typeof body !== "object") {
    return withCors(errorResponse("INVALID_REQUEST", 400, { origin }), origin);
  }
  const clientId = typeof body.clientId === "string" ? body.clientId.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(clientId)) {
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
  const qid = await deriveQuotaId(env.TRIAL_SESSION_SECRET, clientId);
  const clientClass = classifyTrialClient(request.headers.get("User-Agent"));
  const { token, expiresAt } = await createSessionToken(
    env.TRIAL_SESSION_SECRET,
    config.sessionTtlSeconds,
    { qid, clientClass },
  );
  const resBody: TrialSessionResponse = { ok: true, session: { token, expiresAt: Math.floor(expiresAt / 1000) } };
  console.log(JSON.stringify({
    requestId, route: "trial/session", status: 200, ipHash: hashPrefix(ipKey), clientClass,
  }));
  return withCors(new Response(JSON.stringify(resBody), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Request-ID": requestId },
  }), origin);
}

// ── GET /trial/usage ────────────────────────────────────────────────────────
async function handleUsage(
  request: Request,
  env: TrialEnv,
  config: ParsedConfig | null,
  requestId: string,
): Promise<Response> {
  if (!config) return errorResponse("TRIAL_DISABLED", 503);
  const origin = checkOrigin(request, config);
  if (!origin) return withCors(errorResponse("ORIGIN_FORBIDDEN", 403), request.headers.get("Origin") || "");
  const session = await verifyBearerSession(request, env);
  if (!session.ok) return withCors(errorResponse(session.code, 401, { origin }), origin);

  let body: TrialUsageResponse;
  if (session.payload.clientClass !== "mobile") {
    body = { ok: true, limited: false, usage: null };
  } else {
    try {
      body = {
        ok: true,
        limited: true,
        usage: await getUsage(env, session.payload.qid, config.mobileDailyLimit),
      };
    } catch (error) {
      console.error(JSON.stringify({ requestId, route: "trial/usage", error: safeError(error) }));
      return withCors(errorResponse("INTERNAL_ERROR", 503, { origin }), origin);
    }
  }
  return withCors(Response.json(body, {
    headers: { "Cache-Control": "no-store", "X-Request-ID": requestId },
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
  const session = await verifyBearerSession(request, env);
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

  let reservation: { reservationId: string; usage: TrialUsage } | null = null;
  if (session.payload.clientClass === "mobile") {
    const cost = validation.hasImage ? TRIAL_VISION_COST : TRIAL_TEXT_COST;
    try {
      const reserved = await reserveUsage(env, session.payload.qid, cost, config.mobileDailyLimit);
      if (!reserved.allowed || !reserved.reservationId) {
        const retryAfterSeconds = Math.max(1, Math.ceil((Date.parse(reserved.usage.resetAt) - Date.now()) / 1000));
        return withCors(errorResponse("TRIAL_DAILY_LIMIT_REACHED", 429, {
          origin,
          retryAfterSeconds,
          usage: reserved.usage,
        }), origin);
      }
      reservation = { reservationId: reserved.reservationId, usage: reserved.usage };
    } catch (error) {
      console.error(JSON.stringify({ requestId, route: "trial/chat", error: safeError(error), stage: "reserve" }));
      return withCors(errorResponse("INTERNAL_ERROR", 503, { origin }), origin);
    }
  }

  // Call upstream Groq.
  const upstream = await callUpstream(env, validation.payload);
  if (!upstream.ok) {
    if (reservation) {
      try {
        await finishUsage(env, session.payload.qid, reservation.reservationId, config.mobileDailyLimit, true);
      } catch (error) {
        console.error(JSON.stringify({ requestId, route: "trial/chat", error: safeError(error), stage: "refund" }));
      }
    }
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
  let finalUsage = reservation?.usage ?? null;
  if (reservation) {
    try {
      finalUsage = await finishUsage(
        env,
        session.payload.qid,
        reservation.reservationId,
        config.mobileDailyLimit,
        false,
      );
    } catch (error) {
      // Reservation already counted the successful inference. A commit only
      // clears its refund lease; preserve the successful OpenAI response and
      // use the authoritative reservation result in the headers.
      console.error(JSON.stringify({ requestId, route: "trial/chat", error: safeError(error), stage: "commit" }));
    }
  }
  console.log(JSON.stringify({
    requestId, route: "trial/chat", status: 200, sid, ipHash: hashPrefix(ipKey),
  }));
  return withCors(new Response(upstreamBody, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Request-ID": requestId,
      ...(finalUsage ? usageHeaders(finalUsage) : {}),
    },
  }), origin);
}

type VerifiedSession = Awaited<ReturnType<typeof verifySessionToken>>;

async function verifyBearerSession(request: Request, env: TrialEnv): Promise<VerifiedSession> {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  return verifySessionToken(env.TRIAL_SESSION_SECRET, token);
}

function usageStub(env: TrialEnv, qid: string): DurableObjectStub {
  const id = env.TRIAL_USAGE.idFromName(qid);
  return env.TRIAL_USAGE.get(id);
}

async function durableJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`usage store returned ${response.status}`);
  return response.json<T>();
}

async function getUsage(env: TrialEnv, qid: string, limit: number): Promise<TrialUsage> {
  const response = await usageStub(env, qid).fetch(`https://trial-usage/usage?limit=${limit}`);
  return (await durableJson<{ ok: true; usage: TrialUsage }>(response)).usage;
}

async function reserveUsage(env: TrialEnv, qid: string, cost: number, limit: number) {
  const response = await usageStub(env, qid).fetch("https://trial-usage/reserve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cost, limit }),
  });
  return durableJson<{ allowed: boolean; reservationId?: string; usage: TrialUsage }>(response);
}

async function finishUsage(
  env: TrialEnv,
  qid: string,
  reservationId: string,
  limit: number,
  refund: boolean,
): Promise<TrialUsage> {
  const response = await usageStub(env, qid).fetch(`https://trial-usage/${refund ? "refund" : "commit"}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reservationId, limit }),
  });
  return (await durableJson<{ ok: true; usage: TrialUsage }>(response)).usage;
}

function usageHeaders(usage: TrialUsage): Record<string, string> {
  return {
    "X-MADchatter-Trial-Used": String(usage.used),
    "X-MADchatter-Trial-Remaining": String(usage.remaining),
    "X-MADchatter-Trial-Limit": String(usage.limit),
    "X-MADchatter-Trial-Reset-At": usage.resetAt,
  };
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
