/**
 * Em-dashes (—) are banned from all user-facing AI output — Forge suggestion
 * cards, AutoForge action payloads/reasons, refined messages, briefings.
 * They read as machine-polished rather than human-typed chat. Replaced with
 * " - " (spaces on either side), collapsing any surrounding whitespace so the
 * result is always a single-spaced hyphen regardless of the original spacing.
 */
export function stripEmDashes(text: string): string {
  if (!text || typeof text !== "string") return text;
  return text.replace(/\s*—\s*/g, " - ").trim();
}

/**
 * Actual Unicode emoji characters (😂 💀 🔥 ⭐) are banned from bot chat
 * output. Twitch chat convention is TEXT emotes — Twitch native or
 * BetterTTV/7TV/FrankerFaceZ names ("POG", "LUL", "KEKW", "monkaS") — which
 * render as images for everyone. Emoji glyphs render inconsistently, can be
 * unreadable on some clients, and instantly mark the sender as a bot. Text
 * emote names are untouched. Also strips variation selectors, zero-width
 * joiners, and keycap combinators so decomposed sequences ("1️⃣") degrade
 * cleanly to their base character.
 *
 * EMOJI_GLYPH_REGEX is the SINGLE glyph table for the whole app — tts.ts's
 * speech cleaner imports it instead of keeping its own copy. The two lists
 * had already drifted (this table originally missed the media-control /
 * geometric-shape / enclosed-ideograph ranges like ⏰ 🔄 ▶ ㊙ that TTS
 * stripped), so they are unified here as the union of both.
 */
export const EMOJI_GLYPH_REGEX = new RegExp(
  [
    "[\\u{1F000}-\\u{1FAFF}]", // all emoji blocks (flags, pictographs, symbols)
    "[\\u{2600}-\\u{27BF}]",   // misc symbols + dingbats (☀ ✂ ✅)
    "[\\u{2B00}-\\u{2BFF}]",   // star/arrows block additions (⭐ ⬛)
    "[\\u{231A}-\\u{231B}]",   // watch + hourglass (⌚ ⌛)
    "[\\u{23E9}-\\u{23FA}]",   // media controls + alarm/timer (⏩ ⏰ ⏳ ⏸ ⏺)
    "[\\u{25AA}-\\u{25AB}\\u{25B6}\\u{25C0}\\u{25FB}-\\u{25FE}]", // shape buttons (▪ ▶ ◀ ◼)
    "[\\u{2934}-\\u{2935}]",   // repeat arrows (🔄 🔁)
    "\\u{3030}",               // wavy dash (〰)
    "\\u{303D}",               // part alternation mark (〽)
    "\\u{3297}",               // circled ideograph congratulation (㊗)
    "\\u{3299}",               // circled ideograph secret (㊙)
    "[\\u{FE00}-\\u{FE0F}]",   // variation selectors (incl. emoji VS-16)
    "\\u{200D}",               // zero-width joiner (ZWJ sequences)
    "\\u{20E3}",               // combining enclosing keycap
  ].join("|"),
  "gu",
);

export function stripEmojis(text: string): string {
  if (!text || typeof text !== "string") return text;
  return text.replace(EMOJI_GLYPH_REGEX, "").replace(/ {2,}/g, " ").trim();
}

/**
 * Thinking-capable models (Ollama reasoning models, OpenRouter reasoning
 * variants) can leak internal deliberation into visible output as
 * `<think>…</think>` / `<thinking>…` / `<reasoning>…` blocks — even when
 * reasoning is disabled at the request level, older endpoints and some
 * providers still inline it. That content is not analysis: it's raw
 * chain-of-thought that provides no situational context, and it was landing
 * verbatim in the Visual Snapshot History description.
 *
 * Strips:
 *  - closed blocks anywhere in the text,
 *  - an unterminated trailing block (token-budget truncation cuts the
 *    closing tag, leaving "<think> …" running to end-of-output),
 *  - stray closing tags.
 *
 * If the entire output was reasoning, the result is "" — callers treat an
 * empty observation as "no analysis" rather than displaying deliberation.
 */
export function stripReasoningBlocks(text: string): string {
  if (!text || typeof text !== "string") return text;
  return text
    .replace(/<(think|thinking|reasoning|thought)>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(think|thinking|reasoning|thought)>[\s\S]*$/i, "")
    .replace(/<\/(think|thinking|reasoning|thought)>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
