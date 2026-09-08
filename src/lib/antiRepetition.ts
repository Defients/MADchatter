import type { SentMessage } from "../types";

export interface RepetitionAnalysis {
  recentMessages: string[];
  recentPatterns: string[];
  repeatedPhrases: string[];
  openingPhrases: string[];
  averageMessageLength: number;
  varietyScore: number;
}

const OPENING_PATTERNS = [
  /^(hey|yo|lol|lmao|omg|no way|wait|bruh|bro|nah|yeah|yooo|holy|damn|whew|woah|whoa)/i,
  /^(pog|kekw|lulw|omegalul|ez|clap|based|real|w|l)/i,
  /^(i|i'm|i am|you|we|they|this|that|it's|its)/i,
  /^\*/,
];

function extractOpeningPhrase(message: string): string {
  const trimmed = message.trim();
  for (const pattern of OPENING_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) return match[1].toLowerCase();
  }
  return trimmed.split(/\s+/)[0]?.toLowerCase() || "";
}

function extractNgrams(text: string, n: number): string[] {
  const words = text.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  if (words.length < n) return [];
  const ngrams: string[] = [];
  for (let i = 0; i <= words.length - n; i++) {
    ngrams.push(words.slice(i, i + n).join(" "));
  }
  return ngrams;
}

function findRepeatedPhrases(messages: string[], minLen: number = 3): string[] {
  const ngramCounts = new Map<string, number>();
  for (const msg of messages) {
    const ngrams = extractNgrams(msg, minLen);
    for (const ngram of ngrams) {
      ngramCounts.set(ngram, (ngramCounts.get(ngram) || 0) + 1);
    }
  }
  return [...ngramCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([phrase]) => phrase);
}

export function analyzeRepetition(sentMessages: SentMessage[], windowSize: number = 20): RepetitionAnalysis {
  const recent = sentMessages.slice(-windowSize);
  const messages = recent.map((s) => s.message);

  if (messages.length === 0) {
    return {
      recentMessages: [],
      recentPatterns: [],
      repeatedPhrases: [],
      openingPhrases: [],
      averageMessageLength: 0,
      varietyScore: 1.0,
    };
  }

  const openings = messages.map(extractOpeningPhrase);
  const openingCounts = new Map<string, number>();
  for (const op of openings) {
    if (op) openingCounts.set(op, (openingCounts.get(op) || 0) + 1);
  }
  const dominantOpenings = [...openingCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([phrase]) => phrase);

  const repeatedPhrases = findRepeatedPhrases(messages);

  const avgLen = messages.reduce((s, m) => s + m.length, 0) / messages.length;

  // Variety score: 1.0 = perfectly varied, 0.0 = highly repetitive
  const uniqueMessages = new Set(messages.map((m) => m.toLowerCase().trim())).size;
  const uniqueOpenings = new Set(openings.filter(Boolean)).size;
  const messageVariety = uniqueMessages / messages.length;
  const openingVariety = openings.length > 0 ? uniqueOpenings / openings.length : 1;
  const varietyScore = messageVariety * 0.6 + openingVariety * 0.4;

  return {
    recentMessages: messages.slice(-10),
    recentPatterns: dominantOpenings,
    repeatedPhrases,
    openingPhrases: dominantOpenings,
    averageMessageLength: avgLen,
    varietyScore,
  };
}

export function formatRepetitionContext(analysis: RepetitionAnalysis): string {
  const parts: string[] = [];

  if (analysis.recentMessages.length > 0) {
    parts.push(`YOUR RECENT SENT MESSAGES (avoid repeating these or similar patterns):`);
    for (const msg of analysis.recentMessages) {
      parts.push(`- "${msg}"`);
    }
  }

  if (analysis.repeatedPhrases.length > 0) {
    parts.push(`\nOVERUSED PHRASES (do not use these again):`);
    for (const phrase of analysis.repeatedPhrases) {
      parts.push(`- "${phrase}"`);
    }
  }

  if (analysis.openingPhrases.length > 0) {
    parts.push(`\nOVERUSED OPENING PATTERNS (vary your sentence starts):`);
    for (const op of analysis.openingPhrases) {
      parts.push(`- "${op}"`);
    }
  }

  if (analysis.varietyScore < 0.6) {
    parts.push(`\n⚠ VARIETY ALERT: Your recent messages are becoming repetitive (variety score: ${analysis.varietyScore.toFixed(2)}). Consciously vary your tone, length, structure, and vocabulary.`);
  }

  return parts.length > 0 ? parts.join("\n") : "";
}
