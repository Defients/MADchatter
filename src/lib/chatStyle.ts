/**
 * chatStyle — lightweight, dependency-free heuristic that analyzes a recent
 * chat log and produces a compact "CHAT STYLE PROFILE" describing the
 * chatters' surface typing texture (casing, length, emote cadence,
 * punctuation signals, slang/abbreviation tokens, sample lines).
 *
 * Used by R34L mode (ai.ts) to steer the model toward mirroring the room's
 * actual voice instead of applying a one-size-fits-all overlay. Texture only —
 * never language switching or profanity mirroring.
 *
 * The input is the same formatted chat log string already passed to the AI
 * (`"user: text\nuser: text..."`), produced by formatChatLog() which already
 * filters out the bot's own marked messages.
 */

/** Minimum usable chat lines required to build a profile; below this we return
 * null so the caller falls back to the fixed R34L baseline texture. */
const MIN_SAMPLES = 6;

/** Fraction of lines that must contain a signal for it to be reported. */
const SIGNAL_THRESHOLD = 0.15;

/** Fixed slang/abbreviation lexicon to scan for.
 * Note: trailing-filler tokens ("lol", "tbh", "ngl", "lmao", "fr", "lowkey",
 * "highkey", "istg", "frfr") are intentionally excluded — detecting and
 * mirroring them re-encourages the forced closers R34L mode explicitly bans. */
const SLANG_LEXICON = [
  "ppl", "rn", "bc", "bcuz", "idk", "tho", "w/",
  "omg", "af", "np", "mayb", "kinda", "sorta",
  "cuz", "gonna", "wanna", "ya", "ur", "pls", "plz",
  "bruh", "bruv", "nah", "yep", "nope", "smh",
];

export interface ChatStyleProfile {
  /** "mostly lowercase" | "mixed" | "capitalized" */
  casing: "mostly lowercase" | "mixed" | "capitalized";
  /** classified length bucket */
  lengthBucket: "short" | "medium" | "long";
  /** rounded mean text length in chars */
  avgLength: number;
  /** classified emote density bucket */
  emoteDensity: "none" | "sparse" | "moderate" | "heavy" | "unknown";
  /** most-frequent emotes seen (top 3–5) */
  topEmotes: string[];
  /** punctuation/laugh signals appearing in ≥15% of lines */
  punctuationSignals: string[];
  /** slang/abbreviation tokens seen at least once */
  slangTokens: string[];
  /** 2–3 short representative chatter lines (text only, no username) */
  sampleLines: string[];
  /** number of usable lines analyzed */
  sampleCount: number;
}

/**
 * Analyze a formatted chat log and return a style profile, or null when there
 * isn't enough signal (caller should fall back to the fixed R34L texture).
 */
export function analyzeChatStyle(
  chatLog: string,
  availableEmotes?: string[],
): ChatStyleProfile | null {
  if (!chatLog || !chatLog.trim()) return null;

  // Parse "user: text" lines, splitting on the first ": ".
  const lines: string[] = [];
  for (const raw of chatLog.split("\n")) {
    const idx = raw.indexOf(": ");
    const text = idx >= 0 ? raw.slice(idx + 2) : raw;
    const trimmed = text.trim();
    if (trimmed.length > 0) lines.push(trimmed);
  }

  if (lines.length < MIN_SAMPLES) return null;

  const n = lines.length;

  // ── Casing ───────────────────────────────────────────────────────────────
  let lowercaseLines = 0;
  for (const line of lines) {
    const alpha = line.replace(/[^a-zA-Z]/g, "");
    if (alpha.length === 0) continue;
    const lower = line.replace(/[^a-z]/g, "").length;
    const firstAlpha = line.match(/[a-zA-Z]/);
    const startsLower = firstAlpha ? firstAlpha[0] === firstAlpha[0].toLowerCase() : true;
    if (startsLower && lower / alpha.length > 0.6) lowercaseLines++;
  }
  const lowercaseRatio = lowercaseLines / n;
  const casing: ChatStyleProfile["casing"] =
    lowercaseRatio > 0.6 ? "mostly lowercase" : lowercaseRatio < 0.3 ? "capitalized" : "mixed";

  // ── Average length ───────────────────────────────────────────────────────
  const totalLen = lines.reduce((sum, l) => sum + l.length, 0);
  const avgLength = Math.round(totalLen / n);
  const lengthBucket: ChatStyleProfile["lengthBucket"] =
    avgLength < 40 ? "short" : avgLength <= 90 ? "medium" : "long";

  // ── Emote density ─────────────────────────────────────────────────────────
  let emoteDensity: ChatStyleProfile["emoteDensity"] = "unknown";
  const topEmotes: string[] = [];
  if (availableEmotes && availableEmotes.length > 0) {
    const emoteCounts = new Map<string, number>();
    let totalEmoteUses = 0;
    for (const line of lines) {
      // Count emote occurrences (case-sensitive — emote names are).
      for (const emote of availableEmotes) {
        if (!emote) continue;
        const matches = line.match(new RegExp(escapeRegExp(emote), "g"));
        if (matches) {
          const count = matches.length;
          totalEmoteUses += count;
          emoteCounts.set(emote, (emoteCounts.get(emote) ?? 0) + count);
        }
      }
    }
    const perLine = totalEmoteUses / n;
    emoteDensity =
      totalEmoteUses === 0 ? "none" : perLine < 0.3 ? "sparse" : perLine < 1 ? "moderate" : "heavy";
    topEmotes.push(
      ...[...emoteCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([e]) => e),
    );
  }

  // ── Punctuation / laugh signals ───────────────────────────────────────────
  // Note: trailing "lol"/"lmao" and "xd" signals are intentionally excluded —
  // reporting them as punctuation texture encourages the model to append the
  // exact cringe closers R34L mode forbids.
  const signalPatterns: [string, RegExp][] = [
    ['"..."', /\.\.\./],
    ['"??"', /\?\?/],
    ['"!!"', /!!/],
    ['"?!"', /\?!|!\?/],
    ['"(!)"', /\(!\)/],
  ];
  const punctuationSignals: string[] = [];
  for (const [label, re] of signalPatterns) {
    const hits = lines.filter((l) => re.test(l)).length;
    if (hits / n >= SIGNAL_THRESHOLD) punctuationSignals.push(label);
  }

  // ── Slang / abbreviation tokens ───────────────────────────────────────────
  const slangTokens: string[] = [];
  const lowerJoined = lines.join(" ").toLowerCase();
  for (const tok of SLANG_LEXICON) {
    const re = new RegExp(`(^|[^a-z])${escapeRegExp(tok)}([^a-z]|$)`, "i");
    if (re.test(lowerJoined)) slangTokens.push(tok);
  }

  // ── Sample lines (2–3 shortest non-empty) ─────────────────────────────────
  const sampleLines = [...lines]
    .filter((l) => l.length <= 60)
    .sort((a, b) => a.length - b.length)
    .slice(0, 3);

  return {
    casing,
    lengthBucket,
    avgLength,
    emoteDensity,
    topEmotes,
    punctuationSignals,
    slangTokens,
    sampleLines,
    sampleCount: n,
  };
}

/** Format a ChatStyleProfile into the compact prompt block injected after R34L_TYPING_PROMPT. */
export function formatChatStyleProfile(profile: ChatStyleProfile): string {
  const parts: string[] = [
    `### CHAT STYLE PROFILE — mirror this surface texture`,
    `- Casing: ${profile.casing}`,
    `- Avg length: ${profile.lengthBucket} (~${profile.avgLength} chars)`,
  ];
  if (profile.emoteDensity !== "unknown") {
    const emoteNote =
      profile.topEmotes.length > 0 ? ` (common: ${profile.topEmotes.join(", ")})` : "";
    parts.push(`- Emote density: ${profile.emoteDensity}${emoteNote}`);
  }
  if (profile.punctuationSignals.length > 0) {
    parts.push(`- Punctuation signals: ${profile.punctuationSignals.join(", ")}`);
  }
  if (profile.slangTokens.length > 0) {
    parts.push(`- Slang/abbrev seen: ${profile.slangTokens.join(", ")}`);
  }
  if (profile.sampleLines.length > 0) {
    parts.push(`- Sample chatters: ${profile.sampleLines.map((l) => `"${l}"`).join(", ")}`);
  }
  parts.push(
    `Mirror these SURFACE textures (casing, punctuation, slang density, emote cadence, length) in your output. Do NOT copy any chatter's specific content, do NOT switch language, do NOT increase profanity beyond what your own message warrants. Slang tokens are texture density cues only — never append them as trailing closers or filler.`,
    `### END CHAT STYLE PROFILE`,
  );
  return "\n" + parts.join("\n");
}

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
