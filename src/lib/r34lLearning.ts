/**
 * R34L Community Style Learning — the persistent, evidence-driven core of
 * R34L mode.
 *
 * One canonical, typed learning model per channel+platform. It incrementally
 * learns how the room actually types (casing, length, punctuation, vocabulary,
 * emote usage, response forms) from eligible incoming chat messages, and
 * produces a bounded style profile consumed by BOTH generation (prompt block)
 * and the UI (learning readout) — same numbers, same statements.
 *
 * Design principles:
 * - Deterministic local analysis only. Counting, aggregation, confidence,
 *   decay, and profile selection are pure functions — learning works with no
 *   AI provider configured and never adds a model request per message.
 * - Measured traits are separated from inferred interpretations. We record
 *   what was typed, never what it "meant" (no humor/sarcasm/emote-meaning
 *   claims from token frequency).
 * - Feature-appropriate denominators: emote-only messages never distort casing
 *   stats; messages without cased letters never count as capitalization
 *   evidence; unsupported analysis is marked unknown.
 * - Bounded influence: per-contributor diminishing weight, duplicate-flood
 *   downweighting, minimum multi-contributor support, and recency decay keep
 *   one prolific chatter / copypasta flood / brief raid from redefining a
 *   channel permanently.
 * - Persistent baseline vs short-term session overlay: fresh evidence adapts
 *   current behavior (overlay) but is capped so it cannot overwrite months of
 *   retained community tendencies.
 *
 * This module is pure: no store, no timers, no AI, no DOM. Store wiring lives
 * in store.ts (noteR34lObservation), the store-bound resolver in
 * r34lAdaptation.ts.
 */

import { normalizeSessionChannel } from "./normalizeChannel";

// ─── Tuning constants (single source of truth — no scattered magic numbers) ──

export const R34L_PROFILE_VERSION = 1;

/** Baseline half-life: community typing style evolves slowly. */
export const R34L_BASELINE_HALF_LIFE_MS = 21 * 24 * 60 * 60 * 1000;
/** Session overlay half-life: the overlay tracks THIS visit's texture. */
export const R34L_OVERLAY_HALF_LIFE_MS = 6 * 60 * 60 * 1000;
/** Neutral pseudo-samples for confidence = weight / (weight + PRIOR). */
export const R34L_PRIOR_WEIGHT = 8;
/** Effective message weight at which a trait starts influencing output. */
export const R34L_USABLE_WEIGHT = 12;
/** Effective message weight at which the whole profile is "established". */
export const R34L_ESTABLISHED_WEIGHT = 60;
/** A profile whose newest evidence is older than this is "aging". */
export const R34L_AGING_MS = 14 * 24 * 60 * 60 * 1000;

/** Max retained channel profiles (pruned by lastUpdatedAt). */
export const R34L_MAX_PROFILES = 25;
/** Max learned vocabulary tokens per channel. */
export const R34L_MAX_VOCAB = 60;
/** Max tracked emote entries per channel. */
export const R34L_MAX_EMOTES = 40;
/** Max tracked contributors per channel (influence balancing only). */
export const R34L_MAX_CONTRIBUTORS = 150;
/** Per-token / per-emote contributor hashes kept for minimum support. */
export const R34L_MAX_SUPPORT_HASHES = 4;
/** Session dedup ring size per channel (normalized text hashes). */
export const R34L_DEDUP_WINDOW = 120;
/** Duplicate messages within the dedup window are worth this much of a fresh one. */
export const R34L_DUP_WEIGHT = 0.15;
/** Per-contributor damping: message weight = 1 / (1 + DAMPING × priorMessages). */
export const R34L_CONTRIBUTOR_DAMPING = 0.35;
/** Max share of merged evidence the session overlay may contribute. */
export const R34L_OVERLAY_MAX_SHARE = 0.4;
/** Hard cap on the session overlay's effective weight (burst protection). */
export const R34L_OVERLAY_MAX_WEIGHT = 240;
/** Entries decayed below this weight are pruned as dust on write. */
const DUST_WEIGHT = 0.05;
/** Max chars of a message analyzed for style stats (longer = capped paste). */
const MAX_ANALYSIS_CHARS = 400;

// ─── Types ───────────────────────────────────────────────────────────────────

/** Where an emote recognition came from. "extension" = the BTTV/7TV/FFZ cache
 *  (any account can type these names — known usable as text). "native" =
 *  platform metadata (Twitch IRC emote tags) — a viewer typing a subscriber
 *  emote says nothing about a bot's permission to send it. */
export type R34lEmoteSource = "extension" | "native";

export interface R34lEmoteStats {
  /** decayed total uses (an emote used twice in one message counts twice) */
  uses: number;
  /** decayed count of messages containing it */
  msgs: number;
  /** decayed standalone (emote-only message) count */
  solo: number;
  /** decayed leading / trailing / repeated-within-message counts */
  lead: number;
  trail: number;
  rep: number;
  /** up to R34L_MAX_SUPPORT_HASHES contributor hashes (minimum support) */
  c: number[];
  src: R34lEmoteSource;
  /** last time this emote was observed (ms epoch) */
  last: number;
}

export interface R34lTokenStats {
  /** decayed weight (message-level presence, not raw frequency) */
  w: number;
  /** up to R34L_MAX_SUPPORT_HASHES contributor hashes */
  c: number[];
}


/**
 * The persisted per-channel style profile. All accumulators are
 * decay-compounded on write (anchored at lastDecayAt), so reads only need
 * `now`. Compact aggregate evidence only — never raw message text.
 */
export interface R34lChannelProfile {
  version: number;
  /** Canonical identity: `${platform}:${normalizedChannel}`. */
  key: string;
  channel: string;
  platform: string;
  createdAt: number;
  lastUpdatedAt: number;
  lastDecayAt: number;
  /** Lifetime eligible messages ingested (not decayed; display counter). */
  totalMessages: number;
  /** Decayed per-contributor message counts (influence bounding). */
  contributors: Record<string, number>;
  /** Decayed effective evidence weight over all eligible messages. */
  w: number;
  /** Weight of ingested messages that had emote metadata available. */
  emoteMetaW: number;
  // Length (chars) over text-bearing messages.
  lenW: number;
  lenSum: number;
  lenSq: number;
  // Casing over casing-eligible messages (has cased letters, not emote-only).
  caseW: number;
  caseLower: number;
  caseSentence: number;
  caseCaps: number;
  caseMixed: number;
  // Punctuation over punctuation-eligible (text-bearing) messages.
  punW: number;
  punNone: number;
  punTerminal: number;
  punRepeat: number;
  punQuestion: number;
  // Response forms over all eligible messages (reply only where metadata exists).
  formFragment: number;
  formShortAck: number;
  formEmoteOnly: number;
  /** Messages where reply metadata was available (Twitch only). */
  replyKnownW: number;
  formReply: number;
  // Emote aggregate (denominator: w).
  emWith: number;
  emUses: number;
  emSolo: number;
  emotes: Record<string, R34lEmoteStats>;
  // Unicode emoji — tracked SEPARATELY from platform emotes (denominator: w).
  ejWith: number;
  ejUses: number;
  // Community vocabulary (abbreviations, recurring words — NOT laughter forms).
  vocab: Record<string, R34lTokenStats>;
  // Laughter forms, measured separately (denominator: w). Never prompt vocab.
  laugh: Record<string, number>;
}

/** What the eligibility filter decided about one incoming message. */
export interface R34lEligibility {
  eligible: boolean;
  reason?: "own-bot" | "known-bot" | "command" | "empty" | "url-only";
}

/** One emote occurrence set found in a message. */
export interface R34lEmoteUse {
  name: string;
  count: number;
  leading: boolean;
  trailing: boolean;
  repeated: boolean;
  src: R34lEmoteSource;
}

/** Measured traits of a single message. All fields are observations. */
export interface R34lMessageAnalysis {
  /** Message carries text content after removing emotes/emoji. */
  textBearing: boolean;
  chars: number;
  words: number;
  /** null = casing analysis unsupported for this message (no cased letters). */
  casing: "lower" | "sentence" | "caps" | "mixed" | null;
  /** null = punctuation analysis unsupported (not text-bearing). */
  punct: { none: boolean; terminal: boolean; repeat: boolean; question: boolean } | null;
  fragment: boolean;
  shortAck: boolean;
  emoteOnly: boolean;
  emotes: R34lEmoteUse[];
  emojiCount: number;
  vocabTokens: string[];
  laughs: string[];
}


// ─── Identity ───────────────────────────────────────────────────────────────

/** Canonical per-channel identity: platform-qualified so identical channel
 *  names on different platforms stay separate. Channel names are normalized
 *  (strip "#", trim, lowercase). No stable platform channel ID is available
 *  in the current session metadata, so the normalized name is the supported
 *  fallback — a rename creates a fresh profile and the old one decays out via
 *  retention pruning. */
export function r34lProfileKey(platform: string, channel: string): string {
  return `${platform.trim().toLowerCase()}:${normalizeSessionChannel(channel)}`;
}

export function parseR34lProfileKey(key: string): { platform: string; channel: string } {
  const idx = key.indexOf(":");
  if (idx <= 0) return { platform: "unknown", channel: key };
  return { platform: key.slice(0, idx), channel: key.slice(idx + 1) };
}

export function emptyR34lProfile(platform: string, channel: string, now: number): R34lChannelProfile {
  return {
    version: R34L_PROFILE_VERSION,
    key: r34lProfileKey(platform, channel),
    channel: normalizeSessionChannel(channel),
    platform: platform.trim().toLowerCase(),
    createdAt: now,
    lastUpdatedAt: 0,
    lastDecayAt: now,
    totalMessages: 0,
    contributors: {},
    w: 0,
    emoteMetaW: 0,
    lenW: 0, lenSum: 0, lenSq: 0,
    caseW: 0, caseLower: 0, caseSentence: 0, caseCaps: 0, caseMixed: 0,
    punW: 0, punNone: 0, punTerminal: 0, punRepeat: 0, punQuestion: 0,
    formFragment: 0, formShortAck: 0, formEmoteOnly: 0, replyKnownW: 0, formReply: 0,
    emWith: 0, emUses: 0, emSolo: 0,
    emotes: {},
    ejWith: 0, ejUses: 0,
    vocab: {},
    laugh: {},
  };
}

// ─── Eligibility ─────────────────────────────────────────────────────────────

/**
 * Well-known automated chatters (exact lowercase names). This is a curated
 * denylist, not a claim of perfect bot detection: unknown participants stay
 * unknown and are simply influence-bounded like everyone else.
 */
const KNOWN_BOT_NAMES = new Set([
  "nightbot", "streamelements", "streamlabs", "moobot", "wizebot", "fossabot",
  "sagebot", "phantombot", "deepbot", "ankhbot", "soundalerts", "pretzelrocks",
  "sery_bot", "botrixoficial", "kofi", "streamloots", "alivebot", "cloudbot",
]);

/**
 * Decide whether an incoming chat message is eligible as community-style
 * evidence. Excludes MADchatter's own bots (all configured identities,
 * including inactive roster bots), curated known bots, command-only noise,
 * empty messages, and URL-only messages (no style signal).
 */
export function filterR34lObservation(input: {
  username: string;
  text: string;
  /** All MADchatter-controlled usernames (roster + legacy session), lowercase. */
  botUsernames: readonly string[];
}): R34lEligibility {
  const text = (input.text || "").trim();
  if (!text) return { eligible: false, reason: "empty" };
  const user = (input.username || "").trim().toLowerCase();
  if (user && input.botUsernames.includes(user)) return { eligible: false, reason: "own-bot" };
  if (KNOWN_BOT_NAMES.has(user)) return { eligible: false, reason: "known-bot" };
  if (text.startsWith("!")) return { eligible: false, reason: "command" };
  // URL-only messages carry no typing-style evidence.
  if (/^https?:\/\/\S+$/i.test(text) || /^www\.\S+$/i.test(text)) {
    return { eligible: false, reason: "url-only" };
  }
  return { eligible: true };
}


// ─── Per-message analysis ────────────────────────────────────────────────────

/** Emoji counting table — narrower than textSanitize's strip table (which
 *  also matches ZWJ/variation selectors). We count visible glyphs, so
 *  decomposed sequences count once per base glyph, not per combinator. */
const EMOJI_COUNT_REGEX = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu;

/** Laughter families — measured as a trait, never added to vocabulary. */
const LAUGHTER_PATTERNS: [string, RegExp][] = [
  ["lol", /^lo+l+(ol)*$/i],
  ["lmao", /^(lmao+|lmfao|rofl)$/i],
  ["haha", /^(ha){2,}$|^ha(ha)+h*a$/i],
  ["hehe", /^(he){2,}$/i],
  ["xd", /^xd+$/i],
];

/** Short acknowledgment tokens — measured as a response form only. A message
 *  counts when it IS the acknowledgment (normalized), not when it contains it. */
const SHORT_ACK_SET = new Set([
  "yes", "yeah", "yep", "yup", "nah", "nope", "ok", "okay", "kk", "true",
  "real", "same", "gg", "ggs", "rip", "nice", "w", "l", "mhm", "fax",
  "based", "lol", "lmao", "xd", "fr", "+1", "o7", "ggwp",
]);

/** English stopwords + chat-fillers excluded from learned vocabulary. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "of", "at", "by", "for", "to",
  "in", "on", "is", "it", "its", "be", "are", "was", "were", "been", "am",
  "i", "you", "he", "she", "we", "they", "them", "him", "her", "his", "their",
  "my", "your", "our", "me", "us", "this", "that", "these", "those", "there",
  "here", "what", "when", "where", "who", "how", "why", "which", "not", "no",
  "do", "does", "did", "have", "has", "had", "can", "could", "will", "would",
  "should", "just", "so", "too", "very", "with", "about", "into", "over",
  "then", "than", "now", "out", "up", "down", "all", "any", "some", "as",
  "im", "ive", "youre", "thats", "dont", "cant", "let", "lets",
  "got", "get", "go", "going", "see", "saw", "say", "said", "well",
]);

/** Strip decoration from a token edge for exact emote matching ("KEKW," →
 *  "KEKW"). Exact-match is tried first — emote names with punctuation still
 *  match before any stripping. */
function stripTokenEdges(token: string): string {
  return token.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "");
}

function classifyCasing(text: string): "lower" | "sentence" | "caps" | "mixed" | null {
  const letters = text.match(/\p{L}/gu);
  if (!letters || letters.length === 0) return null;
  let upper = 0, lower = 0;
  for (const ch of letters) {
    const isUpper = ch.toUpperCase() === ch && ch.toLowerCase() !== ch;
    const isLower = ch.toLowerCase() === ch && ch.toUpperCase() !== ch;
    if (isUpper) upper++;
    else if (isLower) lower++;
  }
  const cased = upper + lower;
  if (cased === 0) return null; // uncased script only (e.g. pure kana) — unknown
  const upperShare = upper / cased;
  if (upper === 0) return "lower";
  if (upperShare >= 0.7 && cased >= 2) return "caps";
  // Sentence case: uppercase appears ONLY at sentence-initial positions
  // (message start, or right after terminal punctuation). Uppercase anywhere
  // else — mid-word or mid-sentence — is expressive casing, not sentence case.
  // This lets "Great play by the team." read as sentence case even though its
  // uppercase share is tiny, without letting "LETS GOOO" slip through.
  let onlySentenceInitial = true;
  let idx = 0;
  for (const ch of text) {
    const isUpperCased = /\p{L}/u.test(ch) && ch.toUpperCase() === ch && ch.toLowerCase() !== ch;
    if (isUpperCased) {
      const prev = text.slice(0, idx);
      const atSentenceStart = prev.trim().length === 0 || /[.!?…]\s*$/u.test(prev);
      if (!atSentenceStart) { onlySentenceInitial = false; break; }
    }
    idx += ch.length;
  }
  if (onlySentenceInitial && cased >= 3) return "sentence";
  // A lone stray capital in otherwise-lowercase text still reads as lowercase.
  if (upperShare <= 0.08) return "lower";
  return upperShare >= 0.5 ? "caps" : "mixed";
}

function classifyLaughter(token: string): string | null {
  for (const [family, re] of LAUGHTER_PATTERNS) if (re.test(token)) return family;
  return null;
}

function normalizeAck(text: string): string {
  return text
    .toLowerCase()
    .replace(/(\p{L})\1{2,}/gu, "$1$1") // "yesss" → collapse long repeats
    .replace(/[^\p{L}\p{N}+]/gu, "")
    .trim();
}


/**
 * Measure one message. `knownEmotes` = exact, case-sensitive names from the
 * extension emote cache (may be empty when metadata is unavailable).
 * `nativeEmotes` = names recovered from platform emote tags (Twitch IRC).
 * Matching is whole-token, case-sensitive: tokens are split on whitespace so
 * overlapping names ("LUL" vs "LULW") can never double count, and ordinary
 * words are never counted as emotes without a metadata match.
 */
export function analyzeR34lMessage(
  rawText: string,
  opts: { knownEmotes?: ReadonlySet<string>; nativeEmotes?: readonly string[] } = {},
): R34lMessageAnalysis {
  const text = (rawText || "").slice(0, MAX_ANALYSIS_CHARS).trim();
  const known = opts.knownEmotes ?? new Set<string>();
  const tokens = text.split(/\s+/).filter(Boolean);

  // ── Emote uses (whole-token, case-sensitive) ──────────────────────────
  const emoteUses = new Map<string, R34lEmoteUse>();
  const tokenIsEmote: boolean[] = tokens.map(() => false);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    let name: string | null = null;
    if (known.has(tok)) name = tok;
    else {
      const stripped = stripTokenEdges(tok);
      if (stripped && stripped !== tok && known.has(stripped)) name = stripped;
    }
    if (name) {
      tokenIsEmote[i] = true;
      const existing = emoteUses.get(name);
      if (existing) {
        existing.count++;
        existing.repeated = true;
        existing.trailing = i === tokens.length - 1;
      } else {
        emoteUses.set(name, {
          name, count: 1,
          leading: i === 0, trailing: i === tokens.length - 1,
          repeated: false, src: "extension",
        });
      }
    }
  }
  // Native (platform-tag) emotes: names recovered from Twitch IRC tags.
  // Counted per exact token occurrence; deduped against extension matches.
  for (const nativeName of opts.nativeEmotes ?? []) {
    if (!nativeName) continue;
    if (emoteUses.has(nativeName)) continue; // extension recognition wins
    let count = 0;
    let firstIdx = -1, lastIdx = -1;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === nativeName || stripTokenEdges(tokens[i]) === nativeName) {
        count++;
        tokenIsEmote[i] = true;
        if (firstIdx < 0) firstIdx = i;
        lastIdx = i;
      }
    }
    if (count > 0) {
      emoteUses.set(nativeName, {
        name: nativeName, count,
        leading: firstIdx === 0, trailing: lastIdx === tokens.length - 1,
        repeated: count > 1, src: "native",
      });
    }
  }

  const emojiCount = (text.match(EMOJI_COUNT_REGEX) ?? []).length;

  // ── Text-bearing remainder (emotes + emoji removed) ───────────────────
  const textTokens = tokens.filter(
    (t, i) => !tokenIsEmote[i] && !/^[\u{1F000}-\u{1FAFF}\u2600-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}]+$/u.test(t),
  );
  const textOnly = textTokens.join(" ");
  const textBearing = /[\p{L}\p{N}]/u.test(textOnly);
  const emoteOnly = !textBearing && (emoteUses.size > 0 || emojiCount > 0);

  const words = textBearing ? textTokens.filter((t) => /[\p{L}\p{N}]/u.test(t)).length : 0;
  const chars = textBearing ? textOnly.length : 0;

  const casing = textBearing ? classifyCasing(textOnly) : null;

  const punct = textBearing
    ? {
        none: !/[.!?,;…]/u.test(textOnly),
        terminal: /[.!?…]+$/u.test(textOnly),
        repeat: /([!?])\1/u.test(textOnly) || /\.{2,}|…/u.test(textOnly) || /\?!|!\?/u.test(textOnly),
        question: /\?/u.test(textOnly),
      }
    : null;

  const fragment = textBearing && words > 0 && words <= 3;
  const shortAck = textBearing && words <= 3 && SHORT_ACK_SET.has(normalizeAck(textOnly));

  // ── Vocabulary (message-level presence; laughter measured separately) ──
  const vocabSet = new Set<string>();
  const laughSet = new Set<string>();
  for (const tok of textTokens) {
    const cleaned = stripTokenEdges(tok).toLowerCase();
    if (cleaned.length < 2 || cleaned.length > 24) continue;
    if (!/\p{L}/u.test(cleaned)) continue;
    if (cleaned.startsWith("@") || cleaned.includes("http") || cleaned.includes(".")) continue;
    // Chat-derived tokens are untrusted data: reject anything with characters
    // that could break prompt block structure or smuggle markup/instructions.
    if (/[<>`"'[\]{}\\|^~$;]/u.test(cleaned)) continue;
    const laugh = classifyLaughter(cleaned);
    if (laugh) { laughSet.add(laugh); continue; }
    if (STOPWORDS.has(cleaned)) continue;
    vocabSet.add(cleaned);
  }

  return {
    textBearing,
    chars,
    words,
    casing: emoteOnly ? null : casing,
    punct,
    fragment,
    shortAck,
    emoteOnly,
    emotes: [...emoteUses.values()],
    emojiCount,
    vocabTokens: [...vocabSet],
    laughs: [...laughSet],
  };
}

// ─── Duplicate suppression (runtime-only, per channel) ──────────────────────

/** Session-scoped dedup rings: normalized-text FNV hashes per channel key.
 *  Copypasta floods are momentary by nature, so the ring is runtime-only —
 *  bounded at R34L_DEDUP_WINDOW entries and cleared on channel reset. */
const dedupRings = new Map<string, number[]>();

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Normalize for duplicate detection: lowercase + collapsed whitespace. */
function normalizeForDedup(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, MAX_ANALYSIS_CHARS);
}

/**
 * Mark a message's text in the channel's dedup ring. Returns true when the
 * same normalized text was already seen within the ring window (duplicate).
 * Each live message is ingested exactly once by the caller, so this ring is
 * the single dedup authority — polling, rendering, restore, and multi-variant
 * generation never pass through here.
 */
export function markR34lSeen(channelKey: string, text: string): boolean {
  const hash = fnv1a(normalizeForDedup(text));
  let ring = dedupRings.get(channelKey);
  if (!ring) { ring = []; dedupRings.set(channelKey, ring); }
  const dup = ring.includes(hash);
  ring.push(hash);
  if (ring.length > R34L_DEDUP_WINDOW) ring.splice(0, ring.length - R34L_DEDUP_WINDOW);
  return dup;
}

/** Clear a channel's dedup ring (reset learning / channel data teardown). */
export function clearR34lDedup(channelKey: string): void {
  dedupRings.delete(channelKey);
}

/** Username hash for bounded contributor attribution (never stores names). */
export function r34lContributorHash(username: string): number {
  return fnv1a(username.trim().toLowerCase());
}

// ─── Decay & recording ───────────────────────────────────────────────────────

function decayFactor(lastDecayAt: number, now: number, halfLifeMs: number): number {
  const dt = now - lastDecayAt;
  if (dt <= 0) return 1;
  return Math.pow(0.5, dt / halfLifeMs);
}

/** Multiply every decayed accumulator by f and prune dust entries. Mutates the
 *  (already cloned) profile. */
function applyDecayInPlace(p: R34lChannelProfile, f: number): void {
  if (f >= 1) return;
  p.w *= f;
  p.emoteMetaW *= f;
  p.lenW *= f; p.lenSum *= f; p.lenSq *= f;
  p.caseW *= f; p.caseLower *= f; p.caseSentence *= f; p.caseCaps *= f; p.caseMixed *= f;
  p.punW *= f; p.punNone *= f; p.punTerminal *= f; p.punRepeat *= f; p.punQuestion *= f;
  p.formFragment *= f; p.formShortAck *= f; p.formEmoteOnly *= f; p.replyKnownW *= f; p.formReply *= f;
  p.emWith *= f; p.emUses *= f; p.emSolo *= f;
  p.ejWith *= f; p.ejUses *= f;
  for (const k of Object.keys(p.contributors)) {
    p.contributors[k] *= f;
    if (p.contributors[k] < DUST_WEIGHT) delete p.contributors[k];
  }
  for (const k of Object.keys(p.vocab)) {
    p.vocab[k].w *= f;
    if (p.vocab[k].w < DUST_WEIGHT) delete p.vocab[k];
  }
  for (const k of Object.keys(p.emotes)) {
    const e = p.emotes[k];
    e.uses *= f; e.msgs *= f; e.solo *= f; e.lead *= f; e.trail *= f; e.rep *= f;
    if (e.msgs < DUST_WEIGHT) delete p.emotes[k];
  }
  for (const k of Object.keys(p.laugh)) {
    p.laugh[k] *= f;
    if (p.laugh[k] < DUST_WEIGHT) delete p.laugh[k];
  }
}

function cloneProfile(p: R34lChannelProfile): R34lChannelProfile {
  return {
    ...p,
    contributors: { ...p.contributors },
    vocab: Object.fromEntries(Object.entries(p.vocab).map(([k, v]) => [k, { w: v.w, c: [...v.c] }])),
    emotes: Object.fromEntries(Object.entries(p.emotes).map(([k, v]) => [k, { ...v, c: [...v.c] }])),
    laugh: { ...p.laugh },
  };
}

/** Prune a bounded map to `max` entries, dropping the lowest-weighted. */
function pruneLowest<T>(map: Record<string, T>, max: number, weightOf: (v: T) => number): void {
  const keys = Object.keys(map);
  if (keys.length <= max) return;
  keys.sort((a, b) => weightOf(map[b]) - weightOf(map[a]));
  for (const k of keys.slice(max)) delete map[k];
}

/**
 * Record one eligible message into a profile (baseline or overlay).
 * Decay-compounds existing evidence to `now`, then adds this message with a
 * bounded weight: diminishing per-contributor influence, duplicate floods
 * downweighted to R34L_DUP_WEIGHT. Returns a NEW profile (clone-on-write).
 */
export function recordR34lObservation(
  prev: R34lChannelProfile,
  analysis: R34lMessageAnalysis,
  meta: {
    username: string;
    isReply?: boolean;
    duplicate: boolean;
    now: number;
    halfLifeMs: number;
    /** Whether emote metadata was available for this message. */
    emoteMetadataAvailable: boolean;
  },
): R34lChannelProfile {
  const p = cloneProfile(prev);
  applyDecayInPlace(p, decayFactor(p.lastDecayAt, meta.now, meta.halfLifeMs));
  p.lastDecayAt = meta.now;

  const uHash = r34lContributorHash(meta.username);
  const priorMsgs = p.contributors[String(uHash)] ?? 0;
  // Bounded contributor influence: each further message from the same person
  // is worth less; duplicates (copypasta floods) are worth much less.
  let mw = 1 / (1 + R34L_CONTRIBUTOR_DAMPING * priorMsgs);
  if (meta.duplicate) mw *= R34L_DUP_WEIGHT;

  p.contributors[String(uHash)] = priorMsgs + 1;
  pruneLowest(p.contributors, R34L_MAX_CONTRIBUTORS, (v) => v);

  p.totalMessages = Math.min(p.totalMessages + 1, 1_000_000);
  p.lastUpdatedAt = meta.now;
  p.w += mw;
  if (meta.emoteMetadataAvailable) p.emoteMetaW += mw;

  // Length (text-bearing only — emote-only messages carry no length signal)
  if (analysis.textBearing) {
    p.lenW += mw;
    p.lenSum += mw * analysis.chars;
    p.lenSq += mw * analysis.chars * analysis.chars;
  }
  // Casing (null = unsupported for this message — not counted either way)
  if (analysis.casing) {
    p.caseW += mw;
    if (analysis.casing === "lower") p.caseLower += mw;
    else if (analysis.casing === "sentence") p.caseSentence += mw;
    else if (analysis.casing === "caps") p.caseCaps += mw;
    else p.caseMixed += mw;
  }
  // Punctuation
  if (analysis.punct) {
    p.punW += mw;
    if (analysis.punct.none) p.punNone += mw;
    if (analysis.punct.terminal) p.punTerminal += mw;
    if (analysis.punct.repeat) p.punRepeat += mw;
    if (analysis.punct.question) p.punQuestion += mw;
  }
  // Response forms (denominator: all eligible messages)
  if (analysis.fragment) p.formFragment += mw;
  if (analysis.shortAck) p.formShortAck += mw;
  if (analysis.emoteOnly) p.formEmoteOnly += mw;
  if (meta.isReply !== undefined) {
    p.replyKnownW += mw;
    if (meta.isReply) p.formReply += mw;
  }
  // Emotes
  if (analysis.emotes.length > 0) {
    p.emWith += mw;
    for (const use of analysis.emotes) {
      p.emUses += mw * use.count;
      const e = p.emotes[use.name] ?? { uses: 0, msgs: 0, solo: 0, lead: 0, trail: 0, rep: 0, c: [], src: use.src, last: 0 };
      e.uses += mw * use.count;
      e.msgs += mw;
      if (analysis.emoteOnly) e.solo += mw;
      if (use.leading) e.lead += mw;
      if (use.trailing) e.trail += mw;
      if (use.repeated) e.rep += mw;
      if (!e.c.includes(uHash) && e.c.length < R34L_MAX_SUPPORT_HASHES) e.c.push(uHash);
      if (use.src === "extension") e.src = "extension";
      e.last = meta.now;
      p.emotes[use.name] = e;
    }
    pruneLowest(p.emotes, R34L_MAX_EMOTES, (v) => v.msgs);
  }
  if (analysis.emoteOnly) p.emSolo += mw;
  // Emoji (separate from platform emotes)
  if (analysis.emojiCount > 0) {
    p.ejWith += mw;
    p.ejUses += mw * analysis.emojiCount;
  }
  // Vocabulary + laughter
  for (const tok of analysis.vocabTokens) {
    const t = p.vocab[tok] ?? { w: 0, c: [] };
    t.w += mw;
    if (!t.c.includes(uHash) && t.c.length < R34L_MAX_SUPPORT_HASHES) t.c.push(uHash);
    p.vocab[tok] = t;
  }
  pruneLowest(p.vocab, R34L_MAX_VOCAB, (v) => v.w);
  for (const family of analysis.laughs) {
    p.laugh[family] = (p.laugh[family] ?? 0) + mw;
  }

  return p;
}

/** Scale all decayed accumulators so total weight ≤ max (overlay burst cap). */
export function capProfileWeight(p: R34lChannelProfile, max: number): R34lChannelProfile {
  if (p.w <= max) return p;
  const f = max / p.w;
  const scaled = cloneProfile(p);
  applyDecayInPlace(scaled, f);
  scaled.totalMessages = p.totalMessages;
  scaled.lastUpdatedAt = p.lastUpdatedAt;
  return scaled;
}

// ─── Sanitization & retention ────────────────────────────────────────────────

function clampNum(v: unknown, max = 1e9): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(v, 0), max) : 0;
}

function sanitizeSupport(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.filter((h): h is number => typeof h === "number" && Number.isFinite(h)).slice(0, R34L_MAX_SUPPORT_HASHES);
}

/**
 * Defensive sanitizer for persisted/imported profiles. Malformed data
 * degrades to a fresh profile for the key's channel — never crashes, never
 * trusts. Keys are re-derived from the map key so identity cannot be spoofed.
 */
export function sanitizeR34lProfile(raw: unknown, mapKey: string): R34lChannelProfile {
  const { platform, channel } = parseR34lProfileKey(mapKey);
  const now = Date.now();
  const base = emptyR34lProfile(platform, channel, now);
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const out: R34lChannelProfile = {
    ...base,
    createdAt: clampNum(r.createdAt, now) || now,
    lastUpdatedAt: clampNum(r.lastUpdatedAt, now),
    lastDecayAt: clampNum(r.lastDecayAt, now) || now,
    totalMessages: Math.min(clampNum(r.totalMessages), 1_000_000),
  };
  const nums = [
    "w", "emoteMetaW", "lenW", "lenSum", "lenSq",
    "caseW", "caseLower", "caseSentence", "caseCaps", "caseMixed",
    "punW", "punNone", "punTerminal", "punRepeat", "punQuestion",
    "formFragment", "formShortAck", "formEmoteOnly", "replyKnownW", "formReply",
    "emWith", "emUses", "emSolo", "ejWith", "ejUses",
  ] as const;
  for (const k of nums) (out as unknown as Record<string, number>)[k] = clampNum(r[k]);
  if (r.contributors && typeof r.contributors === "object") {
    for (const [k, v] of Object.entries(r.contributors as Record<string, unknown>)) {
      out.contributors[String(k)] = clampNum(v, 1e6);
    }
    pruneLowest(out.contributors, R34L_MAX_CONTRIBUTORS, (v) => v);
  }
  if (r.vocab && typeof r.vocab === "object") {
    for (const [k, v] of Object.entries(r.vocab as Record<string, unknown>)) {
      if (!k || k.length > 24) continue;
      const e = (v ?? {}) as Record<string, unknown>;
      out.vocab[k] = { w: clampNum(e.w, 1e6), c: sanitizeSupport(e.c) };
    }
    pruneLowest(out.vocab, R34L_MAX_VOCAB, (v) => v.w);
  }
  if (r.emotes && typeof r.emotes === "object") {
    for (const [k, v] of Object.entries(r.emotes as Record<string, unknown>)) {
      if (!k || k.length > 64) continue;
      const e = (v ?? {}) as Record<string, unknown>;
      out.emotes[k] = {
        uses: clampNum(e.uses, 1e6), msgs: clampNum(e.msgs, 1e6),
        solo: clampNum(e.solo, 1e6), lead: clampNum(e.lead, 1e6),
        trail: clampNum(e.trail, 1e6), rep: clampNum(e.rep, 1e6),
        c: sanitizeSupport(e.c),
        src: e.src === "native" ? "native" : "extension",
        last: clampNum(e.last, now),
      };
    }
    pruneLowest(out.emotes, R34L_MAX_EMOTES, (v) => v.msgs);
  }
  if (r.laugh && typeof r.laugh === "object") {
    for (const [k, v] of Object.entries(r.laugh as Record<string, unknown>)) {
      if (k.length <= 12) out.laugh[k] = clampNum(v, 1e6);
    }
  }
  return out;
}

/** Prune the profile map to R34L_MAX_PROFILES entries, oldest first. */
export function pruneR34lProfiles(
  profiles: Record<string, R34lChannelProfile>,
): Record<string, R34lChannelProfile> {
  const keys = Object.keys(profiles);
  if (keys.length <= R34L_MAX_PROFILES) return profiles;
  const sorted = keys.sort(
    (a, b) => (profiles[a].lastUpdatedAt ?? 0) - (profiles[b].lastUpdatedAt ?? 0),
  );
  const out: Record<string, R34lChannelProfile> = {};
  for (const k of sorted.slice(keys.length - R34L_MAX_PROFILES)) out[k] = profiles[k];
  return out;
}

// ─── Derived view (baseline + session overlay → effective adaptation) ───────

export type R34lBand = "collecting" | "emerging" | "established";
export type R34lLearningState = "unlearned" | "collecting" | "usable" | "established" | "aging";

export interface R34lTraitStatement {
  family: "length" | "casing" | "punctuation" | "forms" | "emotes" | "emoji" | "vocab" | "laughter";
  text: string;
  band: R34lBand;
  /** true = currently steering generation (enough evidence). Emoji/laughter
   *  are always observed-only: output policy strips emoji glyphs, and learned
   *  laughter tokens are never appended as closers. */
  applied: boolean;
}

export interface R34lEmoteView {
  name: string;
  /** merged share of messages containing it (0–1) */
  share: number;
  band: R34lBand;
  src: R34lEmoteSource;
  /** "yes" = in the channel's current usable (extension-cache) set.
   *  "unknown" = observed in chat but bot usability can't be verified
   *  (platform-native/subscriber emote, stale cache, or awareness off).
   *  We never claim "no" — absence of evidence is not evidence of denial. */
  usable: "yes" | "unknown";
  patterns: string[]; // "standalone" | "leading" | "trailing" | "repeated"
  /** Fresh in the session overlay but not established in the baseline. */
  newThisSession: boolean;
}

export interface R34lView {
  channelKey: string;
  channel: string;
  platform: string;
  state: R34lLearningState;
  /** Merged effective evidence weight (decayed baseline + capped overlay). */
  effectiveWeight: number;
  /** Lifetime retained eligible messages (baseline counter). */
  retainedMessages: number;
  /** Eligible messages observed this session (overlay counter). */
  recentMessages: number;
  lastUpdatedAt: number | null;
  /** Age of newest retained evidence (null when none). */
  evidenceAgeMs: number | null;
  /** Share of learned history that had emote metadata (null = no history). */
  emoteMetadataShare: number | null;
  /** True when reply metadata exists for a meaningful share of messages. */
  replyMetadataVisible: boolean;
  statements: R34lTraitStatement[];
  emotes: R34lEmoteView[];
  vocab: { token: string; band: R34lBand }[];
  laughters: string[];
  notes: string[];
  /** Statements currently steering generation (the rest are observed-only). */
  appliedCount: number;
}

function bandFor(weight: number): R34lBand {
  return weight < R34L_USABLE_WEIGHT ? "collecting" : weight < R34L_ESTABLISHED_WEIGHT ? "emerging" : "established";
}

/** Merge baseline + overlay weights with the overlay's share capped so a
 *  brief burst can adapt current behavior but never overwrite the retained
 *  baseline. Returns the overlay scale factor (1 when baseline is empty). */
function overlayScale(baseW: number, overW: number): number {
  if (overW <= 0) return 0;
  if (baseW <= 0) return 1;
  const cap = R34L_OVERLAY_MAX_SHARE;
  const maxOver = (baseW * cap) / (1 - cap);
  return overW > maxOver ? maxOver / overW : 1;
}

/** Share-of-evidence phrasing without fake precision. */
function sharePhrase(p: number): string {
  if (p >= 0.85) return "almost always";
  if (p >= 0.6) return "usually";
  if (p >= 0.35) return "often";
  if (p >= 0.15) return "sometimes";
  return "rarely";
}

/** A decayed read of one profile at `now` (no mutation). */
interface DecayedRead {
  f: number; // multiplicative decay factor applied to every accumulator
  p: R34lChannelProfile;
}
function decayedRead(p: R34lChannelProfile, now: number, halfLifeMs: number): DecayedRead {
  return { f: decayFactor(p.lastDecayAt, now, halfLifeMs), p };
}

/** Merge one scalar counter from baseline + overlay into a decayed merged value. */
function m(base: DecayedRead | null, over: DecayedRead | null, os: number, pick: (p: R34lChannelProfile) => number): number {
  return (base ? pick(base.p) * base.f : 0) + (over ? pick(over.p) * over.f * os : 0);
}

export interface DeriveR34lInput {
  baseline: R34lChannelProfile | null | undefined;
  overlay: R34lChannelProfile | null | undefined;
  /** Current channel key — overlay is ignored when its key doesn't match. */
  channelKey: string;
  /** Names from the channel's current usable (extension-cache) emote set;
   *  null = emote awareness off / capability unknown. */
  usableEmotes: ReadonlySet<string> | null;
  now: number;
}

/**
 * Derive the effective R34l view: retained baseline merged with the session
 * overlay (share-capped), per-feature confidence bands, plain-language trait
 * statements, emote tiers, and honest uncertainty notes. This ONE derivation
 * powers both the generation prompt block and the UI learning readout.
 */
export function deriveR34lView(input: DeriveR34lInput): R34lView {
  const { now } = input;
  const base = input.baseline ? decayedRead(input.baseline, now, R34L_BASELINE_HALF_LIFE_MS) : null;
  const overlayValid = input.overlay && input.overlay.key === input.channelKey ? input.overlay : null;
  const over = overlayValid ? decayedRead(overlayValid, now, R34L_OVERLAY_HALF_LIFE_MS) : null;

  const baseW = base ? base.p.w * base.f : 0;
  const overW = over ? over.p.w * over.f : 0;
  const os = overlayScale(baseW, overW);
  const totalW = baseW + overW * os;

  const retained = input.baseline?.totalMessages ?? 0;
  const recent = overlayValid?.totalMessages ?? 0;
  const lastUpdatedAt = Math.max(input.baseline?.lastUpdatedAt ?? 0, overlayValid?.lastUpdatedAt ?? 0) || null;

  const { channel, platform } = parseR34lProfileKey(input.channelKey);

  // ── Learning state ──────────────────────────────────────────────────────
  let state: R34lLearningState;
  if (retained === 0 && totalW < 3) state = "unlearned";
  else if (totalW < R34L_USABLE_WEIGHT) state = "collecting";
  else if (totalW >= R34L_ESTABLISHED_WEIGHT) state = "established";
  else state = "usable";
  if ((state === "usable" || state === "established") && lastUpdatedAt && now - lastUpdatedAt > R34L_AGING_MS) {
    state = "aging";
  }

  // ── Family weights (merged) ─────────────────────────────────────────────
  const lenW = m(base, over, os, (p) => p.lenW);
  const caseW = m(base, over, os, (p) => p.caseW);
  const punW = m(base, over, os, (p) => p.punW);
  const replyKnownW = m(base, over, os, (p) => p.replyKnownW);
  const emoteMetaW = m(base, over, os, (p) => p.emoteMetaW);

  const statements: R34lTraitStatement[] = [];

  // ── Length ──────────────────────────────────────────────────────────────
  if (lenW > 0) {
    const mean = m(base, over, os, (p) => p.lenSum) / lenW;
    const variance = Math.max(0, m(base, over, os, (p) => p.lenSq) / lenW - mean * mean);
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
    const bucket = mean < 15 ? "very short" : mean < 40 ? "short" : mean < 90 ? "medium-length" : "long";
    const band = bandFor(lenW);
    statements.push({
      family: "length",
      text: `Messages are ${band === "collecting" ? "leaning " : ""}${bucket} on average (~${Math.round(mean)} chars)${cv > 0.9 ? ", with big variation in length" : ""}`,
      band,
      applied: band !== "collecting",
    });
  }

  // ── Casing ──────────────────────────────────────────────────────────────
  if (caseW > 0) {
    const lower = m(base, over, os, (p) => p.caseLower) / caseW;
    const sentence = m(base, over, os, (p) => p.caseSentence) / caseW;
    const caps = m(base, over, os, (p) => p.caseCaps) / caseW;
    let text: string;
    if (lower >= 0.6) {
      text = "Mostly lowercase";
      if (caps >= 0.07) text += "; uppercase appears in short reaction bursts";
    } else if (sentence >= 0.5) {
      text = "Usually sentence case (first letter capitalized)";
      if (caps >= 0.07) text += "; uppercase appears in short reaction bursts";
    } else if (caps >= 0.35) {
      text = "Frequent uppercase / reaction caps";
    } else {
      text = "Mixed casing — no single dominant pattern";
    }
    const band = bandFor(caseW);
    statements.push({ family: "casing", text, band, applied: band !== "collecting" });
  }

  // ── Punctuation ─────────────────────────────────────────────────────────
  if (punW > 0) {
    const none = m(base, over, os, (p) => p.punNone) / punW;
    const repeat = m(base, over, os, (p) => p.punRepeat) / punW;
    const question = m(base, over, os, (p) => p.punQuestion) / punW;
    const clauses: string[] = [];
    if (none >= 0.5) clauses.push("most messages end without punctuation");
    if (repeat >= 0.12) clauses.push('repeated punctuation ("!!", "??", "...") shows up often');
    if (question >= 0.18) clauses.push("questions are common");
    if (clauses.length === 0) clauses.push("punctuation use is mixed");
    const band = bandFor(punW);
    statements.push({
      family: "punctuation",
      text: `Punctuation: ${clauses.slice(0, 2).join("; ")}`,
      band,
      applied: band !== "collecting",
    });
  }

  // ── Response forms (denominator: all eligible messages) ─────────────────
  if (totalW > 0) {
    const shortAck = m(base, over, os, (p) => p.formShortAck) / totalW;
    const fragment = m(base, over, os, (p) => p.formFragment) / totalW;
    const clauses: string[] = [];
    if (shortAck >= 0.15) clauses.push("short acknowledgments are common");
    if (fragment >= 0.5) clauses.push("very short fragment messages dominate");
    const replyVisible = totalW > 0 && replyKnownW / totalW >= 0.3;
    if (replyVisible) {
      const replyShare = m(base, over, os, (p) => p.formReply) / replyKnownW;
      if (replyShare >= 0.2) clauses.push("direct reply-tagged messages are common");
      else if (replyShare <= 0.05) clauses.push("direct reply-tagging is rare");
    }
    if (clauses.length > 0) {
      const band = bandFor(totalW);
      statements.push({
        family: "forms",
        text: `Response style: ${clauses.slice(0, 2).join("; ")}`,
        band,
        applied: band !== "collecting",
      });
    }
  }

  // ── Emotes (aggregate) ──────────────────────────────────────────────────
  const emWith = m(base, over, os, (p) => p.emWith);
  const emSolo = m(base, over, os, (p) => p.emSolo);
  const emoteViews: R34lEmoteView[] = [];
  if (totalW > 0) {
    const density = emWith / totalW;
    const densityPhrase =
      emWith <= 0 ? "no emotes were observed in this history"
      : density < 0.05 ? "emotes are rarely used"
      : density < 0.15 ? "emotes are sparse"
      : density < 0.35 ? "emotes are used moderately"
      : "emotes are used heavily";
    const placement: string[] = [];
    if (emWith > 0) {
      if (emSolo / emWith >= 0.35) placement.push("often sent as standalone reactions");
      const lead = m(base, over, os, (p) => Object.values(p.emotes).reduce((a, e) => a + e.lead, 0));
      const trail = m(base, over, os, (p) => Object.values(p.emotes).reduce((a, e) => a + e.trail, 0));
      if (trail / emWith >= 0.4) placement.push("usually placed at the end of a message");
      else if (lead / emWith >= 0.3) placement.push("often placed at the start of a message");
    }
    const band = bandFor(totalW);
    statements.push({
      family: "emotes",
      text: `Emotes: ${densityPhrase}${placement.length > 0 ? ` — ${placement[0]}` : ""}`,
      band,
      applied: band !== "collecting",
    });

    // ── Per-emote views ─────────────────────────────────────────────────
    const names = new Set<string>();
    if (base) for (const n of Object.keys(base.p.emotes)) names.add(n);
    if (over) for (const n of Object.keys(over.p.emotes)) names.add(n);
    for (const name of names) {
      const be = base?.p.emotes[name];
      const oe = over?.p.emotes[name];
      if (!base && !over) continue;
      const bf = base ? base.f : 0;
      const of = over ? over.f * os : 0;
      const msgs = (be ? be.msgs * bf : 0) + (oe ? oe.msgs * of : 0);
      if (msgs < 0.2) continue;
      const solo = (be ? be.solo * bf : 0) + (oe ? oe.solo * of : 0);
      const lead = (be ? be.lead * bf : 0) + (oe ? oe.lead * of : 0);
      const trail = (be ? be.trail * bf : 0) + (oe ? oe.trail * of : 0);
      const rep = (be ? be.rep * bf : 0) + (oe ? oe.rep * of : 0);
      const support = new Set([...(be?.c ?? []), ...(oe?.c ?? [])]).size;
      const patterns: string[] = [];
      if (solo / msgs >= 0.4) patterns.push("standalone");
      if (trail / msgs >= 0.4) patterns.push("trailing");
      if (lead / msgs >= 0.3) patterns.push("leading");
      if (rep / msgs >= 0.25) patterns.push("repeated");
      const src: R34lEmoteSource = be?.src === "extension" || oe?.src === "extension" ? "extension" : "native";
      const usable: R34lEmoteView["usable"] =
        input.usableEmotes === null ? "unknown" : input.usableEmotes.has(name) ? "yes" : "unknown";
      emoteViews.push({
        name,
        share: msgs / totalW,
        // Per-emote band: needs both weight and multi-contributor support.
        band: msgs >= 1.5 && support >= 2 ? bandFor(msgs) : "collecting",
        src,
        usable,
        patterns,
        newThisSession: (be ? be.msgs * bf : 0) < 1 && (oe ? oe.msgs * (over ? over.f : 0) : 0) >= 0.5,
      });
    }
    emoteViews.sort((a, b) => b.share - a.share);
  }

  // ── Emoji (observed-only — output policy strips emoji glyphs) ───────────
  const ejWith = m(base, over, os, (p) => p.ejWith);
  if (totalW > 0 && ejWith / totalW >= 0.02) {
    statements.push({
      family: "emoji",
      text: `Chat ${sharePhrase(ejWith / totalW)} uses Unicode emoji — bots here never send emoji (text emote names only)`,
      band: bandFor(totalW),
      applied: false,
    });
  }

  // ── Vocabulary ──────────────────────────────────────────────────────────
  const vocabViews: { token: string; band: R34lBand }[] = [];
  {
    const tokens = new Set<string>();
    if (base) for (const t of Object.keys(base.p.vocab)) tokens.add(t);
    if (over) for (const t of Object.keys(over.p.vocab)) tokens.add(t);
    const merged: { token: string; w: number; support: number }[] = [];
    for (const token of tokens) {
      const bt = base?.p.vocab[token];
      const ot = over?.p.vocab[token];
      const w = (bt ? bt.w * base!.f : 0) + (ot ? ot.w * over!.f * os : 0);
      const support = new Set([...(bt?.c ?? []), ...(ot?.c ?? [])]).size;
      // Minimum support: a token used by only one chatter is never vocabulary.
      if (w >= 0.5 && support >= 2) merged.push({ token, w, support });
    }
    merged.sort((a, b) => b.w - a.w);
    for (const v of merged.slice(0, 8)) {
      vocabViews.push({ token: v.token, band: v.w < 1.5 ? "collecting" : v.w < 4 ? "emerging" : "established" });
    }
    const supported = vocabViews.filter((v) => v.band !== "collecting");
    if (supported.length > 0) {
      const band = bandFor(totalW);
      statements.push({
        family: "vocab",
        text: `Recurring community words: ${supported.slice(0, 6).map((v) => `"${safeToken(v.token)}"`).join(", ")}`,
        band,
        applied: band !== "collecting",
      });
    }
  }

  // ── Laughter (observed-only, never prompt vocabulary) ───────────────────
  const laughters: string[] = [];
  {
    const fams = new Map<string, number>();
    if (base) for (const [k, v] of Object.entries(base.p.laugh)) fams.set(k, (fams.get(k) ?? 0) + v * base.f);
    if (over) for (const [k, v] of Object.entries(over.p.laugh)) fams.set(k, (fams.get(k) ?? 0) + v * over.f * os);
    for (const [fam, w] of [...fams.entries()].sort((a, b) => b[1] - a[1])) {
      if (w >= 1 && totalW > 0 && w / totalW >= 0.03) laughters.push(fam);
      if (laughters.length >= 3) break;
    }
    if (laughters.length > 0) {
      statements.push({
        family: "laughter",
        text: `Chat laughs with ${laughters.map((l) => `"${l}"`).join(" / ")}-style messages`,
        band: bandFor(totalW),
        applied: false,
      });
    }
  }

  // ── Uncertainty notes ───────────────────────────────────────────────────
  const notes: string[] = [];
  const emoteMetadataShare = totalW > 0 ? emoteMetaW / totalW : null;
  if (emoteMetadataShare !== null && emoteMetadataShare < 0.5) {
    notes.push("Emote metadata was unavailable for much of the learned history — emote stats are partial.");
  }
  if (platform !== "twitch") {
    notes.push("Reply structure isn't visible on this platform — response-form stats exclude replies.");
  } else if (totalW > 0 && replyKnownW / totalW < 0.05) {
    notes.push("Reply metadata wasn't observed in this history — response-form stats may undercount replies.");
  }
  if (input.usableEmotes === null) {
    notes.push("Bot emote capability is unknown (emote awareness is off or the cache is cold).");
  }

  const appliedCount = statements.filter((s) => s.applied).length;

  return {
    channelKey: input.channelKey,
    channel,
    platform,
    state,
    effectiveWeight: totalW,
    retainedMessages: retained,
    recentMessages: recent,
    lastUpdatedAt,
    evidenceAgeMs: lastUpdatedAt ? now - lastUpdatedAt : null,
    emoteMetadataShare,
    replyMetadataVisible: totalW > 0 && replyKnownW / totalW >= 0.3,
    statements,
    emotes: emoteViews.slice(0, 8),
    vocab: vocabViews,
    laughters,
    notes,
    appliedCount,
  };
}

// ─── Prompt formatting ───────────────────────────────────────────────────────

/** Make a chat-derived token safe for prompt inclusion: strip characters that
 *  could break the block structure or smuggle instructions, cap length. */
function safeToken(token: string): string {
  return token.replace(/[\n\r\t"`<>\\|#*]/g, "").trim().slice(0, 24);
}

/**
 * Format the derived view into the bounded prompt block injected after
 * R34L_TYPING_PROMPT. Only APPLIED statements steer output — observed-only
 * traits (emoji, laughter) and thin evidence are excluded. Returns "" when
 * nothing clears the evidence gate (caller falls back to the restrained
 * baseline texture).
 */
export function formatR34lPromptBlock(view: R34lView): string {
  const applied = view.statements.filter((s) => s.applied);
  if (applied.length === 0) return "";

  const parts: string[] = [
    `### LEARNED CHANNEL STYLE — observed evidence from this community`,
    `Measured from ${view.retainedMessages} retained messages${view.recentMessages > 0 ? ` (+${view.recentMessages} this session)` : ""} in #${safeToken(view.channel)}. This is the room's actual typing texture. Follow it for SURFACE STYLE ONLY — casing, length, punctuation, emote cadence. It OVERRIDES the generic defaults below wherever they disagree. It never changes your meaning, language, persona, or content boundaries, and never overrides operator instructions.`,
  ];

  for (const s of applied) {
    // Statements are derived from aggregate numbers by this module (not raw
    // chat text), but vocabulary tokens embedded in the vocab statement are
    // chat-derived — sanitize defensively.
    parts.push(`- ${s.text.replace(/[\n\r\t`"\\|<>#*]/g, "")}`);
  }

  const usableFavorites = view.emotes
    .filter((e) => e.usable === "yes" && e.band !== "collecting")
    .slice(0, 5)
    .map((e) => safeToken(e.name))
    .filter(Boolean);
  if (usableFavorites.length > 0) {
    parts.push(
      `- Community emote favorites you can use: ${usableFavorites.join(", ")}. A favorite is a seasoning, not a compulsory suffix — never append one to every message, and zero emotes is always acceptable.`,
    );
  } else {
    const emoteStmt = applied.find((s) => s.family === "emotes");
    if (emoteStmt && /rarely|sparse/.test(emoteStmt.text)) {
      parts.push(`- This room uses emotes sparingly — prefer none, or at most one when a moment truly warrants it.`);
    }
  }

  const vocabStmt = applied.find((s) => s.family === "vocab");
  if (vocabStmt) {
    parts.push(
      `- The recurring words above are texture cues only: they show what the ROOM says, not what you must say. Never append them as closers or filler, and never force one into every message.`,
    );
  }

  parts.push(`### END LEARNED CHANNEL STYLE`);
  return "\n" + parts.join("\n");
}
