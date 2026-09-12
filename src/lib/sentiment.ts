import type { SentimentLabel, SentimentReading, SentimentSummary } from "../types";

const POSITIVE_WORDS = new Set([
  "good", "great", "awesome", "amazing", "love", "loved", "best", "nice",
  "cool", "fun", "happy", "glad", "thanks", "thank", "appreciate", "beautiful",
  "perfect", "incredible", "fantastic", "wonderful", "brilliant", "genius",
  "clutch", "clean", "smooth", "satisfying", "wholesome", "wholesome100",
  "pog", "poggers", "pogchamp", "lets go", "let's go", "based", "real", "w",
  "gg", "ez", "respect", "underrated", "fire", "peak", "goated", "goat",
  "beautiful", "stunning", "insane", "huge", "massive", "w", "lfg",
]);

const NEGATIVE_WORDS = new Set([
  "bad", "terrible", "awful", "hate", "hated", "worst", "boring", "bored",
  "sad", "unhappy", "angry", "mad", "annoying", "annoyed", "stupid", "dumb",
  "trash", "garbage", "cringe", "cringey", "lame", "wack", "mid", "fell off",
  "dead", "rip", "f", "l", "ratio", "skill issue", "cope", "copium",
  "disappointed", "disappointing", "frustrating", "tilted", "malding",
  "negative", "gross", "yikes", "oof", "rough", "brutal", "painful",
]);

const HYPE_WORDS = new Set([
  "pog", "poggers", "pogchamp", "lets go", "let's go", "no way", "no fucking way",
  "insane", "huge", "massive", "clutch", "god", "goated", "goat", "unreal",
  "lfg", "lftg", "hype", "hyped", "pepega", "monka", "widepeepohappy",
  "kekw", "omegalul", "pogchamp", "kreygasm", "hypers", "clean", "cracked",
  "beast", "insane", "absolute cinema", "cinema", "peak fiction",
  "world first", "wr", "pb", "speedrun", "world record",
]);

const WHOLESOME_WORDS = new Set([
  "wholesome", "wholesome100", "wholesome100%", "cute", "adorable", "sweet",
  "kind", "loving", "wholesome moment", "friend", "bestie", "comfort",
  "cozy", "wholesome vibes", "wholesome content", "wholesome stream",
  "wholesome chat", "wholesome community", "wholesome peepo",
  "love you", "love this", "appreciate you", "thank you", "thanks for",
  "grateful", "blessed", "happy for", "proud of", "support",
]);

const TOXIC_WORDS = new Set([
  "kill yourself", "kys", "trash", "garbage", "delete", "uninstall",
  "you suck", "you're bad", "youre bad", "loser", "pathetic", "embarrassing",
  "cringe", "cringey", "ratio", "l+ratio", "nobody asked", "who asked",
  "did i ask", "shut up", "stfu", "idiot", "moron", "braindead", "smooth brain",
  "neckbeard", "touch grass", "cope", "copium", "seethe", "mald", "cry about it",
  "skill issue", "get good", "git gud", "you're terrible", "youre terrible",
]);

const POSITIVE_EMOTES = new Set([
  "🙂", "😄", "😀", "😍", "🥰", "😊", "🤗", "👍", "👏", "🙌", "💪", "❤️", "💕",
  "💙", "💚", "🧡", "💛", "🤍", "💖", "✨", "🔥", "💯", "🎉", "🎊", "🥳",
  "<3", "<33", "<333", "Kappa", "Kreygasm", "PogChamp", "Poggers", "Pog",
  "FeelsGoodMan", "SeemsGood", "EZClap", "4Head", "5Head", "TriHard",
  "CoolCat", "PartyTime", "BlessRNG", "GoldenKappa", "catJAM", "PeepoHappy",
  "WidePeepoHappy", "PeepoClap",
]);

const NEGATIVE_EMOTES = new Set([
  "😢", "😭", "😡", "😠", "👎", "💀", "☠️", "🤡", "🤦", "🤮", "💔",
  "BibleThump", "FeelsBadMan", "Pepega", "PepeHands", "monkaS", "monkaW",
  "Sadge", "WeirdChamp", "NotLikeThis", "FailFish", "DansGame", "WutFace",
  "PeepoSad", "WidePeepoSad", "PepeLa", "KEKW", "LULW", "OMEGALUL", "EleGiggle",
]);

const HYPE_EMOTES = new Set([
  "🔥", "💯", "🎉", "🚀", "⚡", "💪", "🙌", "⭐", "🏆",
  "PogChamp", "Poggers", "Pog", "KEKW", "Kreygasm", "EZClap", "5Head",
  "WidePeepoHappy", "PeepoHappy", "catJAM", "Hypers",
]);

const TOXIC_EMOTES = new Set([
  "🤡", "💀", "☠️", "👎", "🤮",
  "Pepega", "WeirdChamp", "KEKW", "OMEGALUL", "LULW", "EleGiggle",
  "PepegaBox", "FeelingKachow",
]);

// ─── Negation & Intensity Handling ────────────────────────────────────────────

/** Negation words that flip the sentiment of a following sentiment word. */
const NEGATION_WORDS = new Set([
  "not", "never", "dont", "don't", "doesnt", "doesn't", "isnt", "isn't",
  "arent", "aren't", "wasnt", "wasn't", "werent", "weren't", "wont",
  "won't", "cant", "can't", "couldnt", "couldn't", "shouldnt", "shouldn't",
  "wouldnt", "wouldn't", "no", "nor", "neither", "barely", "hardly",
]);

/** Intensity amplifiers — multiply the following word's score by 1.5. */
const AMPLIFIERS = new Set([
  "very", "really", "super", "extremely", "incredibly", "so", "too",
  "absolutely", "totally", "completely", "utterly", "hella", "crazy",
  "insanely", "wildly", "genuinely", "truly", "mad", "af",
]);

/** Intensity dampeners — multiply the following word's score by 0.5. */
const DAMPENERS = new Set([
  "kinda", "kind of", "sorta", "sort of", "slightly", "somewhat",
  "a bit", "a little", "mildly", "fairly", "reasonably", "semi",
]);

/** Max words to look back for a negation word. */
const NEGATION_WINDOW = 3;

/**
 * Find all match positions of `phrase` in `text` (case-insensitive).
 * For single words (no spaces), uses word-boundary matching to avoid
 * false-positive substring matches (e.g. "w" matching "what", "kind"
 * matching "kinda", "l" matching "let"). Multi-word phrases (e.g. "lets go",
 * "skill issue") use substring matching since they're specific enough.
 * Returns the start index of each occurrence.
 */
function findMatchPositions(text: string, phrase: string): number[] {
  const positions: number[] = [];
  if (!phrase) return positions;
  if (!phrase.includes(" ")) {
    // Word-boundary match for single words.
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(phrase)}([^a-z0-9]|$)`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // Position of the phrase within the match (after the leading boundary).
      positions.push(m.index + (m[1] ? m[1].length : 0));
      // Avoid infinite loop on zero-length matches.
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  } else {
    let idx = text.indexOf(phrase);
    while (idx >= 0) {
      positions.push(idx);
      idx = text.indexOf(phrase, idx + 1);
    }
  }
  return positions;
}

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract the words preceding a match position (up to `window` words back).
 * Returns lowercase word tokens.
 */
function getPrecedingWords(text: string, matchPos: number, window: number): string[] {
  const prefix = text.slice(0, matchPos).trim();
  if (!prefix) return [];
  const words = prefix.split(/\s+/);
  return words.slice(-window).map((w) => w.toLowerCase().replace(/[^a-z']/g, ""));
}

/**
 * Check if a negation word appears within the preceding `window` words.
 * Also returns the word immediately before the match (for intensity detection).
 */
function checkNegationAndIntensity(
  precedingWords: string[],
): { negated: boolean; multiplier: number } {
  let negated = false;
  let multiplier = 1.0;

  for (let i = 0; i < precedingWords.length; i++) {
    const w = precedingWords[i];
    if (NEGATION_WORDS.has(w)) {
      negated = true;
    }
    // Intensity modifier must be the word immediately before the match
    // (last word in precedingWords) to apply.
    if (i === precedingWords.length - 1) {
      if (AMPLIFIERS.has(w)) multiplier = 1.5;
      else if (DAMPENERS.has(w)) multiplier = 0.5;
    }
  }

  return { negated, multiplier };
}

/**
 * Count matches with negation and intensity awareness.
 *
 * For each word/phrase in `wordSet` found in the text:
 * - If a negation word appears within `NEGATION_WINDOW` words before the match,
 *   the match contributes 0 to its own category and is tracked separately as
 *   a "flipped" contribution for the OPPOSITE category (caller routes it).
 * - If an intensity modifier (amplifier/dampener) is the word immediately before,
 *   the match's weight is scaled (×1.5 or ×0.5).
 *
 * Emotes are not subject to negation (you can't "not PogChamp" an emote).
 *
 * Returns `{ direct, flipped }` where:
 * - `direct` = non-negated matches (contributes to THIS category)
 * - `flipped` = negated matches (contributes to the OPPOSITE category)
 */
function countMatchesWithNegation(
  text: string,
  wordSet: Set<string>,
  emoteSet: Set<string>,
): { direct: number; flipped: number } {
  const lower = text.toLowerCase();
  let direct = 0;
  let flipped = 0;

  for (const word of wordSet) {
    const positions = findMatchPositions(lower, word);
    for (const pos of positions) {
      const preceding = getPrecedingWords(lower, pos, NEGATION_WINDOW);
      const { negated, multiplier } = checkNegationAndIntensity(preceding);
      if (negated) {
        // Negated match: contributes 0 to its own category, and 0.5 * multiplier
        // to the opposite category. Reduced weight because negation weakens
        // the signal — "not great" is mildly negative, not strongly negative.
        flipped += 0.5 * multiplier;
      } else {
        direct += 1 * multiplier;
      }
    }
  }

  // Emotes — no negation handling (emotes are visual, not negatable in text).
  for (const emote of emoteSet) {
    if (text.includes(emote)) direct += 1;
  }

  return { direct, flipped };
}

export function classifySentiment(text: string): { label: SentimentLabel; score: number } {
  if (!text || text.trim().length === 0) {
    return { label: "neutral", score: 0 };
  }

  // Negation-aware scoring: when a sentiment word is negated ("not bad"),
  // it contributes its weight to the OPPOSITE category instead of its own.
  // Intensity modifiers scale the weight of the following word.
  //
  // Flip routing:
  //   POSITIVE↔NEGATIVE  ("not great" → negative, "not bad" → positive)
  //   HYPE→NEGATIVE      ("not pog" → negative; negated hype deflates)
  //   WHOLESOME→NEGATIVE ("not cute" → negative)
  //   TOXIC→POSITIVE      ("not trash" → mild positive; negated toxic deflates)
  const toxic = countMatchesWithNegation(text, TOXIC_WORDS, TOXIC_EMOTES);
  const hype = countMatchesWithNegation(text, HYPE_WORDS, HYPE_EMOTES);
  const wholesome = countMatchesWithNegation(text, WHOLESOME_WORDS, POSITIVE_EMOTES);
  const positive = countMatchesWithNegation(text, POSITIVE_WORDS, new Set());
  const negative = countMatchesWithNegation(text, NEGATIVE_WORDS, NEGATIVE_EMOTES);

  // Route negated ("flipped") contributions to the opposite category.
  // POSITIVE↔NEGATIVE, TOXIC→POSITIVE. Hype and wholesome just deflate
  // when negated (no flip — "not pog" is less hype, not actively negative).
  const toxicScore = toxic.direct * 3;
  const hypeScore = hype.direct * 2;
  const wholesomeScore = wholesome.direct * 2;
  const positiveScore = (positive.direct + negative.flipped + toxic.flipped) * 1;
  const negativeScore = (negative.direct + positive.flipped) * 1;

  // Toxic overrides everything
  if (toxicScore >= 2) return { label: "toxic", score: Math.min(1, toxicScore / 5) };
  if (toxicScore >= 1 && hypeScore === 0 && wholesomeScore === 0) {
    return { label: "toxic", score: Math.min(1, toxicScore / 4) };
  }

  // Hype is next priority
  if (hypeScore >= 2) return { label: "hype", score: Math.min(1, hypeScore / 5) };
  if (hypeScore >= 1 && hypeScore > positiveScore) return { label: "hype", score: Math.min(1, hypeScore / 3) };

  // Wholesome
  if (wholesomeScore >= 2) return { label: "wholesome", score: Math.min(1, wholesomeScore / 4) };
  if (wholesomeScore >= 1 && wholesomeScore > positiveScore) return { label: "wholesome", score: Math.min(1, wholesomeScore / 3) };

  // Positive vs negative
  if (positiveScore > negativeScore && positiveScore >= 1) {
    return { label: "positive", score: Math.min(1, positiveScore / 3) };
  }
  if (negativeScore > positiveScore && negativeScore >= 1) {
    return { label: "negative", score: Math.min(1, negativeScore / 3) };
  }

  // Caps lock detection = hype
  const upperRatio = (text.replace(/[^a-zA-Z]/g, "").match(/[A-Z]/g) || []).length;
  const totalLetters = text.replace(/[^a-zA-Z]/g, "").length;
  if (totalLetters > 5 && upperRatio / totalLetters > 0.7) {
    return { label: "hype", score: 0.5 };
  }

  // Exclamation marks = mild hype
  const exclamationCount = (text.match(/!/g) || []).length;
  if (exclamationCount >= 3) {
    return { label: "hype", score: 0.3 };
  }

  return { label: "neutral", score: 0 };
}

const MAX_READINGS = 100;

export function addSentimentReading(
  history: SentimentReading[],
  reading: SentimentReading,
): SentimentReading[] {
  const updated = [...history, reading];
  if (updated.length > MAX_READINGS) {
    updated.splice(0, updated.length - MAX_READINGS);
  }
  return updated;
}

export function summarizeSentiment(history: SentimentReading[]): SentimentSummary {
  const recent = history.slice(-50);
  if (recent.length === 0) {
    return {
      current: "neutral",
      distribution: { positive: 0, negative: 0, hype: 0, wholesome: 0, toxic: 0, neutral: 0 },
      trend: "stable",
      dominantScore: 0,
      readings: [],
    };
  }

  const distribution: Record<SentimentLabel, number> = {
    positive: 0, negative: 0, hype: 0, wholesome: 0, toxic: 0, neutral: 0,
  };
  for (const r of recent) {
    distribution[r.label]++;
  }

  const dominant = Object.entries(distribution).reduce((a, b) =>
    b[1] > a[1] ? b : a,
  )[0] as SentimentLabel;

  const dominantScore = recent.length > 0 ? distribution[dominant] / recent.length : 0;

  // Trend: compare last 10 readings vs previous 10
  const last10 = recent.slice(-10);
  const prev10 = recent.slice(-20, -10);
  const last10Positive = last10.filter((r) =>
    r.label === "positive" || r.label === "hype" || r.label === "wholesome",
  ).length;
  const prev10Positive = prev10.filter((r) =>
    r.label === "positive" || r.label === "hype" || r.label === "wholesome",
  ).length;

  let trend: "rising" | "falling" | "stable" = "stable";
  if (prev10.length > 0) {
    const lastRatio = last10Positive / Math.max(1, last10.length);
    const prevRatio = prev10Positive / Math.max(1, prev10.length);
    if (lastRatio - prevRatio > 0.15) trend = "rising";
    else if (prevRatio - lastRatio > 0.15) trend = "falling";
  }

  return {
    current: dominant,
    distribution,
    trend,
    dominantScore,
    readings: recent,
  };
}

export function formatSentimentContext(summary: SentimentSummary): string {
  if (summary.readings.length === 0) return "";

  const parts: string[] = [];
  parts.push(`[CHAT SENTIMENT] Current vibe: ${summary.current} (${Math.round(summary.dominantScore * 100)}% dominant). Trend: ${summary.trend}.`);

  const dist = Object.entries(summary.distribution)
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label}: ${count}`)
    .join(", ");
  parts.push(`Distribution: ${dist}`);

  if (summary.current === "toxic") {
    parts.push("⚠ Chat sentiment is turning toxic — consider de-escalating or staying positive.");
  } else if (summary.current === "hype" && summary.trend === "rising") {
    parts.push("🔥 Chat hype is rising — this is a good moment to engage with high-energy content.");
  } else if (summary.current === "wholesome") {
    parts.push("💕 Chat is in a wholesome mood — warm, supportive messages will land well.");
  } else if (summary.current === "negative" && summary.trend === "falling") {
    parts.push("📉 Chat sentiment is declining — consider lighter or more positive contributions.");
  }

  return parts.join("\n");
}

export const SENTIMENT_COLORS: Record<SentimentLabel, string> = {
  positive: "text-green-400 bg-green-500/10",
  negative: "text-red-400 bg-red-500/10",
  hype: "text-orange-400 bg-orange-500/10",
  wholesome: "text-pink-400 bg-pink-500/10",
  toxic: "text-red-600 bg-red-600/10",
  neutral: "text-gray-400 bg-gray-500/10",
};

export const SENTIMENT_DOT_COLORS: Record<SentimentLabel, string> = {
  positive: "bg-green-400",
  negative: "bg-red-400",
  hype: "bg-orange-400",
  wholesome: "bg-pink-400",
  toxic: "bg-red-600",
  neutral: "bg-gray-400",
};
