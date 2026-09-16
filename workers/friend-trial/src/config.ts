/**
 * Configuration parsing + validation. Fails closed for any security-sensitive
 * missing/invalid setting — the trial becomes unavailable rather than
 * silently falling back to permissive defaults.
 */
import type { TrialEnv, TrialVars } from "./types";

export interface ParsedConfig {
  enabled: boolean;
  endsAt: number | null; // epoch ms; null = no expiry configured (fails closed in prod)
  endsAtIso: string | null;
  model: string;
  /** Optional vision-capable model id; empty when vision is not configured. */
  visionModel: string;
  maxOutputTokens: number;
  sessionTtlSeconds: number;
  requireInvite: boolean;
  allowedOrigins: string[];
  turnstileSiteKey: string;
  turnstileExpectedHostname: string | null;
}

export interface ConfigValidation {
  config: ParsedConfig | null;
  /** When null, config is fully valid. Otherwise a fail-closed reason code. */
  reason: "ENDED" | "DISABLED" | "MISCONFIGURED" | null;
  /** True when the trial is operationally available right now. */
  available: boolean;
}

function parseBool(v: string | undefined): boolean {
  return (v ?? "").trim().toLowerCase() === "true";
}

function parseOrigins(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse + validate the trial configuration from env bindings.
 *
 * Fail-closed rules:
 *  - TRIAL_ENABLED != "true" → disabled
 *  - TRIAL_END_AT missing/invalid → unavailable (no unlimited trial)
 *  - TRIAL_END_AT in the past → expired
 *  - TRIAL_MODEL missing → unavailable
 *  - ALLOWED_ORIGINS empty → unavailable (never fall back to "*")
 *  - GROQ_API_KEY missing → unavailable (inference cannot function)
 *  - TRIAL_SESSION_SECRET missing → unavailable (sessions cannot be signed)
 */
export function parseConfig(env: TrialEnv): ConfigValidation {
  const enabled = parseBool(env.TRIAL_ENABLED);

  // Parse expiration — fail closed on missing/invalid.
  let endsAt: number | null = null;
  let endsAtIso: string | null = null;
  if (env.TRIAL_END_AT) {
    const parsed = Date.parse(env.TRIAL_END_AT);
    if (Number.isNaN(parsed)) {
      return { config: null, reason: "MISCONFIGURED", available: false };
    }
    endsAt = parsed;
    endsAtIso = env.TRIAL_END_AT;
  } else {
    // No expiry configured → fail closed (never an unlimited trial).
    return { config: null, reason: "MISCONFIGURED", available: false };
  }

  const now = Date.now();
  const expired = endsAt !== null && now >= endsAt;

  const model = (env.TRIAL_MODEL ?? "").trim();
  const visionModel = (env.TRIAL_VISION_MODEL ?? "").trim();
  const allowedOrigins = parseOrigins(env.ALLOWED_ORIGINS);

  // Security-sensitive missing settings → unavailable.
  const misconfigured =
    !model ||
    allowedOrigins.length === 0 ||
    !env.GROQ_API_KEY ||
    !env.TRIAL_SESSION_SECRET ||
    !env.TURNSTILE_SECRET_KEY;

  const config: ParsedConfig = {
    enabled,
    endsAt,
    endsAtIso,
    model,
    visionModel,
    maxOutputTokens: parseMaxTokens(env.TRIAL_MAX_OUTPUT_TOKENS),
    sessionTtlSeconds: parseTtl(env.TRIAL_SESSION_TTL_SECONDS),
    requireInvite: parseBool(env.TRIAL_REQUIRE_INVITE),
    allowedOrigins,
    turnstileSiteKey: (env.TURNSTILE_SITE_KEY ?? "").trim(),
    turnstileExpectedHostname: (env.TURNSTILE_EXPECTED_HOSTNAME ?? "").trim() || null,
  };

  if (!enabled) return { config, reason: "DISABLED", available: false };
  if (expired) return { config, reason: "ENDED", available: false };
  if (misconfigured) return { config, reason: "MISCONFIGURED", available: false };

  return { config, reason: null, available: true };
}

function parseMaxTokens(v: string | undefined): number {
  const n = parseInt((v ?? "").trim(), 10);
  if (!Number.isFinite(n) || n < 1) return 2048;
  return Math.min(n, 8192);
}

function parseTtl(v: string | undefined): number {
  const n = parseInt((v ?? "").trim(), 10);
  if (!Number.isFinite(n) || n < 60) return 3 * 60 * 60; // 3 hours default
  return Math.min(n, 24 * 60 * 60); // cap at 24h
}

/** Build the public status response body from parsed config. */
export function buildStatusBody(c: ParsedConfig, available: boolean, reason: string | null) {
  return {
    ok: true as const,
    trial: {
      enabled: available ? true : false,
      ...(reason ? { reason } : {}),
      ...(c.endsAtIso ? { endsAt: c.endsAtIso } : {}),
      requiresTurnstile: true,
      requiresInviteCode: c.requireInvite,
      ...(c.model && available ? { modelLabel: c.model } : {}),
      ...(c.visionModel && available ? { supportsVision: true, visionModelLabel: c.visionModel } : {}),
    },
  };
}
