/**
 * stripEmojis: actual Unicode emoji characters are banned from bot chat
 * output (Forge suggestion messages, refined messages, AutoForge
 * action_payload). TEXT emotes ("POG", "LUL", "monkaS") are fine and must be
 * untouched. These tests lock the removal contract.
 */
import { stripEmojis } from "./textSanitize";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`, extra ?? ""); }
}
function eq(name: string, actual: unknown, expected: unknown) {
  check(name, actual === expected, { actual, expected });
}

console.log("stripEmojis");
eq("face with tears of joy removed", stripEmojis("that play 😂 was insane"), "that play was insane");
eq("skull removed", stripEmojis("💀 lol"), "lol");
eq("fire removed", stripEmojis("lets go 🔥🔥"), "lets go");
eq("star removed", stripEmojis("⭐ nice"), "nice");
eq("checkmark removed", stripEmojis("done ✅"), "done");
eq("emoji-only message becomes empty", stripEmojis("😂😂😂"), "");
eq("double spaces collapsed", stripEmojis("a 😂 b"), "a b");
eq("text emotes untouched (POG)", stripEmojis("POG moment"), "POG moment");
eq("text emotes untouched (LUL/KEKW)", stripEmojis("LUL KEKW monkaS"), "LUL KEKW monkaS");
eq("lowercase words untouched", stripEmojis("lol lmao based real"), "lol lmao based real");
eq("flags removed", stripEmojis("gg 🇺🇸"), "gg");
eq("keycap degrades to base digit", stripEmojis("top 1️⃣"), "top 1");
eq("ZWJ family sequence fully removed", stripEmojis("hi 👨‍👩‍👧"), "hi");
eq("regular punctuation untouched", stripEmojis("wait - what?! :)"), "wait - what?! :)");
eq("no emoji unchanged", stripEmojis("lmao nice play"), "lmao nice play");
eq("empty string", stripEmojis(""), "");
eq("non-string passthrough (undefined)", stripEmojis(undefined as any), undefined);
eq("non-string passthrough (null)", stripEmojis(null as any), null);
// Ranges added when the glyph table was unified with tts.ts's speech cleaner
// (media controls, geometric shapes, enclosed ideographs) — a drift regression
// where the chat path missed glyphs TTS already stripped.
eq("alarm clock removed (misc technical)", stripEmojis("meeting ⏰ soon"), "meeting soon");
eq("hourglass removed", stripEmojis("waiting ⌛"), "waiting");
eq("watch removed", stripEmojis("its ⌚ time"), "its time");
eq("repeat arrows removed", stripEmojis("that again 🔄"), "that again");
eq("play button removed (geometric shape)", stripEmojis("press ▶ now"), "press now");
eq("enclosed ideograph removed", stripEmojis("secret ㊙ club"), "secret club");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);