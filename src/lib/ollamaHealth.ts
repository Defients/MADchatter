/**
 * Ollama health check — lightweight endpoint/model reachability verification.
 *
 * Distinguishes between:
 * - "Configured" (base URL + model set, but not verified)
 * - "Connecting" (health check in flight)
 * - "Ready" (endpoint reachable + model available)
 * - "Model unavailable" (endpoint reachable but model not found)
 * - "Endpoint unreachable" (cannot connect to Ollama server)
 */

export type OllamaHealthState =
  | "configured"
  | "connecting"
  | "ready"
  | "model_unavailable"
  | "endpoint_unreachable";

export interface OllamaHealthResult {
  state: OllamaHealthState;
  models: string[];
  checkedAt: number;
  error?: string;
}

let cachedResult: OllamaHealthResult | null = null;
let inFlight: Promise<OllamaHealthResult> | null = null;
const CACHE_TTL_MS = 30_000; // Cache for 30s to avoid polling overhead.

/**
 * Check Ollama endpoint reachability and model availability.
 * Uses the OpenAI-compatible `/v1/models` endpoint (lightweight, no inference).
 * Results are cached for 30 seconds.
 */
export async function checkOllamaHealth(
  baseUrl: string,
  model: string,
  forceRefresh = false,
): Promise<OllamaHealthResult> {
  // Return cached result if fresh.
  if (!forceRefresh && cachedResult && Date.now() - cachedResult.checkedAt < CACHE_TTL_MS) {
    return cachedResult;
  }

  // Dedup concurrent checks.
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<OllamaHealthResult> => {
    const checkedAt = Date.now();
    const url = baseUrl.replace(/\/+$/, "") + "/models";

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const result: OllamaHealthResult = {
          state: "endpoint_unreachable",
          models: [],
          checkedAt,
          error: `HTTP ${res.status} ${res.statusText}`,
        };
        cachedResult = result;
        return result;
      }

      const data = await res.json();
      const models: string[] = Array.isArray(data?.data)
        ? data.data.map((m: any) => m.id || m.name).filter(Boolean)
        : [];

      const modelAvailable = models.some(
        (m) => m === model || m.startsWith(model + ":") || model.startsWith(m + ":"),
      );

      const result: OllamaHealthResult = {
        state: modelAvailable ? "ready" : "model_unavailable",
        models,
        checkedAt,
        error: modelAvailable ? undefined : `Model "${model}" not found. Available: ${models.slice(0, 5).join(", ") || "none"}`,
      };
      cachedResult = result;
      return result;
    } catch (e: any) {
      const result: OllamaHealthResult = {
        state: "endpoint_unreachable",
        models: [],
        checkedAt,
        error: e?.name === "AbortError" ? "Connection timeout (5s)" : (e?.message || "Cannot reach Ollama endpoint"),
      };
      cachedResult = result;
      return result;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Get the cached health result without making a new request. */
export function getCachedOllamaHealth(): OllamaHealthResult | null {
  return cachedResult;
}

/** Invalidate the cache (e.g. when the user changes the endpoint/model). */
export function invalidateOllamaHealthCache(): void {
  cachedResult = null;
}
