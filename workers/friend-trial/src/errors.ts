/**
 * Sanitized error responses. Never relay upstream diagnostic bodies, stack
 * traces, secrets, or internal identifiers to clients.
 */
import type { TrialErrorBody, TrialErrorCode } from "./types";

const SAFE_MESSAGES: Record<TrialErrorCode, string> = {
  TRIAL_DISABLED: "Friend Trial is currently unavailable.",
  TRIAL_EXPIRED: "Friend Trial has ended. Add your own API key to continue.",
  ORIGIN_FORBIDDEN: "Request not permitted from this origin.",
  INVALID_SESSION: "Trial session is missing or invalid. Please restart Friend Trial.",
  SESSION_EXPIRED: "Trial session expired. Please reactivate Friend Trial.",
  TURNSTILE_REQUIRED: "Human verification is required to start Friend Trial.",
  TURNSTILE_FAILED: "Human verification failed. Please try again.",
  INVITE_INVALID: "The invite code is not valid.",
  RATE_LIMITED: "Too many requests. Please slow down and try again shortly.",
  INVALID_REQUEST: "The request could not be processed.",
  PAYLOAD_TOO_LARGE: "The request payload is too large.",
  UPSTREAM_RATE_LIMITED: "Friend Trial is temporarily busy. Try again shortly.",
  UPSTREAM_UNAVAILABLE: "Friend Trial is temporarily unavailable. Try again shortly.",
  UPSTREAM_TIMEOUT: "Friend Trial took too long to respond. Try again shortly.",
  INTERNAL_ERROR: "An unexpected error occurred. Please try again.",
};

export function errorResponse(
  code: TrialErrorCode,
  status: number,
  opts?: { retryAfterSeconds?: number; origin?: string | null },
): Response {
  const body: TrialErrorBody = {
    ok: false,
    error: {
      code,
      message: SAFE_MESSAGES[code],
      ...(opts?.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: opts.retryAfterSeconds }
        : {}),
    },
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (opts?.origin) {
    headers["Access-Control-Allow-Origin"] = opts.origin;
    headers["Vary"] = "Origin";
  }
  if (opts?.retryAfterSeconds !== undefined) {
    headers["Retry-After"] = String(Math.max(1, Math.round(opts.retryAfterSeconds)));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

/** Map an upstream HTTP status to a stable client-facing code. */
export function upstreamStatusToCode(status: number): TrialErrorCode {
  if (status === 429) return "UPSTREAM_RATE_LIMITED";
  if (status === 401 || status === 403) return "UPSTREAM_UNAVAILABLE";
  if (status >= 500) return "UPSTREAM_UNAVAILABLE";
  return "UPSTREAM_UNAVAILABLE";
}
