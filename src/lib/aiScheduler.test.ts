/**
 * AI Scheduler — focused test harness.
 *
 * Run with: npx tsx src/lib/aiScheduler.test.ts
 *
 * Tests the scheduler's core invariants deterministically without making
 * real AI calls. Uses fake tasks that resolve/reject on demand.
 */

import {
  aiScheduler,
  AIRequestTimeoutError,
  AIRequestPreemptedError,
  AIRequestCancelledError,
  isSchedulerCancellation,
  isSchedulerTimeout,
  buildProviderRequestOptions,
  getOperationTokenBudget,
  getOperationTimeout,
  type AIRequestPriority,
} from "./aiScheduler";

// ─── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(msg);
    console.error(`  FAIL: ${msg}`);
  }
}

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n▸ ${name}`);
  try {
    await fn();
  } catch (e: any) {
    failed++;
    failures.push(`${name}: threw ${e?.message ?? e}`);
    console.error(`  FAIL: threw ${e?.message ?? e}`);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Create a controllable task that resolves with `value` after `delayMs`. */
function makeResolvingTask<T>(value: T, delayMs = 0): (signal: AbortSignal) => Promise<T> {
  return (signal: AbortSignal) => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(value), delayMs);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

/** Create a controllable task that never resolves (hangs forever). */
function makeHangingTask(): (signal: AbortSignal) => Promise<never> {
  return (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

/** Create a task that tracks whether it was actually aborted. */
function makeAbortTrackingTask(): { task: (signal: AbortSignal) => Promise<string>; wasAborted: () => boolean } {
  let aborted = false;
  return {
    task: (signal: AbortSignal) => new Promise<string>((resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
      // Resolve after a long delay (will be aborted before this).
      setTimeout(() => resolve("completed"), 10_000);
    }),
    wasAborted: () => aborted,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function testBasicExecution() {
  const result = await aiScheduler.execute(
    makeResolvingTask("hello", 10),
    { operation: "test-basic", provider: "gemini", priority: "critical", timeoutMs: 5000 },
  );
  assert(result === "hello", "should return the task result");
}

async function testTimeoutCancels() {
  const tracker = makeAbortTrackingTask();
  try {
    await aiScheduler.execute(
      tracker.task,
      { operation: "test-timeout", provider: "gemini", priority: "critical", timeoutMs: 50 },
    );
    assert(false, "should have thrown AIRequestTimeoutError");
  } catch (e) {
    assert(e instanceof AIRequestTimeoutError, "should throw AIRequestTimeoutError");
    assert(isSchedulerTimeout(e), "isSchedulerTimeout should be true");
    assert(tracker.wasAborted(), "underlying task should have been aborted");
  }
}

async function testPreemption() {
  // Start a background Ollama request that hangs.
  const tracker = makeAbortTrackingTask();
  const bgPromise = aiScheduler.execute(
    tracker.task,
    { operation: "bg-memory", provider: "ollama", priority: "background", timeoutMs: 10_000 },
  ).catch((e) => e); // capture the error, don't throw

  // Wait a tick for the background request to start.
  await new Promise((r) => setTimeout(r, 20));

  // Now start a critical (Forge) request — should preempt the background.
  const forgeResult = await aiScheduler.execute(
    makeResolvingTask("forge-done", 10),
    { operation: "forge", provider: "ollama", priority: "critical", timeoutMs: 5000 },
  );
  assert(forgeResult === "forge-done", "Forge should complete immediately after preemption");

  // The background request should have been preempted.
  const bgError = await bgPromise;
  assert(bgError instanceof AIRequestPreemptedError, "background should be preempted");
  assert(isSchedulerCancellation(bgError), "preemption should be a scheduler cancellation");
  assert(!isSchedulerTimeout(bgError), "preemption should NOT be a timeout");
  assert(tracker.wasAborted(), "background task should have been aborted");
}

async function testPreemptionNotProviderFailure() {
  // This is a semantic test: preemption errors should not be treated as
  // provider failures. The caller (autoforgeDecide) checks isSchedulerCancellation.
  const tracker = makeAbortTrackingTask();
  const bgPromise = aiScheduler.execute(
    tracker.task,
    { operation: "bg-memory", provider: "ollama", priority: "background", timeoutMs: 10_000 },
  ).catch((e) => e);

  await new Promise((r) => setTimeout(r, 20));

  await aiScheduler.execute(
    makeResolvingTask("forge", 10),
    { operation: "forge", provider: "ollama", priority: "critical", timeoutMs: 5000 },
  );

  const bgError = await bgPromise;
  // The key invariant: isSchedulerCancellation returns true, so the caller
  // should NOT call recordProviderFailure.
  assert(isSchedulerCancellation(bgError), "preemption should be cancellation, not failure");
}

async function testCloudConcurrency() {
  // Cloud providers should NOT serialize. Two concurrent cloud requests
  // should both run simultaneously.
  const t0 = Date.now();
  const [r1, r2] = await Promise.all([
    aiScheduler.execute(
      makeResolvingTask("a", 50),
      { operation: "cloud-a", provider: "gemini", priority: "critical", timeoutMs: 5000 },
    ),
    aiScheduler.execute(
      makeResolvingTask("b", 50),
      { operation: "cloud-b", provider: "openai", priority: "critical", timeoutMs: 5000 },
    ),
  ]);
  const elapsed = Date.now() - t0;
  assert(r1 === "a" && r2 === "b", "both should complete");
  assert(elapsed < 100, `cloud requests should run concurrently (elapsed=${elapsed}ms)`);
}

async function testOllamaSerialization() {
  // Two Ollama requests at the same priority should serialize (not concurrent).
  const t0 = Date.now();
  const [r1, r2] = await Promise.all([
    aiScheduler.execute(
      makeResolvingTask("first", 50),
      { operation: "ollama-1", provider: "ollama", priority: "autonomous", timeoutMs: 5000 },
    ),
    aiScheduler.execute(
      makeResolvingTask("second", 50),
      { operation: "ollama-2", provider: "ollama", priority: "autonomous", timeoutMs: 5000 },
    ),
  ]);
  const elapsed = Date.now() - t0;
  assert(r1 === "first" && r2 === "second", "both should complete");
  assert(elapsed >= 100, `ollama requests should serialize (elapsed=${elapsed}ms, expected >=100)`);
}

async function testDedup() {
  // Two requests with the same dedupeKey — second should be cancelled.
  const key = "test-dedupe-" + Date.now();
  const p1 = aiScheduler.execute(
    makeHangingTask(),
    { operation: "dedup-1", provider: "ollama", priority: "background", timeoutMs: 10_000, dedupeKey: key },
  ).catch((e) => e);
  const p2 = aiScheduler.execute(
    makeResolvingTask("dup", 10),
    { operation: "dedup-2", provider: "ollama", priority: "background", timeoutMs: 5000, dedupeKey: key },
  ).catch((e) => e);

  const [r1, r2] = await Promise.all([p1, p2]);
  // The first request is hanging; the second should be cancelled as duplicate.
  // (Which one gets cancelled depends on timing, but the dedupe guard should
  // prevent both from running.)
  const oneCancelled = r1 instanceof AIRequestCancelledError || r2 instanceof AIRequestCancelledError;
  assert(oneCancelled, "one of the duplicate requests should be cancelled");
}

async function testProviderSwitchCancels() {
  // Start an Ollama request, then cancel it via cancelProvider.
  const tracker = makeAbortTrackingTask();
  const bgPromise = aiScheduler.execute(
    tracker.task,
    { operation: "ollama-bg", provider: "ollama", priority: "background", timeoutMs: 10_000 },
  ).catch((e) => e);

  await new Promise((r) => setTimeout(r, 20));
  aiScheduler.cancelProvider("ollama", "provider changed");

  const error = await bgPromise;
  assert(tracker.wasAborted(), "should be aborted after cancelProvider");
  assert(isSchedulerCancellation(error) || isSchedulerTimeout(error), "should be cancellation or timeout");
}

async function testSlotReleased() {
  // After a request completes/fails/times out, the Ollama slot should be released.
  await aiScheduler.execute(
    makeResolvingTask("done", 10),
    { operation: "slot-1", provider: "ollama", priority: "critical", timeoutMs: 5000 },
  );
  assert(!aiScheduler.isOllamaBusy(), "Ollama slot should be released after completion");

  // Now a second request should start immediately.
  const t0 = Date.now();
  await aiScheduler.execute(
    makeResolvingTask("done2", 10),
    { operation: "slot-2", provider: "ollama", priority: "critical", timeoutMs: 5000 },
  );
  const elapsed = Date.now() - t0;
  assert(elapsed < 100, `second request should start immediately after slot release (elapsed=${elapsed}ms)`);
}

async function testSlotReleasedOnTimeout() {
  // After a timeout, the slot should be released.
  try {
    await aiScheduler.execute(
      makeHangingTask(),
      { operation: "slot-timeout", provider: "ollama", priority: "critical", timeoutMs: 50 },
    );
  } catch {
    // expected
  }
  assert(!aiScheduler.isOllamaBusy(), "Ollama slot should be released after timeout");
}

async function testSlotReleasedOnFailure() {
  // After a genuine error, the slot should be released.
  const failingTask = (signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    setTimeout(() => reject(new Error("genuine failure")), 10);
  });
  try {
    await aiScheduler.execute(
      failingTask,
      { operation: "slot-fail", provider: "ollama", priority: "critical", timeoutMs: 5000 },
    );
  } catch {
    // expected
  }
  assert(!aiScheduler.isOllamaBusy(), "Ollama slot should be released after failure");
}

async function testOllamaReasoningDisabled() {
  const opts = buildProviderRequestOptions("ollama");
  assert(opts.reasoning_effort === "none", "Ollama should have reasoning_effort=none");
}

async function testCloudNoReasoningField() {
  const geminiOpts = buildProviderRequestOptions("gemini");
  const openaiOpts = buildProviderRequestOptions("openai");
  const claudeOpts = buildProviderRequestOptions("claude");
  assert(!("reasoning_effort" in geminiOpts), "Gemini should NOT have reasoning_effort");
  assert(!("reasoning_effort" in openaiOpts), "OpenAI should NOT have reasoning_effort");
  assert(!("reasoning_effort" in claudeOpts), "Claude should NOT have reasoning_effort");
}

async function testTokenBudgets() {
  // Forge budget scales with card count.
  const low1 = getOperationTokenBudget("forge", "low", 1);
  const low5 = getOperationTokenBudget("forge", "low", 5);
  assert(low5 > low1, "5-card Forge should have higher budget than 1-card");

  const high1 = getOperationTokenBudget("forge", "high", 1);
  const high5 = getOperationTokenBudget("forge", "high", 5);
  assert(high5 > high1, "5-card high-effort Forge should have higher budget than 1-card");

  // Memory extraction has a bounded budget.
  const memBudget = getOperationTokenBudget("memory_extraction");
  assert(memBudget > 0 && memBudget <= 2048, `memory extraction budget should be bounded (got ${memBudget})`);

  // Vision is small.
  const visionBudget = getOperationTokenBudget("vision");
  assert(visionBudget <= 1024, `vision budget should be small (got ${visionBudget})`);
}

async function testTimeouts() {
  const forgeTimeout = getOperationTimeout("forge", "ollama");
  const memTimeout = getOperationTimeout("memory_extraction", "ollama");
  assert(forgeTimeout > memTimeout, "Forge should have longer timeout than memory extraction on Ollama");

  const cloudForgeTimeout = getOperationTimeout("forge", "gemini");
  assert(cloudForgeTimeout > 0, "cloud Forge timeout should be positive");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══ AI Scheduler Test Suite ═══");

  await runTest("Basic execution", testBasicExecution);
  await runTest("Timeout cancels underlying task", testTimeoutCancels);
  await runTest("Preemption: Forge preempts background", testPreemption);
  await runTest("Preemption is not provider failure", testPreemptionNotProviderFailure);
  await runTest("Cloud providers run concurrently", testCloudConcurrency);
  await runTest("Ollama requests serialize", testOllamaSerialization);
  await runTest("Dedup prevents duplicate requests", testDedup);
  await runTest("Provider switch cancels active requests", testProviderSwitchCancels);
  await runTest("Slot released after completion", testSlotReleased);
  await runTest("Slot released after timeout", testSlotReleasedOnTimeout);
  await runTest("Slot released after failure", testSlotReleasedOnFailure);
  await runTest("Ollama reasoning disabled by default", testOllamaReasoningDisabled);
  await runTest("Cloud providers don't get Ollama fields", testCloudNoReasoningField);
  await runTest("Token budgets scale correctly", testTokenBudgets);
  await runTest("Timeouts are operation-aware", testTimeouts);

  console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  } else {
    console.log("\n✓ All tests passed");
    process.exit(0);
  }
}

main().catch((e) => {
  console.error("Test harness crashed:", e);
  process.exit(1);
});
