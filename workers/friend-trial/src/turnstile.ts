/**
 * Cloudflare Turnstile server-side siteverify.
 *
 * Never trust client-side success alone. The token is validated through
 * Cloudflare's official siteverify flow. Tokens are short-lived and
 * single-use.
 *
 * Docs: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */
import type { TrialEnv } from "./types";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileResult {
  success: boolean;
}

/**
 * Validate a Turnstile token server-side. Returns `{ success: false }` on any
 * failure — never throws, never leaks diagnostic detail to the client.
 */
export async function verifyTurnstile(
  env: TrialEnv,
  token: string,
  clientIp: string,
): Promise<TurnstileResult> {
  if (!token || typeof token !== "string") return { success: false };

  const params = new URLSearchParams();
  params.set("secret", env.TURNSTILE_SECRET_KEY);
  params.set("response", token);
  if (clientIp) params.set("remoteip", clientIp);

  try {
    const resp = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!resp.ok) return { success: false };
    const data = (await resp.json()) as {
      success?: boolean;
      "error-codes"?: string[];
      hostname?: string;
    };
    if (!data.success) return { success: false };

    // Optional hostname verification (defense-in-depth against token reuse
    // from a different widget/domain).
    if (env.TURNSTILE_EXPECTED_HOSTNAME) {
      const expected = env.TURNSTILE_EXPECTED_HOSTNAME.trim().toLowerCase();
      const got = (data.hostname ?? "").trim().toLowerCase();
      if (expected && got && got !== expected) return { success: false };
    }

    return { success: true };
  } catch {
    return { success: false };
  }
}
