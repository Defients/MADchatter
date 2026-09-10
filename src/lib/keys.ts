export interface ApiKeys {
  geminiKey: string;
  chatGptKey: string;
  claudeKey: string;
  deepgramKey: string;
  openRouterKey: string;
  customBaseUrl: string;
  customModel: string;
}

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
      };
    }
  } catch {}
  const deepgram = localStorage.getItem("VITE_DEEPGRAM_API_KEY") || "";
  return {
    geminiKey: "",
    chatGptKey: "",
    claudeKey: "",
    deepgramKey: deepgram,
    openRouterKey: "",
    customBaseUrl: "",
    customModel: "",
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
  return null;
}

export function hasAnyApiKey(): boolean {
  const keys = getKeys();
  if (keys.geminiKey || keys.chatGptKey || keys.claudeKey || keys.openRouterKey) return true;
  // Ollama needs no key, but it does need a base URL and model to actually
  // function. Only count it as configured when both are set.
  return getActiveProvider() === "ollama" && !!keys.customBaseUrl && !!keys.customModel;
}

export function getProviderWithKey(): string | null {
  const keys = getKeys();
  if (keys.openRouterKey) return "openrouter";
  if (keys.geminiKey) return "gemini";
  if (keys.chatGptKey) return "openai";
  if (keys.claudeKey) return "claude";
  // No cloud keys configured — fall back to Ollama if it's the active provider
  // AND has a base URL + model set.
  if (getActiveProvider() === "ollama" && keys.customBaseUrl && keys.customModel) return "ollama";
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
      model: keys.customModel || "llama3.1:8b",
    };
  }
  // plain OpenAI
  return { baseUrl: undefined, model: "gpt-5.6-luna" };
}

export function setActiveProvider(provider: string): void {
  localStorage.setItem("active_api_provider", provider);
  try {
    import("../store").then(({ useAppStore }) => useAppStore.getState().bumpAuthTick());
  } catch {}
}
