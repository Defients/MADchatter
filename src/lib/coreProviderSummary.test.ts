import assert from "node:assert/strict";
import { getCoreProviderSummary } from "./coreProviderSummary";
import { getKeys, openAiCompatEndpoint } from "./keys";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => values.get(key) ?? null,
} });
let passed = 0;
function check(provider: string, keys: Record<string, string>, expected: Partial<ReturnType<typeof getCoreProviderSummary>>) {
  values.set("active_api_provider", provider);
  values.set("autoforge_api_keys", JSON.stringify(keys));
  const actual = getCoreProviderSummary();
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(actual[key as keyof typeof actual], value, `${provider}: ${key}`);
  }
  passed++;
}
check("openai", { chatGptKey: "test-only" }, { label: "OpenAI", configured: true, model: openAiCompatEndpoint("openai", getKeys()).model });
check("claude", { claudeKey: "test-only" }, { label: "Claude", configured: true, model: "" });
check("gemini", { geminiKey: "test-only" }, { label: "Gemini", configured: true, model: "" });
check("openrouter", { openRouterKey: "test-only", customModel: "chosen/model" }, { model: "chosen/model", configured: true });
check("openrouter", { openRouterKey: "test-only" }, { model: openAiCompatEndpoint("openrouter", { ...getKeys(), customModel: "" }).model });
check("openai", { geminiKey: "test-only" }, { configured: false });
check("ollama", { customBaseUrl: "http://localhost:11434/v1" }, { model: "", configured: false, isLocal: true });
check("ollama", { customBaseUrl: "http://localhost:11434/v1", customModel: "local-a" }, { model: "local-a", configured: true });
check("ollama", { customBaseUrl: "http://localhost:11434/v1", customModel: "local-b" }, { model: "local-b", configured: true });
check("anthropic", { claudeKey: "test-only" }, { label: "Claude", configured: true });
console.log(`${passed} Core provider summary scenarios passed`);
