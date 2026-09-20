import assert from "node:assert/strict";
import { isSelfSabotageShortcut, MobileSelfSabotageTapSequence } from "./selfSabotageTriggers";

const chord = { key: "b", ctrlKey: true, shiftKey: true, altKey: true };

assert.equal(isSelfSabotageShortcut(chord), true, "desktop chord should fire");
assert.equal(isSelfSabotageShortcut({ ...chord, repeat: true }), false, "key repeat must not refire");
assert.equal(isSelfSabotageShortcut({ ...chord, altKey: false }), false, "all modifiers are required");
assert.equal(isSelfSabotageShortcut({ ...chord, metaKey: true }), false, "Cmd variant is intentionally not the desktop chord");

const taps = new MobileSelfSabotageTapSequence(3, 1_500, 2_000);
assert.equal(taps.noteTap(0), false);
assert.equal(taps.noteTap(500), false);
assert.equal(taps.noteTap(1_000), true, "third tap in the rolling window should fire");
assert.equal(taps.noteTap(1_050), false, "fourth rapid tap must be swallowed by lockout");

const slow = new MobileSelfSabotageTapSequence(3, 1_500, 2_000);
assert.equal(slow.noteTap(0), false);
assert.equal(slow.noteTap(1_600), false);
assert.equal(slow.noteTap(3_200), false, "taps outside the timeout must not accumulate");

console.log("SELF-SAB-BOT-AGE trigger tests passed");
