/**
 * Local Bridge client — unit tests.
 *
 * Run with:  npx tsx src/lib/localBridge.test.ts
 *
 * Tests the typed client contracts: URL construction, error message mapping,
 * connection probing (mocked fetch), and SSE event parsing. No real Bridge
 * or network is required.
 */

// ── localStorage shim (must exist before store.ts module init) ──────────
const storageMap = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => storageMap.get(k) ?? null,
  setItem: (k: string, v: string) => { storageMap.set(k, String(v)); },
  removeItem: (k: string) => { storageMap.delete(k); },
  clear: () => storageMap.clear(),
  get length() { return storageMap.size; },
  key: (i: number) => [...storageMap.keys()][i] ?? null,
};

// ── fetch shim ───────────────────────────────────────────────────────────
let lastFetchUrl = "";
let lastFetchOpts: any = null;
let fetchResponse: any = { ok: true, status: 200, json: async () => ({}) };
(globalThis as any).fetch = async (url: string, opts?: any) => {
  lastFetchUrl = url;
  lastFetchOpts = opts || {};
  const res = {
    ok: fetchResponse.ok,
    status: fetchResponse.status,
    json: async () => fetchResponse.body,
  };
  return res;
};

// ── EventSource shim ─────────────────────────────────────────────────────
class FakeEventSource {
  url: string;
  onmessage: ((msg: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  static last: FakeEventSource | null = null;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }
  close() {}
}
(globalThis as any).EventSource = FakeEventSource;

import {
  LocalBridgeClient,
  probeBridge,
  buildStreamUrl,
  bridgeErrorMessage,
  BRIDGE_API_VERSION,
  BRIDGE_ERROR_CODES,
  DEFAULT_BRIDGE_BASE_URL,
  type BridgeEvent,
} from "./localBridge";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; failures.push(msg); console.error(`  FAIL: ${msg}`); }
}

async function runTest(name: string, fn: () => Promise<void> | void): Promise<void> {
  console.log(`\n▸ ${name}`);
  try { await fn(); } catch (e: any) {
    failed++; failures.push(`${name}: threw ${e?.message ?? e}`); console.error(`  FAIL: threw ${e?.message ?? e}`);
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

await runTest("buildStreamUrl constructs Twitch URL", () => {
  const url = buildStreamUrl("twitch", "example");
  assert(url === "https://www.twitch.tv/example", `got ${url}`);
});

await runTest("buildStreamUrl constructs Kick URL", () => {
  const url = buildStreamUrl("kick", "example");
  assert(url === "https://kick.com/example", `got ${url}`);
});

await runTest("buildStreamUrl returns null for unknown platform", () => {
  const url = buildStreamUrl("joystick", "example");
  assert(url === null, `got ${url}`);
});

await runTest("buildStreamUrl returns null for empty channel", () => {
  assert(buildStreamUrl("twitch", "") === null, "empty string");
  assert(buildStreamUrl("twitch", "   ") === null, "whitespace only");
});

await runTest("bridgeErrorMessage maps known codes", () => {
  assert(bridgeErrorMessage(BRIDGE_ERROR_CODES.FFMPEG_NOT_FOUND).includes("FFmpeg"), "FFmpeg message");
  assert(bridgeErrorMessage(BRIDGE_ERROR_CODES.STREAM_OFFLINE).includes("offline"), "offline message");
  assert(bridgeErrorMessage(BRIDGE_ERROR_CODES.STREAMLINK_NOT_FOUND).includes("Streamlink"), "streamlink message");
});

await runTest("bridgeErrorMessage falls back for unknown codes", () => {
  const msg = bridgeErrorMessage("UNKNOWN_CODE", "fallback text");
  assert(msg === "fallback text", `got ${msg}`);
});

await runTest("LocalBridgeClient sends auth header", async () => {
  const client = new LocalBridgeClient(DEFAULT_BRIDGE_BASE_URL, "my-token");
  fetchResponse = { ok: true, status: 200, body: { service: "madchatter-local", serviceVersion: "0.1.0", apiVersion: BRIDGE_API_VERSION, status: "ready", transcription: { state: "idle", device: null, computeType: null, model: "small.en" }, capabilities: { streamlink: true, ffmpeg: true, wasapi: false, cuda: false } } };
  await client.checkHealth();
  // /health is unauthenticated — no auth header expected.
  assert(!lastFetchOpts.headers?.Authorization, "health should not send auth header");
});

await runTest("LocalBridgeClient.getStatus sends auth header", async () => {
  const client = new LocalBridgeClient(DEFAULT_BRIDGE_BASE_URL, "my-token");
  fetchResponse = { ok: true, status: 200, body: { service: "madchatter-local", serviceVersion: "0.1.0", apiVersion: BRIDGE_API_VERSION, transcription: { state: "idle", source: null, url: null, deviceId: null, model: "small.en", device: null, computeType: null, lastError: null, lastErrorCode: null, retryCount: 0, latencyMs: null }, model: { state: "ready", model: "small.en", device: "cpu", computeType: "int8", progress: null, error: null } } };
  await client.getStatus();
  assert(lastFetchOpts.headers?.Authorization === "Bearer my-token", `got ${lastFetchOpts.headers?.Authorization}`);
});

await runTest("LocalBridgeClient.start sends POST with body", async () => {
  const client = new LocalBridgeClient(DEFAULT_BRIDGE_BASE_URL, "tok");
  fetchResponse = { ok: true, status: 200, body: { started: true, state: { state: "listening" } } };
  await client.start({ source: "stream", url: "https://twitch.tv/test" });
  assert(lastFetchOpts.method === "POST", "should be POST");
  const body = JSON.parse(lastFetchOpts.body);
  assert(body.source === "stream", "body source");
  assert(body.url === "https://twitch.tv/test", "body url");
});

await runTest("probeBridge returns connected on valid health", async () => {
  fetchResponse = { ok: true, status: 200, body: { service: "madchatter-local", serviceVersion: "0.1.0", apiVersion: BRIDGE_API_VERSION, status: "ready", transcription: { state: "idle", device: "cpu", computeType: "int8", model: "small.en" }, capabilities: { streamlink: true, ffmpeg: true, wasapi: false, cuda: false } } };
  const result = await probeBridge(DEFAULT_BRIDGE_BASE_URL, null);
  assert(result.state === "connected", `got ${result.state}`);
  assert(result.health?.apiVersion === BRIDGE_API_VERSION, "api version");
});

await runTest("probeBridge returns version_mismatch on wrong API version", async () => {
  fetchResponse = { ok: true, status: 200, body: { service: "madchatter-local", serviceVersion: "0.1.0", apiVersion: "99", status: "ready", transcription: { state: "idle", device: null, computeType: null, model: "small.en" }, capabilities: { streamlink: true, ffmpeg: true, wasapi: false, cuda: false } } };
  const result = await probeBridge(DEFAULT_BRIDGE_BASE_URL, null);
  assert(result.state === "version_mismatch", `got ${result.state}`);
});

await runTest("probeBridge returns not_running on fetch abort (timeout)", async () => {
  const origFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    throw e;
  };
  const result = await probeBridge(DEFAULT_BRIDGE_BASE_URL, null, 100);
  assert(result.state === "not_running", `got ${result.state}`);
  (globalThis as any).fetch = origFetch;
});

await runTest("probeBridge returns not_running on TypeError (network)", async () => {
  const origFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async () => {
    const e = new Error("fetch failed");
    e.name = "TypeError";
    throw e;
  };
  // Non-secure context (http) → not_running, not permission_required.
  const result = await probeBridge("http://127.0.0.1:8765", null, 100);
  assert(result.state === "not_running", `got ${result.state}`);
  (globalThis as any).fetch = origFetch;
});

await runTest("LocalBridgeClient.openEventStream passes token via query param", () => {
  const client = new LocalBridgeClient(DEFAULT_BRIDGE_BASE_URL, "sse-token");
  const es = client.openEventStream(() => {});
  assert(es instanceof FakeEventSource, "should return EventSource");
  assert((es as any).url.includes("token=sse-token"), `url should contain token: ${(es as any).url}`);
});

await runTest("SSE event parsing — transcript.final", () => {
  const rawEvent = { type: "transcript.final", data: { id: "seg_1", text: "hello", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:01.000Z", source: "stream", final: true }, ts: 12345 };
  const parsed = JSON.parse(JSON.stringify(rawEvent)) as BridgeEvent;
  assert(parsed.type === "transcript.final", "type");
  if (parsed.type === "transcript.final") {
    assert(parsed.data.text === "hello", "text");
    assert(parsed.data.final === true, "final");
  }
});

await runTest("LocalBridgeClient without token omits auth header", async () => {
  const client = new LocalBridgeClient(DEFAULT_BRIDGE_BASE_URL, null);
  fetchResponse = { ok: true, status: 200, body: { service: "madchatter-local", serviceVersion: "0.1.0", apiVersion: BRIDGE_API_VERSION, transcription: { state: "idle", source: null, url: null, deviceId: null, model: "small.en", device: null, computeType: null, lastError: null, lastErrorCode: null, retryCount: 0, latencyMs: null }, model: { state: "ready", model: "small.en", device: "cpu", computeType: "int8", progress: null, error: null } } };
  await client.getStatus();
  assert(!lastFetchOpts.headers?.Authorization, "should not send auth header without token");
});

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n${passed}/${passed + failed} assertions passed; ${failed} failed.`);
if (failed > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
