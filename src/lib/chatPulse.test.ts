import assert from "node:assert/strict";
import { summarizeChatPulse } from "./chatPulse";
import type { SentimentReading } from "../types";

const labels = ["negative", "neutral", "neutral", "positive", "hype", "positive"] as const;
const readings = labels.map((label, index) => ({ timestamp: index, label, score: 0.8, username: "u", text: "x" })) as SentimentReading[];
const summary = summarizeChatPulse(readings);
assert.equal(summary.sampleCount, 6);
assert.equal(summary.positive, 3);
assert.equal(summary.neutral, 2);
assert.equal(summary.negative, 1);
assert.equal(summary.trend, "warming");
assert.equal(summarizeChatPulse([]).trend, "insufficient");
console.log("Chat Pulse deterministic inspector summary scenarios passed");
