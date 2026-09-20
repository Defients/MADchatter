/**
 * AutoForge Core — focused test harness.
 *
 * Run with: npx tsx src/lib/autoForgeCore.test.ts
 *
 * Tests the pure computation functions: chat activity, engagement scores,
 * stream health, hype level, offline detection, vibe check, adaptive
 * backoff, dedup, and engagement labeling.
 */

import {
  computeChatActivity,
  computeEngagementScores,
  computeStreamHealth,
  computeHypeLevel,
  detectOfflineStream,
  buildLongTermMemoryContext,
  normalizeConfidence,
  isDuplicateMessage,
  computeAdaptiveBackoff,
  labelEngagement,
  countPostSendEngagement,
  isDecisionPayloadSent,
} from "./autoForgeCore";
import type { SentimentReading, PinnedMemory, ChatMessage } from "../types";

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

// ─── computeChatActivity ──────────────────────────────────────────────────────

await runTest("chat velocity computes correctly", () => {
  const now = Date.now();
  const r = computeChatActivity(50, now - 60000, 20); // 30 new msgs in 1 min
  assert(r.newMessages === 30, `expected 30 new, got ${r.newMessages}`);
  assert(r.chatVelocity === 30, `expected velocity 30, got ${r.chatVelocity}`);
  assert(r.activityLevel === 4, `expected level 4, got ${r.activityLevel}`);
});

await runTest("activity spike detected", () => {
  const now = Date.now();
  const r = computeChatActivity(30, now - 60000, 15); // 15 new in 1 min
  assert(r.activitySpike === true, "15 new msgs in <2min should be a spike");
});

await runTest("no spike when spread over long time", () => {
  const now = Date.now();
  const r = computeChatActivity(30, now - 300000, 15); // 15 new in 5 min
  assert(r.activitySpike === false, "15 new msgs over 5min should not be a spike");
});

await runTest("zero new messages", () => {
  const now = Date.now();
  const r = computeChatActivity(10, now - 60000, 10);
  assert(r.newMessages === 0, "no new messages");
  assert(r.chatVelocity === 0, "zero velocity");
  assert(r.activityLevel === 0, "zero activity level");
});

// ─── computeEngagementScores ──────────────────────────────────────────────────

await runTest("engagement scores compute correctly", () => {
  const now = Date.now();
  const sentiment: SentimentReading[] = [
    { timestamp: now - 1000, label: "positive", score: 0.8, username: "a", text: "great" },
    { timestamp: now - 500, label: "hype", score: 0.9, username: "b", text: "POG" },
  ];
  const r = computeEngagementScores(30, sentiment, 15, now - 60000, now);
  assert(r.velocityScore === 1, `velocity should be 1, got ${r.velocityScore}`);
  assert(r.sentimentScore === 1, `sentiment should be 1 (all positive), got ${r.sentimentScore}`);
  assert(r.diversityScore === 0.75, `diversity 15/20=0.75, got ${r.diversityScore}`);
  assert(r.recencyScore > 0, "recency should be > 0");
  assert(r.overall > 0, "overall should be > 0");
});

await runTest("engagement with no sentiment defaults to 0.5", () => {
  const now = Date.now();
  const r = computeEngagementScores(10, [], 5, null, now);
  assert(r.sentimentScore === 0.5, `empty sentiment should default to 0.5, got ${r.sentimentScore}`);
});

// ─── computeStreamHealth ──────────────────────────────────────────────────────

await runTest("stream health labels by overall score", () => {
  const now = Date.now();
  const high = computeStreamHealth(1, 1, 1, true, 5, ["tag"], now);
  assert(high.label === "poppin", `expected poppin, got ${high.label}`);
  const low = computeStreamHealth(0, 0, 0, false, 0, [], now);
  assert(low.label === "dead", `expected dead, got ${low.label}`);
});

await runTest("mention score scales with mentions", () => {
  const now = Date.now();
  const r = computeStreamHealth(0.5, 0.5, 0.5, true, 3, [], now);
  assert(r.mentionScore === 45, `mentioned + 3 mentions = 30+15=45, got ${r.mentionScore}`);
});

// ─── computeHypeLevel ─────────────────────────────────────────────────────────

await runTest("hype level 3 for spike or high velocity", () => {
  assert(computeHypeLevel(true, 0) === 3, "spike → hype 3");
  assert(computeHypeLevel(false, 30) === 3, "velocity 30 → hype 3");
});

await runTest("hype level scales with velocity", () => {
  assert(computeHypeLevel(false, 15) === 2, "velocity 15 → hype 2");
  assert(computeHypeLevel(false, 5) === 1, "velocity 5 → hype 1");
  assert(computeHypeLevel(false, 0) === 0, "velocity 0 → hype 0");
});

// ─── detectOfflineStream ──────────────────────────────────────────────────────

await runTest("offline detected with 0 viewers and no chat", () => {
  assert(detectOfflineStream(0, 0, 400000) === true, "0 viewers + no chat for 5min = offline");
});

await runTest("not offline with viewers", () => {
  assert(detectOfflineStream(100, 0, 400000) === false, "viewers present = not offline");
});

await runTest("not offline with recent chat", () => {
  assert(detectOfflineStream(0, 5, 400000) === false, "recent chat = not offline");
});

await runTest("not offline with short elapsed time", () => {
  assert(detectOfflineStream(0, 0, 100000) === false, "short elapsed = not offline");
});

// ─── buildLongTermMemoryContext ───────────────────────────────────────────────

await runTest("long term memory prefers explicit string", () => {
  const r = buildLongTermMemoryContext("explicit memory", [], null);
  assert(r === "explicit memory", "explicit string should take precedence");
});

await runTest("long term memory builds from pinned memories", () => {
  const pinned: PinnedMemory[] = [
    { id: "1", type: "chat", content: "memory A content", label: "memory A", timestamp: 0 },
    { id: "2", type: "chat", content: "memory B content", label: "memory B", timestamp: 0 },
  ];
  const r = buildLongTermMemoryContext("", pinned, null);
  assert(r.includes("memory A"), "should include memory A");
  assert(r.includes("memory B"), "should include memory B");
});

await runTest("golden memory gets priority tag", () => {
  const pinned: PinnedMemory[] = [
    { id: "1", type: "chat", content: "normal content", label: "normal", timestamp: 0 },
    { id: "2", type: "chat", content: "golden content", label: "golden", timestamp: 0 },
  ];
  const r = buildLongTermMemoryContext("", pinned, "2");
  assert(r.includes("[GOLDEN MEMORY — PRIORITIZE THIS]: golden"), "golden memory should be tagged");
  assert(!r.includes("[GOLDEN MEMORY — PRIORITIZE THIS]: normal"), "normal memory should not be tagged");
});

// ─── normalizeConfidence ──────────────────────────────────────────────────────

await runTest("normalizeConfidence handles numbers", () => {
  assert(normalizeConfidence(0.85) === 0.85, "number passes through");
  assert(normalizeConfidence(0) === 0, "zero passes through");
});

await runTest("normalizeConfidence handles strings", () => {
  assert(normalizeConfidence("0.9") === 0.9, "string number converts");
  assert(normalizeConfidence("invalid") === 0, "invalid string → 0");
});

await runTest("normalizeConfidence handles invalid types", () => {
  assert(normalizeConfidence(null) === 0, "null → 0");
  assert(normalizeConfidence(undefined) === 0, "undefined → 0");
  assert(normalizeConfidence(NaN) === 0, "NaN → 0");
});

// ─── isDuplicateMessage ───────────────────────────────────────────────────────

await runTest("exact duplicate detected", () => {
  assert(isDuplicateMessage("hello world", ["hello world"]) === true, "exact match = duplicate");
});

await runTest("near duplicate detected via Jaccard", () => {
  assert(isDuplicateMessage("the quick brown fox jumps", ["the quick brown fox leaps"]) === true, "high word overlap = duplicate");
});

await runTest("different messages not duplicate", () => {
  assert(isDuplicateMessage("hello world", ["goodbye universe"]) === false, "different words = not duplicate");
});

await runTest("empty payload not duplicate", () => {
  assert(isDuplicateMessage("", ["anything"]) === false, "empty payload = not duplicate");
});

await runTest("decision delivery state is scoped to the viewed payload", () => {
  const delivered = [{ message: "already sent" }];
  assert(isDecisionPayloadSent("already sent", delivered) === true, "matching historical decision is sent");
  assert(isDecisionPayloadSent("still pending", delivered) === false, "different historical decision stays sendable");
  assert(isDecisionPayloadSent("  ALREADY SENT ", delivered) === true, "delivery match is normalized");
});

// ─── computeAdaptiveBackoff ───────────────────────────────────────────────────

await runTest("no backoff for mentions", () => {
  assert(computeAdaptiveBackoff(10, 15, true, false) === 15, "mention bypasses backoff");
});

await runTest("no backoff for spikes", () => {
  assert(computeAdaptiveBackoff(10, 15, false, true) === 15, "spike bypasses backoff");
});

await runTest("normal interval for low silences", () => {
  assert(computeAdaptiveBackoff(2, 15, false, false) === 15, "≤2 silences = base");
});

await runTest("1.5x backoff for 3-5 silences, capped at 5 min", () => {
  // baseMinutes * 1.5 = 22.5, but capped at 5 min
  assert(computeAdaptiveBackoff(4, 15, false, false) === 5, `4 silences = 1.5x capped at 5, got ${computeAdaptiveBackoff(4, 15, false, false)}`);
  // With base 2, 1.5x = 3 (not capped)
  assert(computeAdaptiveBackoff(4, 2, false, false) === 3, `4 silences base 2 = 3, got ${computeAdaptiveBackoff(4, 2, false, false)}`);
});

await runTest("2x backoff for 6-10 silences, capped at 5 min", () => {
  // baseMinutes * 2 = 30, but capped at 5 min
  assert(computeAdaptiveBackoff(8, 15, false, false) === 5, `8 silences = 2x capped at 5, got ${computeAdaptiveBackoff(8, 15, false, false)}`);
  // With base 2, 2x = 4 (not capped)
  assert(computeAdaptiveBackoff(8, 2, false, false) === 4, `8 silences base 2 = 4, got ${computeAdaptiveBackoff(8, 2, false, false)}`);
});

await runTest("3x backoff for 10+ silences, capped at 5 min", () => {
  assert(computeAdaptiveBackoff(15, 15, false, false) === 5, `15 silences = 3x capped at 5, got ${computeAdaptiveBackoff(15, 15, false, false)}`);
  assert(computeAdaptiveBackoff(20, 2, false, false) === 5, `20 silences base 2 = 6 capped to 5, got ${computeAdaptiveBackoff(20, 2, false, false)}`);
});

// ─── labelEngagement ──────────────────────────────────────────────────────────

await runTest("engagement labels", () => {
  assert(labelEngagement(0) === "ignored", "0 = ignored");
  assert(labelEngagement(2) === "low", "2 = low");
  assert(labelEngagement(7) === "moderate", "7 = moderate");
  assert(labelEngagement(10) === "high", "10 = high");
});

// ─── countPostSendEngagement ──────────────────────────────────────────────────

await runTest("post-send engagement counts correctly", () => {
  const now = Date.now();
  const chatLog: ChatMessage[] = [
    { id: "1", user: "a", text: "before", timestamp: now - 1000, platform: "twitch" },
    { id: "2", user: "b", text: "after", timestamp: now + 1000, platform: "twitch" },
    { id: "3", user: "bot", text: "@bot hey", timestamp: now + 2000, platform: "twitch" },
  ];
  const r = countPostSendEngagement(chatLog, now, "bot");
  assert(r.linesAfter === 2, `2 lines after, got ${r.linesAfter}`);
  assert(r.mentionsAfter === 1, `1 mention after, got ${r.mentionsAfter}`);
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(60)}`);
console.log(`AutoForge Core tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
