/**
 * Friend Trial Worker — automated tests.
 *
 * Runs with: node --import tsx tests/worker.test.ts
 *
 * Mocks the upstream Groq API and Turnstile siteverify so no real credits or
 * network calls are spent. Tests cover the major abuse + regression cases from
 * the spec's testing requirements table.
 *
 * No real secrets are used. All values are placeholders.
 */
import assert from "node:assert";

// ── Mock infrastructure ──────────────────────────────────────────────────────

type FetchHandler = (url: string, init: RequestInit) => Promise<{ status: number; headers: Record<string, string>; body: unknown }>;

let mockFetchHandler: FetchHandler | null = null;
let turnstileSuccess = true;
let groqResponse: { status: number; body: unknown } = {
  status: 200,
  body: {
    id: "chatcmpl-test",
    object: "chat.completion",
    model: "llama-3.3-70b-versatile",
    choices: [{ index: 0, message: { role: "assistant", content: '{"suggestions":[]}' }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  },
};
let groqCalls = 0;

// Override global fetch for the worker's upstream calls.
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url || "";
  if (url.includes("challenges.cloudflare.com")) {
    return Promise.resolve(new Response(JSON.stringify({ success: turnstileSuccess, hostname: "madchatter.fun" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    })) as any;
  }
  if (url.includes("api.groq.com")) {
    groqCalls++;
    if (groqResponse.status === -1) {
      return Promise.reject(Object.assign(new Error("timed out"), { name: "AbortError" })) as any;
    }
    if (groqResponse.status === 429) {
      return Promise.resolve(new Response("rate limited", { status: 429, headers: { "retry-after": "30" } })) as any;
    }
    if (groqResponse.status >= 500) {
      return Promise.resolve(new Response("error", { status: groqResponse.status })) as any;
    }
    if (groqResponse.status === 401 || groqResponse.status === 403) {
      return Promise.resolve(new Response("auth error", { status: groqResponse.status })) as any;
    }
    return Promise.resolve(new Response(JSON.stringify(groqResponse.body), {
      status: 200, headers: { "Content-Type": "application/json" },
    })) as any;
  }
  return originalFetch(input as any, init) as any;
}) as any;

// Mock RateLimit binding.
function makeRateLimit(alwaysSucceed = true, failAfter = Infinity): RateLimit {
  let calls = 0;
  return {
    limit: async (_opts: { key: string }) => {
      calls++;
      return { success: alwaysSucceed ? calls <= failAfter : false };
    },
  } as any;
}

class MemoryDurableStorage {
  private values = new Map<string, unknown>();
  private tail: Promise<unknown> = Promise.resolve();

  transaction<T>(callback: (txn: DurableObjectTransaction) => Promise<T>): Promise<T> {
    const run = this.tail.then(() => callback({
      get: async <V>(key: string) => this.values.get(key) as V | undefined,
      put: async (key: string, value: unknown) => { this.values.set(key, structuredClone(value)); },
    } as unknown as DurableObjectTransaction));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

function makeUsageNamespace(options: { fail?: boolean } = {}) {
  const objects = new Map<string, { fetch(request: RequestInfo | URL, init?: RequestInit): Promise<Response> }>();
  return {
    idFromName(name: string) { return { toString: () => name }; },
    get(id: { toString(): string }) {
      const key = id.toString();
      if (!objects.has(key)) {
        if (options.fail) {
          objects.set(key, { fetch: async () => { throw new Error("usage store unavailable"); } });
        } else {
          const storage = new MemoryDurableStorage();
          objects.set(key, {
            fetch: async (request, init) => {
              const { TrialUsageDurableObject } = await import("../src/usageDurableObject.ts");
              const instance = new TrialUsageDurableObject({ storage } as unknown as DurableObjectState, {} as any);
              return instance.fetch(request instanceof Request ? request : new Request(request, init));
            },
          });
        }
      }
      return objects.get(key)!;
    },
  };
}

// Build a mock env with all required bindings.
function makeEnv(overrides: Record<string, any> = {}): any {
  return {
    GROQ_API_KEY: "test-groq-key",
    TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
    TRIAL_SESSION_SECRET: "test-session-secret-long-enough-for-hmac",
    TRIAL_INVITE_CODE: "",
    TRIAL_ENABLED: "true",
    TRIAL_END_AT: "2099-12-31T23:59:59Z",
    TRIAL_MODEL: "openai/gpt-oss-120b",
    TRIAL_MAX_OUTPUT_TOKENS: "2048",
    TRIAL_SESSION_TTL_SECONDS: "3600",
    TRIAL_MOBILE_DAILY_LIMIT: "30",
    TRIAL_REQUIRE_INVITE: "false",
    ALLOWED_ORIGINS: "https://madchatter.fun",
    TURNSTILE_SITE_KEY: "test-site-key",
    TURNSTILE_EXPECTED_HOSTNAME: "madchatter.fun",
    TRIAL_SESSION_BOOTSTRAP: makeRateLimit(),
    TRIAL_INFERENCE_SESSION: makeRateLimit(),
    TRIAL_INFERENCE_IP: makeRateLimit(),
    TRIAL_USAGE: makeUsageNamespace(),
    ...overrides,
  };
}

function makeRequest(method: string, path: string, opts: { body?: any; headers?: Record<string, string> } = {}): Request {
  const url = `https://friend-trial.example.com${path}`;
  const headers: Record<string, string> = {
    Origin: "https://madchatter.fun",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    ...(opts.headers || {}),
  };
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    const body = path === "/trial/session" && opts.body && typeof opts.body === "object" && !Array.isArray(opts.body) && !("clientId" in opts.body)
      ? { ...opts.body, clientId: "11111111-1111-4111-8111-111111111111" }
      : opts.body;
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
  }
  return new Request(url, init);
}

async function callWorker(env: any, request: Request): Promise<{ status: number; body: any; headers: Headers }> {
  const { default: handler } = await import("../src/index.ts");
  const response = await handler.fetch(request, env);
  const body = await response.json().catch(() => null);
  return { status: response.status, body, headers: response.headers };
}

// ── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}\n    ${(e as Error).message}`);
  }
}

// ── Session token helpers (for chat tests) ────────────────────────────────────

async function makeValidToken(env: any): Promise<string> {
  const { createSessionToken } = await import("../src/session.ts");
  const { token } = await createSessionToken(env.TRIAL_SESSION_SECRET, 3600, { qid: "test_quota_identity_abcdefghijklmnopqrstuvwxyz123", clientClass: "other" });
  return token;
}

async function makeExpiredToken(env: any): Promise<string> {
  const { createSessionToken } = await import("../src/session.ts");
  const { token } = await createSessionToken(env.TRIAL_SESSION_SECRET, -10, { qid: "test_quota_identity_abcdefghijklmnopqrstuvwxyz123", clientClass: "other" });
  return token;
}

async function makeTamperedToken(env: any): Promise<string> {
  const { createSessionToken } = await import("../src/session.ts");
  const { token } = await createSessionToken(env.TRIAL_SESSION_SECRET, 3600, { qid: "test_quota_identity_abcdefghijklmnopqrstuvwxyz123", clientClass: "other" });
  // Tamper with the payload portion.
  const [payload, sig] = token.split(".");
  const tampered = payload.slice(0, -4) + "AAAA";
  return `${tampered}.${sig}`;
}

async function makeMobileToken(env: any, qid = "mobile_quota_identity_abcdefghijklmnopqrstuvwxyz12"): Promise<string> {
  const { createSessionToken } = await import("../src/session.ts");
  const { token } = await createSessionToken(env.TRIAL_SESSION_SECRET, 3600, { qid, clientClass: "mobile" });
  return token;
}

async function callUsageObject(
  instance: { fetch(request: Request): Promise<Response> },
  path: string,
  body?: Record<string, unknown>,
) {
  const response = await instance.fetch(new Request(`https://trial-usage${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }));
  return { status: response.status, body: await response.json() as any };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\nFriend Trial Worker — tests\n");

  // Status
  await test("valid status request → 200", async () => {
    const env = makeEnv();
    const res = await callWorker(env, makeRequest("GET", "/trial/status"));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.trial.enabled, true);
    assert.strictEqual(res.body.trial.requiresTurnstile, true);
  });

  await test("status reflects disabled trial", async () => {
    const env = makeEnv({ TRIAL_ENABLED: "false" });
    const res = await callWorker(env, makeRequest("GET", "/trial/status"));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.trial.enabled, false);
  });

  await test("status reflects expired trial", async () => {
    const env = makeEnv({ TRIAL_END_AT: "2000-01-01T00:00:00Z" });
    const res = await callWorker(env, makeRequest("GET", "/trial/status"));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.trial.enabled, false);
  });

  // Disabled / expired rejection
  await test("disabled trial → session rejected", async () => {
    const env = makeEnv({ TRIAL_ENABLED: "false" });
    const res = await callWorker(env, makeRequest("POST", "/trial/session", { body: { turnstileToken: "valid" } }));
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.error.code, "TRIAL_DISABLED");
  });

  await test("expired trial → session rejected", async () => {
    const env = makeEnv({ TRIAL_END_AT: "2000-01-01T00:00:00Z" });
    const res = await callWorker(env, makeRequest("POST", "/trial/session", { body: { turnstileToken: "valid" } }));
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.error.code, "TRIAL_EXPIRED");
  });

  await test("disabled trial → chat rejected", async () => {
    const env = makeEnv({ TRIAL_ENABLED: "false" });
    const res = await callWorker(env, makeRequest("POST", "/trial/chat", { body: { messages: [{ role: "user", content: "hi" }] } }));
    assert.strictEqual(res.status, 403);
  });

  // CORS
  await test("valid CORS origin → accepted", async () => {
    const env = makeEnv();
    const res = await callWorker(env, makeRequest("GET", "/trial/status"));
    assert.strictEqual(res.headers.get("Access-Control-Allow-Origin"), "https://madchatter.fun");
    assert.strictEqual(res.headers.get("Vary"), "Origin");
  });

  await test("invalid origin on status → 200 but no CORS header (public endpoint)", async () => {
    const env = makeEnv();
    const res = await callWorker(env, makeRequest("GET", "/trial/status", { headers: { Origin: "https://evil.example" } }));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("Access-Control-Allow-Origin"), null);
  });

  await test("invalid origin on session → 403", async () => {
    const env = makeEnv();
    const res = await callWorker(env, makeRequest("POST", "/trial/session", { headers: { Origin: "https://evil.example" }, body: { turnstileToken: "x" } }));
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.error.code, "ORIGIN_FORBIDDEN");
  });

  await test("invalid origin on chat → 403", async () => {
    const env = makeEnv();
    const res = await callWorker(env, makeRequest("POST", "/trial/chat", { headers: { Origin: "https://evil.example" }, body: { messages: [] } }));
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.error.code, "ORIGIN_FORBIDDEN");
  });

  await test("preflight → valid CORS response", async () => {
    const env = makeEnv();
    const res = await callWorker(env, makeRequest("OPTIONS", "/trial/chat", { headers: { Origin: "https://madchatter.fun" } }));
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers.get("Access-Control-Allow-Origin"), "https://madchatter.fun");
    assert.strictEqual(res.headers.get("Access-Control-Allow-Methods"), "GET, POST, OPTIONS");
  });

  await test("preflight from invalid origin → 403", async () => {
    const env = makeEnv();
    const res = await callWorker(env, makeRequest("OPTIONS", "/trial/chat", { headers: { Origin: "https://evil.example" } }));
    assert.strictEqual(res.status, 403);
  });

  // Session creation
  await test("valid session creation → 200 with token", async () => {
    turnstileSuccess = true;
    const env = makeEnv();
    const res = await callWorker(env, makeRequest("POST", "/trial/session", { body: { turnstileToken: "valid-token" } }));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.ok(res.body.session.token.length > 0);
    assert.ok(res.body.session.expiresAt > 0);
  });

  await test("invalid Turnstile → 403", async () => {
    turnstileSuccess = false;
    const env = makeEnv();
    const res = await callWorker(env, makeRequest("POST", "/trial/session", { body: { turnstileToken: "bad" } }));
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.error.code, "TURNSTILE_FAILED");
    turnstileSuccess = true;
  });

  await test("missing Turnstile token → 401", async () => {
    const env = makeEnv();
    const res = await callWorker(env, makeRequest("POST", "/trial/session", { body: {} }));
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error.code, "TURNSTILE_REQUIRED");
  });

  await test("invite required + valid code → 200", async () => {
    const env = makeEnv({ TRIAL_REQUIRE_INVITE: "true", TRIAL_INVITE_CODE: "FRIENDS2026" });
    const res = await callWorker(env, makeRequest("POST", "/trial/session", { body: { turnstileToken: "valid", inviteCode: "FRIENDS2026" } }));
    assert.strictEqual(res.status, 200);
  });

  await test("invite required + invalid code → 403", async () => {
    const env = makeEnv({ TRIAL_REQUIRE_INVITE: "true", TRIAL_INVITE_CODE: "FRIENDS2026" });
    const res = await callWorker(env, makeRequest("POST", "/trial/session", { body: { turnstileToken: "valid", inviteCode: "WRONG" } }));
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.error.code, "INVITE_INVALID");
  });

  // Chat — session validation
  await test("missing session → 401", async () => {
    const env = makeEnv();
    const res = await callWorker(env, makeRequest("POST", "/trial/chat", { body: { messages: [{ role: "user", content: "hi" }] } }));
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error.code, "INVALID_SESSION");
  });

  await test("invalid signature → 401", async () => {
    const env = makeEnv();
    const res = await callWorker(env, makeRequest("POST", "/trial/chat", {
      body: { messages: [{ role: "user", content: "hi" }] },
      headers: { Authorization: "Bearer fake.token.here" },
    }));
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error.code, "INVALID_SESSION");
  });

  await test("tampered token → 401", async () => {
    const env = makeEnv();
    const token = await makeTamperedToken(env);
    const res = await callWorker(env, makeRequest("POST", "/trial/chat", {
      body: { messages: [{ role: "user", content: "hi" }] },
      headers: { Authorization: `Bearer ${token}` },
    }));
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error.code, "INVALID_SESSION");
  });

  await test("expired session → 401", async () => {
    const env = makeEnv();
    const token = await makeExpiredToken(env);
    const res = await callWorker(env, makeRequest("POST", "/trial/chat", {
      body: { messages: [{ role: "user", content: "hi" }] },
      headers: { Authorization: `Bearer ${token}` },
    }));
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error.code, "SESSION_EXPIRED");
  });

  // Chat — happy path
  await test("valid chat request → 200 with OpenAI-compatible response", async () => {
    groqResponse = { status: 200, body: { choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } } };
    const env = makeEnv();
    const token = await makeValidToken(env);
    const res = await callWorker(env, makeRequest("POST", "/trial/chat", {
      body: { messages: [{ role: "user", content: "hi" }], temperature: 0.8, maxTokens: 300 },
      headers: { Authorization: `Bearer ${token}` },
    }));
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.choices);
    assert.ok(res.body.usage);
  });

  // Chat — input validation
  await test("malformed JSON → 400", async () => {
    const env = makeEnv();
    const token = await makeValidToken(env);
    const req = new Request("https://friend-trial.example.com/trial/chat", {
      method: "POST",
      headers: { Origin: "https://madchatter.fun", "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "{not valid json",
    });
    const res = await callWorker(env, req);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error.code, "INVALID_REQUEST");
  });

  await test("oversized body → 413", async () => {
    const env = makeEnv();
    const token = await makeValidToken(env);
    // Above the 256 KB body ceiling (images inflate payloads).
    const big = "x".repeat(300 * 1024);
    const res = await callWorker(env, makeRequest("POST", "/trial/chat", {
      body: { messages: [{ role: "user", content: big }] },
      headers: { Authorization: `Bearer ${token}` },
    }));
    assert.strictEqual(res.status, 413);
    assert.strictEqual(res.body.error.code, "PAYLOAD_TOO_LARGE");
  });

  await test("empty messages → 400", async () => {
    const env = makeEnv();
    const token = await makeValidToken(env);
    const res = await callWorker(env, makeRequest("POST", "/trial/chat", {
      body: { messages: [] },
      headers: { Authorization: `Bearer ${token}` },
    }));
    assert.strictEqual(res.status, 400);
  });

  await test("invalid role → 400", async () => {
    const env = makeEnv();
    const token = await makeValidToken(env);
    const res = await callWorker(env, makeRequest("POST", "/trial/chat", {
      body: { messages: [{ role: "developer", content: "hi" }] },
      headers: { Authorization: `Bearer ${token}` },
    }));
    assert.strictEqual(res.status, 400);
  });

  await test("multimodal array content → 400 (text-only trial)", async () => {
    const env = makeEnv();
    const token = await makeValidToken(env);
    const res = await callWorker(env, makeRequest("POST", "/trial/chat", {
      body: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      headers: { Authorization: `Bearer ${token}` },
    }));
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error.code, "INVALID_REQUEST");
  });

  // ── Vision-capable trial (TRIAL_VISION_MODEL configured) ──────────────
  await test("status includes supportsVision when TRIAL_VISION_MODEL set", async () => {
    const env = makeEnv({ TRIAL_VISION_MODEL: "qwen/qwen3.6-27b" });
    const res = await callWorker(env, makeRequest("GET", "/trial/status"));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.trial.supportsVision, true);
    assert.strictEqual(res.body.trial.visionModelLabel, "qwen/qwen3.6-27b");
  });

  await test("status omits supportsVision when TRIAL_VISION_MODEL unset", async () => {
    const env = makeEnv();
    const res = await callWorker(env, makeRequest("GET", "/trial/status"));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.trial.supportsVision, undefined);
  });

  await test("vision trial accepts multimodal content → 200", async () => {
    groqResponse = { status: 200, body: { choices: [{ message: { content: "I see a game" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } };
    const env = makeEnv({ TRIAL_VISION_MODEL: "qwen/qwen3.6-27b" });
    const token = await makeValidToken(env);
    const res = await callWorker(env, makeRequest("POST", "/trial/chat", {
      body: { messages: [{ role: "user", content: [
        { type: "text", text: "What's on screen?" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQ" } },
      ] }] },
      headers: { Authorization: `Bearer ${token}` },
    }));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.choices[0].message.content, "I see a game");
  });

  await test("vision trial routes image-bearing request to vision model", async () => {
    let capturedModel: string | null = null;
    groqResponse = { status: 200, body: { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } };
    const origFetch = globalThis.fetch;
    globalThis.fetch = ((input: any, init?: any) => {
      const url = typeof input === "string" ? input : input?.url;
      if (url?.includes("api.groq.com")) {
        const body = JSON.parse(init.body);
        capturedModel = body.model;
        return Promise.resolve(new Response(JSON.stringify(groqResponse.body), { status: 200, headers: { "Content-Type": "application/json" } })) as any;
      }
      return (origFetch as any)(input, init);
    }) as any;
    const env = makeEnv({ TRIAL_VISION_MODEL: "qwen/qwen3.6-27b" });
    const token = await makeValidToken(env);
    await callWorker(env, makeRequest("POST", "/trial/chat", {
      body: { messages: [{ role: "user", content: [
        { type: "text", text: "describe" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQ" } },
      ] }] },
      headers: { Authorization: `Bearer ${token}` },
    }));
    globalThis.fetch = origFetch;
    assert.strictEqual(capturedModel, "qwen/qwen3.6-27b");
  });

  await test("vision trial routes text-only request to text model", async () => {
    let capturedModel: string | null = null;
    groqResponse = { status: 200, body: { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } };
    const origFetch = globalThis.fetch;
    globalThis.fetch = ((input: any, init?: any) => {
      const url = typeof input === "string" ? input : input?.url;
      if (url?.includes("api.groq.com")) {
        const body = JSON.parse(init.body);
        capturedModel = body.model;
        return Promise.resolve(new Response(JSON.stringify(groqResponse.body), { status: 200, headers: { "Content-Type": "application/json" } })) as any;
      }
      return (origFetch as any)(input, init);
    }) as any;
    const env = makeEnv({ TRIAL_VISION_MODEL: "qwen/qwen3.6-27b" });
    const token = await makeValidToken(env);
    await callWorker(env, makeRequest("POST", "/trial/chat", {
      body: { messages: [{ role: "user", content: "hello" }] },
      headers: { Authorization: `Bearer ${token}` },
    }));
    globalThis.fetch = origFetch;
    assert.strictEqual(capturedModel, "openai/gpt-oss-120b");
  });

  await test("vision trial rejects non-user image content", async () => {
    const env = makeEnv({ TRIAL_VISION_MODEL: "qwen/qwen3.6-27b" });
    const token = await makeValidToken(env);
    const res = await callWorker(env, makeRequest("POST", "/trial/chat", {
      body: { messages: [{ role: "system", content: [
        { type: "text", text: "sys" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQ" } },
      ] }] },
      headers: { Authorization: `Bearer ${token}` },
    }));
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error.code, "INVALID_REQUEST");
  });

  await test("vision trial rejects remote image URLs", async () => {
    const env = makeEnv({ TRIAL_VISION_MODEL: "qwen/qwen3.6-27b" });
    const token = await makeValidToken(env);
    const res = await callWorker(env, makeRequest("POST", "/trial/chat", {
      body: { messages: [{ role: "user", content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "https://evil.com/img.jpg" } },
      ] }] },
      headers: { Authorization: `Bearer ${token}` },
    }));
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error.code, "INVALID_REQUEST");
  });

  await test("vision trial rejects oversized image", async () => {
    const env = makeEnv({ TRIAL_VISION_MODEL: "qwen/qwen3.6-27b" });
    const token = await makeValidToken(env);
    const big = "data:image/jpeg;base64," + "x".repeat(600 * 1024);
    const res = await callWorker(env, makeRequest("POST", "/trial/chat", {
      body: { messages: [{ role: "user", content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: big } },
      ] }] },
      headers: { Authorization: `Bearer ${token}` },
    }));
    assert.strictEqual(res.status, 413);
    assert.strictEqual(res.body.error.code, "PAYLOAD_TOO_LARGE");
  });

  // Chat — model override impossible
  await test("client model override → ignored (server controls model)", async () => {
    let capturedBody: any = null;
    groqResponse = { status: 200, body: { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } };
    const origFetch = globalThis.fetch;
    globalThis.fetch = ((input: any, init?: any) => {
      const url = typeof input === "string" ? input : input?.url;
      if (url?.includes("api.groq.com")) {
        capturedBody = JSON.parse(init.body);
        return Promise.resolve(new Response(JSON.stringify(groqResponse.body), { status: 200, headers: { "Content-Type": "application/json" } })) as any;
      }
      return (origFetch as any)(input, init);
    }) as any;
    const env = makeEnv();
    const token = await makeValidToken(env);
    await callWorker(env, makeRequest("POST", "/trial/chat", {
      body: { model: "expensive-model-999b", messages: [{ role: "user", content: "hi" }], maxTokens: 500000 },
      headers: { Authorization: `Bearer ${token}` },
    }));
    globalThis.fetch = origFetch as any;
    assert.strictEqual(capturedBody.model, "openai/gpt-oss-120b", "server model must override client model");
    assert.ok(capturedBody.max_completion_tokens <= 2048, "token ceiling must be enforced");
  });

  // Chat — rate limiting
  await test("excessive request rate → 429", async () => {
    const env = makeEnv({
      TRIAL_INFERENCE_SESSION: makeRateLimit(true, 2),
    });
    const token = await makeValidToken(env);
    const req = () => callWorker(env, makeRequest("POST", "/trial/chat", {
      body: { messages: [{ role: "user", content: "hi" }] },
      headers: { Authorization: `Bearer ${token}` },
    }));
    const r1 = await req();
    const r2 = await req();
    const r3 = await req();
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(r3.status, 429);
    assert.strictEqual(r3.body.error.code, "RATE_LIMITED");
    assert.ok(r3.headers.get("Retry-After"));
  });

  // Chat — upstream failures
  await test("upstream 429 → normalized failure", async () => {
    groqResponse = { status: 429, body: null };
    const env = makeEnv();
    const token = await makeValidToken(env);
    const res = await callWorker(env, makeRequest("POST", "/trial/chat", {
      body: { messages: [{ role: "user", content: "hi" }] },
      headers: { Authorization: `Bearer ${token}` },
    }));
    assert.strictEqual(res.status, 429);
    assert.strictEqual(res.body.error.code, "UPSTREAM_RATE_LIMITED");
    assert.ok(!JSON.stringify(res.body).includes("rate limited"), "upstream body must not leak");
  });

  await test("upstream 5xx → normalized failure", async () => {
    groqResponse = { status: 503, body: null };
    const env = makeEnv();
    const token = await makeValidToken(env);
    const res = await callWorker(env, makeRequest("POST", "/trial/chat", {
      body: { messages: [{ role: "user", content: "hi" }] },
      headers: { Authorization: `Bearer ${token}` },
    }));
    assert.strictEqual(res.status, 502);
    assert.strictEqual(res.body.error.code, "UPSTREAM_UNAVAILABLE");
  });

  await test("upstream 401 → normalized failure (no key leak)", async () => {
    groqResponse = { status: 401, body: null };
    const env = makeEnv();
    const token = await makeValidToken(env);
    const res = await callWorker(env, makeRequest("POST", "/trial/chat", {
      body: { messages: [{ role: "user", content: "hi" }] },
      headers: { Authorization: `Bearer ${token}` },
    }));
    assert.strictEqual(res.status, 502);
    assert.strictEqual(res.body.error.code, "UPSTREAM_UNAVAILABLE");
    assert.ok(!JSON.stringify(res.body).includes("test-groq-key"), "groq key must not leak");
  });

  // Config validation
  await test("missing GROQ_API_KEY → trial unavailable", async () => {
    const env = makeEnv({ GROQ_API_KEY: "" });
    const res = await callWorker(env, makeRequest("GET", "/trial/status"));
    assert.strictEqual(res.body.trial.enabled, false);
  });

  await test("missing TRIAL_END_AT → fail closed", async () => {
    const env = makeEnv({ TRIAL_END_AT: "" });
    const res = await callWorker(env, makeRequest("GET", "/trial/status"));
    assert.strictEqual(res.body.trial.enabled, false);
  });

  await test("empty ALLOWED_ORIGINS → fail closed", async () => {
    const env = makeEnv({ ALLOWED_ORIGINS: "" });
    const res = await callWorker(env, makeRequest("GET", "/trial/status"));
    assert.strictEqual(res.body.trial.enabled, false);
  });

  await test("missing TRIAL_MODEL → unavailable", async () => {
    const env = makeEnv({ TRIAL_MODEL: "" });
    const res = await callWorker(env, makeRequest("GET", "/trial/status"));
    assert.strictEqual(res.body.trial.enabled, false);
  });

  // Security headers
  await test("security headers present", async () => {
    const env = makeEnv();
    const res = await callWorker(env, makeRequest("GET", "/trial/status"));
    assert.strictEqual(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.strictEqual(res.headers.get("Cache-Control"), "public, max-age=30");
    assert.ok(res.headers.get("X-Request-ID"));
  });

  await test("chat response has no-store cache + request id", async () => {
    groqResponse = { status: 200, body: { choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } };
    const env = makeEnv();
    const token = await makeValidToken(env);
    const res = await callWorker(env, makeRequest("POST", "/trial/chat", {
      body: { messages: [{ role: "user", content: "hi" }] },
      headers: { Authorization: `Bearer ${token}` },
    }));
    assert.strictEqual(res.headers.get("Cache-Control"), "no-store");
    assert.ok(res.headers.get("X-Request-ID"));
  });

  // Daily quota window — noon America/New_York, including DST boundaries.
  await test("quota window uses winter noon ET (17:00 UTC)", async () => {
    const { getTrialQuotaWindow } = await import("../src/quota.ts");
    const window = getTrialQuotaWindow(Date.parse("2026-01-15T16:00:00Z")); // 11:00 ET
    assert.strictEqual(window.startsAt, "2026-01-14T17:00:00.000Z");
    assert.strictEqual(window.resetAt, "2026-01-15T17:00:00.000Z");
  });

  await test("quota window uses summer noon ET (16:00 UTC)", async () => {
    const { getTrialQuotaWindow } = await import("../src/quota.ts");
    const window = getTrialQuotaWindow(Date.parse("2026-07-15T15:00:00Z")); // 11:00 ET
    assert.strictEqual(window.startsAt, "2026-07-14T16:00:00.000Z");
    assert.strictEqual(window.resetAt, "2026-07-15T16:00:00.000Z");
  });

  await test("spring-forward quota day is noon-to-noon and 23 hours", async () => {
    const { getTrialQuotaWindow } = await import("../src/quota.ts");
    const window = getTrialQuotaWindow(Date.parse("2026-03-08T14:00:00Z"));
    assert.strictEqual(window.startsAt, "2026-03-07T17:00:00.000Z");
    assert.strictEqual(window.resetAt, "2026-03-08T16:00:00.000Z");
    assert.strictEqual(Date.parse(window.resetAt) - Date.parse(window.startsAt), 23 * 60 * 60 * 1000);
  });

  await test("fall-back quota day is noon-to-noon and 25 hours", async () => {
    const { getTrialQuotaWindow } = await import("../src/quota.ts");
    const window = getTrialQuotaWindow(Date.parse("2026-11-01T15:00:00Z"));
    assert.strictEqual(window.startsAt, "2026-10-31T16:00:00.000Z");
    assert.strictEqual(window.resetAt, "2026-11-01T17:00:00.000Z");
    assert.strictEqual(Date.parse(window.resetAt) - Date.parse(window.startsAt), 25 * 60 * 60 * 1000);
  });

  // Identity + signed classification.
  await test("same client id creates new sessions with the same opaque quota identity", async () => {
    const env = makeEnv();
    const clientId = "22222222-2222-4222-8222-222222222222";
    const request = () => callWorker(env, makeRequest("POST", "/trial/session", {
      body: { turnstileToken: "valid", clientId },
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile" },
    }));
    const first = await request();
    const second = await request();
    const { verifySessionToken } = await import("../src/session.ts");
    const a = await verifySessionToken(env.TRIAL_SESSION_SECRET, first.body.session.token);
    const b = await verifySessionToken(env.TRIAL_SESSION_SECRET, second.body.session.token);
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) throw new Error("session verification failed");
    assert.strictEqual(a.payload.clientClass, "mobile");
    assert.strictEqual(a.payload.qid, b.payload.qid);
    assert.notStrictEqual(a.payload.sid, b.payload.sid);
    assert.ok(!JSON.stringify(first.body).includes(clientId), "raw client id must not leak in session response");
    assert.ok(!first.body.session.token.includes(clientId), "raw client id must not appear in token text");
  });

  await test("different client ids resolve to different quota identities", async () => {
    const { deriveQuotaId } = await import("../src/session.ts");
    const secret = "test-session-secret-long-enough-for-hmac";
    const a = await deriveQuotaId(secret, "33333333-3333-4333-8333-333333333333");
    const b = await deriveQuotaId(secret, "44444444-4444-4444-8444-444444444444");
    assert.notStrictEqual(a, b);
  });

  await test("missing or malformed client id is rejected", async () => {
    const env = makeEnv();
    const res = await callWorker(env, makeRequest("POST", "/trial/session", {
      body: { turnstileToken: "valid", clientId: "not-a-uuid" },
    }));
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error.code, "INVALID_REQUEST");
  });

  // Atomic ledger behavior.
  await test("two concurrent last-unit reservations cannot both pass", async () => {
    const { TrialUsageDurableObject } = await import("../src/usageDurableObject.ts");
    const instance = new TrialUsageDurableObject({ storage: new MemoryDurableStorage() } as any, {} as any);
    for (let i = 0; i < 29; i += 1) {
      const reservation = await callUsageObject(instance, "/reserve", { cost: 1, limit: 30 });
      await callUsageObject(instance, "/commit", { reservationId: reservation.body.reservationId, limit: 30 });
    }
    const [a, b] = await Promise.all([
      callUsageObject(instance, "/reserve", { cost: 1, limit: 30 }),
      callUsageObject(instance, "/reserve", { cost: 1, limit: 30 }),
    ]);
    assert.strictEqual([a.body.allowed, b.body.allowed].filter(Boolean).length, 1);
    const usage = await callUsageObject(instance, "/usage?limit=30");
    assert.strictEqual(usage.body.usage.used, 30);
  });

  await test("vision reservation is rejected when only one use remains", async () => {
    const { TrialUsageDurableObject } = await import("../src/usageDurableObject.ts");
    const instance = new TrialUsageDurableObject({ storage: new MemoryDurableStorage() } as any, {} as any);
    for (let i = 0; i < 29; i += 1) {
      const reservation = await callUsageObject(instance, "/reserve", { cost: 1, limit: 30 });
      await callUsageObject(instance, "/commit", { reservationId: reservation.body.reservationId, limit: 30 });
    }
    const rejected = await callUsageObject(instance, "/reserve", { cost: 2, limit: 30 });
    assert.strictEqual(rejected.body.allowed, false);
    assert.strictEqual(rejected.body.usage.used, 29);
  });

  await test("refund restores usage once and is idempotent", async () => {
    const { TrialUsageDurableObject } = await import("../src/usageDurableObject.ts");
    const instance = new TrialUsageDurableObject({ storage: new MemoryDurableStorage() } as any, {} as any);
    for (let i = 0; i < 28; i += 1) {
      const reservation = await callUsageObject(instance, "/reserve", { cost: 1, limit: 30 });
      await callUsageObject(instance, "/commit", { reservationId: reservation.body.reservationId, limit: 30 });
    }
    const vision = await callUsageObject(instance, "/reserve", { cost: 2, limit: 30 });
    assert.strictEqual(vision.body.usage.used, 30);
    const first = await callUsageObject(instance, "/refund", { reservationId: vision.body.reservationId, limit: 30 });
    const second = await callUsageObject(instance, "/refund", { reservationId: vision.body.reservationId, limit: 30 });
    assert.strictEqual(first.body.usage.used, 28);
    assert.strictEqual(second.body.usage.used, 28);
  });

  await test("Durable Object lazily starts a fresh ledger after the noon boundary", async () => {
    const { TrialUsageDurableObject } = await import("../src/usageDurableObject.ts");
    const instance = new TrialUsageDurableObject({ storage: new MemoryDurableStorage() } as any, {} as any);
    const originalNow = Date.now;
    try {
      Date.now = () => Date.parse("2026-07-15T15:59:59Z");
      const before = await callUsageObject(instance, "/reserve", { cost: 1, limit: 30 });
      await callUsageObject(instance, "/commit", { reservationId: before.body.reservationId, limit: 30 });
      assert.strictEqual((await callUsageObject(instance, "/usage?limit=30")).body.usage.used, 1);
      Date.now = () => Date.parse("2026-07-15T16:00:01Z");
      const after = await callUsageObject(instance, "/usage?limit=30");
      assert.strictEqual(after.body.usage.used, 0);
      assert.strictEqual(after.body.usage.resetAt, "2026-07-16T16:00:00.000Z");
    } finally {
      Date.now = originalNow;
    }
  });

  // HTTP integration: costs, headers, errors, refunds, and fail-closed storage.
  await test("mobile text and vision success cost 1 and 2 with usage headers", async () => {
    groqResponse = { status: 200, body: { choices: [{ message: { content: "ok" } }] } };
    const env = makeEnv({ TRIAL_VISION_MODEL: "qwen/qwen3.6-27b" });
    const token = await makeMobileToken(env);
    const text = await callWorker(env, makeRequest("POST", "/trial/chat", {
      body: { messages: [{ role: "user", content: "hello" }], cost: 0 },
      headers: { Authorization: `Bearer ${token}` },
    }));
    assert.strictEqual(text.headers.get("X-MADchatter-Trial-Used"), "1");
    assert.strictEqual(text.headers.get("X-MADchatter-Trial-Remaining"), "29");
    const vision = await callWorker(env, makeRequest("POST", "/trial/chat", {
      body: { messages: [{ role: "user", content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQ" } },
      ] }] },
      headers: { Authorization: `Bearer ${token}` },
    }));
    assert.strictEqual(vision.headers.get("X-MADchatter-Trial-Used"), "3");
    assert.strictEqual(vision.headers.get("X-MADchatter-Trial-Remaining"), "27");
    assert.ok(vision.headers.get("X-MADchatter-Trial-Reset-At"));
    assert.ok(vision.body.choices, "OpenAI-compatible body must remain unwrapped");
  });

  await test("authenticated usage endpoint returns mobile usage and rejects missing session", async () => {
    const env = makeEnv();
    const token = await makeMobileToken(env);
    const unauthenticated = await callWorker(env, makeRequest("GET", "/trial/usage"));
    assert.strictEqual(unauthenticated.status, 401);
    const usage = await callWorker(env, makeRequest("GET", "/trial/usage", {
      headers: { Authorization: `Bearer ${token}` },
    }));
    assert.strictEqual(usage.status, 200);
    assert.strictEqual(usage.body.limited, true);
    assert.deepStrictEqual(usage.body.usage.used, 0);
    assert.deepStrictEqual(usage.body.usage.limit, 30);
  });

  await test("usage endpoint rejects an expired session", async () => {
    const env = makeEnv();
    const token = await makeExpiredToken(env);
    const result = await callWorker(env, makeRequest("GET", "/trial/usage", {
      headers: { Authorization: `Bearer ${token}` },
    }));
    assert.strictEqual(result.status, 401);
    assert.strictEqual(result.body.error.code, "SESSION_EXPIRED");
  });

  await test("reactivating with the same anonymous id preserves used allowance", async () => {
    groqResponse = { status: 200, body: { choices: [{ message: { content: "ok" } }] } };
    const env = makeEnv();
    const clientId = "55555555-5555-4555-8555-555555555555";
    const activate = () => callWorker(env, makeRequest("POST", "/trial/session", {
      body: { turnstileToken: "valid", clientId },
      headers: { "User-Agent": "Mozilla/5.0 (iPhone) AppleWebKit Mobile/15E148" },
    }));
    const firstToken = (await activate()).body.session.token;
    await callWorker(env, makeRequest("POST", "/trial/chat", {
      body: { messages: [{ role: "user", content: "hello" }] },
      headers: { Authorization: `Bearer ${firstToken}` },
    }));
    const secondToken = (await activate()).body.session.token;
    assert.notStrictEqual(firstToken, secondToken);
    const usage = await callWorker(env, makeRequest("GET", "/trial/usage", {
      headers: { Authorization: `Bearer ${secondToken}` },
    }));
    assert.strictEqual(usage.body.usage.used, 1);
    assert.strictEqual(usage.body.usage.remaining, 29);
  });

  await test("non-mobile session is explicitly non-limited", async () => {
    const env = makeEnv({ TRIAL_USAGE: makeUsageNamespace({ fail: true }) });
    const token = await makeValidToken(env);
    const usage = await callWorker(env, makeRequest("GET", "/trial/usage", {
      headers: { Authorization: `Bearer ${token}` },
    }));
    assert.deepStrictEqual(usage.body, { ok: true, limited: false, usage: null });
  });

  for (const [label, status, expectedCode] of [
    ["429", 429, "UPSTREAM_RATE_LIMITED"],
    ["500", 500, "UPSTREAM_UNAVAILABLE"],
    ["timeout", -1, "UPSTREAM_TIMEOUT"],
  ] as const) {
    await test(`upstream ${label} refunds mobile reservation`, async () => {
      groqResponse = { status, body: null };
      const env = makeEnv();
      const token = await makeMobileToken(env, `mobile_refund_${label}_abcdefghijklmnopqrstuvwxyz123`);
      const failed = await callWorker(env, makeRequest("POST", "/trial/chat", {
        body: { messages: [{ role: "user", content: "hello" }] },
        headers: { Authorization: `Bearer ${token}` },
      }));
      assert.strictEqual(failed.body.error.code, expectedCode);
      const usage = await callWorker(env, makeRequest("GET", "/trial/usage", {
        headers: { Authorization: `Bearer ${token}` },
      }));
      assert.strictEqual(usage.body.usage.used, 0);
    });
  }

  await test("quota storage failure fails closed before upstream", async () => {
    groqResponse = { status: 200, body: { choices: [{ message: { content: "nope" } }] } };
    const env = makeEnv({ TRIAL_USAGE: makeUsageNamespace({ fail: true }) });
    const token = await makeMobileToken(env);
    const before = groqCalls;
    const result = await callWorker(env, makeRequest("POST", "/trial/chat", {
      body: { messages: [{ role: "user", content: "hello" }] },
      headers: { Authorization: `Bearer ${token}` },
    }));
    assert.strictEqual(result.status, 503);
    assert.strictEqual(result.body.error.code, "INTERNAL_ERROR");
    assert.strictEqual(groqCalls, before);
  });

  await test("daily exhaustion returns distinct error, usage, and keeps session valid", async () => {
    groqResponse = { status: 200, body: { choices: [{ message: { content: "ok" } }] } };
    const env = makeEnv({ TRIAL_MOBILE_DAILY_LIMIT: "1" });
    const token = await makeMobileToken(env);
    const request = () => callWorker(env, makeRequest("POST", "/trial/chat", {
      body: { messages: [{ role: "user", content: "hello" }] },
      headers: { Authorization: `Bearer ${token}` },
    }));
    assert.strictEqual((await request()).status, 200);
    const exhausted = await request();
    assert.strictEqual(exhausted.status, 429);
    assert.strictEqual(exhausted.body.error.code, "TRIAL_DAILY_LIMIT_REACHED");
    assert.strictEqual(exhausted.body.usage.remaining, 0);
    const usage = await callWorker(env, makeRequest("GET", "/trial/usage", {
      headers: { Authorization: `Bearer ${token}` },
    }));
    assert.strictEqual(usage.status, 200, "quota exhaustion must not invalidate the session");
    assert.strictEqual(usage.body.usage.used, 1);
  });

  // Unknown route
  await test("unknown route → 404", async () => {
    const env = makeEnv();
    const res = await callWorker(env, makeRequest("GET", "/unknown"));
    assert.strictEqual(res.status, 404);
  });

  // Summary
  console.log(`\n${passed}/${passed + failed} tests passed; ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("Test harness error:", e);
  process.exitCode = 1;
});
