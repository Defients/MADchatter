/**
 * Custom OpenAI-Compatible provider keys dispatch tests.
 *
 * Run with: npx tsx src/lib/keys.test.ts
 *
 * Covers: getApiKey (configured with/without key, unconfigured), hasAnyApiKey,
 * getProviderWithKey, openAiCompatEndpoint, and isOpenAICompatibleProvider
 * for the custom-openai provider.
 */

const storageMap = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => storageMap.get(k) ?? null,
  setItem: (k: string, v: string) => { storageMap.set(k, String(v)); },
  removeItem: (k: string) => { storageMap.delete(k); },
  clear: () => storageMap.clear(),
  get length() { return storageMap.size; },
  key: (i: number) => [...storageMap.keys()][i] ?? null,
};

const {
  getApiKey,
  hasAnyApiKey,
  getProviderWithKey,
  openAiCompatEndpoint,
  isOpenAICompatibleProvider,
  CUSTOM_OPENAI_PROVIDER,
  getActiveProvider,
  setActiveProvider,
} = await import("./keys");

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string) {
  if (cond) passed++;
  else { failed++; failures.push(msg); }
}
function setKeys(obj: Record<string, unknown>) {
  storageMap.set("autoforge_api_keys", JSON.stringify(obj));
}

// ─── isOpenAICompatibleProvider ────────────────────────────────────────────
assert(isOpenAICompatibleProvider("openai"), "openai compatible");
assert(isOpenAICompatibleProvider("openrouter"), "openrouter compatible");
assert(isOpenAICompatibleProvider("ollama"), "ollama compatible");
assert(isOpenAICompatibleProvider(CUSTOM_OPENAI_PROVIDER), "custom-openai compatible");
assert(!isOpenAICompatibleProvider("gemini"), "gemini not compatible");
assert(!isOpenAICompatibleProvider("claude"), "claude not compatible");

// ─── getApiKey: unconfigured ───────────────────────────────────────────────
setActiveProvider(CUSTOM_OPENAI_PROVIDER);
setKeys({});
assert(getApiKey(CUSTOM_OPENAI_PROVIDER) === null, "unconfigured → null");

// ─── getApiKey: base URL + model, no key → sentinel ────────────────────────
setKeys({ customOpenAIBaseUrl: "https://api.groq.com/openai/v1", customOpenAIModel: "gpt-oss-120b" });
assert(getApiKey(CUSTOM_OPENAI_PROVIDER) === "custom-openai-no-key", "no-key configured → sentinel");

// ─── getApiKey: fully configured with key ──────────────────────────────────
setKeys({ customOpenAIBaseUrl: "https://api.groq.com/openai/v1", customOpenAIModel: "gpt-oss-120b", customOpenAIKey: "sk-test" });
assert(getApiKey(CUSTOM_OPENAI_PROVIDER) === "sk-test", "configured with key → key");

// ─── getApiKey: missing model → null ───────────────────────────────────────
setKeys({ customOpenAIBaseUrl: "https://api.groq.com/openai/v1" });
assert(getApiKey(CUSTOM_OPENAI_PROVIDER) === null, "missing model → null");

// ─── getApiKey: missing base URL → null ────────────────────────────────────
setKeys({ customOpenAIModel: "gpt-oss-120b" });
assert(getApiKey(CUSTOM_OPENAI_PROVIDER) === null, "missing base URL → null");

// ─── openAiCompatEndpoint ─────────────────────────────────────────────────
setKeys({ customOpenAIBaseUrl: "https://api.groq.com/openai/v1", customOpenAIModel: "gpt-oss-120b" });
const ep = openAiCompatEndpoint(CUSTOM_OPENAI_PROVIDER, {
  geminiKey: "", chatGptKey: "", claudeKey: "", deepgramKey: "", openRouterKey: "",
  customBaseUrl: "", customModel: "",
  customOpenAIKey: "", customOpenAIBaseUrl: "https://api.groq.com/openai/v1",
  customOpenAIModel: "gpt-oss-120b", customOpenAILabel: "",
});
assertEqual(ep.baseUrl, "https://api.groq.com/openai/v1", "endpoint baseUrl");
assertEqual(ep.model, "gpt-oss-120b", "endpoint model");

// ─── hasAnyApiKey ──────────────────────────────────────────────────────────
setKeys({ customOpenAIBaseUrl: "https://api.groq.com/openai/v1", customOpenAIModel: "gpt-oss-120b" });
assert(hasAnyApiKey(), "hasAnyApiKey true when custom configured without key");
setKeys({});
assert(!hasAnyApiKey(), "hasAnyApiKey false when nothing configured");

// ─── getProviderWithKey ────────────────────────────────────────────────────
setKeys({ customOpenAIBaseUrl: "https://api.groq.com/openai/v1", customOpenAIModel: "gpt-oss-120b" });
assertEqual(getProviderWithKey(), CUSTOM_OPENAI_PROVIDER, "getProviderWithKey → custom-openai");
setKeys({ geminiKey: "g" });
assertEqual(getProviderWithKey(), "gemini", "gemini key takes priority over custom");

// ─── existing providers still work ─────────────────────────────────────────
setKeys({ chatGptKey: "sk-openai" });
assertEqual(getApiKey("openai"), "sk-openai", "openai key still resolves");
setKeys({ customBaseUrl: "http://localhost:11434/v1", customModel: "qwen3.5:9b" });
assertEqual(getApiKey("ollama"), "ollama-local", "ollama sentinel still works");
const ollamaEp = openAiCompatEndpoint("ollama", {
  geminiKey: "", chatGptKey: "", claudeKey: "", deepgramKey: "", openRouterKey: "",
  customBaseUrl: "http://localhost:11434/v1", customModel: "qwen3.5:9b",
  customOpenAIKey: "", customOpenAIBaseUrl: "", customOpenAIModel: "", customOpenAILabel: "",
});
assertEqual(ollamaEp.baseUrl, "http://localhost:11434/v1", "ollama endpoint unchanged");

function assertEqual<T>(actual: T, expected: T, msg: string) {
  assert(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// ─── Report ────────────────────────────────────────────────────────────────
console.log("\n============================================================");
if (failed === 0) {
  console.log(`Custom OpenAI keys dispatch tests: ${passed} passed, 0 failed`);
  console.log("All keys dispatch tests passed!");
} else {
  console.log(`Custom OpenAI keys dispatch tests: ${passed} passed, ${failed} failed`);
  failures.forEach((f) => console.log(`  ✗ ${f}`));
  process.exit(1);
}
