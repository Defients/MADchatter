/**
 * Bot Coordinator — focused test harness.
 *
 * Run with: npx tsx src/lib/botCoordinator.test.ts
 *
 * Tests the speaker floor coordinator: floor gap cooldown, bidding window
 * resolution, mention bonus, persona fit tiebreak, and force bypass.
 */

import { botCoordinator, DEFAULT_FLOOR_GAP_MS, type BotCandidate } from "./botCoordinator";

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

function makeCandidate(overrides: Partial<BotCandidate> = {}): BotCandidate {
  return {
    decision: "full_forge",
    confidence: 0.5,
    personaFit: 0.5,
    isMentioned: false,
    ...overrides,
  };
}

// ─── Floor Gap Cooldown ───────────────────────────────────────────────────────

await runTest("first request wins floor (no prior speaker)", async () => {
  botCoordinator.reset();
  const result = botCoordinator.requestFloor("bot1", makeCandidate({ confidence: 0.8 }));
  // Wait for bidding window to resolve
  await new Promise((r) => setTimeout(r, 100));
  const won = await result;
  assert(won === true, "first request should win the floor");
});

await runTest("second request within floor gap is rejected", async () => {
  botCoordinator.reset();
  // First request wins
  const r1 = botCoordinator.requestFloor("bot1", makeCandidate({ confidence: 0.8 }));
  await new Promise((r) => setTimeout(r, 100));
  await r1;
  // Second request within floor gap should be rejected
  const r2 = botCoordinator.requestFloor("bot2", makeCandidate({ confidence: 0.9 }));
  const won2 = await r2;
  assert(won2 === false, "request within floor gap should be rejected");
});

// ─── Bidding Window Resolution ────────────────────────────────────────────────

await runTest("higher confidence wins bidding window", async () => {
  botCoordinator.reset();
  const r1 = botCoordinator.requestFloor("bot1", makeCandidate({ confidence: 0.5 }));
  const r2 = botCoordinator.requestFloor("bot2", makeCandidate({ confidence: 0.9 }));
  await new Promise((r) => setTimeout(r, 100));
  const [won1, won2] = await Promise.all([r1, r2]);
  assert(won1 === false, "lower confidence should lose");
  assert(won2 === true, "higher confidence should win");
});

await runTest("mention bonus can override slight confidence gap", async () => {
  botCoordinator.reset();
  // bot1 has higher confidence (0.6), bot2 is mentioned (0.5 + 0.15 = 0.65)
  const r1 = botCoordinator.requestFloor("bot1", makeCandidate({ confidence: 0.6, isMentioned: false }));
  const r2 = botCoordinator.requestFloor("bot2", makeCandidate({ confidence: 0.5, isMentioned: true }));
  await new Promise((r) => setTimeout(r, 100));
  const [won1, won2] = await Promise.all([r1, r2]);
  assert(won2 === true, "mentioned bot should win with bonus");
  assert(won1 === false, "non-mentioned bot should lose");
});

await runTest("direct mention is not stolen by a higher-confidence bot", async () => {
  botCoordinator.reset();
  // Semantic coordination contract (v1.1): a direct @mention is a
  // conversational obligation. The mentioned bot owns the opportunity as long
  // as its own bid clears the speak threshold; a higher-confidence
  // non-mentioned bot defers instead of stealing the reply. (The legacy
  // 0.15 mention bonus let a 0.9-confidence bot steal a 0.5-confidence
  // mention — replaced by obligation priority.)
  const r1 = botCoordinator.requestFloor("bot1", makeCandidate({ confidence: 0.9, isMentioned: false }));
  const r2 = botCoordinator.requestFloor("bot2", makeCandidate({ confidence: 0.5, isMentioned: true }));
  await new Promise((r) => setTimeout(r, 100));
  const [won1, won2] = await Promise.all([r1, r2]);
  assert(won2 === true, "mentioned bot should win the floor (obligation priority)");
  assert(won1 === false, "non-mentioned bot should defer despite higher confidence");
});

await runTest("mention falls back when the target cannot clear the bar", async () => {
  botCoordinator.reset();
  // The mentioned bot's bid is too weak (confidence 0.05) to clear the
  // direct-mention speak threshold — the floor opens to fair competition.
  const r1 = botCoordinator.requestFloor("bot1", makeCandidate({ confidence: 0.9, isMentioned: false }));
  const r2 = botCoordinator.requestFloor("bot2", makeCandidate({ confidence: 0.05, isMentioned: true }));
  await new Promise((r) => setTimeout(r, 100));
  const [won1, won2] = await Promise.all([r1, r2]);
  assert(won1 === true, "strong non-mentioned bot should win when the target is under the bar");
  assert(won2 === false, "weak mentioned bid should not hold the floor hostage");
});

await runTest("persona fit breaks confidence ties", async () => {
  botCoordinator.reset();
  // Same confidence, different personaFit
  const r1 = botCoordinator.requestFloor("bot1", makeCandidate({ confidence: 0.7, personaFit: 0.3 }));
  const r2 = botCoordinator.requestFloor("bot2", makeCandidate({ confidence: 0.7, personaFit: 0.9 }));
  await new Promise((r) => setTimeout(r, 100));
  const [won1, won2] = await Promise.all([r1, r2]);
  assert(won2 === true, "higher persona fit should win tie");
  assert(won1 === false, "lower persona fit should lose tie");
});

// ─── Single Bot ───────────────────────────────────────────────────────────────

await runTest("single bot wins by default", async () => {
  botCoordinator.reset();
  const r = botCoordinator.requestFloor("bot1", makeCandidate({ confidence: 0.5 }));
  await new Promise((res) => setTimeout(res, 100));
  const won = await r;
  assert(won === true, "single bot should win by default");
});

// ─── Configuration ────────────────────────────────────────────────────────────

await runTest("configure changes floor gap", async () => {
  botCoordinator.reset();
  botCoordinator.configure({ floorGapMs: 100, bidWindowMs: 100 }); // short gap + short bid
  const r1 = botCoordinator.requestFloor("bot1", makeCandidate({ confidence: 0.8 }));
  await new Promise((res) => setTimeout(res, 200));
  await r1;
  // After 100ms gap, second request should win
  const r2 = botCoordinator.requestFloor("bot2", makeCandidate({ confidence: 0.8 }));
  await new Promise((res) => setTimeout(res, 200));
  const won2 = await r2;
  assert(won2 === true, "after short floor gap, second bot should win");
  // Reset to defaults
  botCoordinator.configure({ floorGapMs: DEFAULT_FLOOR_GAP_MS, bidWindowMs: 2500 });
});

// ─── Reset ────────────────────────────────────────────────────────────────────

await runTest("reset clears pending requests", async () => {
  botCoordinator.reset();
  const r = botCoordinator.requestFloor("bot1", makeCandidate({ confidence: 0.8 }));
  botCoordinator.reset(); // reset before window resolves
  const won = await r;
  assert(won === false, "pending request should be resolved false on reset");
});

// ─── DEFAULT_FLOOR_GAP_MS ─────────────────────────────────────────────────────

await runTest("DEFAULT_FLOOR_GAP_MS is 15 seconds", () => {
  assert(DEFAULT_FLOOR_GAP_MS === 15_000, `expected 15000, got ${DEFAULT_FLOOR_GAP_MS}`);
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(60)}`);
console.log(`Bot Coordinator tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
