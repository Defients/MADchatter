import assert from "node:assert/strict";
import { checkOllamaHealth, getCachedOllamaHealth, invalidateOllamaHealthCache } from "./ollamaHealth";
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let calls = 0;
let passed = 0;
const response = (models: unknown[]) => new Response(JSON.stringify({ data: models }), { status: 200 });
const stub = (fn: typeof fetch) => { globalThis.fetch = fn; invalidateOllamaHealthCache(); };
try {
  stub(async () => { calls++; return response([{ id: "alpha:latest" }, { id: "alpha:small" }]); });
  assert.equal((await checkOllamaHealth("http://a/v1", "alpha")).state, "ready"); passed++;
  await checkOllamaHealth("http://a/v1/", "alpha");
  assert.equal(calls, 1, "Trailing slashes share a configuration"); passed++;
  assert.equal((await checkOllamaHealth("http://a/v1", "missing")).state, "model_unavailable");
  assert.equal(calls, 2, "Different model must not reuse ready evidence"); passed++;
  await checkOllamaHealth("http://b/v1", "alpha");
  assert.equal(calls, 3, "Different endpoint must be checked"); passed++;
  await checkOllamaHealth("http://b/v1", "alpha", true);
  assert.equal(calls, 4, "Force refresh skips completed cache"); passed++;
  const checkedAt = getCachedOllamaHealth("http://b/v1", "alpha")!.checkedAt;
  Date.now = () => checkedAt + 30_000;
  assert.equal(getCachedOllamaHealth("http://b/v1", "alpha"), null, "Expired evidence isn't exposed");
  Date.now = originalNow; passed++;

  const pending: Array<(value: Response) => void> = [];
  stub((() => new Promise<Response>((resolve) => pending.push(resolve))) as typeof fetch);
  const first = checkOllamaHealth("http://a/v1", "alpha");
  const duplicate = checkOllamaHealth("http://a/v1", "alpha");
  const other = checkOllamaHealth("http://a/v1", "beta");
  assert.equal(pending.length, 2, "Only identical requests share a flight");
  pending[0](response([{ id: "alpha" }])); pending[1](response([{ id: "beta" }]));
  const results = await Promise.all([first, duplicate, other]);
  assert.deepEqual(results.map((r) => r.state), ["ready", "ready", "ready"]); passed++;

  pending.length = 0;
  invalidateOllamaHealthCache();
  const stale = checkOllamaHealth("http://a/v1", "alpha");
  invalidateOllamaHealthCache();
  const fresh = checkOllamaHealth("http://a/v1", "alpha");
  pending[0](response([{ id: "alpha" }])); await stale;
  assert.equal(getCachedOllamaHealth("http://a/v1", "alpha"), null, "Invalidated work cannot refill cache");
  const freshDuplicate = checkOllamaHealth("http://a/v1", "alpha");
  assert.equal(pending.length, 2, "Old completion cannot remove a newer flight");
  pending[1](response([{ id: "different" }]));
  await Promise.all([fresh, freshDuplicate]);
  assert.equal(getCachedOllamaHealth("http://a/v1", "alpha")!.state, "model_unavailable"); passed++;

  stub(async () => response([null, {}, { id: 5 }, { name: "alpha:small" }]));
  assert.equal((await checkOllamaHealth("http://a/v1", "alpha")).state, "model_unavailable", "Untagged model cannot match arbitrary tag"); passed++;
  assert.equal((await checkOllamaHealth("http://a/v1", "alpha:small")).state, "ready"); passed++;
  stub(async () => new Response("failure", { status: 503 }));
  assert.equal((await checkOllamaHealth("http://a/v1", "alpha")).state, "endpoint_unreachable"); passed++;
  stub(async () => new Response("invalid json"));
  assert.equal((await checkOllamaHealth("http://a/v1", "alpha")).state, "endpoint_unreachable"); passed++;
  stub(async () => { throw new Error("offline"); });
  assert.equal((await checkOllamaHealth("http://a/v1", "alpha")).state, "endpoint_unreachable"); passed++;
  stub((async (_url, options) => ({
    ok: true,
    json: () => new Promise((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })),
  } as Response)) as typeof fetch);
  assert.equal((await checkOllamaHealth("http://a/v1", "alpha")).state, "endpoint_unreachable", "Deadline covers stalled response body"); passed++;
  console.log(`${passed} Ollama health scenarios passed`);
} finally {
  invalidateOllamaHealthCache(); globalThis.fetch = originalFetch; Date.now = originalNow;
}
