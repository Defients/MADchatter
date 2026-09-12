/**
 * Chat Style — focused test harness.
 *
 * Run with: npx tsx src/lib/chatStyle.test.ts
 *
 * Tests the chat style analyzer: casing classification, length buckets,
 * emote density, punctuation signals, slang detection, and the min-samples
 * threshold.
 */

import { analyzeChatStyle, formatChatStyleProfile } from "./chatStyle";

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

function makeChatLog(lines: string[]): string {
  return lines.map((l, i) => `user${i}: ${l}`).join("\n");
}

// ─── Min Samples Threshold ────────────────────────────────────────────────────

await runTest("returns null below min samples", () => {
  const log = makeChatLog(["hi", "hello", "hey"]);
  assert(analyzeChatStyle(log) === null, "3 lines < 6 min should return null");
});

await runTest("returns profile at min samples", () => {
  const log = makeChatLog(["hi", "hello", "hey", "yo", "sup", "howdy"]);
  const r = analyzeChatStyle(log);
  assert(r !== null, "6 lines = min should return profile");
});

await runTest("returns null for empty input", () => {
  assert(analyzeChatStyle("") === null, "empty input should return null");
  assert(analyzeChatStyle("   ") === null, "whitespace should return null");
});

// ─── Casing Classification ────────────────────────────────────────────────────

await runTest("mostly lowercase detected", () => {
  const log = makeChatLog([
    "this is lowercase", "all lowercase here", "no caps at all",
    "just lowercase text", "completely lower", "totally lower case",
  ]);
  const r = analyzeChatStyle(log);
  assert(r!.casing === "mostly lowercase", `expected mostly lowercase, got ${r!.casing}`);
});

await runTest("capitalized detected", () => {
  const log = makeChatLog([
    "Hello World", "This Is Capitalized", "Every Word Caps",
    "Proper Capitalization", "Title Case Here", "All Capitalized",
  ]);
  const r = analyzeChatStyle(log);
  assert(r!.casing === "capitalized", `expected capitalized, got ${r!.casing}`);
});

// ─── Length Buckets ──────────────────────────────────────────────────────────

await runTest("short length bucket", () => {
  const log = makeChatLog(["hi", "yo", "hey", "sup", "lol", "nice"]);
  const r = analyzeChatStyle(log);
  assert(r!.lengthBucket === "short", `expected short, got ${r!.lengthBucket}`);
});

await runTest("medium length bucket", () => {
  const log = makeChatLog([
    "this is a medium length message that is about fifty chars",
    "another medium one right here that is also about fifty",
    "moderate length chat line here about fifty characters ok",
    "some more medium text here that is about fifty chars yep",
    "about this long seems right for a medium length message",
    "medium length overall yeah this is about fifty chars",
  ]);
  const r = analyzeChatStyle(log);
  assert(r!.lengthBucket === "medium", `expected medium, got ${r!.lengthBucket}`);
});

// ─── Emote Density ────────────────────────────────────────────────────────────

await runTest("emote density with available emotes", () => {
  const log = makeChatLog([
    "POGChamp this is great",
    "KEKW that was funny",
    "monkaS scary moment",
    "POGChamp again",
    "nice play POGChamp",
    "KEKW lol",
  ]);
  const r = analyzeChatStyle(log, ["POGChamp", "KEKW", "monkaS"]);
  assert(r!.emoteDensity !== "unknown", "with emotes provided, density should be known");
  assert(r!.topEmotes.includes("POGChamp"), "POGChamp should be in top emotes");
});

await runTest("emote density unknown without emotes list", () => {
  const log = makeChatLog(["hi", "hello", "hey", "yo", "sup", "howdy"]);
  const r = analyzeChatStyle(log);
  assert(r!.emoteDensity === "unknown", "without emotes list, density should be unknown");
});

// ─── Punctuation Signals ─────────────────────────────────────────────────────

await runTest("punctuation signals detected", () => {
  const log = makeChatLog([
    "what??", "no way!!", "really?!", "what??", "no way!!", "really?!",
  ]);
  const r = analyzeChatStyle(log);
  assert(r!.punctuationSignals.includes('"??"'), `should detect ??, got ${JSON.stringify(r!.punctuationSignals)}`);
  assert(r!.punctuationSignals.includes('"!!"'), "should detect !!");
});

// ─── Slang Tokens ────────────────────────────────────────────────────────────

await runTest("slang tokens detected", () => {
  const log = makeChatLog([
    "idk what to say", "bc that was crazy", "tho it was close",
    "nah idk bout that", "bcuz i said so", "tho ngl that was close",
  ]);
  const r = analyzeChatStyle(log);
  assert(r!.slangTokens.includes("idk"), "should detect idk");
  assert(r!.slangTokens.includes("bc"), "should detect bc");
  assert(r!.slangTokens.includes("tho"), "should detect tho");
});

// ─── Sample Lines ────────────────────────────────────────────────────────────

await runTest("sample lines extracted", () => {
  const log = makeChatLog([
    "hi", "this is longer", "hey", "another medium one", "yo", "sup",
  ]);
  const r = analyzeChatStyle(log);
  assert(r!.sampleLines.length > 0, "should have sample lines");
  assert(r!.sampleLines.length <= 3, "should have at most 3 sample lines");
  // Sample lines should be the shortest
  assert(r!.sampleLines.includes("hi"), "shortest line should be included");
});

// ─── formatChatStyleProfile ──────────────────────────────────────────────────

await runTest("formatChatStyleProfile produces prompt block", () => {
  const log = makeChatLog(["hi", "hello", "hey", "yo", "sup", "howdy"]);
  const r = analyzeChatStyle(log);
  const formatted = formatChatStyleProfile(r!);
  assert(formatted.includes("CHAT STYLE PROFILE"), "should have header");
  assert(formatted.includes("Casing:"), "should include casing");
  assert(formatted.includes("END CHAT STYLE PROFILE"), "should have footer");
  assert(formatted.startsWith("\n"), "should start with newline");
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(60)}`);
console.log(`Chat Style tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
