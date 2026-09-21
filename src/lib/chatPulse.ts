import type { SentimentLabel, SentimentReading } from "../types";

export interface ChatPulseSummary {
  sampleCount: number;
  dominant: SentimentLabel | null;
  positive: number;
  neutral: number;
  negative: number;
  trend: "warming" | "cooling" | "steady" | "insufficient";
}

const POSITIVE = new Set<SentimentLabel>(["positive", "hype", "wholesome"]);
const NEGATIVE = new Set<SentimentLabel>(["negative", "toxic"]);

function polarity(label: SentimentLabel): number {
  if (POSITIVE.has(label)) return 1;
  if (NEGATIVE.has(label)) return -1;
  return 0;
}

/** Cheap deterministic summary for the bounded Mobile Pulse Inspector. */
export function summarizeChatPulse(readings: readonly SentimentReading[], limit = 35): ChatPulseSummary {
  const recent = readings.slice(-Math.max(1, limit));
  if (recent.length === 0) {
    return { sampleCount: 0, dominant: null, positive: 0, neutral: 0, negative: 0, trend: "insufficient" };
  }
  const counts = new Map<SentimentLabel, number>();
  let positive = 0;
  let neutral = 0;
  let negative = 0;
  for (const reading of recent) {
    counts.set(reading.label, (counts.get(reading.label) ?? 0) + 1);
    if (POSITIVE.has(reading.label)) positive++;
    else if (NEGATIVE.has(reading.label)) negative++;
    else neutral++;
  }
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  let trend: ChatPulseSummary["trend"] = "insufficient";
  if (recent.length >= 6) {
    const middle = Math.floor(recent.length / 2);
    const average = (slice: readonly SentimentReading[]) => slice.reduce((sum, item) => sum + polarity(item.label), 0) / slice.length;
    const delta = average(recent.slice(middle)) - average(recent.slice(0, middle));
    trend = delta > 0.2 ? "warming" : delta < -0.2 ? "cooling" : "steady";
  }
  return { sampleCount: recent.length, dominant, positive, neutral, negative, trend };
}
