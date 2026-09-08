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

function countMatches(text: string, wordSet: Set<string>, emoteSet: Set<string>): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const word of wordSet) {
    if (lower.includes(word)) count++;
  }
  for (const emote of emoteSet) {
    if (text.includes(emote)) count++;
  }
  return count;
}

export function classifySentiment(text: string): { label: SentimentLabel; score: number } {
  if (!text || text.trim().length === 0) {
    return { label: "neutral", score: 0 };
  }

  const toxicScore = countMatches(text, TOXIC_WORDS, TOXIC_EMOTES) * 3;
  const hypeScore = countMatches(text, HYPE_WORDS, HYPE_EMOTES) * 2;
  const wholesomeScore = countMatches(text, WHOLESOME_WORDS, POSITIVE_EMOTES) * 2;
  const positiveScore = countMatches(text, POSITIVE_WORDS, new Set()) * 1;
  const negativeScore = countMatches(text, NEGATIVE_WORDS, NEGATIVE_EMOTES) * 1;

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
