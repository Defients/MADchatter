import assert from "node:assert/strict";
import {
  beginRangeGesture,
  collapseMobileProviderDisclosure,
  isAdaptiveLengthPreference,
  isMobileLengthOptionActive,
  toggleMobileLengthPreference,
  updateRangeGestureIntent,
} from "./mobileControls";

let gesture = beginRangeGesture(1, 100, 100);
gesture = updateRangeGestureIntent(gesture, 103, 104);
assert.equal(gesture.intent, "pending", "small jitter does not lock intent");

gesture = updateRangeGestureIntent(gesture, 104, 114);
assert.equal(gesture.intent, "vertical", "vertical-dominant motion locks scrolling");
assert.equal(updateRangeGestureIntent(gesture, 140, 114).intent, "vertical", "vertical intent stays locked");

let horizontal = beginRangeGesture(2, 100, 100);
horizontal = updateRangeGestureIntent(horizontal, 114, 104);
assert.equal(horizontal.intent, "horizontal", "horizontal-dominant motion locks adjustment");
assert.equal(updateRangeGestureIntent(horizontal, 114, 150).intent, "horizontal", "horizontal intent stays locked");

const nextGesture = beginRangeGesture(3, 10, 10);
assert.equal(nextGesture.intent, "pending", "new pointer gesture resets prior intent");
assert.equal(nextGesture.pointerId, 3, "new pointer owns the gesture");

for (const option of ["short", "medium", "long"] as const) {
  assert.equal(toggleMobileLengthPreference("adaptive", option), option, `${option} can be selected`);
  assert.equal(toggleMobileLengthPreference(option, option), "adaptive", `${option} deselects to adaptive`);
  assert.equal(isMobileLengthOptionActive("adaptive", option), false, `adaptive does not select ${option}`);
}
assert.equal(isAdaptiveLengthPreference("adaptive"), true);
assert.equal(isAdaptiveLengthPreference("none"), true, "legacy unconstrained value renders as adaptable");

const savedProviderConfig = Object.freeze({ activeProvider: "openai", apiKey: "saved-secret" });
const collapsed = collapseMobileProviderDisclosure();
assert.deepEqual(collapsed, { expanded: false, expandedProvider: null, apiKeyDraft: "" });
assert.deepEqual(savedProviderConfig, { activeProvider: "openai", apiKey: "saved-secret" }, "collapse does not touch saved provider configuration");

console.log("Mobile control gesture, length, and provider-disclosure scenarios passed");
