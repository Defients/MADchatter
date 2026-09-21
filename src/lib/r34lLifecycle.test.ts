import assert from "node:assert/strict";
import { advanceR34lPlateau, R34L_PLATEAU_EVIDENCE_WINDOW, r34lStyleReady } from "./r34lLifecycle";
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

console.log("R34L readiness and bounded plateau scenarios passed");
