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

const CACHE_TTL_MS = 30_000;
const MAX_CACHED_CONFIGURATIONS = 20;
const cache = new Map<string, OllamaHealthResult>();
const requests = new Map<string, { controller: AbortController; promise: Promise<OllamaHealthResult> }>();
let revision = 0;

function configurationKey(baseUrl: string, model: string): string {
  return JSON.stringify([baseUrl.trim().replace(/\/+$/, ""), model.trim()]);
}

/** Check one endpoint/model pair. Concurrent callers share only that pair's request. */
export async function checkOllamaHealth(
  baseUrl: string,
  model: string,
  forceRefresh = false,
): Promise<OllamaHealthResult> {
  const key = configurationKey(baseUrl, model);
  const cached = getCachedOllamaHealth(baseUrl, model);
  if (!forceRefresh && cached) return cached;
  const existing = requests.get(key);
  if (existing) return existing.promise;

  const requestRevision = revision;
  const controller = new AbortController();
  const selectedModel = model.trim();
  const url = baseUrl.trim().replace(/\/+$/, "") + "/models";
  const promise = (async (): Promise<OllamaHealthResult> => {
    // Keep the deadline active through response-body parsing as well as headers.
    const timeout = setTimeout(() => controller.abort(), 5000);
    let result: OllamaHealthResult;
    try {
      const res = await fetch(url, {
        method: "GET", signal: controller.signal,
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const data = await res.json();
      const models: string[] = Array.isArray(data?.data)
        ? data.data.map((entry: unknown) => {
            if (!entry || typeof entry !== "object") return null;
            const item = entry as { id?: unknown; name?: unknown };
            return typeof item.id === "string" ? item.id : typeof item.name === "string" ? item.name : null;
          }).filter((name: string | null): name is string => !!name)
        : [];
      // Untagged Ollama names mean :latest, never an arbitrary installed tag.
      const canonical = (name: string) => name.includes(":") ? name : `${name}:latest`;
      const modelAvailable = !!selectedModel && models.some((name) => canonical(name) === canonical(selectedModel));
      result = {
        state: modelAvailable ? "ready" : "model_unavailable", models,
        checkedAt: Date.now(),
        error: modelAvailable ? undefined : `Model "${selectedModel}" not found. Available: ${models.slice(0, 5).join(", ") || "none"}`,
      };
    } catch (error: unknown) {
      result = {
        state: "endpoint_unreachable", models: [], checkedAt: Date.now(),
        error: controller.signal.aborted ? "Connection timeout or cancelled check"
          : error instanceof Error ? error.message : "Cannot reach Ollama endpoint",
      };
    } finally {
      clearTimeout(timeout);
    }
    // Invalidation is sticky: even a transport that ignores abort cannot refill
    // the cache, or remove a newer request for the same configuration.
    if (revision === requestRevision && !controller.signal.aborted) {
      cache.delete(key);
      cache.set(key, result);
      if (cache.size > MAX_CACHED_CONFIGURATIONS) cache.delete(cache.keys().next().value!);
    }
    return result;
  })();
  const request = { controller, promise };
  requests.set(key, request);
  try {
    return await promise;
  } finally {
    if (requests.get(key) === request) requests.delete(key);
  }
}

/** Fresh evidence for this exact configuration; never another model's result. */
export function getCachedOllamaHealth(baseUrl: string, model: string): OllamaHealthResult | null {
  const key = configurationKey(baseUrl, model);
  const result = cache.get(key);
  if (!result) return null;
  if (Date.now() - result.checkedAt >= CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return result;
}

/** Invalidate completed and pending evidence after a settings change. */
export function invalidateOllamaHealthCache(): void {
  revision++;
  cache.clear();
  for (const request of requests.values()) request.controller.abort();
  requests.clear();
}
