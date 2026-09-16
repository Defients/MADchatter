/**
 * Shared types for the Friend Trial Worker.
 *
 * The Env interface describes every binding the Worker expects. Secrets are
 * declared here as `string` so TypeScript knows their shape; their VALUES are
 * injected exclusively via `wrangler secret put` (production) or `.dev.vars`
 * (local) and never appear in source, config, or build output.
 */

/** Worker secrets — injected via `wrangler secret put`, never in `vars`. */
export interface TrialSecrets {
  /** Groq API key. The only place this credential exists. */
  GROQ_API_KEY: string;
  /** Turnstile server-side siteverify secret. */
  TURNSTILE_SECRET_KEY: string;
  /** HMAC secret used to sign/verify stateless trial session tokens. */
  TRIAL_SESSION_SECRET: string;
  /** Optional invite code (only required when TRIAL_REQUIRE_INVITE=true). */
  TRIAL_INVITE_CODE?: string;
}

/** Public, non-secret configuration — declared in `vars` in wrangler.jsonc. */
export interface TrialVars {
  /** Kill switch. "true" enables trial; anything else disables. */
  TRIAL_ENABLED: string;
  /** ISO-8601 instant after which trial creation + inference fail closed. */
  TRIAL_END_AT: string;
  /** Server-controlled Groq model id (e.g. "llama-3.3-70b-versatile"). */
  TRIAL_MODEL: string;
  /** Hard ceiling on completion tokens the Worker will forward upstream. */
  TRIAL_MAX_OUTPUT_TOKENS: string;
  /** Trial session lifetime in seconds. */
  TRIAL_SESSION_TTL_SECONDS: string;
  /** "true" requires an invite code during session creation. */
  TRIAL_REQUIRE_INVITE: string;
  /** Comma-separated exact origin allowlist (no wildcards in production). */
  ALLOWED_ORIGINS: string;
  /** Public Turnstile site key (safe to expose to browsers). */
  TURNSTILE_SITE_KEY: string;
  /** Optional: expected Turnstile hostname (cf-turnstile-response hostname). */
  TURNSTILE_EXPECTED_HOSTNAME: string;
}

/** Rate-limiting bindings (native Cloudflare RateLimit). */
export interface TrialRateLimits {
  /** Session bootstrap throttle — keyed by IP. */
  TRIAL_SESSION_BOOTSTRAP: RateLimit;
  /** Inference throttle — keyed by session id. */
  TRIAL_INFERENCE_SESSION: RateLimit;
  /** Inference throttle — keyed by IP. */
  TRIAL_INFERENCE_IP: RateLimit;
}

export interface TrialEnv extends TrialSecrets, TrialVars, TrialRateLimits {}

/** Stable, user-facing error codes. Never relay upstream diagnostics. */
export type TrialErrorCode =
  | "TRIAL_DISABLED"
  | "TRIAL_EXPIRED"
  | "ORIGIN_FORBIDDEN"
  | "INVALID_SESSION"
  | "SESSION_EXPIRED"
  | "TURNSTILE_REQUIRED"
  | "TURNSTILE_FAILED"
  | "INVITE_INVALID"
  | "RATE_LIMITED"
  | "INVALID_REQUEST"
  | "PAYLOAD_TOO_LARGE"
  | "UPSTREAM_RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_TIMEOUT"
  | "INTERNAL_ERROR";

export interface TrialErrorBody {
  ok: false;
  error: {
    code: TrialErrorCode;
    message: string;
    retryAfterSeconds?: number;
  };
}

/** Public status response (GET /trial/status). */
export interface TrialStatusResponse {
  ok: true;
  trial: {
    enabled: boolean;
    /** User-safe reason when disabled (e.g. "ENDED", "DISABLED", "MISCONFIGURED"). */
    reason?: string;
    endsAt: string | null;
    requiresTurnstile: boolean;
    requiresInviteCode: boolean;
    /** Optional user-facing model/provider label. */
    modelLabel?: string;
  };
}

/** Session creation response (POST /trial/session). */
export interface TrialSessionResponse {
  ok: true;
  session: {
    token: string;
    expiresAt: number;
  };
}

/** Parsed + validated session payload. */
export interface SessionPayload {
  v: number;
  sid: string;
  iat: number;
  exp: number;
}
