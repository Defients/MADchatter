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

// ─── Jaccard Semantic Dedup ──────────────────────────────────────────────────

/**
 * Tokenize a message into a set of lowercase words with punctuation stripped.
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 0),
  );
}

/**
 * Compute Jaccard similarity between two word sets: |intersection| / |union|.
 * Returns 0 if both sets are empty.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  for (const word of smaller) {
    if (larger.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Check if a payload is a near-duplicate of any recently sent message using
 * Jaccard similarity on word sets. Catches reworded duplicates (same words,
 * different order) that exact-match misses.
 *
 * @param payload - The candidate message (already lowercased + trimmed by caller)
 * @param recentSentMessages - Recent sent messages (already lowercased + trimmed)
 * @param threshold - Jaccard similarity threshold (default 0.6 = 60% word overlap)
 * @returns true if any recent message exceeds the similarity threshold
 */
export function isNearDuplicate(
  payload: string,
  recentSentMessages: string[],
  threshold: number = 0.6,
): boolean {
  if (!payload || recentSentMessages.length === 0) return false;
  const payloadTokens = tokenize(payload);
  // Skip short messages — too few words for meaningful similarity.
  if (payloadTokens.size < 3) return false;
  for (const recent of recentSentMessages) {
    if (!recent) continue;
    const recentTokens = tokenize(recent);
    if (recentTokens.size < 3) continue;
    const similarity = jaccardSimilarity(payloadTokens, recentTokens);
    if (similarity >= threshold) return true;
  }
  return false;
}
