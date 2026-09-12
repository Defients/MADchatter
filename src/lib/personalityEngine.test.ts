/**
 * Personality Engine — focused test harness.
 *
 * Run with: npx tsx src/lib/personalityEngine.test.ts
 *
 * Tests mood detection, comfort level growth, mood lock validation,
 * trait evolution, and relationship milestones.
 */

import {
  createDefaultPersonality,
  detectMood,
  detectMoodWithLock,
  updateComfortLevel,
  evolveTraits,
  addRelationshipMilestone,
} from "./personalityEngine";
import type { ChatMessage, PersonalityState } from "../types";

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

function makeChat(messages: string[]): ChatMessage[] {
  return messages.map((m, i) => ({
    id: String(i), user: `user${i}`, text: m,
    timestamp: i, platform: "twitch" as const,
  }));
}

// ─── createDefaultPersonality ────────────────────────────────────────────────

await runTest("default personality has correct defaults", () => {
  const p = createDefaultPersonality();
  assert(p.mood === "chill", "default mood should be chill");
  assert(p.comfortLevel === 20, "default comfort should be 20");
  assert(p.sessionCount === 1, "default session count should be 1");
  assert(p.dominantTraits.length === 0, "default traits should be empty");
  assert(p.relationshipProgression.length === 0, "default progression should be empty");
});

// ─── detectMood ───────────────────────────────────────────────────────────────

await runTest("hyped mood detected from hype signals", () => {
  const chat = makeChat(["POG that was clutch", "no way insane play", "lets go!!!"]);
  const mood = detectMood(chat, "", 0);
  assert(mood === "hyped", `expected hyped, got ${mood}`);
});

await runTest("gremlin mood detected from gremlin signals", () => {
  const chat = makeChat(["lmao bruh", "kekw ratio", "skill issue copium"]);
  const mood = detectMood(chat, "", 0);
  assert(mood === "gremlin", `expected gremlin, got ${mood}`);
});

await runTest("chill mood detected from chill signals", () => {
  const chat = makeChat(["cozy vibes", "relaxing stream", "wholesome and calm"]);
  const mood = detectMood(chat, "", 0);
  assert(mood === "chill", `expected chill, got ${mood}`);
});

await runTest("thoughtful mood detected from thoughtful signals", () => {
  const chat = makeChat(["interesting strategy", "actually the meta is", "analysis because"]);
  const mood = detectMood(chat, "", 0);
  assert(mood === "thoughtful", `expected thoughtful, got ${mood}`);
});

await runTest("chaotic mood detected from chaotic signals", () => {
  const chat = makeChat(["chaos wild", "what is happening", "cursed insane unpredictable"]);
  const mood = detectMood(chat, "", 0);
  assert(mood === "chaotic", `expected chaotic, got ${mood}`);
});

await runTest("sentimental mood detected from nostalgic signals", () => {
  const chat = makeChat(["remember when", "miss you guys", "been here since the old days"]);
  const mood = detectMood(chat, "", 0);
  assert(mood === "sentimental", `expected sentimental, got ${mood}`);
});

await runTest("default to chill with no signals", () => {
  const chat = makeChat(["hello", "how are you", "nice day"]);
  const mood = detectMood(chat, "", 0);
  assert(mood === "chill", `expected chill default, got ${mood}`);
});

await runTest("audio transcript contributes to mood", () => {
  const chat = makeChat(["nice", "cool", "okay"]);
  const mood = detectMood(chat, "POG that was clutch no way", 0);
  assert(mood === "hyped", `audio hype signals should trigger hyped, got ${mood}`);
});

// ─── detectMoodWithLock ───────────────────────────────────────────────────────

await runTest("mood lock overrides detection", () => {
  const chat = makeChat(["POG clutch insane"]); // would be hyped
  const mood = detectMoodWithLock(chat, "", 0, { locked: true, mood: "chill" });
  assert(mood === "chill", "locked mood should override detection");
});

await runTest("invalid locked mood falls back to detection", () => {
  const chat = makeChat(["POG clutch insane"]);
  const mood = detectMoodWithLock(chat, "", 0, { locked: true, mood: "invalid_mood" });
  assert(mood === "hyped", "invalid lock should fall back to detection");
});

await runTest("unlocked mood uses detection", () => {
  const chat = makeChat(["POG clutch insane"]);
  const mood = detectMoodWithLock(chat, "", 0, { locked: false, mood: "chill" });
  assert(mood === "hyped", "unlocked should use detection");
});

// ─── updateComfortLevel ───────────────────────────────────────────────────────

await runTest("comfort grows from bot actions", () => {
  const newComfort = updateComfortLevel(20, 5, 0, 0);
  assert(newComfort === 22.5, `5 actions × 0.5 = +2.5, got ${newComfort}`);
});

await runTest("comfort grows from positive interactions", () => {
  const newComfort = updateComfortLevel(20, 0, 3, 0);
  assert(newComfort === 26, `3 positive × 2 = +6, got ${newComfort}`);
});

await runTest("comfort grows from chat activity", () => {
  const newComfort = updateComfortLevel(20, 0, 0, 50);
  assert(newComfort === 25, `50 messages × 0.1 = +5, got ${newComfort}`);
});

await runTest("comfort caps at 100", () => {
  const newComfort = updateComfortLevel(95, 20, 10, 100);
  assert(newComfort === 100, `should cap at 100, got ${newComfort}`);
});

await runTest("comfort with no activity stays same", () => {
  const newComfort = updateComfortLevel(50, 0, 0, 0);
  assert(newComfort === 50, "no activity = no change");
});

// ─── evolveTraits ─────────────────────────────────────────────────────────────

await runTest("traits evolve from successful actions", () => {
  const traits = evolveTraits([], [
    { type: "short_reaction", success: true },
    { type: "short_reaction", success: true },
    { type: "full_forge", success: true },
    { type: "full_forge", success: true },
  ]);
  assert(traits.includes("reactive"), "should include reactive from short_reaction");
  assert(traits.includes("thoughtful"), "should include thoughtful from full_forge");
});

await runTest("failed actions don't contribute traits", () => {
  const traits = evolveTraits([], [
    { type: "short_reaction", success: false },
    { type: "short_reaction", success: false },
  ]);
  assert(traits.length === 0, "failed actions should not produce traits");
});

await runTest("traits need 2+ occurrences to persist", () => {
  const traits = evolveTraits([], [
    { type: "short_reaction", success: true }, // only 1 — not enough
    { type: "full_forge", success: true },
    { type: "full_forge", success: true }, // 2 — enough
  ]);
  assert(!traits.includes("reactive"), "1 occurrence should not persist");
  assert(traits.includes("thoughtful"), "2 occurrences should persist");
});

await runTest("existing traits carry over with reinforcement", () => {
  // "funny" starts at count 1 (existing), needs 1 more joke_callback to reach 2
  const traits = evolveTraits(["funny"], [
    { type: "emote_only", success: true },
    { type: "emote_only", success: true },
    { type: "joke_callback", success: true }, // reinforces "funny" to count 2
  ]);
  assert(traits.includes("funny"), "reinforced existing trait should carry over");
  assert(traits.includes("expressive"), "new trait from emote_only should appear");
});

await runTest("traits capped at 5", () => {
  const actions = [
    { type: "short_reaction", success: true },
    { type: "emote_only", success: true },
    { type: "full_forge", success: true },
    { type: "quick_followup", success: true },
    { type: "joke_callback", success: true },
    { type: "meta_observation", success: true },
  ];
  // Repeat each action type twice to meet the threshold
  const doubled = [...actions, ...actions];
  const traits = evolveTraits([], doubled);
  assert(traits.length <= 5, `should cap at 5, got ${traits.length}`);
});

// ─── addRelationshipMilestone ─────────────────────────────────────────────────

await runTest("milestone added to progression", () => {
  const state = createDefaultPersonality();
  const updated = addRelationshipMilestone(state, "acquainted", "reached 50 comfort");
  assert(updated.relationshipProgression.length === 1, "should have 1 milestone");
  assert(updated.relationshipProgression[0].stage === "acquainted", "stage should match");
  assert(updated.relationshipProgression[0].note === "reached 50 comfort", "note should match");
});

await runTest("milestones capped at 50", () => {
  let state = createDefaultPersonality();
  for (let i = 0; i < 55; i++) {
    state = addRelationshipMilestone(state, `stage${i}`, `note${i}`);
  }
  assert(state.relationshipProgression.length === 50, `should cap at 50, got ${state.relationshipProgression.length}`);
});

await runTest("milestone doesn't mutate original state", () => {
  const state = createDefaultPersonality();
  addRelationshipMilestone(state, "test", "test");
  assert(state.relationshipProgression.length === 0, "original should be unchanged");
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(60)}`);
console.log(`Personality Engine tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
