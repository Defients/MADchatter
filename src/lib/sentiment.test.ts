/**
 * Sentiment classifier — focused test harness.
 *
 * Run with: npx tsx src/lib/sentiment.test.ts
 *
 * Tests the lexicon-based sentiment classifier including negation handling,
 * intensity modifiers, label priority, and edge cases.
 */

import { classifySentiment, summarizeSentiment, addSentimentReading, formatSentimentContext } from "./sentiment";
import type { SentimentReading } from "../types";

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

async function runTest(name: string, fn: () => Promise<void> | void): Promise<void> {
  console.log(`\n▸ ${name}`);
  try {
    await fn();
  } catch (e: any) {
    failed++;
    failures.push(`${name}: threw ${e?.message ?? e}`);
    console.error(`  FAIL: threw ${e?.message ?? e}`);
  }
}

// ─── Basic Classification ──────────────────────────────────────────────────────

await runTest("positive words classify as positive", () => {
  const r = classifySentiment("that was great and awesome");
  assert(r.label === "positive", `expected positive, got ${r.label}`);
  assert(r.score > 0, "score should be > 0");
});

await runTest("negative words classify as negative", () => {
  {
    const r = classifySentiment("this is terrible and boring");
    assert(r.label === "negative", `expected negative, got ${r.label}`);
  }
});

await runTest("hype words classify as hype", () => {
  const r = classifySentiment("POG poggers clutch lets go!!!");
  assert(r.label === "hype", `expected hype, got ${r.label}`);
});

await runTest("wholesome words classify as wholesome", () => {
  const r = classifySentiment("this is so wholesome and cute");
  assert(r.label === "wholesome", `expected wholesome, got ${r.label}`);
});

await runTest("toxic words classify as toxic", () => {
  const r = classifySentiment("you suck trash uninstall");
  assert(r.label === "toxic", `expected toxic, got ${r.label}`);
});

await runTest("empty text is neutral", () => {
  assert(classifySentiment("").label === "neutral", "empty string should be neutral");
  assert(classifySentiment("   ").label === "neutral", "whitespace should be neutral");
});

await runTest("neutral text is neutral", () => {
  assert(classifySentiment("hello there").label === "neutral", "plain greeting should be neutral");
});

// ─── Negation Handling ───────────────────────────────────────────────────────

await runTest("negated positive becomes negative", () => {
  const r = classifySentiment("that was not great");
  assert(r.label === "negative" || r.label === "neutral", `negated positive should be negative/neutral, got ${r.label}`);
});

await runTest("negated negative becomes positive", () => {
  const r = classifySentiment("this is not bad at all");
  assert(r.label === "positive" || r.label === "neutral", `negated negative should be positive/neutral, got ${r.label}`);
});

await runTest("negated hype reduces hype score", () => {
  const negated = classifySentiment("not pog at all");
  const positive = classifySentiment("pog");
  // Negated hype should have a lower score than positive hype, or not be hype
  assert(negated.label !== "hype" || negated.score < positive.score, "negated hype should be weaker or not hype");
});

await runTest("never negation works", () => {
  const r = classifySentiment("never good, always bad");
  // "never good" should reduce positive signal
  assert(r.label === "negative" || r.label === "neutral", `expected negative/neutral, got ${r.label}`);
});

await runTest("don't negation works", () => {
  const r = classifySentiment("don't hate on this");
  // "don't hate" should reduce negative signal
  assert(r.label !== "negative" || r.score < classifySentiment("hate this").score, "negated hate should be weaker");
});

// ─── Intensity Modifiers ──────────────────────────────────────────────────────

await runTest("amplifier increases score", () => {
  const plain = classifySentiment("good");
  const amplified = classifySentiment("very good");
  assert(amplified.score >= plain.score, `amplified score (${amplified.score}) should be >= plain (${plain.score})`);
});

await runTest("dampener decreases score", () => {
  const plain = classifySentiment("great");
  const dampened = classifySentiment("kinda great");
  assert(dampened.score <= plain.score, `dampened score (${dampened.score}) should be <= plain (${plain.score})`);
});

await runTest("super amplifier works", () => {
  const r = classifySentiment("super awesome");
  assert(r.label === "positive", `expected positive, got ${r.label}`);
});

// ─── Label Priority ──────────────────────────────────────────────────────────

await runTest("toxic overrides positive", () => {
  const r = classifySentiment("you're trash and garbage");
  assert(r.label === "toxic", `toxic should override, got ${r.label}`);
});

await runTest("hype overrides positive when stronger", () => {
  const r = classifySentiment("POG poggers clutch insane lets go");
  assert(r.label === "hype", `hype should win, got ${r.label}`);
});

// ─── Caps Lock & Punctuation ─────────────────────────────────────────────────

await runTest("caps lock triggers hype", () => {
  const r = classifySentiment("WHAT IS HAPPENING HERE");
  assert(r.label === "hype", `caps lock should be hype, got ${r.label}`);
});

await runTest("multiple exclamation marks trigger hype", () => {
  const r = classifySentiment("okay!!!");
  assert(r.label === "hype", `3+ exclamation marks should be hype, got ${r.label}`);
});

// ─── Emote Detection ──────────────────────────────────────────────────────────

await runTest("positive emotes boost score", () => {
  const r = classifySentiment("Kappa PogChamp");
  assert(r.label === "hype" || r.label === "positive", `emote should be hype/positive, got ${r.label}`);
});

await runTest("negative emotes classify as negative", () => {
  const r = classifySentiment("FeelsBadMan BibleThump");
  assert(r.label === "negative", `negative emotes should be negative, got ${r.label}`);
});

// ─── summarizeSentiment ──────────────────────────────────────────────────────

await runTest("summarizeSentiment returns neutral for empty history", () => {
  const s = summarizeSentiment([]);
  assert(s.current === "neutral", "empty history should be neutral");
  assert(s.trend === "stable", "empty history should be stable trend");
});

await runTest("summarizeSentiment computes distribution", () => {
  const readings: SentimentReading[] = [
    { timestamp: 1, label: "positive", score: 0.8, username: "a", text: "great" },
    { timestamp: 2, label: "positive", score: 0.7, username: "b", text: "nice" },
    { timestamp: 3, label: "negative", score: 0.5, username: "c", text: "bad" },
  ];
  const s = summarizeSentiment(readings);
  assert(s.current === "positive", `dominant should be positive, got ${s.current}`);
  assert(s.distribution.positive === 2, `2 positive readings, got ${s.distribution.positive}`);
  assert(s.distribution.negative === 1, `1 negative reading, got ${s.distribution.negative}`);
});

await runTest("summarizeSentiment detects rising trend", () => {
  const now = Date.now();
  const readings: SentimentReading[] = [];
  // 10 negative readings (old)
  for (let i = 0; i < 10; i++) {
    readings.push({ timestamp: now - 100 + i, label: "negative", score: 0.5, username: "a", text: "bad" });
  }
  // 10 positive readings (recent)
  for (let i = 0; i < 10; i++) {
    readings.push({ timestamp: now + 200 + i, label: "positive", score: 0.8, username: "b", text: "good" });
  }
  const s = summarizeSentiment(readings);
  assert(s.trend === "rising", `expected rising trend, got ${s.trend}`);
});

// ─── addSentimentReading ─────────────────────────────────────────────────────

await runTest("addSentimentReading caps at 100", () => {
  let history: SentimentReading[] = [];
  for (let i = 0; i < 120; i++) {
    history = addSentimentReading(history, { timestamp: i, label: "neutral", score: 0, username: "a", text: "x" });
  }
  assert(history.length === 100, `expected 100, got ${history.length}`);
});

// ─── formatSentimentContext ──────────────────────────────────────────────────

await runTest("formatSentimentContext returns empty for no readings", () => {
  const s = summarizeSentiment([]);
  assert(formatSentimentContext(s) === "", "empty readings should produce empty context");
});

await runTest("formatSentimentContext includes vibe and distribution", () => {
  const readings: SentimentReading[] = [
    { timestamp: 1, label: "hype", score: 0.9, username: "a", text: "POG" },
  ];
  const s = summarizeSentiment(readings);
  const ctx = formatSentimentContext(s);
  assert(ctx.includes("hype"), "context should mention hype");
  assert(ctx.includes("Distribution"), "context should include distribution");
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(60)}`);
console.log(`Sentiment tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
