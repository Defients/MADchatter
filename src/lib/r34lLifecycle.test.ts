import assert from "node:assert/strict";
import { advanceR34lPlateau, isR34lFreezeSuggestionDismissed, R34L_PLATEAU_EVIDENCE_WINDOW, r34lAppliedFingerprint, r34lStyleReady } from "./r34lLifecycle";
import type { R34lView } from "./r34lLearning";

const base = {
  channelKey: "twitch:room", channel: "room", platform: "twitch", state: "established",
  effectiveWeight: 80, retainedMessages: 100, recentMessages: 2, lastUpdatedAt: 1, evidenceAgeMs: 0,
  statements: [{ family: "length", text: "messages run short", band: "established", applied: true }],
  emotes: [], vocab: [], notes: [], appliedCount: 1,
} as R34lView;

assert(r34lStyleReady({ ...base, state: "usable" }), "usable canonical evidence can produce a readiness cue");
assert(!r34lStyleReady({ ...base, appliedCount: 0, statements: [] }), "raw evidence without applied traits is not readiness");
assert.equal(advanceR34lPlateau(null, { ...base, state: "usable" }).suggestFrozen, false, "plateau never begins before established");
const started = advanceR34lPlateau(null, base);
assert(started.snapshot && !started.suggestFrozen, "established profile starts a bounded stability window");
const rawOnly = advanceR34lPlateau(null, { ...base, appliedCount: 0, statements: [], recentMessages: 999 });
assert.equal(rawOnly.suggestFrozen, false, "raw message count alone cannot imply plateau");
const matured = advanceR34lPlateau(started.snapshot, { ...base, recentMessages: base.recentMessages + R34L_PLATEAU_EVIDENCE_WINDOW });
assert(matured.suggestFrozen, "meaningful extra evidence with unchanged applied fingerprint suggests Frozen");
const changed = advanceR34lPlateau(started.snapshot, {
  ...base,
  recentMessages: base.recentMessages + R34L_PLATEAU_EVIDENCE_WINDOW,
  statements: [{ family: "length", text: "messages now run long", band: "established", applied: true }],
});
assert.equal(changed.suggestFrozen, false, "material fingerprint change restarts the window");

const matureView = { ...base, recentMessages: base.recentMessages + R34L_PLATEAU_EVIDENCE_WINDOW };
const dismissal = { channelKey: "twitch:room", fingerprint: r34lAppliedFingerprint(matureView), recentMessages: matureView.recentMessages };
assert.equal(isR34lFreezeSuggestionDismissed(dismissal, matureView), true, "Not now hides the same plateau snapshot");
assert.equal(isR34lFreezeSuggestionDismissed(dismissal, { ...matureView, recentMessages: matureView.recentMessages + 17 }), true, "dismissal survives minor extra evidence");
assert.equal(isR34lFreezeSuggestionDismissed(dismissal, { ...matureView, recentMessages: matureView.recentMessages + 18 }), false, "substantially more evidence permits a later suggestion");

// Channel scoping: a "Not now" in one room never leaks into another, even
// when both rooms apply an identical fingerprint. Returning to the original
// channel still honors ITS dismissal while the evidence window has not
// advanced past the bounded threshold.
const otherChannelView = { ...matureView, channelKey: "twitch:other", channel: "other" };
assert.equal(isR34lFreezeSuggestionDismissed(dismissal, otherChannelView), false, "same fingerprint in another channel does NOT inherit the dismissal");
const otherChannelDismissal = { channelKey: "twitch:other", fingerprint: r34lAppliedFingerprint(otherChannelView), recentMessages: otherChannelView.recentMessages };
assert.equal(isR34lFreezeSuggestionDismissed(otherChannelDismissal, otherChannelView), true, "each channel's own dismissal applies in its own room");
assert.equal(isR34lFreezeSuggestionDismissed(otherChannelDismissal, matureView), false, "the second channel's dismissal does not suppress the first");
assert.equal(isR34lFreezeSuggestionDismissed(dismissal, { ...matureView, channelKey: undefined } as unknown as R34lView), false, "missing channel identity never matches a scoped dismissal");

console.log("R34L readiness, bounded plateau and channel-scoped dismissal scenarios passed");
