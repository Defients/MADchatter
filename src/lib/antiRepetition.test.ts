/**
 * Anti-Repetition — focused test harness.
 *
 * Run with: npx tsx src/lib/antiRepetition.test.ts
 *
 * Tests n-gram extraction, opening phrase detection, Jaccard similarity,
 * and the repetition analysis pipeline.
 */

import { analyzeRepetition, formatRepetitionContext, isNearDuplicate } from "./antiRepetition";
import type { SentMessage } from "../types";

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

// ─── analyzeRepetition ────────────────────────────────────────────────────────

await runTest("empty history returns variety score 1.0", () => {
  const r = analyzeRepetition([]);
  assert(r.varietyScore === 1.0, `empty should be 1.0, got ${r.varietyScore}`);
  assert(r.recentMessages.length === 0, "no recent messages");
});

await runTest("varied messages have high variety score", () => {
  const msgs: SentMessage[] = [
    { id: "1", message: "that was incredible", channel: "test", timestamp: 0, source: "manual" },
    { id: "2", message: "what a play", channel: "test", timestamp: 1, source: "manual" },
    { id: "3", message: "love this stream", channel: "test", timestamp: 2, source: "manual" },
    { id: "4", message: "how does he do it", channel: "test", timestamp: 3, source: "manual" },
  ];
  const r = analyzeRepetition(msgs);
  assert(r.varietyScore > 0.7, `varied messages should have high variety, got ${r.varietyScore}`);
});

await runTest("repeated messages have low variety score", () => {
  const msgs: SentMessage[] = [];
  for (let i = 0; i < 10; i++) {
    msgs.push({ id: String(i), message: "lol that was funny", channel: "test", timestamp: i, source: "manual" });
  }
  const r = analyzeRepetition(msgs);
  assert(r.varietyScore < 0.5, `repeated messages should have low variety, got ${r.varietyScore}`);
  assert(r.repeatedPhrases.length > 0, "should detect repeated phrases");
});

await runTest("repeated opening phrases detected", () => {
  const msgs: SentMessage[] = [
    { id: "1", message: "hey everyone", channel: "test", timestamp: 0, source: "manual" },
    { id: "2", message: "hey what's up", channel: "test", timestamp: 1, source: "manual" },
    { id: "3", message: "hey how are you", channel: "test", timestamp: 2, source: "manual" },
  ];
  const r = analyzeRepetition(msgs);
  assert(r.openingPhrases.includes("hey"), `should detect "hey" opening, got ${JSON.stringify(r.openingPhrases)}`);
});

await runTest("average message length computed", () => {
  const msgs: SentMessage[] = [
    { id: "1", message: "hi", channel: "test", timestamp: 0, source: "manual" },
    { id: "2", message: "hello world", channel: "test", timestamp: 1, source: "manual" },
  ];
  const r = analyzeRepetition(msgs);
  // "hi" = 2 chars, "hello world" = 11 chars, avg = 6.5
  assert(r.averageMessageLength === 6.5, `avg of "hi"(2) and "hello world"(11) = 6.5, got ${r.averageMessageLength}`);
});

// ─── formatRepetitionContext ──────────────────────────────────────────────────

await runTest("empty analysis produces empty context", () => {
  const r = analyzeRepetition([]);
  assert(formatRepetitionContext(r) === "", "empty analysis should produce empty context");
});

await runTest("context includes recent messages", () => {
  const msgs: SentMessage[] = [
    { id: "1", message: "test message", channel: "test", timestamp: 0, source: "manual" },
  ];
  const r = analyzeRepetition(msgs);
  const ctx = formatRepetitionContext(r);
  assert(ctx.includes("test message"), "context should include the message");
  assert(ctx.includes("YOUR RECENT SENT MESSAGES"), "context should have header");
});

await runTest("variety alert triggered for low variety", () => {
  const msgs: SentMessage[] = [];
  for (let i = 0; i < 10; i++) {
    msgs.push({ id: String(i), message: "lol same", channel: "test", timestamp: i, source: "manual" });
  }
  const r = analyzeRepetition(msgs);
  const ctx = formatRepetitionContext(r);
  assert(ctx.includes("VARIETY ALERT"), "should trigger variety alert");
});

// ─── isNearDuplicate (Jaccard similarity) ─────────────────────────────────────

await runTest("identical messages are duplicates", () => {
  assert(isNearDuplicate("the quick brown fox", ["the quick brown fox"]) === true, "identical = duplicate");
});

await runTest("high word overlap is duplicate", () => {
  assert(isNearDuplicate("the quick brown fox jumps over", ["the quick brown fox leaps over"]) === true, "high overlap = duplicate");
});

await runTest("low word overlap is not duplicate", () => {
  assert(isNearDuplicate("hello world", ["goodbye universe"]) === false, "low overlap = not duplicate");
});

await runTest("short messages skip dedup", () => {
  assert(isNearDuplicate("hi", ["hi there"]) === false, "short payload skips dedup");
  assert(isNearDuplicate("hello there", ["hi"]) === false, "short recent skips dedup");
});

await runTest("empty inputs are not duplicate", () => {
  assert(isNearDuplicate("", ["anything"]) === false, "empty payload = not duplicate");
  assert(isNearDuplicate("hello world", []) as any === false, "empty recent = not duplicate");
});

await runTest("custom threshold works", () => {
  // With threshold 0.9, even high overlap shouldn't trigger
  assert(isNearDuplicate("the quick brown fox", ["the quick brown fox"], 0.9) === true, "identical still triggers at 0.9");
  assert(isNearDuplicate("the quick brown fox jumps", ["the quick brown dog leaps"], 0.9) === false, "partial overlap doesn't trigger at 0.9");
});

await runTest("checks against multiple recent messages", () => {
  assert(isNearDuplicate("the quick brown fox", ["hello world", "the quick brown fox", "goodbye"]) === true, "matches any in list");
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(60)}`);
console.log(`Anti-Repetition tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
