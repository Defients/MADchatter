import { getActiveProvider, getApiKey, getKeys, openAiCompatEndpoint } from "./keys";

/** Display configured models only where the request path exposes a shared resolver.
 * Cloud-specific model selection stays in the AI pipeline, avoiding stale UI guesses.
 */
export function getCoreProviderSummary(): { label: string; model: string; isLocal: boolean; configured: boolean } {
  const provider = getActiveProvider();
  const keys = getKeys();
  const labels: Record<string, string> = {
    gemini: "Gemini", "gemini-pro": "Gemini", openai: "OpenAI",
    claude: "Claude", anthropic: "Claude", openrouter: "OpenRouter", ollama: "Ollama",
  };
  const compatible = provider === "openai" || provider === "openrouter" || provider === "ollama";
  return {
    label: labels[provider] || provider,
    model: provider === "ollama" && !keys.customModel
      ? "" : compatible ? openAiCompatEndpoint(provider, keys).model : "",
    isLocal: provider === "ollama",
    configured: !!getApiKey(provider),
  };
}
