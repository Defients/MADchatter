/**
 * Memory Continuity — focused test harness.
 *
 * Run with: npx tsx src/lib/memoryContinuity.test.ts
 *
 * Tests the extraction cursor (ID-set + audio tail), new-signal detection
 * (message IDs, audio-only, audio rollover), and the incremental decay
 * math (non-compounding over repeated cycles).
 */

import { captureMemoryExtractionCursor, hasNewMemorySignal } from "./memoryContinuity";
import { applyMemoryDecay, applyJokeDecay } from "./memoryEngine";
import type { AutoMemory, ChatMessage, InsideJoke } from "../types";

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

function makeMessage(id: string, text = "hello"): ChatMessage {
  return { id, user: "viewer", text, timestamp: Date.now() };
}

function makeMemory(overrides: Partial<AutoMemory> = {}): AutoMemory {
  return {
    id: "m1",
    type: "fact",
    subject: "streamer",
    content: "likes pizza",
    context: "",
    source: "chat",
    confidence: 0.8,
    createdAt: 1000,
    lastReferencedAt: 1000,
    referenceCount: 1,
    strength: 1.0,
    tags: [],
    isVerified: false,
    ...overrides,
  };
}

function makeJoke(overrides: Partial<InsideJoke> = {}): InsideJoke {
  return {
    id: "j1",
    origin: "viewer",
    originTimestamp: 1000,
    participants: ["viewer"],
    punchline: "the punchline",
    context: "",
    variations: [],
    usageCount: 1,
    lastUsedAt: 1000,
    strength: 1.0,
    status: "active",
    createdAt: 1000,
    ...overrides,
  };
}

const DAY = 86_400_000;

// ─── Cursor Capture ──────────────────────────────────────────────────────────

await runTest("cursor captures non-marker message IDs", () => {
  const chat = [
    makeMessage("a"), makeMessage("b"), makeMessage("c"),
    { ...makeMessage("d"), marker: "manual" as const },
  ];
  const cursor = captureMemoryExtractionCursor(chat, "");
  assert(cursor.messageIds.size === 3, `should have 3 IDs, got ${cursor.messageIds.size}`);
  assert(cursor.messageIds.has("a"), "should have a");
  assert(cursor.messageIds.has("b"), "should have b");
  assert(cursor.messageIds.has("c"), "should have c");
  assert(!cursor.messageIds.has("d"), "should not have marker d");
});

await runTest("cursor captures audio tail (last 1500 chars)", () => {
  const audio = "x".repeat(2000);
  const cursor = captureMemoryExtractionCursor([], audio);
  assert(cursor.audioTail.length === 1500, `tail should be 1500, got ${cursor.audioTail.length}`);
  assert(cursor.audioTail === audio.slice(-1500), "tail should be last 1500 chars");
});

await runTest("cursor with empty chat and audio", () => {
  const cursor = captureMemoryExtractionCursor([], "");
  assert(cursor.messageIds.size === 0, "no messages");
  assert(cursor.audioTail === "", "empty audio tail");
});

// ─── hasNewMemorySignal ──────────────────────────────────────────────────────

await runTest("null cursor + enough messages → true", () => {
  const chat = Array.from({ length: 10 }, (_, i) => makeMessage(`m${i}`));
  assert(hasNewMemorySignal(chat, "", null) === true, "10 new messages with null cursor");
});

await runTest("null cursor + too few messages → false", () => {
  const chat = Array.from({ length: 9 }, (_, i) => makeMessage(`m${i}`));
  assert(hasNewMemorySignal(chat, "", null) === false, "9 messages < 10 threshold");
});

await runTest("cursor covers all messages + no audio → false", () => {
  const chat = Array.from({ length: 10 }, (_, i) => makeMessage(`m${i}`));
  const cursor = captureMemoryExtractionCursor(chat, "");
  assert(hasNewMemorySignal(chat, "", cursor) === false, "no new messages, no audio");
});

await runTest("5 new message IDs beyond cursor → true", () => {
  const oldChat = Array.from({ length: 10 }, (_, i) => makeMessage(`old${i}`));
  const cursor = captureMemoryExtractionCursor(oldChat, "");
  const chat = [...oldChat, ...Array.from({ length: 5 }, (_, i) => makeMessage(`new${i}`))];
  assert(hasNewMemorySignal(chat, "", cursor) === true, "5 new IDs");
});

await runTest("4 new message IDs → false (below 5 threshold)", () => {
  const oldChat = Array.from({ length: 10 }, (_, i) => makeMessage(`old${i}`));
  const cursor = captureMemoryExtractionCursor(oldChat, "");
  const chat = [...oldChat, ...Array.from({ length: 4 }, (_, i) => makeMessage(`new${i}`))];
  assert(hasNewMemorySignal(chat, "", cursor) === false, "4 new IDs < 5");
});

await runTest("audio-only signal (≥100 new chars) → true", () => {
  const cursor = captureMemoryExtractionCursor([], "old audio content here");
  const audio = "old audio content here" + "y".repeat(100);
  assert(hasNewMemorySignal([], audio, cursor) === true, "100 new audio chars");
});

await runTest("audio below 100 new chars → false", () => {
  const cursor = captureMemoryExtractionCursor([], "old audio content here");
  const audio = "old audio content here" + "y".repeat(50);
  assert(hasNewMemorySignal([], audio, cursor) === false, "50 new audio chars < 100");
});

await runTest("audio rollover overlap detected (no false positive)", () => {
  // The transcript rolls over — the tail is the last 1500 chars. If the
  // previous tail is a prefix of the new tail (overlap), only the suffix
  // counts as new.
  const prevAudio = "a".repeat(500);
  const cursor = captureMemoryExtractionCursor([], prevAudio);
  // New audio = same 500 + 100 new chars → only 100 new
  const newAudio = prevAudio + "b".repeat(100);
  assert(hasNewMemorySignal([], newAudio, cursor) === true, "100 new chars after overlap");
});

await runTest("audio identical → false", () => {
  const audio = "same audio content";
  const cursor = captureMemoryExtractionCursor([], audio);
  assert(hasNewMemorySignal([], audio, cursor) === false, "identical audio");
});

await runTest("chatLog at cap (150) with new IDs still triggers", () => {
  // This is the core fix: a count-based cursor stalls at the cap, but the
  // ID-set cursor detects new messages even when total count is stable.
  const oldChat = Array.from({ length: 150 }, (_, i) => makeMessage(`old${i}`));
  const cursor = captureMemoryExtractionCursor(oldChat, "");
  // Simulate the rolling buffer: old messages roll off, new ones append
  const newChat = [...oldChat.slice(5), ...Array.from({ length: 5 }, (_, i) => makeMessage(`new${i}`))];
  assert(newChat.length === 150, "buffer still at cap");
  assert(hasNewMemorySignal(newChat, "", cursor) === true, "5 new IDs at cap");
});

// ─── Memory Decay (non-compounding) ──────────────────────────────────────────

await runTest("single decay over 1 half-life → strength halves", () => {
  const t0 = 10 * DAY;
  const mem = makeMemory({ strength: 1.0, lastReferencedAt: t0 });
  const result = applyMemoryDecay([mem], 7, t0 + 7 * DAY);
  assert(Math.abs(result[0].strength - 0.5) < 0.001, `1 half-life → 0.5, got ${result[0].strength}`);
  assert(result[0].lastDecayedAt === t0 + 7 * DAY, "lastDecayedAt set to now");
});

await runTest("repeated cycles over T = single cycle over T (non-compounding)", () => {
  const t0 = 10 * DAY;
  const halfLife = 7 * DAY;
  const mem = makeMemory({ strength: 1.0, lastReferencedAt: t0 });
  // Single application over 3 half-lives
  const single = applyMemoryDecay([mem], 7, t0 + 3 * halfLife);
  // 3 applications, each 1 half-life apart
  let stepped = [mem];
  stepped = applyMemoryDecay(stepped, 7, t0 + halfLife);
  stepped = applyMemoryDecay(stepped, 7, t0 + 2 * halfLife);
  stepped = applyMemoryDecay(stepped, 7, t0 + 3 * halfLife);
  assert(Math.abs(single[0].strength - stepped[0].strength) < 0.0001,
    `single=${single[0].strength.toFixed(6)} stepped=${stepped[0].strength.toFixed(6)} should match`);
  // Should be 0.125 (0.5^3)
  assert(Math.abs(stepped[0].strength - 0.125) < 0.001, `3 half-lives → 0.125, got ${stepped[0].strength}`);
});

await runTest("decay anchored to lastDecayedAt not lastReferencedAt", () => {
  const t0 = 10 * DAY;
  const mem = makeMemory({ strength: 1.0, lastReferencedAt: t0, lastDecayedAt: t0 + 3 * DAY });
  // Decay from lastDecayedAt (t0+3d), 4 days pass → 4 days of decay
  const result = applyMemoryDecay([mem], 7, t0 + 7 * DAY);
  const expected = 1.0 * Math.pow(0.5, 4 / 7);
  assert(Math.abs(result[0].strength - expected) < 0.001,
    `anchored decay: expected ${expected.toFixed(6)}, got ${result[0].strength}`);
});

await runTest("legacy memory without lastDecayedAt starts from lastReferencedAt", () => {
  const t0 = 10 * DAY;
  const mem = makeMemory({ strength: 1.0, lastReferencedAt: t0 });
  // No lastDecayedAt — should anchor to lastReferencedAt
  const result = applyMemoryDecay([mem], 7, t0 + 7 * DAY);
  assert(Math.abs(result[0].strength - 0.5) < 0.001, `legacy → 0.5, got ${result[0].strength}`);
  assert(result[0].lastDecayedAt === t0 + 7 * DAY, "lastDecayedAt set");
});

await runTest("decay never goes below 0", () => {
  const t0 = 10 * DAY;
  const mem = makeMemory({ strength: 0.001, lastReferencedAt: t0 });
  const result = applyMemoryDecay([mem], 7, t0 + 365 * DAY);
  assert(result[0].strength < 1e-10, `should be ~0, got ${result[0].strength}`);
});

await runTest("zero half-life → no decay", () => {
  const mem = makeMemory({ strength: 0.8 });
  const result = applyMemoryDecay([mem], 0, Date.now() + 100 * DAY);
  assert(result[0].strength === 0.8, `0 half-life → unchanged, got ${result[0].strength}`);
});

await runTest("empty memory array → empty result", () => {
  const result = applyMemoryDecay([], 7);
  assert(result.length === 0, "empty in, empty out");
});

// ─── Joke Decay (non-compounding + status transitions) ───────────────────────

await runTest("joke decay halves over 1 half-life", () => {
  const t0 = 10 * DAY;
  const joke = makeJoke({ strength: 1.0, lastUsedAt: t0 });
  const result = applyJokeDecay([joke], 7, t0 + 7 * DAY);
  assert(Math.abs(result[0].strength - 0.5) < 0.001, `joke → 0.5, got ${result[0].strength}`);
  assert(result[0].status === "active", "still active at 0.5");
});

await runTest("joke status transitions to fading below 0.1", () => {
  const t0 = 10 * DAY;
  const joke = makeJoke({ strength: 0.15, lastUsedAt: t0 });
  // Decay enough to drop below 0.1
  const result = applyJokeDecay([joke], 1, t0 + 2 * DAY);
  assert(result[0].strength < 0.1, `strength ${result[0].strength} < 0.1`);
  assert(result[0].status === "fading", `should be fading, got ${result[0].status}`);
});

await runTest("joke status transitions to retired below 0.03", () => {
  const t0 = 10 * DAY;
  const joke = makeJoke({ strength: 0.04, lastUsedAt: t0 });
  const result = applyJokeDecay([joke], 1, t0 + 2 * DAY);
  assert(result[0].strength < 0.03, `strength ${result[0].strength} < 0.03`);
  assert(result[0].status === "retired", `should be retired, got ${result[0].status}`);
});

await runTest("retired joke stays retired", () => {
  const t0 = 10 * DAY;
  const joke = makeJoke({ strength: 0.01, lastUsedAt: t0, status: "retired" });
  const result = applyJokeDecay([joke], 7, t0 + 100 * DAY);
  assert(result[0].status === "retired", "retired stays retired");
});

await runTest("joke non-compounding: repeated cycles = single cycle", () => {
  const t0 = 10 * DAY;
  const halfLife = 7 * DAY;
  const joke = makeJoke({ strength: 1.0, lastUsedAt: t0 });
  const single = applyJokeDecay([joke], 7, t0 + 3 * halfLife);
  let stepped = [joke];
  stepped = applyJokeDecay(stepped, 7, t0 + halfLife);
  stepped = applyJokeDecay(stepped, 7, t0 + 2 * halfLife);
  stepped = applyJokeDecay(stepped, 7, t0 + 3 * halfLife);
  assert(Math.abs(single[0].strength - stepped[0].strength) < 0.0001,
    `single=${single[0].strength.toFixed(6)} stepped=${stepped[0].strength.toFixed(6)}`);
});

await runTest("joke legacy without lastDecayedAt starts from lastUsedAt", () => {
  const t0 = 10 * DAY;
  const joke = makeJoke({ strength: 1.0, lastUsedAt: t0 });
  const result = applyJokeDecay([joke], 7, t0 + 7 * DAY);
  assert(Math.abs(result[0].strength - 0.5) < 0.001, `legacy joke → 0.5`);
  assert(result[0].lastDecayedAt === t0 + 7 * DAY, "lastDecayedAt set");
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(60)}`);
console.log(`Memory Continuity tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
