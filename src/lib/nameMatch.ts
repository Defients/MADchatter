/**
 * Fuzzy name matching for audio/chat mention detection.
 *
 * Whisper transcriptions frequently mishear names (e.g. "kovrycha" → "cory cha",
 * "MADchatter" → "mad chatter"). This utility provides tolerant matching that
 * catches exact, partial, and phonetically similar mentions without adding
 * any dependency.
 */

/**
 * Normalize a name for comparison: lowercase, strip non-alphanumeric,
 * collapse whitespace.
 */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Compute Levenshtein edit distance between two strings.
 * Standard DP approach, O(a*b).
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/**
 * Simple Soundex-like first consonant + vowel shape check.
 * Returns true if `word` and `name` start with the same consonant and have
 * a similar vowel structure (used to relax the Levenshtein threshold).
 */
function phoneticallySimilar(word: string, name: string): boolean {
  if (!word || !name) return false;
  if (word[0] !== name[0]) return false;
  const vowels = (s: string) => s.replace(/[^aeiou]/g, "");
  const wv = vowels(word);
  const nv = vowels(name);
  // Same vowel count ±1, or one is a prefix of the other
  if (Math.abs(wv.length - nv.length) <= 1) return true;
  if (wv.length > 0 && nv.startsWith(wv.slice(0, 2))) return true;
  return false;
}

/**
 * Check if `name` is mentioned in `text` using tolerant matching.
 *
 * Strategy (in order of specificity):
 * 1. Exact substring of the normalized name.
 * 2. Partial name match — if the name has significant tokens (≥4 chars),
 *    check if any of them appear as a substring.
 * 3. Fuzzy word match — tokenize text, compute Levenshtein distance between
 *    each word and the name (or name tokens). If distance ≤ threshold, it's
 *    a match. Threshold is 2 for names ≤8 chars, 3 for longer. Phonetic
 *    similarity lowers the threshold by 1 (catches "nightbot" → "night bot").
 *
 * @param text  The text to search (chat message or audio transcript line).
 * @param name  The bot username to look for.
 * @param opts  Optional: { fuzzy: boolean } — defaults to true. When false,
 *              only exact substring matching is used (legacy behavior).
 */
export function isNameMentioned(
  text: string,
  name: string,
  opts?: { fuzzy?: boolean },
): boolean {
  if (!name || !text) return false;
  const fuzzy = opts?.fuzzy ?? true;
  const normName = normalizeName(name);
  if (!normName) return false;
  const lowerText = text.toLowerCase();

  // 1. Exact substring of the full normalized name
  if (lowerText.includes(normName)) return true;
  // Also check without spaces (e.g. "mad chatter" → "madchatter")
  if (lowerText.replace(/\s+/g, "").includes(normName.replace(/\s+/g, ""))) return true;

  if (!fuzzy) return false;

  // 2. Partial name match — check significant tokens (≥4 chars)
  const nameTokens = normName.split(" ").filter((t) => t.length >= 4);
  for (const token of nameTokens) {
    if (lowerText.includes(token)) return true;
  }

  // 3. Fuzzy word match
  const maxDist = normName.length <= 8 ? 2 : 3;
  const words = lowerText.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  for (const word of words) {
    // Skip very short words — they'd match too many things
    if (word.length < 3) continue;
    // Direct distance vs full name
    let dist = levenshtein(word, normName);
    let threshold = maxDist;
    if (phoneticallySimilar(word, normName)) threshold += 1;
    if (dist <= threshold) return true;
    // Also check vs each significant token
    for (const token of nameTokens) {
      if (word === token) return true;
      dist = levenshtein(word, token);
      threshold = token.length <= 8 ? 2 : 3;
      if (phoneticallySimilar(word, token)) threshold += 1;
      if (dist <= threshold) return true;
    }
  }

  return false;
}
