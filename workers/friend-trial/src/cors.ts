/**
 * Centralized CORS handling. CORS is enforced strictly but is NEVER treated as
 * the primary security boundary — a valid trial session + all server-side
 * controls are still required even when CORS passes.
 *
 * Rules:
 *  - Exact origin match against the allowlist (no wildcards in production).
 *  - Reject unknown / malformed / missing origins for trial endpoints.
 *  - Emit `Vary: Origin` so caches don't leak cross-origin.
 *  - Never use `Access-Control-Allow-Origin: *` for trial endpoints.
 */
import type { ParsedConfig } from "./config";

/** Returns the exact allowed origin if the request origin is permitted, else null. */
export function checkOrigin(request: Request, config: ParsedConfig): string | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null; // reject missing origin for browser endpoints
  // Exact match only — no substring, no wildcard.
  if (config.allowedOrigins.includes(origin)) return origin;
  return null;
}

/** Build CORS headers for a validated origin. */
export function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Expose-Headers": [
      "X-MADchatter-Trial-Used",
      "X-MADchatter-Trial-Remaining",
      "X-MADchatter-Trial-Limit",
      "X-MADchatter-Trial-Reset-At",
    ].join(", "),
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

/** Handle OPTIONS preflight. Returns null if not a preflight request. */
export function handlePreflight(request: Request, config: ParsedConfig): Response | null {
  if (request.method !== "OPTIONS") return null;
  const origin = checkOrigin(request, config);
  if (!origin) {
    return new Response(null, {
      status: 403,
      headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" },
    });
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin),
      "Content-Length": "0",
    },
  });
}

/** Apply CORS + security headers to an existing response. */
export function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) {
    headers.set(k, v);
  }
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
