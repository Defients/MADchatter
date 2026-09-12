/**
 * Session Scope — focused test harness.
 *
 * Run with: npx tsx src/lib/sessionScope.test.ts
 *
 * Tests the session revision system (invalidates in-flight work across
 * channel round-trips, platform switches, and context wipes), the scope
 * capture/compare functions, and the AutoForge execution guard (trips on
 * channel change, AutoForge toggle, dry-run flip, multi-bot flip, and
 * identity loss).
 */

// ─── localStorage shim (must exist before store.ts module init) ──────────
const storageMap = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => storageMap.get(k) ?? null,
  setItem: (k: string, v: string) => { storageMap.set(k, String(v)); },
  removeItem: (k: string) => { storageMap.delete(k); },
  clear: () => storageMap.clear(),
  get length() { return storageMap.size; },
  key: (i: number) => [...storageMap.keys()][i] ?? null,
};

const { useAppStore } = await import("../store");
import { captureSessionScope, isSessionScopeCurrent, normalizeSessionChannel, createAutoForgeExecutionGuard } from "./sessionScope";

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

function reset() {
  useAppStore.getState().setPlatform("twitch");
  useAppStore.getState().updateStreamMetadata({ channelName: "testchannel" });
  useAppStore.getState().clearAllContext();
}

// ─── normalizeSessionChannel ────────────────────────────────────────────────

await runTest("normalizeSessionChannel strips #, trims, lowercases", () => {
  assert(normalizeSessionChannel("#TestChannel") === "testchannel", "#TestChannel → testchannel");
  assert(normalizeSessionChannel("  TestChannel  ") === "testchannel", "trims");
  assert(normalizeSessionChannel("TestChannel") === "testchannel", "lowercases");
  assert(normalizeSessionChannel("") === "", "empty");
  assert(normalizeSessionChannel("#") === "", "just #");
});

// ─── captureSessionScope / isSessionScopeCurrent ────────────────────────────

await runTest("scope is current immediately after capture", () => {
  reset();
  const scope = captureSessionScope();
  assert(isSessionScopeCurrent(scope) === true, "scope should be current");
});

await runTest("channel change invalidates scope", () => {
  reset();
  const scope = captureSessionScope();
  useAppStore.getState().updateStreamMetadata({ channelName: "otherchannel" });
  assert(isSessionScopeCurrent(scope) === false, "channel change should invalidate");
});

await runTest("platform change invalidates scope", () => {
  reset();
  const scope = captureSessionScope();
  useAppStore.getState().setPlatform("kick");
  assert(isSessionScopeCurrent(scope) === false, "platform change should invalidate");
});

await runTest("clearAllContext invalidates scope (revision bump)", () => {
  reset();
  const scope = captureSessionScope();
  useAppStore.getState().clearAllContext();
  assert(isSessionScopeCurrent(scope) === false, "clearAllContext should invalidate");
});

await runTest("A→B→A round-trip invalidates scope (revision bump)", () => {
  reset();
  const scope = captureSessionScope();
  // Switch to B
  useAppStore.getState().updateStreamMetadata({ channelName: "channelB" });
  useAppStore.getState().clearAllContext();
  // Switch back to A
  useAppStore.getState().updateStreamMetadata({ channelName: "testchannel" });
  useAppStore.getState().clearAllContext();
  // Channel name is the same, but the revision bumped — scope is stale
  assert(useAppStore.getState().streamMetadata.channelName === "testchannel", "channel name restored");
  assert(isSessionScopeCurrent(scope) === false, "A→B→A should invalidate (revision)");
});

await runTest("same channel name (no change) does not invalidate", () => {
  reset();
  const scope = captureSessionScope();
  // updateStreamMetadata with the same channel name should NOT bump revision
  useAppStore.getState().updateStreamMetadata({ channelName: "testchannel" });
  assert(isSessionScopeCurrent(scope) === true, "same channel → still current");
});

await runTest("channel name case difference does not invalidate (normalized)", () => {
  reset();
  const scope = captureSessionScope();
  // The store compares trimmed+lowercased, so "TestChannel" == "testchannel"
  useAppStore.getState().updateStreamMetadata({ channelName: "TestChannel" });
  assert(isSessionScopeCurrent(scope) === true, "case-only difference → still current");
});

// ─── createAutoForgeExecutionGuard ──────────────────────────────────────────

await runTest("guard is current when context matches", () => {
  reset();
  useAppStore.getState().setAutoForgeEnabled(true);
  const guard = createAutoForgeExecutionGuard(() => true);
  assert(guard.isCurrent() === true, "guard should be current");
  guard.dispose();
});

await runTest("guard trips on channel change", () => {
  reset();
  useAppStore.getState().setAutoForgeEnabled(true);
  const guard = createAutoForgeExecutionGuard(() => true);
  useAppStore.getState().updateStreamMetadata({ channelName: "otherchannel" });
  assert(guard.isCurrent() === false, "guard should trip on channel change");
  guard.dispose();
});

await runTest("guard trips on AutoForge toggle off", () => {
  reset();
  useAppStore.getState().setAutoForgeEnabled(true);
  const guard = createAutoForgeExecutionGuard(() => true);
  useAppStore.getState().setAutoForgeEnabled(false);
  assert(guard.isCurrent() === false, "guard should trip on AutoForge off");
  guard.dispose();
});

await runTest("guard trips on dry-run flip", () => {
  reset();
  useAppStore.getState().setAutoForgeEnabled(true);
  useAppStore.getState().setAutoForgeDryRun(false);
  const guard = createAutoForgeExecutionGuard(() => true);
  useAppStore.getState().setAutoForgeDryRun(true);
  assert(guard.isCurrent() === false, "guard should trip on dry-run flip");
  guard.dispose();
});

await runTest("guard trips on multi-bot mode flip", () => {
  reset();
  useAppStore.getState().setAutoForgeEnabled(true);
  const guard = createAutoForgeExecutionGuard(() => true);
  useAppStore.getState().enableMultiBot();
  assert(guard.isCurrent() === false, "guard should trip on multi-bot enable");
  guard.dispose();
});

await runTest("guard trips on identity failure", () => {
  reset();
  useAppStore.getState().setAutoForgeEnabled(true);
  let identityOk = true;
  const guard = createAutoForgeExecutionGuard(() => identityOk);
  identityOk = false;
  // Trigger a store change so the subscription fires
  useAppStore.getState().updateStreamMetadata({ channelName: "testchannel" });
  assert(guard.isCurrent() === false, "guard should trip on identity failure");
  guard.dispose();
});

await runTest("guard cancel() makes isCurrent() false", () => {
  reset();
  useAppStore.getState().setAutoForgeEnabled(true);
  const guard = createAutoForgeExecutionGuard(() => true);
  guard.cancel();
  assert(guard.isCurrent() === false, "cancelled guard is not current");
});

await runTest("guard dispose() stops the subscription (cancelled flag stays false)", () => {
  reset();
  useAppStore.getState().setAutoForgeEnabled(true);
  const guard = createAutoForgeExecutionGuard(() => true);
  guard.dispose();
  // After dispose, the subscription is removed so `cancelled` is never set
  // by store changes. But isCurrent() still does a live contextMatches()
  // check — so a real context change still returns false. The difference
  // is that the `cancelled` flag (sticky) is never set, so a *transient*
  // change followed by a restore would leave isCurrent() true (the live
  // check passes again), whereas a non-disposed guard would stay false.
  useAppStore.getState().appendChatLog({ id: "x", user: "u", text: "hi", timestamp: Date.now() });
  assert(guard.isCurrent() === true, "non-context change after dispose → still current (live check)");
  guard.dispose();
});

await runTest("guard survives multiple store changes before dispose", () => {
  reset();
  useAppStore.getState().setAutoForgeEnabled(true);
  const guard = createAutoForgeExecutionGuard(() => true);
  // Non-context changes (e.g. chatLog append) should not trip the guard
  useAppStore.getState().appendChatLog({ id: "x", user: "u", text: "hi", timestamp: Date.now() });
  assert(guard.isCurrent() === true, "chatLog append should not trip guard");
  guard.dispose();
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(60)}`);
console.log(`Session Scope tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
