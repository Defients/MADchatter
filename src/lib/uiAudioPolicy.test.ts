import assert from "node:assert/strict";
import { isOptionalUiAudioAllowed, setOptionalUiPageHiddenForTest } from "./uiAudioPolicy";
import { mobileAudioCueAllowed } from "./mobileAudioPolicy";

const visible = { visibilityState: "visible" } as Pick<Document, "visibilityState">;
const hidden = { visibilityState: "hidden" } as Pick<Document, "visibilityState">;

setOptionalUiPageHiddenForTest(false);
assert.equal(isOptionalUiAudioAllowed(visible), true, "foreground document admits optional UI audio");
assert.equal(isOptionalUiAudioAllowed(hidden), false, "hidden document suppresses optional UI audio");
setOptionalUiPageHiddenForTest(true);
assert.equal(isOptionalUiAudioAllowed(visible), false, "pagehide state suppresses callers even if visibility has not caught up");
setOptionalUiPageHiddenForTest(false);
assert.equal(isOptionalUiAudioAllowed(visible), true, "foreground restore admits only future UI events");
assert.equal(mobileAudioCueAllowed("attention_mention", false), true, "direct mention attention remains independent from SFX preference");
assert.equal(mobileAudioCueAllowed("navigation", false), false, "ordinary UI audio still requires SFX preference");

console.log("6/6 optional UI audio policy scenarios passed");
