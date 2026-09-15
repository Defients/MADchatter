/**
 * Generic OpenAI-compatible provider client utilities.
 *
 * These helpers operate on a raw { baseUrl, apiKey, model } config — they do
 * NOT read from the persisted ApiKeys store — so the Settings UI can probe an
 * endpoint the user is still typing in, before anything is saved. The same
 * helpers are reused by future provider presets (Groq, Cerebras, Together…)
 * since they all speak the OpenAI schema.
 *
 * Only plain `fetch` is used (no SDK) so these work before any provider is
 * selected and never pull in node-only SDK code. All network errors are
 * normalized into short, user-facing messages; API keys are never logged.
 */

/** Minimal config for probing an OpenAI-compatible endpoint. */
export interface CustomProviderConfig {
  baseUrl: string;
  apiKey?: string;
  model?: string;
}

export interface ModelFetchResult {
  ok: boolean;
  models: string[];
  /** Short user-facing message on failure; empty on success. */
  message: string;
}

export type ConnectionStatus =
  | "connected"
  | "auth_failed"
  | "model_not_found"
  | "endpoint_unreachable"
  | "invalid_url"
  | "timed_out"
  | "not_openai_compatible";

export interface ConnectionTestResult {
  ok: boolean;
  status: ConnectionStatus;
  /** Short user-facing message. */
  message: string;
  /** Whether /models was reachable (used to decide manual-entry fallback). */
  modelsReachable: boolean;
  /** Models discovered during the test, if any. */
  models: string[];
}

const TEST_TIMEOUT_MS = 20_000;

/** Normalize a base URL: trim whitespace + trailing slashes. Does NOT
 *  force a `/v1` suffix — some endpoints use a different path layout and
 *  the user is the authority on that. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/** Build the /models URL, tolerating base URLs with or without /v1. */
function modelsUrl(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  // If the user already ended with /models, don't double up.
  if (base.endsWith("/models")) return base;
  return `${base}/models`;
}

/** Build the /chat/completions URL. */
function chatUrl(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  if (base.endsWith("/chat/completions")) return base;
  return `${base}/chat/completions`;
}

function authHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey && apiKey.trim()) headers["Authorization"] = `Bearer ${apiKey.trim()}`;
  return headers;
}

/** Fetch with a timeout via AbortController. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = TEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException || (e instanceof Error && e.name === "AbortError");
}

/** Extract model ids from an OpenAI-compatible /models response, tolerating
 *  the minor shape differences between providers (OpenAI, OpenRouter, Groq,
 *  Ollama, LM Studio, localai). */
export function extractModelIds(payload: unknown): string[] {
  const data = payload as { data?: unknown; models?: unknown };
  const list = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.models)
      ? data.models
      : Array.isArray(payload)
        ? payload
        : [];
  const ids: string[] = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      ids.push(entry);
    } else if (entry && typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      const id = obj.id ?? obj.name ?? obj.model;
      if (typeof id === "string" && id.trim()) ids.push(id.trim());
    }
  }
  // De-dup + sort for a stable dropdown.
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

// ─── Provider presets for label → base URL autofill ──────────────────────────

/** Known OpenAI-compatible providers keyed by a lowercase match token.
 *  The label the user types is matched case-insensitively against the keys
 *  (and a few common aliases) to suggest a base URL. */
export const CUSTOM_PROVIDER_PRESETS: Record<string, { baseUrl: string; label: string }> = {
  groq: { baseUrl: "https://api.groq.com/openai/v1", label: "Groq" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", label: "OpenRouter" },
  cerebras: { baseUrl: "https://api.cerebras.ai/v1", label: "Cerebras" },
  together: { baseUrl: "https://api.together.xyz/v1", label: "Together" },
  "lm studio": { baseUrl: "http://localhost:1234/v1", label: "LM Studio" },
  lmstudio: { baseUrl: "http://localhost:1234/v1", label: "LM Studio" },
  localai: { baseUrl: "http://localhost:8080/v1", label: "LocalAI" },
  ollama: { baseUrl: "http://localhost:11434/v1", label: "Ollama" },
  vllm: { baseUrl: "http://localhost:8000/v1", label: "vLLM" },
  "openai-compatible": { baseUrl: "", label: "Custom" },
};

/** All preset base URLs (used to detect when a URL is still a default that
 *  can be safely overwritten by a new label match). */
const PRESET_URLS = new Set(Object.values(CUSTOM_PROVIDER_PRESETS).map((p) => p.baseUrl).filter(Boolean));

/** Look up a base URL suggestion for a provider label the user is typing.
 *  Returns `null` when no preset matches. Matching is case-insensitive and
 *  checks both the full label and each whitespace-separated token, so
 *  "Groq", "groq prod", "my groq proxy", and "GROQ" all resolve. */
export function suggestBaseUrlFromLabel(label: string): string | null {
  const trimmed = label.trim().toLowerCase();
  if (!trimmed) return null;
  // Direct key match first (e.g. "lm studio").
  if (CUSTOM_PROVIDER_PRESETS[trimmed]) {
    const preset = CUSTOM_PROVIDER_PRESETS[trimmed];
    return preset.baseUrl || null;
  }
  // Token match — catches "my groq proxy", "groq-prod", etc.
  const tokens = trimmed.split(/[\s\-_/]+/).filter(Boolean);
  for (const token of tokens) {
    if (CUSTOM_PROVIDER_PRESETS[token]) {
      const preset = CUSTOM_PROVIDER_PRESETS[token];
      if (preset.baseUrl) return preset.baseUrl;
    }
  }
  return null;
}

/** Decide whether a base URL is "empty or still a preset default" — i.e. the
 *  user hasn't typed anything custom yet, so an autofill won't clobber their
 *  work. An empty string counts as overwritable. */
export function isPresetOrDefaultUrl(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  if (!trimmed) return true;
  return PRESET_URLS.has(trimmed);
}

/** Fetch the available models from GET /models. Never throws — returns a
 *  normalized result so the UI can fall back to manual entry on failure. */
export async function fetchAvailableModels(
  config: CustomProviderConfig,
): Promise<ModelFetchResult> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!baseUrl) return { ok: false, models: [], message: "Base URL is required." };
  if (!isValidBaseUrl(baseUrl)) return { ok: false, models: [], message: "Invalid base URL." };

  try {
    const response = await fetchWithTimeout(modelsUrl(baseUrl), {
      method: "GET",
      headers: authHeaders(config.apiKey),
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, models: [], message: "Authentication failed — check your API key." };
    }
    if (!response.ok) {
      return {
        ok: false,
        models: [],
        message: `Could not fetch models (HTTP ${response.status}). You can still enter a model manually.`,
      };
    }
    const payload = await response.json().catch(() => null);
    const models = extractModelIds(payload);
    if (models.length === 0) {
      return {
        ok: true,
        models: [],
        message: "Endpoint responded but listed no models. Enter a model manually.",
      };
    }
    return { ok: true, models, message: "" };
  } catch (e) {
    if (isAbortError(e)) {
      return { ok: false, models: [], message: "Request timed out while fetching models." };
    }
    return {
      ok: false,
      models: [],
      message: "Could not reach the endpoint. Check the base URL and CORS settings.",
    };
  }
}

/** Quick syntactic check that a string looks like a usable URL. */
export function isValidBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Test an OpenAI-compatible endpoint end-to-end.
 *
 *  Flow:
 *   1. Validate the base URL.
 *   2. Try GET /models — confirms reachability + auth + OpenAI schema.
 *   3. If /models fails but a model is provided, try a minimal
 *      chat/completions request to confirm the endpoint is usable.
 *
 *  Never throws. API keys are never included in messages or logs. */
export async function testProviderConnection(
  config: CustomProviderConfig,
): Promise<ConnectionTestResult> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!baseUrl) {
    return { ok: false, status: "invalid_url", message: "Base URL is required.", modelsReachable: false, models: [] };
  }
  if (!isValidBaseUrl(baseUrl)) {
    return { ok: false, status: "invalid_url", message: "Invalid base URL. Use http(s)://host/path.", modelsReachable: false, models: [] };
  }

  // Step 1: GET /models
  const modelsResult = await fetchAvailableModels(config);
  if (modelsResult.ok) {
    // If a model was specified, confirm it exists in the list (when the list
    // is non-empty). An empty list is not a failure — some endpoints don't
    // enumerate models but still serve chat completions.
    if (config.model && modelsResult.models.length > 0 && !modelsResult.models.includes(config.model.trim())) {
      return {
        ok: false,
        status: "model_not_found",
        message: `Endpoint responded, but "${config.model.trim()}" was not in the model list.`,
        modelsReachable: true,
        models: modelsResult.models,
      };
    }
    return {
      ok: true,
      status: "connected",
      message: "Connected successfully.",
      modelsReachable: true,
      models: modelsResult.models,
    };
  }

  // /models failed with an auth error — no point probing chat completions.
  if (/authentication failed/i.test(modelsResult.message)) {
    return {
      ok: false,
      status: "auth_failed",
      message: "Authentication failed — check your API key.",
      modelsReachable: false,
      models: [],
    };
  }

  // Step 2: fall back to a tiny chat/completions probe (only if a model is
  // given — we need a model id to call chat completions).
  if (config.model && config.model.trim()) {
    try {
      const response = await fetchWithTimeout(chatUrl(baseUrl), {
        method: "POST",
        headers: authHeaders(config.apiKey),
        body: JSON.stringify({
          model: config.model.trim(),
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
      });
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          status: "auth_failed",
          message: "Authentication failed — check your API key.",
          modelsReachable: false,
          models: [],
        };
      }
      if (response.ok) {
        return {
          ok: true,
          status: "connected",
          message: "Connected successfully (chat completions responded).",
          modelsReachable: false,
          models: [],
        };
      }
      if (response.status === 404) {
        return {
          ok: false,
          status: "model_not_found",
          message: `Endpoint responded, but model "${config.model.trim()}" was not found.`,
          modelsReachable: false,
          models: [],
        };
      }
      return {
        ok: false,
        status: "not_openai_compatible",
        message: `Endpoint responded with HTTP ${response.status} — it may not be OpenAI-compatible.`,
        modelsReachable: false,
        models: [],
      };
    } catch (e) {
      if (isAbortError(e)) {
        return { ok: false, status: "timed_out", message: "Request timed out.", modelsReachable: false, models: [] };
      }
      return {
        ok: false,
        status: "endpoint_unreachable",
        message: "Could not reach the endpoint. Check the base URL and CORS settings.",
        modelsReachable: false,
        models: [],
      };
    }
  }

  // /models failed and no model provided — surface the /models failure.
  return {
    ok: false,
    status: "endpoint_unreachable",
    message: modelsResult.message || "Could not fetch models.",
    modelsReachable: false,
    models: [],
  };
}
