/**
 * Friend Trial — frontend client tests.
 *
 * Runs with: npx tsx src/lib/trial.test.ts
 *
 * Tests the trial session management, fetch override (image stripping +
 * routing), and config helpers. No real network calls — fetch is mocked.
 * No real secrets are used.
 */
import assert from "node:assert";

// ── Mock storage ──────────────────────────────────────────────────────────────

const memStore: Record<string, string> = {};
const sessionStore: Record<string, string> = {};

// @ts-expect-error — mock localStorage
globalThis.localStorage = {
  getItem: (k: string) => memStore[k] ?? null,
  setItem: (k: string, v: string) => { memStore[k] = v; },
  removeItem: (k: string) => { delete memStore[k]; },
  clear: () => { for (const k of Object.keys(memStore)) delete memStore[k]; },
};
// @ts-expect-error — mock sessionStorage
globalThis.sessionStorage = {
  getItem: (k: string) => sessionStore[k] ?? null,
  setItem: (k: string, v: string) => { sessionStore[k] = v; },
  removeItem: (k: string) => { delete sessionStore[k]; },
  clear: () => { for (const k of Object.keys(sessionStore)) delete sessionStore[k]; },
};

// ── Mock fetch ────────────────────────────────────────────────────────────────

let mockFetchResponse: { status: number; body: any } = { status: 200, body: {} };
let capturedFetchUrl: string = "";
let capturedFetchInit: any = null;

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url || "";
  capturedFetchUrl = url;
  capturedFetchInit = init;
  return {
    ok: mockFetchResponse.status >= 200 && mockFetchResponse.status < 300,
    status: mockFetchResponse.status,
    headers: new Headers({ "Content-Type": "application/json" }),
    json: async () => mockFetchResponse.body,
    text: async () => JSON.stringify(mockFetchResponse.body),
  } as any;
}) as any;

// ── Import after mocks are in place ──────────────────────────────────────────

const {
  TRIAL_PROVIDER, getTrialToken, setTrialSession, clearTrialSession,
  isTrialSessionValid, getTrialWorkerUrl, setTrialWorkerUrl,
  getTrialTurnstileSiteKey, setTrialTurnstileSiteKey, isTrialConfigured,
  fetchTrialStatus, createTrialSession, createTrialFetch, trialSupportsVision,
  resetTrialVisionCapability,
} = await import("./trial.ts");

// ── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}\n    ${(e as Error).message}`);
  }
}

function reset() {
  for (const k of Object.keys(memStore)) delete memStore[k];
  for (const k of Object.keys(sessionStore)) delete sessionStore[k];
  mockFetchResponse = { status: 200, body: {} };
  capturedFetchUrl = "";
  capturedFetchInit = null;
  resetTrialVisionCapability();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\nFriend Trial — frontend tests\n");

  await test("TRIAL_PROVIDER is 'trial'", () => {
    assert.strictEqual(TRIAL_PROVIDER, "trial");
  });

  // Session token management
  await test("getTrialToken returns null when no session", () => {
    reset();
    assert.strictEqual(getTrialToken(), null);
  });

  await test("setTrialSession stores token + expiry in sessionStorage", () => {
    reset();
    setTrialSession("test-token", Math.floor(Date.now() / 1000) + 3600);
    assert.strictEqual(getTrialToken(), "test-token");
    assert.ok(isTrialSessionValid());
  });

  await test("clearTrialSession removes token + expiry", () => {
    reset();
    setTrialSession("test-token", Math.floor(Date.now() / 1000) + 3600);
    clearTrialSession();
    assert.strictEqual(getTrialToken(), null);
    assert.strictEqual(isTrialSessionValid(), false);
  });

  await test("isTrialSessionValid returns false for expired session", () => {
    reset();
    setTrialSession("test-token", Math.floor(Date.now() / 1000) - 10);
    assert.strictEqual(isTrialSessionValid(), false);
  });

  // Worker URL config
  await test("setTrialWorkerUrl + getTrialWorkerUrl round-trip", () => {
    reset();
    setTrialWorkerUrl("https://friend-trial.example.workers.dev/");
    assert.strictEqual(getTrialWorkerUrl(), "https://friend-trial.example.workers.dev");
  });

  await test("isTrialConfigured returns false when no URL set", () => {
    reset();
    assert.strictEqual(isTrialConfigured(), false);
  });

  await test("isTrialConfigured returns true when URL set", () => {
    reset();
    setTrialWorkerUrl("https://friend-trial.example.workers.dev");
    assert.strictEqual(isTrialConfigured(), true);
  });

  // Turnstile site key
  await test("setTrialTurnstileSiteKey + getTrialTurnstileSiteKey round-trip", () => {
    reset();
    setTrialTurnstileSiteKey("0x4AAAAAAAAtest");
    assert.strictEqual(getTrialTurnstileSiteKey(), "0x4AAAAAAAAtest");
  });

  // fetchTrialStatus
  await test("fetchTrialStatus returns enabled status", async () => {
    reset();
    setTrialWorkerUrl("https://friend-trial.example.workers.dev");
    mockFetchResponse = { status: 200, body: { ok: true, trial: { enabled: true, requiresTurnstile: true, requiresInviteCode: false } } };
    const status = await fetchTrialStatus(getTrialWorkerUrl());
    assert.strictEqual(status.enabled, true);
    assert.strictEqual(status.requiresTurnstile, true);
    assert.ok(capturedFetchUrl.endsWith("/trial/status"));
  });

  await test("fetchTrialStatus handles error response", async () => {
    reset();
    setTrialWorkerUrl("https://friend-trial.example.workers.dev");
    mockFetchResponse = { status: 500, body: {} };
    const status = await fetchTrialStatus(getTrialWorkerUrl());
    assert.strictEqual(status.enabled, false);
  });

  // createTrialSession
  await test("createTrialSession returns token on success", async () => {
    reset();
    setTrialWorkerUrl("https://friend-trial.example.workers.dev");
    mockFetchResponse = { status: 200, body: { ok: true, session: { token: "session-token", expiresAt: 9999999999 } } };
    const result = await createTrialSession(getTrialWorkerUrl(), "turnstile-token");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.token, "session-token");
    assert.ok(capturedFetchUrl.endsWith("/trial/session"));
    assert.strictEqual(JSON.parse(capturedFetchInit.body).turnstileToken, "turnstile-token");
  });

  await test("createTrialSession includes invite code when provided", async () => {
    reset();
    setTrialWorkerUrl("https://friend-trial.example.workers.dev");
    mockFetchResponse = { status: 200, body: { ok: true, session: { token: "t", expiresAt: 1 } } };
    await createTrialSession(getTrialWorkerUrl(), "ts", "INVITE123");
    assert.strictEqual(JSON.parse(capturedFetchInit.body).inviteCode, "INVITE123");
  });

  await test("createTrialSession returns error on failure", async () => {
    reset();
    setTrialWorkerUrl("https://friend-trial.example.workers.dev");
    mockFetchResponse = { status: 403, body: { ok: false, error: { code: "TURNSTILE_FAILED" } } };
    const result = await createTrialSession(getTrialWorkerUrl(), "bad");
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "TURNSTILE_FAILED");
  });

  // createTrialFetch — routing
  await test("createTrialFetch routes chat completions to /trial/chat", async () => {
    reset();
    setTrialWorkerUrl("https://friend-trial.example.workers.dev");
    setTrialSession("test-token", Math.floor(Date.now() / 1000) + 3600);
    mockFetchResponse = { status: 200, body: { choices: [{ message: { content: "hi" } }] } };
    const trialFetch = createTrialFetch();
    await trialFetch("https://friend-trial.placeholder.workers.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "ignored", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.ok(capturedFetchUrl.endsWith("/trial/chat"), `expected /trial/chat, got ${capturedFetchUrl}`);
    assert.strictEqual(capturedFetchInit.headers.Authorization, "Bearer test-token");
  });

  await test("createTrialFetch passes through non-chat requests", async () => {
    reset();
    setTrialWorkerUrl("https://friend-trial.example.workers.dev");
    setTrialSession("test-token", Math.floor(Date.now() / 1000) + 3600);
    mockFetchResponse = { status: 200, body: { data: [] } };
    const trialFetch = createTrialFetch();
    await trialFetch("https://friend-trial.placeholder.workers.dev/v1/models");
    assert.ok(capturedFetchUrl.endsWith("/v1/models"), "non-chat requests should pass through");
  });

  // createTrialFetch — image stripping
  await test("createTrialFetch strips image parts from multimodal content", async () => {
    reset();
    setTrialWorkerUrl("https://friend-trial.example.workers.dev");
    setTrialSession("test-token", Math.floor(Date.now() / 1000) + 3600);
    mockFetchResponse = { status: 200, body: { choices: [{ message: { content: "hi" } }] } };
    const trialFetch = createTrialFetch();
    await trialFetch("https://friend-trial.placeholder.workers.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: [
            { type: "text", text: "describe this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
          ] },
        ],
      }),
    });
    const forwarded = JSON.parse(capturedFetchInit.body);
    assert.strictEqual(typeof forwarded.messages[0].content, "string", "content must be string after stripping");
    assert.strictEqual(forwarded.messages[0].content, "describe this");
    assert.ok(!JSON.stringify(forwarded).includes("image_url"), "no image data should be forwarded");
    assert.ok(!JSON.stringify(forwarded).includes("base64"), "no base64 data should be forwarded");
  });

  await test("createTrialFetch passes string content through unchanged", async () => {
    reset();
    setTrialWorkerUrl("https://friend-trial.example.workers.dev");
    setTrialSession("test-token", Math.floor(Date.now() / 1000) + 3600);
    mockFetchResponse = { status: 200, body: { choices: [{ message: { content: "hi" } }] } };
    const trialFetch = createTrialFetch();
    await trialFetch("https://friend-trial.placeholder.workers.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "plain text" }] }),
    });
    const forwarded = JSON.parse(capturedFetchInit.body);
    assert.strictEqual(forwarded.messages[0].content, "plain text");
  });

  // createTrialFetch — vision-capable (forwards multimodal content)
  await test("fetchTrialStatus caches supportsVision capability", async () => {
    reset();
    setTrialWorkerUrl("https://friend-trial.example.workers.dev");
    mockFetchResponse = { status: 200, body: { ok: true, trial: { enabled: true, requiresTurnstile: true, requiresInviteCode: false, supportsVision: true } } };
    assert.strictEqual(trialSupportsVision(), false, "not cached yet");
    await fetchTrialStatus(getTrialWorkerUrl());
    assert.strictEqual(trialSupportsVision(), true, "cached after fetch");
  });

  await test("createTrialFetch forwards multimodal content when vision supported", async () => {
    reset();
    setTrialWorkerUrl("https://friend-trial.example.workers.dev");
    setTrialSession("test-token", Math.floor(Date.now() / 1000) + 3600);
    // First fetch the status to cache the vision capability.
    mockFetchResponse = { status: 200, body: { ok: true, trial: { enabled: true, requiresTurnstile: true, requiresInviteCode: false, supportsVision: true } } };
    await fetchTrialStatus(getTrialWorkerUrl());
    // Now the chat request should forward images unchanged.
    mockFetchResponse = { status: 200, body: { choices: [{ message: { content: "I see it" } }] } };
    const trialFetch = createTrialFetch();
    await trialFetch("https://friend-trial.placeholder.workers.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: [
            { type: "text", text: "describe this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
          ] },
        ],
      }),
    });
    const forwarded = JSON.parse(capturedFetchInit.body);
    assert.ok(Array.isArray(forwarded.messages[0].content), "content must remain array when vision supported");
    assert.strictEqual(forwarded.messages[0].content[0].type, "text");
    assert.strictEqual(forwarded.messages[0].content[1].type, "image_url");
    assert.ok(JSON.stringify(forwarded).includes("image_url"), "image data should be forwarded");
  });

  await test("createTrialFetch strips images when vision not supported", async () => {
    reset();
    setTrialWorkerUrl("https://friend-trial.example.workers.dev");
    setTrialSession("test-token", Math.floor(Date.now() / 1000) + 3600);
    // No status fetch — vision capability not cached, defaults to false.
    mockFetchResponse = { status: 200, body: { choices: [{ message: { content: "hi" } }] } };
    const trialFetch = createTrialFetch();
    await trialFetch("https://friend-trial.placeholder.workers.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: [
            { type: "text", text: "describe this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
          ] },
        ],
      }),
    });
    const forwarded = JSON.parse(capturedFetchInit.body);
    assert.strictEqual(typeof forwarded.messages[0].content, "string", "content must be string after stripping");
    assert.ok(!JSON.stringify(forwarded).includes("image_url"), "no image data should be forwarded");
  });

  // createTrialFetch — error handling
  await test("createTrialFetch throws when no worker URL configured", async () => {
    reset();
    setTrialSession("test-token", Math.floor(Date.now() / 1000) + 3600);
    const trialFetch = createTrialFetch();
    await assert.rejects(
      () => trialFetch("https://x.workers.dev/v1/chat/completions", { method: "POST", body: "{}" }),
      /not configured/i,
    );
  });

  await test("createTrialFetch throws when no session token", async () => {
    reset();
    setTrialWorkerUrl("https://friend-trial.example.workers.dev");
    const trialFetch = createTrialFetch();
    await assert.rejects(
      () => trialFetch("https://x.workers.dev/v1/chat/completions", { method: "POST", body: "{}" }),
      /session expired/i,
    );
  });

  await test("createTrialFetch clears session on 401", async () => {
    reset();
    setTrialWorkerUrl("https://friend-trial.example.workers.dev");
    setTrialSession("test-token", Math.floor(Date.now() / 1000) + 3600);
    mockFetchResponse = { status: 401, body: { ok: false, error: { code: "SESSION_EXPIRED" } } };
    const trialFetch = createTrialFetch();
    await trialFetch("https://friend-trial.placeholder.workers.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    // Session should be cleared after 401.
    assert.strictEqual(getTrialToken(), null, "session token must be cleared after 401");
  });

  // Security: no Groq key in frontend
  await test("trial module never contains GROQ_API_KEY or gsk_ prefix", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(new URL("./trial.ts", import.meta.url), "utf8");
    assert.ok(!source.includes("gsk_"), "trial module must not contain Groq key prefix");
    assert.ok(!source.includes("GROQ_API_KEY"), "trial module must not reference GROQ_API_KEY");
  });

  // Summary
  console.log(`\n${passed}/${passed + failed} tests passed; ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("Test harness error:", e);
  process.exitCode = 1;
});
