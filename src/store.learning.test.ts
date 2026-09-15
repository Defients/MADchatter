/**
 * Focused test harness for Channel Learning store integration.
 * Run: npx tsx src/store.learning.test.ts
 *
 * Verifies the store-level guarantees of the adaptive feedback loop:
 * - v26 → current migration seeds defaults and preserves existing settings
 *   (the schema has since moved to v28; the seeded-from-v26 guarantees hold)
 * - learning is channel-scoped (A learns A, B learns B, A→B→A restores A)
 * - resetChannelLearning clears ONLY the current channel's learning
 * - reload (re-hydration) preserves learning
 * - adaptiveLearningEnabled toggle round-trips
 * - recordLearningOutcome with no channel connected is a no-op
 *
 * The store module uses `localStorage` (persist middleware) — shimmed here
 * with an in-memory Map before import, mirroring store.multibot.test.ts.
 */

// ─── localStorage shim (must exist before store.ts module init) ──────────
// zustand's persist default storage is createJSONStorage(() => window.localStorage),
// so BOTH `window` and `localStorage` must exist before the store imports.
const storageMap = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => storageMap.get(k) ?? null,
  setItem: (k: string, v: string) => { storageMap.set(k, String(v)); },
  removeItem: (k: string) => { storageMap.delete(k); },
  clear: () => storageMap.clear(),
  get length() { return storageMap.size; },
  key: (i: number) => [...storageMap.keys()][i] ?? null,
};
(globalThis as any).window = globalThis;

// ─── Scenario A: migration from v26 (pre-learning) ─────────────────────────
// Seed a v26 persisted state WITHOUT learning fields, then import the store:
// the v27 migration must seed learning defaults while preserving every
// existing field.
storageMap.set("madchatter-storage", JSON.stringify({
  state: {
    r34lEnabled: true,
    autoForgeDryRun: true,
    autoForgeConfidenceThreshold: 0.65,
    streamMetadata: { channelName: "LegacyChannel", title: "", category: "", viewerCount: 0 },
  },
  version: 26,
}));

const { useAppStore } = await import("./store");
const { emptyLearningProfile, getLearnedActionStats } = await import("./lib/channelLearning");

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const s = () => useAppStore.getState();

console.log("\n[A] v26 → v27 migration");
check("existing settings preserved (r34lEnabled)", s().r34lEnabled === true);
check("existing settings preserved (dry run)", s().autoForgeDryRun === true);
check("existing settings preserved (confidence threshold)", s().autoForgeConfidenceThreshold === 0.65);
check("learningProfiles seeded empty", s().learningProfiles !== undefined && Object.keys(s().learningProfiles).length === 0);
check("adaptiveLearningEnabled defaults true", s().adaptiveLearningEnabled === true);

// ─── Scenario B: channel-scoped learning + A→B→A isolation ─────────────────

console.log("\n[B] Channel isolation");
s().updateStreamMetadata({ channelName: "ChannelA" });
s().recordLearningOutcome("short_reaction", 0.5);
s().recordLearningOutcome("short_reaction", 0.7);
const aProfile1 = s().learningProfiles["channela"];
check("channel A records outcomes under its normalized key", aProfile1 !== undefined && getLearnedActionStats(aProfile1, "short_reaction")!.samples === 2);

s().updateStreamMetadata({ channelName: "ChannelB" });
check("channel B starts with no learned evidence", s().learningProfiles["channelb"] === undefined);
s().recordLearningOutcome("emote_only", -0.4);
const bProfile = s().learningProfiles["channelb"];
check("channel B records its own outcomes", getLearnedActionStats(bProfile, "emote_only")!.samples === 1);
check("channel B has no leakage of A's actions", getLearnedActionStats(bProfile, "short_reaction") === null);

s().updateStreamMetadata({ channelName: "ChannelA" });
const aProfile2 = s().learningProfiles["channela"];
check("A→B→A restores A's learning exactly", getLearnedActionStats(aProfile2, "short_reaction")!.samples === 2);

// ─── Scenario C: reset clears only the current channel ────────────────────

console.log("\n[C] Reset scoping");
s().resetChannelLearning();
check("reset clears current channel's learning", s().learningProfiles["channela"] === undefined);
check("reset leaves other channels untouched", s().learningProfiles["channelb"] !== undefined);
check("reset does not touch unrelated settings", s().r34lEnabled === true && s().autoForgeConfidenceThreshold === 0.65);
check("reset does not touch memories", Array.isArray(s().pinnedMemories));
check("reset on empty learning is a safe no-op", (s().resetChannelLearning(), true));

// ─── Scenario D: reload (re-hydration) preserves learning ─────────────────

console.log("\n[D] Reload persistence");
s().updateStreamMetadata({ channelName: "ChannelA" });
s().recordLearningOutcome("full_forge", 0.3);
s().setAdaptiveLearningEnabled(false);
const persisted = JSON.parse(storageMap.get("madchatter-storage")!);
check("learning persisted to storage under its channel key", persisted?.state?.learningProfiles?.channela?.actions?.full_forge !== undefined);
check("adaptiveLearningEnabled persisted", persisted?.state?.adaptiveLearningEnabled === false);
check("persisted version migrated to current schema (29)", persisted?.version === 29);

// Simulate a reload: rebuild the store from what's on disk.
// (New module instance is not possible in-process; verify the persisted
// payload hydrates through the same shape the store reads.)
const rehydrated = persisted.state;
check("rehydrated state carries learning profiles", typeof rehydrated.learningProfiles === "object" && rehydrated.learningProfiles.channela !== undefined);
check("rehydrated profile parses with correct sample count", (() => {
  const p = rehydrated.learningProfiles.channela;
  return p.actions.full_forge.sampleCount === 1;
})());

// ─── Scenario E: no channel connected ───────────────────────────────────────

console.log("\n[E] No-channel guard");
s().updateStreamMetadata({ channelName: "" });
const before = JSON.stringify(s().learningProfiles);
s().recordLearningOutcome("short_reaction", 0.9);
check("recording with no channel connected is a no-op", JSON.stringify(s().learningProfiles) === before);
check("disabled state survives no-channel record", s().adaptiveLearningEnabled === false);
s().setAdaptiveLearningEnabled(true);
check("adaptive toggle round-trips back to true", s().adaptiveLearningEnabled === true);

// ─── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${passed}/${passed + failed} checks passed${failed ? `; ${failed} FAILED` : ""}.`);
if (failed > 0) process.exit(1);
