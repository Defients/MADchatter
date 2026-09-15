/**
 * SpokenCallout — Spoken Callout Priority (v29).
 *
 * Problem: MADchatter hears the streamer, but every name occurrence in the
 * transcript was treated the same. "I saw Gremlin earlier" forced a check for
 * Gremlin exactly like "Gremlin, what do you think?" does. The result was
 * keyword-matching, not listening: false activations on third-person
 * mentions, STT hallucinations, TTS echoes of the bots' own messages, and
 * swarm triggers when a fuzzy name matched several bots at once.
 *
 * Solution: a deterministic address detector between transcription and
 * routing. Every final transcript line is analyzed for:
 *
 *   1. IDENTITY — which bot (by canonical bot ID) was named, using a bounded
 *      spoken-name lexicon (username, label, explicit aliases; joined/space
 *      variants for STT splitting; strictly-bounded Levenshtein for mishears).
 *   2. ADDRESS vs MENTION — vocative syntax (name at start, comma/question
 *      after, second-person language) versus third-person markers
 *      ("said", "saw", "keeps", "earlier"…). A name alone is not an obligation.
 *   3. INTENT — question / command-request / greeting / acknowledgment /
 *      generic address / negative instruction ("BotA don't answer").
 *   4. CONFIDENCE — nameMatch × addressLikelihood, fused against a
 *      distinctiveness-aware threshold (common-word bot names like "May" get
 *      a stricter bar; fuzzy matches get a stricter bar).
 *   5. LIFECYCLE — confirmed → claimed → consumed / expired with per-kind
 *      TTL, repeat merging ("Gremlin? Gremlin, hello?" = one callout) and
 *      follow-up enrichment.
 *
 * Only a CONFIRMED specific/ensemble callout creates a routing opportunity
 * (the store action dispatches the existing `autoforge-force-check` event).
 * Everything else stays as ambient transcript context. Hard controls are
 * untouched: the global stop still blocks at the platformSend chokepoint,
 * rate limits still apply, and a disabled target bot is never routed.
 *
 * Purity contract: no store, no React, no AI calls, no timers, no DOM.
 * All ingestion is explicit note*() calls with injectable timestamps; the
 * engine is a deterministic function of its bounded buffers, so the whole
 * detector is testable via `detectSpokenCallout` / `simulateSpokenCallout`
 * without React, providers, or live transcription. Zero recurring LLM cost.
 *
 * Echo protection: bot sends are TTS-read on stream; the transcriber hears
 * them back. `noteAgentSpeech` records recent bot output and any transcript
 * line that paraphrases it within the echo window is classified agent_echo —
 * a bot's own speech can never call out another bot (no feedback loops).
 *
 * Channel isolation: the engine is channel-scoped exactly like
 * semanticCoordination / participation — a channel change wipes every active
 * callout, so a Channel-A callout can never route, refresh, or expire inside
 * Channel B. Callout state is never persisted (reload = clean slate).
 */

import { generateId } from "./ids";

// ─── Types ───────────────────────────────────────────────────────────────────

/** What the streamer's utterance asks of the target. */
export type SpokenCalloutKind =
  | "direct_question" // "Gremlin, what do you think?"
  | "command_request" // "Gremlin, roast that build."
  | "greeting" // "Hey Gremlin."
  | "acknowledgment" // "Good one, Gremlin."
  | "generic_address" // "Gremlin?" / "Yo Gremlin."
  | "negative_instruction"; // "Gremlin, don't answer this."

/** Who the utterance addresses. Resolved to canonical bot IDs, never display strings. */
export type SpokenCalloutTarget =
  | { type: "bot"; botId: string }
  | { type: "ensemble" } // "MADchatter" / confidently-addressed "bots"
  | { type: "multi_bot"; botIds: string[] } // "Gremlin and Analyst, both take"
  | { type: "ambiguous"; candidateBotIds: string[] }; // name fits 2+ bots

/** One active bot's bounded set of spoken names. */
export interface SpokenIdentity {
  botId: string;
  /** UI/display name (label) — presentation only, never identity. */
  display: string;
  /** Normalized spoken names (exact tier): username first, then label/aliases. */
  names: string[];
}

export interface SpokenCalloutEvidence {
  /** 0..1 — how well the transcript word matches a spoken name. */
  nameMatch: number;
  /** "exact" (username) | "alias" (label/alias) | "fuzzy" (bounded STT mishear). */
  matchType: "exact" | "alias" | "fuzzy";
  /** 0..1 — vocative syntax vs third-person mention evidence. */
  addressLikelihood: number;
  matchedText: string;
  utterancePosition: "start" | "mid" | "end" | "alone";
  questionCue: boolean;
  imperativeCue: boolean;
  negativeCue: boolean;
}

export type SpokenCalloutState = "confirmed" | "claimed" | "consumed" | "expired";

export interface SpokenCallout {
  id: string;
  channel: string | null;
  detectedAt: number;
  /** Most recent repeat utterance ("Gremlin? Gremlin, hello?"). */
  latestSpokenAt: number;
  target: SpokenCalloutTarget;
  /** Display string for the target (bot label or "MADchatter") — UI only. */
  targetDisplay: string;
  kind: SpokenCalloutKind;
  transcriptText: string;
  /** 0..1 fused confidence. */
  confidence: number;
  evidence: SpokenCalloutEvidence;
  /** Repeated callouts merged into this one. */
  repeatCount: number;
  expiresAt: number;
  state: SpokenCalloutState;
  consumedByBotId?: string;
  /** spokenAt → sent latency when consumed (diagnostics only). */
  responseLatencyMs?: number;
}

/** Result of analyzing one transcript line (pure). */
export interface SpokenCalloutDetection {
  classification:
    | "confirmed" // actionable direct address
    | "candidate" // name present, address evidence too weak — no routing
    | "mention_only" // name present, third-person/contextual
    | "agent_echo" // paraphrases recent bot output — suppressed
    | "no_match";
  target?: SpokenCalloutTarget;
  targetDisplay?: string;
  kind?: SpokenCalloutKind;
  confidence: number;
  evidence?: SpokenCalloutEvidence;
  transcriptText: string;
  /** Why this classification was reached (diagnostics). */
  reason: string;
}

// ─── Limits & Weights (centralized, exported for tests) ──────────────────────

export const SPOKEN_CALLOUT_LIMITS = {
  /** Confirmed callouts require this fused confidence (after penalties). */
  confirmThreshold: 0.7,
  /** Below this a name occurrence is mention-only noise. */
  candidateThreshold: 0.45,
  /** Non-distinctive (common-word / ≤3-char) names need a stricter bar. */
  commonWordThresholdPenalty: 0.14,
  /** Bounded-fuzzy matches need a stricter bar. */
  fuzzyThresholdPenalty: 0.1,
  /** Response windows per kind (ms). Late answers feel broken. */
  ttlMs: {
    direct_question: 12_000,
    command_request: 12_000,
    greeting: 20_000,
    acknowledgment: 8_000,
    generic_address: 8_000,
    negative_instruction: 15_000,
  } as Record<SpokenCalloutKind, number>,
  /** Repeated name utterances merge into one callout within this window. */
  mergeWindowMs: 20_000,
  /** Bot TTS echo suppression window. */
  echoWindowMs: 12_000,
  /** Word-overlap ratio for echo classification. */
  echoJaccard: 0.5,
  /** Bounded agent-speech ring for echo protection. */
  maxAgentEchoEntries: 40,
  /** Bounded callout log (diagnostics). */
  maxLog: 20,
  /** Bounded spoken aliases per bot. */
  maxAliasesPerBot: 6,
  /** Minimum normalized length for any spoken name. */
  minNameLength: 3,
  /** Fuzzy matching only for distinctive names at least this long. */
  minFuzzyNameLength: 5,
  /** Bounded Levenshtein distance for STT mishears. */
  fuzzyMaxDistance: 2,
} as const;

// ─── Lexicon: common words that must never lightly become bot names ──────────

/**
 * Words that occur naturally in streamer speech. A spoken name that
 * normalizes to one of these (or is ≤3 chars) is NOT distinctive — direct
 * address then requires strictly stronger syntax ("May, what do you think?"
 * with vocative comma can still pass; "May I see that?" never does).
 */
const COMMON_SPOKEN_WORDS = new Set([
  "may", "can", "will", "shall", "just", "say", "said", "sees", "saw", "hey",
  "hi", "ok", "okay", "chat", "bot", "bots", "ai", "the", "who", "you", "now",
  "here", "there", "what", "when", "where", "how", "why", "whoa", "one",
  "two", "time", "day", "man", "guy", "dude", "bro", "sis", "mom", "dad",
  "dog", "cat", "run", "win", "won", "war", "job", "sun", "sky", "sea", "top",
  "pop", "jam", "van", "dot", "map", "cap", "tap", "bag", "era", "age", "ice",
  "tea", "are", "our", "out", "own", "off", "add", "aid", "aim", "air", "arm",
  "art", "ask", "bad", "ban", "bar", "bed", "bet", "big", "bit", "box", "buy",
  "cut", "dab", "dig", "dim", "dip", "doe", "dry", "due", "eat", "egg", "ego",
  "end", "eve", "eye", "fan", "far", "fat", "fee", "few", "fig", "fit", "fix",
  "fly", "for", "fox", "fun", "gas", "get", "got", "gum", "gun", "gut", "ham",
  "has", "hat", "her", "him", "his", "hit", "hmm", "hog", "hot", "hug", "ill",
  "ink", "ire", "its", "jaw", "jet", "jog", "joy", "key", "kid", "kin", "kit",
  "lab", "lad", "lag", "lap", "law", "lay", "led", "leg", "let", "lid", "lie",
  "lip", "lit", "log", "lot", "low", "lab", "mad", "mat", "men", "met", "mix",
  "mob", "mop", "mud", "mug", "nab", "nap", "net", "new", "nod", "nor", "not",
  "nut", "oak", "oar", "oat", "odd", "oil", "old", "orb", "ore", "owe", "owl",
  "pad", "pal", "pan", "par", "pat", "paw", "pay", "pea", "peg", "pen", "per",
  "pet", "pie", "pig", "pin", "pit", "ply", "pod", "pot", "pow", "pro", "pub",
  "pug", "pun", "put", "rag", "ram", "ran", "rap", "rat", "raw", "ray", "red",
  "rib", "rid", "rig", "rim", "rip", "rob", "rod", "rot", "row", "rub", "rue",
  "rug", "rum", "rut", "sad", "sap", "sat", "see", "set", "sew", "she", "shy",
  "sin", "sip", "sir", "sit", "six", "ski", "sly", "sob", "son", "sow", "soy",
  "spa", "spy", "sty", "sub", "sue", "sum", "sup", "tab", "tag", "tan", "tar",
  "tat", "tax", "ten", "thy", "tic", "tie", "tin", "tip", "toe", "ton", "too",
  "tot", "tow", "toy", "try", "tub", "urn", "use", "vat", "vet", "via", "vie",
  "wad", "wag", "wax", "way", "web", "wed", "wee", "wet", "wig", "wit", "woe",
  "wok", "woo", "wow", "wry", "yet", "yew", "zap", "zen", "zip", "zoo",
]);

/** Generic ensemble identifiers (strictly syntax-gated when spoken). */
const GENERIC_ENSEMBLE_WORDS = new Set(["bots", "bot", "ai", "chatbot"]);

// ─── Normalization & pure helpers ─────────────────────────────────────────────

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Normalize a spoken name / transcript word: lowercase, join apostrophes
 * ("where's" → "wheres"), keep letters+digits and single spaces.
 */
export function normalizeSpokenText(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strip the transcript-line formatting the transcription hooks add
 * ("[mm:ss] '...'") so detection sees the raw utterance.
 */
export function stripTranscriptDecorations(line: string): string {
  let text = line;
  const ts = /^\s*\[\d{1,3}:\d{2}\]\s*/.exec(text);
  if (ts) text = text.slice(ts[0].length);
  text = text.trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    text = text.slice(1, -1);
  }
  return text.trim();
}

/** Is this name distinctive enough for ordinary-confidence matching? */
export function isDistinctiveName(normalizedName: string): boolean {
  if (normalizedName.length < SPOKEN_CALLOUT_LIMITS.minNameLength) return false;
  return !COMMON_SPOKEN_WORDS.has(normalizedName);
}

/** Standard DP Levenshtein with early exit once distance exceeds `max`. */
function levenshteinWithin(a: string, b: string, max: number): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > max) return false;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return false;
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length] <= max;
}

function wordSet(text: string): Set<string> {
  return new Set(normalizeSpokenText(text).split(" ").filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const w of small) if (large.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Identity lexicon ─────────────────────────────────────────────────────────

export interface SpokenIdentitySource {
  id: string;
  label?: string;
  active?: boolean;
  session?: { username?: string } | null;
  persona?: { spokenAliases?: string[] } | null;
}

/**
 * Build the bounded spoken-identity set for the active bots.
 *
 * Names per bot (deduped, order = precedence for match scoring):
 *   1. platform username (exact tier, score 1.0)
 *   2. bot label (alias tier, score 0.95)
 *   3. explicit spoken aliases (alias tier, score 0.95)
 *
 * Dangerous auto-derivations are forbidden: no substrings of machine-like
 * usernames ("MegaBot123" never yields "mega"/"bot"/"123"). Distinctiveness
 * is evaluated per matched name at detection time, not per bot.
 */
export function buildSpokenIdentities(
  bots: SpokenIdentitySource[],
  extraLegacyUsernames: string[] = [],
): SpokenIdentity[] {
  const identities: SpokenIdentity[] = [];
  for (const bot of bots) {
    if (bot.active === false || !bot.session?.username) continue;
    const names: string[] = [];
    const add = (raw: string) => {
      const n = normalizeSpokenText(raw);
      if (n.length >= SPOKEN_CALLOUT_LIMITS.minNameLength && !names.includes(n)) names.push(n);
    };
    add(bot.session.username);
    if (bot.label) add(bot.label);
    for (const alias of bot.persona?.spokenAliases ?? []) add(alias);
    if (names.length === 0) continue;
    identities.push({
      botId: bot.id,
      display: bot.label || bot.session.username,
      names,
    });
  }
  // Legacy single-bot mode: platform session globals may hold the active
  // username when bots[] is not synced. bot-less identities still match (the
  // caller routes a broadcast force-check, never a wrong bot ID).
  for (const extra of extraLegacyUsernames) {
    const n = normalizeSpokenText(extra);
    if (n.length < SPOKEN_CALLOUT_LIMITS.minNameLength) continue;
    if (identities.some((i) => i.names.includes(n))) continue;
    identities.push({ botId: "", display: extra, names: [n] });
  }
  return identities;
}

// ─── Detection (pure) ─────────────────────────────────────────────────────────

interface NameMatchResult {
  identity: SpokenIdentity;
  matchedWord: string;
  /** The normalized name that matched (for punctuation checks). */
  matchedName: string;
  matchType: "exact" | "alias" | "fuzzy";
  nameMatch: number;
  /** Distinctiveness of the MATCHED name (common-word names are stricter). */
  nameDistinctive: boolean;
  wordIndex: number;
}

const QUESTION_STARTERS = new Set([
  "what", "whats", "why", "how", "hows", "when", "where", "wheres", "which",
  "who", "whos", "whose", "can", "could", "would", "should", "will", "shall",
  "do", "does", "did", "is", "are", "was", "were", "am", "have", "has", "any",
]);

const IMPERATIVE_VERBS = new Set([
  "tell", "say", "explain", "roast", "give", "answer", "do", "pick", "choose",
  "rate", "describe", "name", "list", "summarize", "compare", "decide",
  "calculate", "translate", "take", "guess", "call", "rank", "judge", "weigh",
]);

const GREETING_WORDS = new Set(["hey", "hi", "hello", "yo", "sup", "ay", "ayy", "heyy"]);

const THIRD_PERSON_BEFORE = new Set([
  "said", "says", "saw", "seen", "banned", "thinks", "thought", "keeps",
  "kept", "was", "is", "are", "were", "earlier", "again", "about", "called",
  "named", "heard", "told", "mentioned", "chat", "that", "this", "wheres",
  "like", "likes", "loved", "hated", "missed", "recalled", "and",
]);

const NEGATIVE_RE =
  /\b(don'?t|do not|dont)\s+(answer|respond|reply|say|talk|bother|worry)|be quiet|shut up|stop (talking|responding|answering|replying)|no response|don'?t say anything|dont say anything|don'?t you dare|not you\b|hush\b|chill out|cool it\b/i;

/** Match every identity's spoken names against the utterance words. */
function matchIdentities(words: string[], identities: SpokenIdentity[]): NameMatchResult[] {
  const L = SPOKEN_CALLOUT_LIMITS;
  const results: NameMatchResult[] = [];
  for (const identity of identities) {
    const username = identity.names[0] ?? "";
    let best: NameMatchResult | undefined;
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const next = i + 1 < words.length ? words[i + 1] : null;
      for (const name of identity.names) {
        let matched: NameMatchResult | undefined;
        const isUsername = name === username;
        if (word === name) {
          matched = {
            identity, matchedWord: word, matchedName: name,
            matchType: isUsername ? "exact" : "alias",
            nameMatch: isUsername ? 1 : 0.95,
            nameDistinctive: isDistinctiveName(name),
            wordIndex: i,
          };
        } else if (next) {
          // STT splitting: "mad chatter" ↔ "madchatter" (both directions).
          const bigram = word + " " + next;
          if (bigram === name || word + next === name) {
            matched = {
              identity, matchedWord: bigram, matchedName: name,
              matchType: isUsername ? "exact" : "alias",
              nameMatch: isUsername ? 0.95 : 0.9,
              nameDistinctive: isDistinctiveName(name),
              wordIndex: i,
            };
          }
        }
        if (
          !matched &&
          isDistinctiveName(name) && // no fuzzy for common-word names
          name.length >= L.minFuzzyNameLength &&
          word.length >= L.minFuzzyNameLength &&
          levenshteinWithin(word, name, L.fuzzyMaxDistance)
        ) {
          matched = {
            identity, matchedWord: word, matchedName: name,
            matchType: "fuzzy", nameMatch: 0.7,
            nameDistinctive: true, wordIndex: i,
          };
        }
        if (matched && betterMatch(matched, best)) best = matched;
      }
      if (best && best.wordIndex === i) break; // first occurrence wins
    }
    if (best) results.push(best);
  }
  // Longest-defensible-match rule for prefix collisions: when one bot's
  // matched name is a strict prefix of another bot's matched name ("nova" vs
  // "nova prime"), the more specific match wins and the shorter is dropped.
  if (results.length > 1) {
    const keep = results.filter(
      (r) => !results.some(
        (o) => o !== r && o.identity.botId !== r.identity.botId &&
          o.matchedName.length > r.matchedName.length &&
          o.matchedName.startsWith(r.matchedName),
      ),
    );
    if (keep.length > 0 && keep.length < results.length) return keep;
  }
  return results;
}

function betterMatch(a: NameMatchResult, b: NameMatchResult | undefined): boolean {
  if (!b) return true;
  if (a.nameMatch !== b.nameMatch) return a.nameMatch > b.nameMatch;
  if (a.matchType !== b.matchType) return a.matchType !== "fuzzy";
  return a.wordIndex < b.wordIndex;
}

/**
 * Address-likelihood: is the utterance DIRECTED AT the named bot, or merely
 * ABOUT it? Compact explainable features only — no NLP pipeline.
 */
function analyzeAddressLikelihood(
  words: string[],
  match: NameMatchResult,
  rawLower: string,
): {
  likelihood: number;
  position: "start" | "mid" | "end" | "alone";
  questionCue: boolean;
  imperativeCue: boolean;
  negativeCue: boolean;
} {
  const i = match.wordIndex;
  const nameWordSpan = match.matchedWord.split(" ").length;
  const before = words.slice(0, i);
  const after = words.slice(i + nameWordSpan);
  const afterText = after.join(" ");
  const alone = words.length === nameWordSpan;

  let positive = 0;
  // Name at utterance start (allowing a greeting/attention word before).
  const nameAtStart = i === 0 || (i === 1 && GREETING_WORDS.has(before[0]));
  if (nameAtStart) positive += 0.45;
  // Vocative punctuation directly after the name ("Gremlin, ...").
  const nameRe = match.matchedName.split(" ").map(escapeRe).join("\\s+");
  if (new RegExp(nameRe + "\\s*[,.!?]").test(rawLower)) positive += 0.2;
  // Question addressed at the bot (after the name, or name-at-end question).
  const questionCue =
    afterText.includes("?") ||
    (after.length > 0 && QUESTION_STARTERS.has(after[0])) ||
    (before.length > 0 && QUESTION_STARTERS.has(before[0]) && i === words.length - 1);
  if (questionCue) positive += 0.2;
  // Greeting word immediately before the name ("hey Gremlin").
  if (before.length > 0 && GREETING_WORDS.has(before[before.length - 1])) positive += 0.15;
  // Second-person language in the remainder.
  if (/\b(you|your|yourself|yall|u)\b/.test(afterText)) positive += 0.15;
  // Imperative verb opens the remainder ("Gremlin, roast that build").
  const imperativeCue = after.length > 0 && IMPERATIVE_VERBS.has(after[0]);
  if (imperativeCue) positive += 0.1;
  // Name alone with a question mark ("Gremlin?") — a summons.
  if (alone && /\?\s*$/.test(rawLower)) positive += 0.35;

  // Third-person mention markers in the words before the name.
  let negative = 0;
  if (before.slice(-3).some((w) => THIRD_PERSON_BEFORE.has(w))) negative += 0.4;
  // Explicit third-person verbs ABOUT the bot after the name ("Gremlin said…").
  if (/\b(said|says|thought|thinks|kept|keeps|banned|mentioned|told|would|did)\b/.test(
    after.slice(0, 3).join(" "),
  )) negative += 0.3;
  // Meta-discussion ("Gremlin keeps replying whenever I say its name").
  if (/\b(keeps|whenever|its name|his name|her name|that bot|this bot)\b/.test(rawLower)) negative += 0.2;

  const negativeCue = NEGATIVE_RE.test(rawLower);

  return {
    likelihood: round2(clamp01(positive - negative)),
    position: alone ? "alone" : nameAtStart ? "start" : i === words.length - 1 ? "end" : "mid",
    questionCue,
    imperativeCue,
    negativeCue,
  };
}

/** Classify the utterance's intent toward the named bot. */
function classifyIntent(
  words: string[],
  wordIndex: number,
  nameWordSpan: number,
  address: ReturnType<typeof analyzeAddressLikelihood>,
): SpokenCalloutKind {
  if (address.negativeCue) return "negative_instruction";
  const after = words.slice(wordIndex + nameWordSpan);
  const afterText = after.join(" ");
  if (
    address.questionCue ||
    afterText.includes("?") ||
    (after.length > 0 && QUESTION_STARTERS.has(after[0]))
  ) {
    return "direct_question";
  }
  if (address.imperativeCue) return "command_request";
  if (words.length <= 4 && GREETING_WORDS.has(words[0])) return "greeting";
  if (
    words.length <= 6 &&
    /\b(good one|nice|well done|thanks|thank you|gg|great|brutal|savage)\b/.test(words.join(" "))
  ) {
    return "acknowledgment";
  }
  return "generic_address";
}

function ttlFor(kind: SpokenCalloutKind): number {
  return SPOKEN_CALLOUT_LIMITS.ttlMs[kind];
}

function evidenceOf(
  match: NameMatchResult,
  address: ReturnType<typeof analyzeAddressLikelihood>,
): SpokenCalloutEvidence {
  return {
    nameMatch: match.nameMatch,
    matchType: match.matchType,
    addressLikelihood: address.likelihood,
    matchedText: match.matchedWord,
    utterancePosition: address.position,
    questionCue: address.questionCue,
    imperativeCue: address.imperativeCue,
    negativeCue: address.negativeCue,
  };
}

export interface DetectSpokenCalloutInput {
  /** Raw transcript line (decorators like "[01:23] '...'" are stripped). */
  text: string;
  /** Only final transcripts confirm; interim can at most prime a candidate. */
  isFinal?: boolean;
  identities: SpokenIdentity[];
  /** Recent agent (bot) speech for echo suppression. */
  recentAgentSpeech?: Array<{ text: string; at: number }>;
  now?: number;
}

/**
 * Pure, deterministic spoken-callout detection. Zero AI, zero store — this is
 * the simulation harness AND the live path (the engine calls it directly).
 */
export function detectSpokenCallout(input: DetectSpokenCalloutInput): SpokenCalloutDetection {
  const now = input.now ?? Date.now();
  const isFinal = input.isFinal ?? true;
  const rawText = stripTranscriptDecorations(input.text);
  const rawLower = rawText.toLowerCase();
  const words = normalizeSpokenText(rawText).split(" ").filter(Boolean);
  const base: SpokenCalloutDetection = {
    classification: "no_match",
    confidence: 0,
    transcriptText: rawText.slice(0, 200),
    reason: "no identity matched",
  };
  if (words.length === 0 || input.identities.length === 0) return base;

  // ── Echo protection: bot TTS heard back through the transcriber ──────────
  const echo = (input.recentAgentSpeech ?? []).find(
    (s) =>
      now - s.at <= SPOKEN_CALLOUT_LIMITS.echoWindowMs &&
      jaccard(wordSet(s.text), wordSet(rawText)) >= SPOKEN_CALLOUT_LIMITS.echoJaccard,
  );
  if (echo) {
    return { ...base, classification: "agent_echo", reason: "paraphrases recent bot output (TTS echo)" };
  }

  // ── Identity matching ─────────────────────────────────────────────────────
  const matches = matchIdentities(words, input.identities);

  // ── Ensemble: "MADchatter" (exact) or generic "bots" (syntax-gated) ──────
  const systemNamed =
    words.includes("madchatter") ||
    words.some((w, i) => i > 0 && w === "chatter" && words[i - 1] === "mad");
  const genericWordIdx = words.findIndex((w) => GENERIC_ENSEMBLE_WORDS.has(w));

  if (matches.length === 0 && !systemNamed && genericWordIdx < 0) {
    return { ...base, reason: "no identity matched" };
  }

  // ── Ambiguity / multi-target: utterance matched multiple bots ────────────
  if (matches.length > 1) {
    const botIds = [...new Set(matches.map((m) => m.identity.botId))];
    if (botIds.length > 1) {
      if (/\b(and|both|with|then)\b/.test(words.join(" "))) {
        // "Gremlin and Analyst, both of you take" — multi-target; the
        // coordinator serializes (the store forces only the first target).
        const m = matches[0];
        const address = analyzeAddressLikelihood(words, m, rawLower);
        const kind = classifyIntent(words, m.wordIndex, m.matchedWord.split(" ").length, address);
        const confidence = round2(
          clamp01(Math.min(...matches.map((x) => x.nameMatch)) * (0.35 + 0.65 * address.likelihood)),
        );
        if (isFinal && confidence >= SPOKEN_CALLOUT_LIMITS.confirmThreshold) {
          return {
            classification: "confirmed",
            target: { type: "multi_bot", botIds },
            targetDisplay: matches.map((x) => x.identity.display).join(" & "),
            kind,
            confidence,
            evidence: evidenceOf(m, address),
            transcriptText: base.transcriptText,
            reason: "multi-bot address",
          };
        }
        return {
          ...base,
          classification: "candidate",
          target: { type: "multi_bot", botIds },
          confidence,
          reason: "multi-name utterance below confirm bar",
        };
      }
      // Same word fits 2+ bots (colliding aliases) — never route arbitrarily.
      return {
        ...base,
        classification: "candidate",
        target: { type: "ambiguous", candidateBotIds: botIds },
        confidence: 0.4,
        reason: "ambiguous name — multiple bots fit",
      };
    }
  }

  // ── Single specific match ────────────────────────────────────────────────
  const match = matches[0];
  if (match) {
    const address = analyzeAddressLikelihood(words, match, rawLower);
    const nameWordSpan = match.matchedWord.split(" ").length;
    const kind = classifyIntent(words, match.wordIndex, nameWordSpan, address);

    // No address evidence at all → mention, never a callout.
    if (address.likelihood <= 0.15 && !address.negativeCue) {
      return {
        ...base,
        classification: "mention_only",
        target: { type: "bot", botId: match.identity.botId },
        targetDisplay: match.identity.display,
        kind,
        confidence: round2(match.nameMatch * 0.5),
        reason: "third-person/contextual mention — no address evidence",
      };
    }

    const confidence = round2(
      clamp01(match.nameMatch * (0.35 + 0.65 * address.likelihood)),
    );

    // Negative instructions are confirmed on address evidence alone (restraint
    // must be honored reliably) but never route a reply.
    if (address.negativeCue) {
      return {
        classification: isFinal && address.likelihood >= 0.3 ? "confirmed" : "candidate",
        target: { type: "bot", botId: match.identity.botId },
        targetDisplay: match.identity.display,
        kind: "negative_instruction",
        confidence: Math.max(confidence, round2(clamp01(match.nameMatch * 0.8))),
        evidence: evidenceOf(match, address),
        transcriptText: base.transcriptText,
        reason: "direct suppression instruction",
      };
    }

    if (!isFinal) {
      return {
        ...base,
        classification: "candidate",
        target: { type: "bot", botId: match.identity.botId },
        targetDisplay: match.identity.display,
        kind,
        confidence,
        reason: "interim transcript — candidate only until final",
      };
    }

    // Distinctiveness-aware threshold: common-word names and fuzzy matches
    // need a strictly stronger bar before they can act.
    let threshold = SPOKEN_CALLOUT_LIMITS.confirmThreshold;
    if (!match.nameDistinctive) threshold += SPOKEN_CALLOUT_LIMITS.commonWordThresholdPenalty;
    if (match.matchType === "fuzzy") threshold += SPOKEN_CALLOUT_LIMITS.fuzzyThresholdPenalty;

    if (confidence >= threshold) {
      return {
        classification: "confirmed",
        target: { type: "bot", botId: match.identity.botId },
        targetDisplay: match.identity.display,
        kind,
        confidence,
        evidence: evidenceOf(match, address),
        transcriptText: base.transcriptText,
        reason: "direct address above confirm threshold",
      };
    }
    if (confidence >= SPOKEN_CALLOUT_LIMITS.candidateThreshold) {
      return {
        ...base,
        classification: "candidate",
        target: { type: "bot", botId: match.identity.botId },
        targetDisplay: match.identity.display,
        kind,
        confidence,
        reason: "address evidence below confirm threshold",
      };
    }
    return {
      ...base,
      classification: "mention_only",
      target: { type: "bot", botId: match.identity.botId },
      targetDisplay: match.identity.display,
      kind,
      confidence,
      reason: "weak name/address evidence",
    };
  }

  // ── Ensemble address (no specific bot named) ──────────────────────────────
  const idx = systemNamed
    ? words.includes("madchatter")
      ? words.indexOf("madchatter")
      : words.indexOf("mad")
    : genericWordIdx;
  const before = words.slice(0, idx);
  const after = words.slice(idx + 1);
  const afterText = after.join(" ");
  const nameAtStart = idx === 0 || (idx === 1 && GREETING_WORDS.has(before[0]));
  const questionCue =
    afterText.includes("?") ||
    (after.length > 0 && QUESTION_STARTERS.has(after[0])) ||
    (before.length > 0 && QUESTION_STARTERS.has(before[0]) && idx === words.length - 1);
  const imperativeCue = after.length > 0 && IMPERATIVE_VERBS.has(after[0]);
  const secondPerson = /\b(you|your)\b/.test(afterText);
  let likelihood = 0;
  if (nameAtStart) likelihood += 0.45;
  if (questionCue) likelihood += 0.2;
  if (secondPerson) likelihood += 0.15;
  if (imperativeCue) likelihood += 0.1;
  if (/\b(said|says|told|keeps|the bot)\b/.test(before.slice(-3).join(" "))) likelihood -= 0.4;
  likelihood = round2(clamp01(likelihood));
  const negativeCue = NEGATIVE_RE.test(rawLower);

  // Generic words ("bots") occur constantly in speech — they need the
  // STRICTEST syntax (name at start + question/second-person/imperative).
  const strict = !systemNamed;
  const nameMatch = systemNamed ? 0.95 : 0.8;
  const confidence = round2(clamp01(nameMatch * (0.35 + 0.65 * likelihood)));
  const threshold = SPOKEN_CALLOUT_LIMITS.confirmThreshold;

  if (isFinal && !negativeCue && confidence >= threshold) {
    return {
      classification: "confirmed",
      target: { type: "ensemble" },
      targetDisplay: "MADchatter",
      kind: classifyIntent(words, idx, 1, { likelihood, position: nameAtStart ? "start" : idx === words.length - 1 ? "end" : "mid", questionCue, imperativeCue, negativeCue }),
      confidence,
      evidence: {
        nameMatch,
        matchType: "alias",
        addressLikelihood: likelihood,
        matchedText: systemNamed ? "madchatter" : words[idx],
        utterancePosition: nameAtStart ? "start" : idx === words.length - 1 ? "end" : "mid",
        questionCue,
        imperativeCue,
        negativeCue,
      },
      transcriptText: base.transcriptText,
      reason: strict ? "generic ensemble word with strong vocative syntax" : "system name address",
    };
  }
  return {
    ...base,
    classification: "candidate",
    target: { type: "ensemble" },
    confidence,
    reason: "ensemble address below confirm bar",
  };
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export interface NoteTranscriptLineInput {
  text: string;
  isFinal?: boolean;
  channel: string | null;
  identities: SpokenIdentity[];
  now?: number;
}

export interface SpokenCalloutRouting {
  callout: SpokenCallout;
  /** Freshly confirmed (vs a repeat-merge into an existing callout). */
  isNew: boolean;
}

/**
 * Channel-scoped callout lifecycle engine. Holds at most ONE active callout
 * (repeats merge; a new incompatible confirmed callout supersedes an older
 * one), plus a bounded diagnostic log and the agent-speech echo ring.
 */
export class SpokenCalloutEngine {
  private channel: string | null = null;
  private active: SpokenCallout | null = null;
  private log: SpokenCallout[] = [];
  private agentSpeech: Array<{ text: string; at: number }> = [];
  private seq = 0;

  /** Bind to a channel; any change wipes every volatile buffer. */
  reset(channel: string | null): void {
    const normalized = channel != null ? channel.trim().toLowerCase() : null;
    this.channel = normalized;
    this.active = null;
    this.agentSpeech = [];
    this.log = [];
    // The diagnostic log survives within the session, dies on reset.
  }

  /** Record bot output (send + TTS) for echo suppression. */
  noteAgentSpeech(note: { text: string; at?: number }): void {
    const at = note.at ?? Date.now();
    this.agentSpeech.push({ text: note.text.slice(0, 200), at });
    if (this.agentSpeech.length > SPOKEN_CALLOUT_LIMITS.maxAgentEchoEntries) {
      this.agentSpeech.splice(0, this.agentSpeech.length - SPOKEN_CALLOUT_LIMITS.maxAgentEchoEntries);
    }
  }

  /**
   * Ingest one transcript line. Runs pure detection, merges repeats, and
   * returns the callout when a new/updated CONFIRMED callout exists for the
   * caller to route (the caller owns the actual dispatch + hard-control
   * checks — this engine never bypasses them).
   */
  noteTranscriptLine(input: NoteTranscriptLineInput): SpokenCalloutRouting | null {
    const now = input.now ?? Date.now();
    const channel = input.channel != null ? input.channel.trim().toLowerCase() : null;
    if (channel !== this.channel) this.reset(channel);

    const detection = detectSpokenCallout({
      text: input.text,
      isFinal: input.isFinal,
      identities: input.identities,
      recentAgentSpeech: this.agentSpeech,
      now,
    });

    if (detection.classification !== "confirmed") {
      // Ambient speech and TTS echoes cannot keep an old obligation alive.
      return null;
    }

    const kind = detection.kind ?? "generic_address";
    const expiresAt = now + ttlFor(kind);

    // Repeat merge: same target within the merge window → ONE callout,
    // urgency/confidence updated, never two competing opportunities.
    if (
      this.active &&
      (this.active.state === "confirmed" || this.active.state === "claimed") &&
      this.active.kind === kind &&
      now - this.active.latestSpokenAt <= SPOKEN_CALLOUT_LIMITS.mergeWindowMs &&
      sameTarget(this.active.target, detection.target!)
    ) {
      this.active.latestSpokenAt = now;
      this.active.expiresAt = expiresAt;
      this.active.repeatCount += 1;
      this.active.confidence = Math.max(this.active.confidence, detection.confidence);
      this.active.transcriptText = detection.transcriptText;
      return { callout: this.active, isNew: false };
    }

    // New confirmed callout — a still-active older one is superseded.
    const callout: SpokenCallout = {
      id: `callout_${++this.seq}_${generateId().slice(0, 8)}`,
      channel: this.channel,
      detectedAt: now,
      latestSpokenAt: now,
      target: detection.target!,
      targetDisplay: detection.targetDisplay ?? "MADchatter",
      kind,
      transcriptText: detection.transcriptText,
      confidence: detection.confidence,
      evidence: detection.evidence ?? {
        nameMatch: 0, matchType: "alias", addressLikelihood: 0, matchedText: "",
        utterancePosition: "mid", questionCue: false, imperativeCue: false, negativeCue: false,
      },
      repeatCount: 1,
      expiresAt,
      state: "confirmed",
    };
    this.active = callout;
    this.log.unshift(callout);
    if (this.log.length > SPOKEN_CALLOUT_LIMITS.maxLog) {
      this.log.length = SPOKEN_CALLOUT_LIMITS.maxLog;
    }
    return { callout, isNew: true };
  }

  /** Active (confirmed/claimed, unexpired, non-negative) callout, or null. */
  getActiveCallout(now: number = Date.now()): SpokenCallout | null {
    this.sweep(now);
    if (!this.active) return null;
    if (this.active.state !== "confirmed" && this.active.state !== "claimed") return null;
    if (this.active.kind === "negative_instruction") return null; // restraint, not obligation
    return this.active;
  }

  /** Active callout that addresses a specific bot (direct, ensemble, or multi). */
  getActiveForBot(botId: string, now: number = Date.now()): SpokenCallout | null {
    const active = this.getActiveCallout(now);
    if (!active) return null;
    const t = active.target;
    if (t.type === "bot") return t.botId === botId ? active : null;
    if (t.type === "ensemble") return active;
    if (t.type === "multi_bot") return t.botIds.includes(botId) ? active : null;
    return null; // ambiguous never hard-routes
  }

  /** Mark the callout as dispatched for routing (prevents repeat force-checks). */
  markClaimed(id: string, now: number = Date.now()): void {
    if (this.active?.id === id && this.active.state === "confirmed") {
      this.active.state = "claimed";
    }
  }

  /**
   * Consume the active callout for a bot that just responded. A consumed
   * callout can never trigger a second response. Returns the consumed callout
   * (with latency recorded) or null.
   */
  consumeForBot(botId: string | undefined, now: number = Date.now()): SpokenCallout | null {
    const active = this.getActiveCallout(now);
    if (!active) return null;
    const t = active.target;
    const addressed =
      (t.type === "bot" && (botId == null || t.botId === botId)) ||
      t.type === "ensemble" ||
      (t.type === "multi_bot" && (botId == null || t.botIds.includes(botId)));
    if (!addressed) return null;
    active.state = "consumed";
    active.consumedByBotId = botId ?? "ensemble";
    active.responseLatencyMs = now - active.latestSpokenAt;
    return active;
  }

  /** Expire stale state (cheap, called on every read). */
  private sweep(now: number): void {
    if (
      this.active &&
      (this.active.state === "confirmed" || this.active.state === "claimed") &&
      now > this.active.expiresAt
    ) {
      this.active.state = "expired";
    }
    if (this.agentSpeech.length > 0) {
      const cutoff = now - SPOKEN_CALLOUT_LIMITS.echoWindowMs * 10;
      this.agentSpeech = this.agentSpeech.filter((s) => s.at >= cutoff);
    }
  }

  /** Bounded developer diagnostics (STUDIO). No secrets, no raw audio. */
  getDiagnostics(): Record<string, unknown> {
    return {
      channel: this.channel,
      active: this.active
        ? {
            id: this.active.id,
            target: this.active.target,
            kind: this.active.kind,
            state: this.active.state,
            confidence: this.active.confidence,
            repeatCount: this.active.repeatCount,
            transcript: this.active.transcriptText,
            expiresAt: this.active.expiresAt,
          }
        : null,
      log: this.log.map((c) => ({
        id: c.id,
        target: c.target,
        kind: c.kind,
        state: c.state,
        confidence: c.confidence,
        responseLatencyMs: c.responseLatencyMs,
      })),
    };
  }
}

function sameTarget(a: SpokenCalloutTarget, b: SpokenCalloutTarget): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "bot" && b.type === "bot") return a.botId === b.botId;
  if (a.type === "multi_bot" && b.type === "multi_bot") {
    return a.botIds.length === b.botIds.length && a.botIds.every((x) => b.botIds.includes(x));
  }
  if (a.type === "ambiguous" && b.type === "ambiguous") {
    return a.candidateBotIds.length === b.candidateBotIds.length &&
      a.candidateBotIds.every((x) => b.candidateBotIds.includes(x));
  }
  return true; // ensemble
}

/** Module singleton (mirrors roomModel / semanticCoordination / participation). */
export const spokenCallouts = new SpokenCalloutEngine();

/** One source for audio obligations in both automation loops and smart replies. */
export function getSpokenMentionLines(botId: string, now = Date.now()): string[] {
  const callout = spokenCallouts.getActiveForBot(botId, now);
  return callout ? [`[AUDIO] ${callout.transcriptText}`] : [];
}

// ─── Simulation harness (deterministic, test-only ergonomics) ─────────────────

export interface SpokenCalloutSimulationInput {
  transcript: string;
  isFinal?: boolean;
  bots: Array<{ id: string; spokenNames: string[]; display?: string }>;
  now?: number;
  recentAgentSpeech?: Array<{ text: string; at: number }>;
}

/**
 * One-shot deterministic simulation of the detector — the same code path the
 * live engine uses, without React, providers, or the store.
 */
export function simulateSpokenCallout(input: SpokenCalloutSimulationInput): SpokenCalloutDetection {
  return detectSpokenCallout({
    text: input.transcript,
    isFinal: input.isFinal,
    identities: input.bots.map((b) => ({
      botId: b.id,
      display: b.display ?? b.id,
      names: b.spokenNames.map(normalizeSpokenText).filter((n) => n.length > 0),
    })),
    recentAgentSpeech: input.recentAgentSpeech,
    now: input.now,
  });
}
