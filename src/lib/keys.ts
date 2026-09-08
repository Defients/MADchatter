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
  return null;
}

export function hasAnyApiKey(): boolean {
  const keys = getKeys();
  return !!(keys.geminiKey || keys.chatGptKey || keys.claudeKey || keys.openRouterKey);
}

export function getProviderWithKey(): string | null {
  const keys = getKeys();
  if (keys.openRouterKey) return "openrouter";
  if (keys.geminiKey) return "gemini";
  if (keys.chatGptKey) return "openai";
  if (keys.claudeKey) return "claude";
  return null;
}

export function getActiveProvider(): string {
  return localStorage.getItem("active_api_provider") || "gemini";
}

export function setActiveProvider(provider: string): void {
  localStorage.setItem("active_api_provider", provider);
  try {
    import("../store").then(({ useAppStore }) => useAppStore.getState().bumpAuthTick());
  } catch {}
}
