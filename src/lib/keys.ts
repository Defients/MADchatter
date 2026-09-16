export interface ApiKeys {
  geminiKey: string;
  chatGptKey: string;
  claudeKey: string;
  deepgramKey: string;
  openRouterKey: string;
  customBaseUrl: string;
  customModel: string;
  // Custom OpenAI-Compatible provider (generic escape hatch for Groq,
  // OpenRouter, Cerebras, Together, local proxies, self-hosted gateways,
  // and any other OpenAI-style API). Kept separate from the shared
  // customBaseUrl/customModel pair (which OpenRouter + Ollama reuse) so a
  // custom endpoint never overwrites those presets.
  customOpenAIKey: string;
  customOpenAIBaseUrl: string;
  customOpenAIModel: string;
  customOpenAILabel: string;
}

/** Internal provider id for the generic OpenAI-compatible escape hatch. */
export const CUSTOM_OPENAI_PROVIDER = "custom-openai";

/** Internal provider id for the Friend Trial transport (Worker-held Groq key).
 *  Routed through createTrialFetch() to POST /trial/chat; the user never sees
 *  the Groq credential. See src/lib/trial.ts. */
export const TRIAL_PROVIDER = "trial";

// Synchronous trial session check (called in hot paths). Reads sessionStorage
// directly to avoid an async import on every readiness check.
function trialSessionActiveSync(): boolean {
  try {
    const token = sessionStorage.getItem("madchatter_trial_token");
    if (!token) return false;
    const exp = parseInt(sessionStorage.getItem("madchatter_trial_expiry") || "0", 10);
    if (exp && Date.now() >= exp * 1000) return false;
    const workerUrl = (localStorage.getItem("madchatter_trial_worker_url") || ((import.meta as any).env?.VITE_TRIAL_WORKER_URL || "")).trim();
    return workerUrl.length > 0;
  } catch {
    return false;
  }
}
function trialTokenSync(): string | null {
  try {
    return sessionStorage.getItem("madchatter_trial_token");
  } catch {
    return null;
  }
}

/** Providers that speak the OpenAI chat-completions schema. Adding a new
 *  OpenAI-compatible preset here automatically wires it through every
 *  generation path (Forge, AutoForge, smart replies, memory, vision). */
export const OPENAI_COMPATIBLE_PROVIDERS = [
  "openai",
  "openrouter",
  "ollama",
  CUSTOM_OPENAI_PROVIDER,
  TRIAL_PROVIDER,
] as const;

/** True for any provider that dispatches through the OpenAI-compatible
 *  branch in the AI pipeline. Use this instead of listing providers
 *  inline so new presets are wired automatically. */
export function isOpenAICompatibleProvider(provider: string): boolean {
  return (OPENAI_COMPATIBLE_PROVIDERS as readonly string[]).includes(provider);
}

/** Sentinel returned by getApiKey() for OpenAI-compatible endpoints that
 *  are configured (base URL + model present) but require no API key. The
 *  OpenAI SDK always sends an Authorization header when apiKey is truthy;
 *  no-auth local servers (LM Studio, localai, …) ignore it, so this keeps
 *  the SDK happy without pretending the provider is unconfigured. */
const NO_KEY_SENTINEL = "custom-openai-no-key";

const KEYS_STORAGE_KEY = "autoforge_api_keys";

export function getKeys(): ApiKeys {
  try {
    const raw = localStorage.getItem(KEYS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        geminiKey: parsed.geminiKey || "",
        chatGptKey: parsed.chatGptKey || "",
        claudeKey: parsed.claudeKey || "",
        deepgramKey: parsed.deepgramKey !== undefined ? parsed.deepgramKey : (localStorage.getItem("VITE_DEEPGRAM_API_KEY") || ""),
        openRouterKey: parsed.openRouterKey || "",
        customBaseUrl: parsed.customBaseUrl || "",
        customModel: parsed.customModel || "",
        customOpenAIKey: parsed.customOpenAIKey || "",
        customOpenAIBaseUrl: parsed.customOpenAIBaseUrl || "",
        customOpenAIModel: parsed.customOpenAIModel || "",
        customOpenAILabel: parsed.customOpenAILabel || "",
      };
    }
  } catch (e) {
    console.warn("[keys] Failed to parse stored API keys from localStorage:", e);
  }
  const deepgram = localStorage.getItem("VITE_DEEPGRAM_API_KEY") || "";
  return {
    geminiKey: "",
    chatGptKey: "",
    claudeKey: "",
    deepgramKey: deepgram,
    openRouterKey: "",
    customBaseUrl: "",
    customModel: "",
    customOpenAIKey: "",
    customOpenAIBaseUrl: "",
    customOpenAIModel: "",
    customOpenAILabel: "",
  };
}

export function saveKeys(keys: Partial<ApiKeys>): void {
  const current = getKeys();
  const merged = { ...current, ...keys };
  localStorage.setItem(KEYS_STORAGE_KEY, JSON.stringify(merged));
  if (merged.deepgramKey) {
    localStorage.setItem("VITE_DEEPGRAM_API_KEY", merged.deepgramKey);
  } else {
    localStorage.removeItem("VITE_DEEPGRAM_API_KEY");
  }
  try {
    import("../store").then(({ useAppStore }) => useAppStore.getState().bumpAuthTick());
  } catch {}
}

export function getApiKey(provider: string): string | null {
  const keys = getKeys();
  const normProvider = provider === "gemini-pro" ? "gemini" : provider === "anthropic" ? "claude" : provider;

  if (normProvider === "gemini") return keys.geminiKey || null;
  if (normProvider === "openai") return keys.chatGptKey || null;
  if (normProvider === "claude") return keys.claudeKey || null;
  if (normProvider === "openrouter") return keys.openRouterKey || null;
  if (normProvider === "ollama") {
    // Ollama runs without a key, but it still needs a base URL and model to
    // function. Return null when either is missing so key guards and fallback
    // chains don't treat an unconfigured Ollama as available.
    const keys = getKeys();
    if (!keys.customBaseUrl || !keys.customModel) return null;
    return "ollama-local";
  }
  if (normProvider === CUSTOM_OPENAI_PROVIDER) {
    // Custom OpenAI-compatible endpoint: base URL + model are required; the
    // API key is optional (local proxies / self-hosted gateways may not need
    // one). Return null when not configured so readiness guards treat it as
    // unconfigured, and a sentinel when configured without a key so the
    // OpenAI SDK (which requires a non-null apiKey) still constructs.
    const k = getKeys();
    if (!k.customOpenAIBaseUrl || !k.customOpenAIModel) return null;
    return k.customOpenAIKey || NO_KEY_SENTINEL;
  }
  if (normProvider === TRIAL_PROVIDER) {
    // Friend Trial: the "API key" is the disposable HMAC session token (NOT the
    // Groq credential). Return it when a valid session exists so the OpenAI SDK
    // constructs; return null when unconfigured so readiness guards treat
    // trial as unavailable. The Groq key never exists in the browser.
    if (!trialSessionActiveSync()) return null;
    return trialTokenSync() || NO_KEY_SENTINEL;
  }
  return null;
}

export function hasAnyApiKey(): boolean {
  const keys = getKeys();
  if (keys.geminiKey || keys.chatGptKey || keys.claudeKey || keys.openRouterKey) return true;
  // Ollama needs no key, but it does need a base URL and model to actually
  // function. Only count it as configured when both are set.
  if (getActiveProvider() === "ollama" && !!keys.customBaseUrl && !!keys.customModel) return true;
  // Custom OpenAI-compatible: needs base URL + model; key optional.
  if (getActiveProvider() === CUSTOM_OPENAI_PROVIDER && !!keys.customOpenAIBaseUrl && !!keys.customOpenAIModel) return true;
  // Friend Trial: counts as configured when a valid session exists.
  if (getActiveProvider() === TRIAL_PROVIDER && trialSessionActiveSync()) return true;
  return false;
}

export function getProviderWithKey(): string | null {
  const keys = getKeys();
  if (keys.openRouterKey) return "openrouter";
  if (keys.geminiKey) return "gemini";
  if (keys.chatGptKey) return "openai";
  if (keys.claudeKey) return "claude";
  // Custom OpenAI-compatible: configured without a key still counts.
  if (keys.customOpenAIBaseUrl && keys.customOpenAIModel) return CUSTOM_OPENAI_PROVIDER;
  // No cloud keys configured — fall back to Ollama if it's the active provider
  // AND has a base URL + model set.
  if (getActiveProvider() === "ollama" && keys.customBaseUrl && keys.customModel) return "ollama";
  // Friend Trial: valid session counts as having a provider with key.
  if (getActiveProvider() === TRIAL_PROVIDER && trialSessionActiveSync()) return TRIAL_PROVIDER;
  return null;
}

export function getActiveProvider(): string {
  return localStorage.getItem("active_api_provider") || "gemini";
}

/** Resolve the OpenAI-compatible base URL and model for a given provider.
 * Centralized so ai.ts / memoryEngine.ts / server.ts share one source of truth
 * for OpenRouter and Ollama defaults. Returns `baseUrl: undefined` for plain
 * OpenAI (the SDK's own default endpoint). */
export function openAiCompatEndpoint(
  provider: string,
  keys: ApiKeys,
): { baseUrl: string | undefined; model: string } {
  if (provider === "openrouter") {
    return {
      baseUrl: keys.customBaseUrl || "https://openrouter.ai/api/v1",
      model: keys.customModel || "google/gemini-3.8-flash",
    };
  }
  if (provider === "ollama") {
    return {
      baseUrl: keys.customBaseUrl || "http://localhost:11434/v1",
      // Recommended local model: qwen3.5:9b (balanced quality/speed on 16GB GPUs).
      // Fast alternative: qwen3.5:4b. Users can override via customModel.
      model: keys.customModel || "qwen3.5:9b",
    };
  }
  if (provider === CUSTOM_OPENAI_PROVIDER) {
    // Generic OpenAI-compatible escape hatch. Base URL + model are required
    // (getApiKey returns null otherwise, so this branch is only reached when
    // configured). No defaults — the user owns the endpoint completely.
    return {
      baseUrl: keys.customOpenAIBaseUrl,
      model: keys.customOpenAIModel,
    };
  }
  if (provider === TRIAL_PROVIDER) {
    // Friend Trial: base URL is the Worker URL; model is a placeholder (the
    // Worker ignores the client model and uses the server-controlled
    // TRIAL_MODEL). createTrialFetch() rewrites the request to /trial/chat.
    const workerUrl = (localStorage.getItem("madchatter_trial_worker_url") || ((import.meta as any).env?.VITE_TRIAL_WORKER_URL || "")).trim().replace(/\/+$/, "");
    return {
      baseUrl: workerUrl || "https://friend-trial.placeholder.workers.dev",
      model: "trial",
    };
  }
  // plain OpenAI
  return { baseUrl: undefined, model: "gpt-5.6-luna" };
}

export function setActiveProvider(provider: string): void {
  // Cancel any active AI requests for the old provider to prevent stale
  // results from applying after the switch.
  const oldProvider = localStorage.getItem("active_api_provider");
  if (oldProvider && oldProvider !== provider) {
    try {
      import("./aiScheduler").then(({ aiScheduler }) => {
        aiScheduler.cancelProvider(oldProvider, "provider changed");
      });
    } catch {}
  }
  localStorage.setItem("active_api_provider", provider);
  try {
    import("../store").then(({ useAppStore }) => useAppStore.getState().bumpAuthTick());
  } catch {}
}
