/**
 * Custom OpenAI-Compatible provider client tests.
 *
 * Run with: npx tsx src/lib/customProvider.test.ts
 *
 * Covers: model-id extraction across provider shape variants, URL helpers,
 * and the testProviderConnection flow (mocked fetch) for success, auth
 * failure, model-not-found, invalid URL, and /models-unavailable fallback
 * to a chat/completions probe.
 */

// ─── fetch shim (must be set before importing customProvider) ──────────────
type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
let fetchHandler: FetchHandler = async () => new Response("{}", { status: 200 });
const fetchCalls: { url: string; init?: RequestInit }[] = [];

(globalThis as any).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : (input as Request).url;
  fetchCalls.push({ url, init });
  return fetchHandler(url, init);
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const {
  extractModelIds,
  isValidBaseUrl,
  fetchAvailableModels,
  testProviderConnection,
  suggestBaseUrlFromLabel,
  isPresetOrDefaultUrl,
  CUSTOM_PROVIDER_PRESETS,
} = await import("./customProvider");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(msg);
  }
}

function assertEqual<T>(actual: T, expected: T, msg: string) {
  assert(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function reset() {
  fetchCalls.length = 0;
}

// ─── extractModelIds ───────────────────────────────────────────────────────
// OpenAI shape: { data: [{ id }] }
assertEqual(extractModelIds({ data: [{ id: "gpt-4" }, { id: "gpt-3.5" }] }).length, 2, "OpenAI data[].id");
// OpenRouter shape: { data: [{ id: "openai/gpt-4" }] }
assertEqual(extractModelIds({ data: [{ id: "openai/gpt-4" }] })[0], "openai/gpt-4", "OpenRouter id");
// Ollama shape: { models: [{ name: "llama3" }] }
assertEqual(extractModelIds({ models: [{ name: "llama3" }] })[0], "llama3", "Ollama models[].name");
// Some gateways return a bare array of strings
assertEqual(extractModelIds(["m1", "m2"]).length, 2, "bare array of strings");
// De-dup + sort
const dedup = extractModelIds({ data: [{ id: "b" }, { id: "a" }, { id: "a" }] });
assertEqual(dedup.join(","), "a,b", "dedup + sort");
// Empty / malformed
assertEqual(extractModelIds({}).length, 0, "empty object yields no models");
assertEqual(extractModelIds({ data: [{ foo: "bar" }] }).length, 0, "entry without id/name/model skipped");

// ─── isValidBaseUrl ───────────────────────────────────────────────────────
assert(isValidBaseUrl("https://api.groq.com/openai/v1"), "https URL valid");
assert(isValidBaseUrl("http://localhost:1234/v1"), "http localhost valid");
assert(!isValidBaseUrl("not a url"), "plain string invalid");
assert(!isValidBaseUrl("ftp://example.com"), "ftp invalid");

// ─── fetchAvailableModels ──────────────────────────────────────────────────
reset();
fetchHandler = async () => jsonResponse({ data: [{ id: "gpt-oss-120b" }, { id: "gpt-oss-20b" }] });
let r = await fetchAvailableModels({ baseUrl: "https://api.groq.com/openai/v1", apiKey: "k" });
assert(r.ok, "fetch models ok");
assertEqual(r.models.length, 2, "two models returned");
assert(fetchCalls[0].url.endsWith("/models"), "hits /models endpoint");
assertEqual((fetchCalls[0].init?.headers as any)?.Authorization, "Bearer k", "sends Authorization header");

reset();
fetchHandler = async () => new Response("{}", { status: 401 });
r = await fetchAvailableModels({ baseUrl: "https://api.groq.com/openai/v1", apiKey: "bad" });
assert(!r.ok, "401 not ok");
assert(/authentication failed/i.test(r.message), "auth failure message");

reset();
fetchHandler = async () => jsonResponse({ data: [] });
r = await fetchAvailableModels({ baseUrl: "https://api.groq.com/openai/v1" });
assert(r.ok, "empty model list is still ok");
assertEqual(r.models.length, 0, "no models");
assert(/no models/i.test(r.message), "empty-list hint message");

// No API key → no Authorization header
reset();
fetchHandler = async () => jsonResponse({ data: [{ id: "m" }] });
await fetchAvailableModels({ baseUrl: "http://localhost:1234/v1" });
assert(!(fetchCalls[0].init?.headers as any)?.Authorization, "no key → no Authorization header");

// Invalid URL
r = await fetchAvailableModels({ baseUrl: "not a url" });
assert(!r.ok && /invalid/i.test(r.message), "invalid url rejected");

// Empty base URL
r = await fetchAvailableModels({ baseUrl: "" });
assert(!r.ok && /required/i.test(r.message), "empty base url rejected");

// ─── testProviderConnection ────────────────────────────────────────────────
// Success via /models
reset();
fetchHandler = async () => jsonResponse({ data: [{ id: "gpt-oss-120b" }] });
let t = await testProviderConnection({ baseUrl: "https://api.groq.com/openai/v1", apiKey: "k", model: "gpt-oss-120b" });
assert(t.ok, "connection ok via /models");
assertEqual(t.status, "connected", "status connected");
assert(t.modelsReachable, "models reachable true");

// Model not in list
reset();
fetchHandler = async () => jsonResponse({ data: [{ id: "gpt-oss-120b" }] });
t = await testProviderConnection({ baseUrl: "https://api.groq.com/openai/v1", apiKey: "k", model: "wrong-model" });
assert(!t.ok, "model not found not ok");
assertEqual(t.status, "model_not_found", "status model_not_found");

// Auth failure on /models
reset();
fetchHandler = async () => new Response("{}", { status: 401 });
t = await testProviderConnection({ baseUrl: "https://api.groq.com/openai/v1", apiKey: "bad", model: "m" });
assert(!t.ok, "auth fail not ok");
assertEqual(t.status, "auth_failed", "status auth_failed");

// Invalid URL
t = await testProviderConnection({ baseUrl: "ftp://x", model: "m" });
assert(!t.ok, "invalid url not ok");
assertEqual(t.status, "invalid_url", "status invalid_url");

// Empty base URL
t = await testProviderConnection({ baseUrl: "" });
assert(!t.ok, "empty base not ok");
assertEqual(t.status, "invalid_url", "empty → invalid_url");

// /models fails (non-auth), falls back to chat/completions probe → success
reset();
let callCount = 0;
fetchHandler = async (url) => {
  callCount++;
  if (url.endsWith("/models")) return new Response("{}", { status: 404 });
  if (url.endsWith("/chat/completions")) return jsonResponse({ choices: [{ message: { content: "ok" } }] });
  return new Response("{}", { status: 500 });
};
t = await testProviderConnection({ baseUrl: "http://localhost:1234/v1", model: "local-model" });
assert(t.ok, "fallback chat probe ok");
assertEqual(t.status, "connected", "fallback status connected");
assert(!t.modelsReachable, "models not reachable (used fallback)");

// /models fails, chat probe 404 → model_not_found
reset();
fetchHandler = async (url) => {
  if (url.endsWith("/models")) return new Response("{}", { status: 500 });
  if (url.endsWith("/chat/completions")) return new Response("{}", { status: 404 });
  return new Response("{}", { status: 500 });
};
t = await testProviderConnection({ baseUrl: "http://localhost:1234/v1", model: "missing" });
assert(!t.ok, "chat 404 not ok");
assertEqual(t.status, "model_not_found", "chat 404 → model_not_found");

// /models fails, no model provided → endpoint_unreachable
reset();
fetchHandler = async () => new Response("{}", { status: 500 });
t = await testProviderConnection({ baseUrl: "http://localhost:1234/v1" });
assert(!t.ok, "no model + models fail not ok");
assertEqual(t.status, "endpoint_unreachable", "no model fallback → endpoint_unreachable");

// ─── Label → Base URL autofill ─────────────────────────────────────────────

// Direct key matches (case-insensitive)
assertEqual(suggestBaseUrlFromLabel("Groq"), "https://api.groq.com/openai/v1", "Groq → groq url");
assertEqual(suggestBaseUrlFromLabel("groq"), "https://api.groq.com/openai/v1", "groq lowercase → groq url");
assertEqual(suggestBaseUrlFromLabel("GROQ"), "https://api.groq.com/openai/v1", "GROQ upper → groq url");
assertEqual(suggestBaseUrlFromLabel("OpenRouter"), "https://openrouter.ai/api/v1", "OpenRouter → openrouter url");
assertEqual(suggestBaseUrlFromLabel("Cerebras"), "https://api.cerebras.ai/v1", "Cerebras → cerebras url");
assertEqual(suggestBaseUrlFromLabel("Together"), "https://api.together.xyz/v1", "Together → together url");

// Multi-word / aliased keys
assertEqual(suggestBaseUrlFromLabel("LM Studio"), "http://localhost:1234/v1", "LM Studio → lm studio url");
assertEqual(suggestBaseUrlFromLabel("lmstudio"), "http://localhost:1234/v1", "lmstudio → lm studio url");
assertEqual(suggestBaseUrlFromLabel("LocalAI"), "http://localhost:8080/v1", "LocalAI → localai url");
assertEqual(suggestBaseUrlFromLabel("vLLM"), "http://localhost:8000/v1", "vLLM → vllm url");

// Token match — catches "my groq proxy", "groq-prod", etc.
assertEqual(suggestBaseUrlFromLabel("my groq proxy"), "https://api.groq.com/openai/v1", "token match: my groq proxy");
assertEqual(suggestBaseUrlFromLabel("groq-prod"), "https://api.groq.com/openai/v1", "token match: groq-prod");
assertEqual(suggestBaseUrlFromLabel("prod groq"), "https://api.groq.com/openai/v1", "token match: prod groq");

// No match
assert(suggestBaseUrlFromLabel("") === null, "empty label → null");
assert(suggestBaseUrlFromLabel("my proxy") === null, "unknown label → null");
assert(suggestBaseUrlFromLabel("acme corp") === null, "no-token-match → null");

// isPresetOrDefaultUrl — overwritable detection
assert(isPresetOrDefaultUrl(""), "empty url is overwritable");
assert(isPresetOrDefaultUrl("   "), "whitespace url is overwritable");
assert(isPresetOrDefaultUrl("https://api.groq.com/openai/v1"), "preset groq url is overwritable");
assert(isPresetOrDefaultUrl("http://localhost:1234/v1"), "preset lm studio url is overwritable");
assert(!isPresetOrDefaultUrl("https://my-custom-gateway.example.com/v1"), "custom url is NOT overwritable");
assert(!isPresetOrDefaultUrl("http://192.168.1.5:8080/v1"), "custom local url is NOT overwritable");

// Preset table sanity
assert(!!CUSTOM_PROVIDER_PRESETS.groq, "groq preset exists");
assert(!!CUSTOM_PROVIDER_PRESETS.openrouter, "openrouter preset exists");
assertEqual(CUSTOM_PROVIDER_PRESETS.groq.label, "Groq", "groq preset label");

// ─── Report ────────────────────────────────────────────────────────────────
console.log("\n============================================================");
if (failed === 0) {
  console.log(`Custom provider tests: ${passed} passed, 0 failed`);
  console.log("All Custom provider tests passed!");
} else {
  console.log(`Custom provider tests: ${passed} passed, ${failed} failed`);
  failures.forEach((f) => console.log(`  ✗ ${f}`));
  process.exit(1);
}
