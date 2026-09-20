/**
 * Focused test harness for R34L community-style learning — STORE integration.
 * Run: npx tsx src/store.r34l.test.ts
 *
 * The pure engine math is covered by src/lib/r34lLearning.test.ts. This suite
 * verifies the store-level guarantees that the engine cannot verify alone:
 *
 *  - v30 → v31 migration seeds r34lProfiles and preserves existing settings
 *  - live ingestion through noteR34lObservation (one message = one count)
 *  - session guards: stale revision / platform / channel are dropped
 *    (including an A→B→A round trip)
 *  - channel + platform identity isolation (same name, different platform)
 *  - own-bot and known-bot messages never contaminate learning
 *  - the session overlay is runtime-only; the baseline persists
 *  - reload (re-hydration) preserves retained learning, drops the overlay
 *  - resetR34lChannelLearning clears ONLY this channel's profile + overlay,
 *    and previously counted history does not silently recreate it
 *  - clearAllContext preserves long-lived R34L learning
 *  - export/import round-trips sanitized profiles (identity is spoof-proof)
 *  - the effective adaptation resolver matches the store's evidence, and
 *    turning R34L off removes the adaptation context immediately
 *  - storage failure never breaks ingestion
 *
 * The store module uses `localStorage` (persist middleware) — shimmed here
 * with an in-memory Map before import, mirroring store.learning.test.ts.
 */

// ─── localStorage shim (must exist before store.ts module init) ──────────
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

// ─── Scenario A: migration from v30 (pre-R34L-learning) ────────────────────
// Seed a v30 persisted state WITHOUT r34lProfiles, then import the store: the
// v31 migration must seed the map while preserving every existing field.
storageMap.set("madchatter-storage", JSON.stringify({
  state: {
    r34lEnabled: true,
    autoForgeDryRun: true,
    autoForgeConfidenceThreshold: 0.65,
    adaptiveLearningEnabled: false,
    streamMetadata: { channelName: "LegacyChannel", title: "", category: "", viewerCount: 0 },
  },
  version: 30,
}));

const { useAppStore } = await import("./store");
const { r34lProfileKey, deriveR34lView } = await import("./lib/r34lLearning");
const { resolveCurrentR34lAdaptation } = await import("./lib/r34lAdaptation");

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const s = () => useAppStore.getState();

/** Ingest one message through the real store action with live session facts. */
function say(username: string, text: string, opts: {
  platform?: string;
  channel?: string;
  revision?: number;
  isReply?: boolean;
  known?: ReadonlySet<string>;
  native?: string[];
  meta?: boolean;
  bots?: string[];
} = {}) {
  const st = s();
  st.noteR34lObservation({
    username,
    text,
    platform: (opts.platform ?? st.platform) as any,
    channel: opts.channel ?? st.streamMetadata.channelName,
    revision: opts.revision ?? st.sessionRevision,
    isReply: opts.isReply,
    knownEmotes: opts.known,
    nativeEmotes: opts.native,
    emoteMetadataAvailable: opts.meta ?? true,
    botUsernames: opts.bots ?? ["madbot", "gremlinbot"],
  });
}

const KNOWN = new Set(["KEKW", "POGGERS"]);
const keyOf = (platform: string, channel: string) => r34lProfileKey(platform, channel);
const profile = (platform: string, channel: string) => s().r34lProfiles[keyOf(platform, channel)];

console.log("\n[A] v30 → v31 migration");
check("existing settings preserved (r34lEnabled)", s().r34lEnabled === true);
check("existing settings preserved (dry run)", s().autoForgeDryRun === true);
check("existing settings preserved (confidence threshold)", s().autoForgeConfidenceThreshold === 0.65);
check("existing settings preserved (unrelated toggle)", s().adaptiveLearningEnabled === false);
check("r34lProfiles seeded empty", s().r34lProfiles !== undefined && Object.keys(s().r34lProfiles).length === 0);
check("session overlay starts null", s().r34lSessionProfile === null);
check("frozen learning defaults off after migration", s().r34lLearningFrozen === false);

// ─── Scenario B: live ingestion ────────────────────────────────────────────

console.log("\n[B] Live ingestion");
s().setPlatform("twitch");
s().updateStreamMetadata({ channelName: "ChannelA" });
say("viewer1", "that was clean", { known: KNOWN });
const aKey = keyOf("twitch", "ChannelA");
check("first eligible message creates the channel profile", profile("twitch", "ChannelA") !== undefined);
check("profile keyed platform:normalizedChannel", profile("twitch", "ChannelA").key === aKey && aKey === "twitch:channela");
check("one message counts once", profile("twitch", "ChannelA").totalMessages === 1);
check("session overlay created for this visit", s().r34lSessionProfile?.key === aKey);
check("overlay counts the same message once", s().r34lSessionProfile!.totalMessages === 1);

for (let i = 0; i < 40; i++) say(`viewer${i % 20}`, `nice round ${i % 5} KEKW`, { known: KNOWN });
check("repeated ingestion accumulates evidence", profile("twitch", "ChannelA").totalMessages === 41);
check("learned emote recorded", profile("twitch", "ChannelA").emotes["KEKW"] !== undefined);
check("baseline weight grows with diverse contributors", profile("twitch", "ChannelA").w > 10);

// ─── Scenario C: eligibility at the store boundary ─────────────────────────

console.log("\n[C] Bots never teach themselves");
const beforeBots = profile("twitch", "ChannelA").totalMessages;
say("MadBot", "hello chat this is my own line");
say("gremlinbot", "another bot line");
say("nightbot", "!followage response");
say("viewer1", "!uptime");
say("viewer1", "");
say("viewer1", "https://example.com");
check("own-bot / known-bot / command / empty / url never counted", profile("twitch", "ChannelA").totalMessages === beforeBots);

// ─── Scenario D: session guards ────────────────────────────────────────────

console.log("\n[D] Session guards");
const beforeGuards = profile("twitch", "ChannelA").totalMessages;
say("viewer1", "stale revision line", { revision: s().sessionRevision - 1 });
check("stale revision dropped", profile("twitch", "ChannelA").totalMessages === beforeGuards);
say("viewer1", "wrong platform line", { platform: "kick" });
check("platform mismatch dropped", profile("twitch", "ChannelA").totalMessages === beforeGuards);
say("viewer1", "wrong channel line", { channel: "SomeoneElse" });
check("channel mismatch dropped", profile("twitch", "ChannelA").totalMessages === beforeGuards);
check("mismatched observation created no foreign profile", s().r34lProfiles[keyOf("twitch", "SomeoneElse")] === undefined);

// ─── Scenario E: channel + platform isolation, A→B→A ──────────────────────

console.log("\n[E] Channel isolation (A→B→A)");
const aMessages = profile("twitch", "ChannelA").totalMessages;
const aRevision = s().sessionRevision;
s().updateStreamMetadata({ channelName: "ChannelB" });
check("channel switch bumps sessionRevision", s().sessionRevision !== aRevision);
check("channel B starts with no retained learning", profile("twitch", "ChannelB") === undefined);
for (let i = 0; i < 12; i++) say(`bviewer${i}`, "Completely different sentence style here.");
check("channel B learns its own evidence", profile("twitch", "ChannelB").totalMessages === 12);
check("channel A untouched while in B", profile("twitch", "ChannelA").totalMessages === aMessages);

// A late observation from channel A's visit cannot train B.
say("viewer1", "late line from A", { channel: "ChannelA", revision: aRevision });
check("late A observation rejected in B (A→B→A guard)", profile("twitch", "ChannelA").totalMessages === aMessages);
check("late A observation did not touch B", profile("twitch", "ChannelB").totalMessages === 12);

s().updateStreamMetadata({ channelName: "ChannelA" });
check("returning to A restores A's retained learning", profile("twitch", "ChannelA").totalMessages === aMessages);
check("B's learning survives the switch back", profile("twitch", "ChannelB").totalMessages === 12);

// Same channel name on a different platform stays separate.
s().setPlatform("kick");
s().updateStreamMetadata({ channelName: "ChannelA" });
check("kick:ChannelA starts unlearned", profile("kick", "ChannelA") === undefined);
say("kviewer", "kick side message");
check("kick profile is separate from twitch profile", profile("kick", "ChannelA").totalMessages === 1 && profile("twitch", "ChannelA").totalMessages === aMessages);
check("platform-qualified keys differ", keyOf("kick", "ChannelA") !== keyOf("twitch", "ChannelA"));

// ─── Scenario F: overlay is per-visit, baseline is retained ───────────────

console.log("\n[F] Overlay vs baseline");
s().setPlatform("twitch");
s().updateStreamMetadata({ channelName: "ChannelA" });
check("overlay does not carry over from another visit", s().r34lSessionProfile === null || s().r34lSessionProfile.key === keyOf("twitch", "ChannelA"));
say("viewer1", "fresh visit line", { known: KNOWN });
check("overlay tracks only this visit", s().r34lSessionProfile!.totalMessages === 1);
check("baseline retains full history", profile("twitch", "ChannelA").totalMessages === aMessages + 1);

// ─── Scenario G: reload preserves baseline, drops overlay ─────────────────

console.log("\n[G] Reload persistence");
const persisted = JSON.parse(storageMap.get("madchatter-storage") ?? "{}");
check("r34lProfiles persisted to storage", persisted.state?.r34lProfiles !== undefined);
check("twitch:channela persisted", persisted.state?.r34lProfiles?.[keyOf("twitch", "ChannelA")] !== undefined);
check("session overlay NOT persisted", persisted.state?.r34lSessionProfile === undefined);
check("persisted profile carries no raw chat text", !JSON.stringify(persisted.state?.r34lProfiles ?? {}).includes("fresh visit line"));

const retainedBefore = profile("twitch", "ChannelA").totalMessages;
await (useAppStore.persist as any).rehydrate();
check("reload preserves retained learning", profile("twitch", "ChannelA")?.totalMessages === retainedBefore);
check("reload preserves other channels", profile("twitch", "ChannelB") !== undefined && profile("kick", "ChannelA") !== undefined);

// ─── Scenario H: reset is scoped and does not resurrect ───────────────────

console.log("\n[H] Reset scoping");
s().setPlatform("twitch");
s().updateStreamMetadata({ channelName: "ChannelA" });
say("viewer1", "pre-reset evidence", { known: KNOWN });
s().resetR34lChannelLearning();
check("reset clears this channel's profile", profile("twitch", "ChannelA") === undefined);
check("reset clears this channel's overlay", s().r34lSessionProfile === null);
check("reset leaves other channels untouched", profile("twitch", "ChannelB") !== undefined && profile("kick", "ChannelA") !== undefined);
check("reset does not touch unrelated settings", s().r34lEnabled === true && s().autoForgeConfidenceThreshold === 0.65);
check("reset does not touch memories", Array.isArray(s().pinnedMemories));
check("reset does not touch channel learning profiles", s().learningProfiles !== undefined);

// Previously counted history must not silently recreate the profile: only NEW
// live messages rebuild it, one at a time.
const afterResetView = deriveR34lView({
  baseline: profile("twitch", "ChannelA") ?? null,
  overlay: s().r34lSessionProfile,
  channelKey: keyOf("twitch", "ChannelA"),
  usableEmotes: null,
  now: Date.now(),
});
check("post-reset state is honestly unlearned", afterResetView.state === "unlearned" && afterResetView.retainedMessages === 0);
say("viewer1", "first message after reset");
check("post-reset profile rebuilds from 1, not from old history", profile("twitch", "ChannelA").totalMessages === 1);
check("reset with no channel connected is a safe no-op", (s().updateStreamMetadata({ channelName: "" }), s().resetR34lChannelLearning(), true));

// ─── Scenario I: clearAllContext preserves long-lived learning ───────────

console.log("\n[I] clearAllContext preserves learning");
s().updateStreamMetadata({ channelName: "ChannelB" });
const bBefore = profile("twitch", "ChannelB").totalMessages;
s().clearAllContext();
check("clearAllContext preserves retained R34L learning", profile("twitch", "ChannelB")?.totalMessages === bBefore);
check("clearAllContext drops the session overlay", s().r34lSessionProfile === null);

// ─── Scenario J: export / import policy ──────────────────────────────────

console.log("\n[J] Export / import");
const exported = JSON.parse(s().exportSettings());
check("export includes r34lProfiles", exported.r34lProfiles !== undefined);
check("export excludes the session overlay", exported.r34lSessionProfile === undefined);

// Import with a spoofed inner identity: the map key must win.
const spoofed = {
  r34lProfiles: {
    "kick:victim": {
      ...(exported.r34lProfiles[keyOf("twitch", "ChannelB")] ?? {}),
      key: "twitch:attacker", channel: "attacker", platform: "twitch",
    },
  },
};
s().importSettings(JSON.stringify(spoofed));
const victim = s().r34lProfiles["kick:victim"];
check("import sanitizes identity from the map key", victim !== undefined && victim.key === "kick:victim" && victim.channel === "victim" && victim.platform === "kick");
s().importSettings(JSON.stringify({ r34lProfiles: { "twitch:garbage": { w: "not a number", emotes: "nope", vocab: 42 } } }));
const garbage = s().r34lProfiles["twitch:garbage"];
check("malformed imported profile degrades to fresh", garbage !== undefined && garbage.w === 0 && typeof garbage.emotes === "object");
check("import never throws on hostile payloads", (s().importSettings("{ not json"), true));

// ─── Scenario K: effective adaptation matches the store ──────────────────

console.log("\n[K] Effective adaptation resolver");
s().setPlatform("twitch");
s().updateStreamMetadata({ channelName: "ResolverRoom" });
useAppStore.setState({ r34lEnabled: true });
for (let i = 0; i < 80; i++) say(`rv${i % 25}`, "yo that was actually insane", { known: KNOWN });
const adaptation = resolveCurrentR34lAdaptation();
check("resolver targets the live channel", adaptation.view.channelKey === keyOf("twitch", "ResolverRoom"));
check("resolver sees the store's retained evidence", adaptation.view.retainedMessages === profile("twitch", "ResolverRoom").totalMessages);
check("resolver reports a usable/established state", adaptation.view.state === "usable" || adaptation.view.state === "established");
check("resolver emits a prompt block once evidence is usable", adaptation.promptBlock.length > 0);
check("prompt block declares it never overrides operator instructions", /never overrides operator instructions/i.test(adaptation.promptBlock));
check("prompt block is bounded", adaptation.promptBlock.length < 2000);

// R34L OFF: adaptation context disappears immediately, learning is retained.
useAppStore.setState({ r34lEnabled: false });
const offAdaptation = resolveCurrentR34lAdaptation();
check("R34L off removes the prompt block immediately", offAdaptation.promptBlock === "");
check("R34L off preserves retained learning", profile("twitch", "ResolverRoom").totalMessages > 0);
check("R34L off still reports the learned view for the readout", offAdaptation.view.retainedMessages > 0);
useAppStore.setState({ r34lEnabled: true });

// Disconnected channel never receives another room's profile.
s().updateStreamMetadata({ channelName: "" });
const disconnected = resolveCurrentR34lAdaptation();
check("no channel → no adaptation context", disconnected.promptBlock === "");
check("no channel → honestly unlearned view", disconnected.view.retainedMessages === 0 && disconnected.view.state === "unlearned");

// ─── Scenario L: storage failure must not break ingestion ────────────────

console.log("\n[L] Storage failure resilience");
const realSetItem = (globalThis as any).localStorage.setItem;
(globalThis as any).localStorage.setItem = () => { throw new Error("quota exceeded"); };
let ingestSurvived = true;
try {
  s().updateStreamMetadata({ channelName: "FailRoom" });
  say("viewer1", "message during storage failure");
} catch { ingestSurvived = false; }
(globalThis as any).localStorage.setItem = realSetItem;
check("ingestion survives a storage write failure", ingestSurvived);
check("in-memory learning still updated during failure", profile("twitch", "FailRoom") !== undefined);

// ─── Scenario M: Frozen Learning (Ctrl+click) ────────────────────────────
// Freezing pauses every learning write — collection, decay, overwrite, reset —
// while the already-learned style keeps steering generation. Unfreezing
// resumes learning from the preserved state.

console.log("\n[M] Frozen Learning");
s().setPlatform("twitch");
s().updateStreamMetadata({ channelName: "FreezeRoom" });
useAppStore.setState({ r34lEnabled: true, r34lLearningFrozen: false });
for (let i = 0; i < 80; i++) say(`fz${i % 25}`, "yo that was actually insane", { known: KNOWN });
const frozenBefore = profile("twitch", "FreezeRoom").totalMessages;
const overlayBefore = s().r34lSessionProfile!.totalMessages;
check("baseline learned before freezing", frozenBefore === 80);

s().setR34lLearningFrozen(true);
check("frozen flag set", s().r34lLearningFrozen === true);

// Frozen: every write path is sealed, but the resolver still applies learning.
const frozenAdaptation = resolveCurrentR34lAdaptation();
check("frozen keeps the learned prompt block applying", frozenAdaptation.promptBlock.length > 0 && frozenAdaptation.applied);
check("frozen still reports the learned view", frozenAdaptation.view.retainedMessages === frozenBefore);

const profileKeysBefore = Object.keys(s().r34lProfiles).sort().join(",");
for (let i = 0; i < 10; i++) say(`fznew${i}`, "brand new style evidence while frozen", { known: KNOWN });
check("frozen collects no new baseline evidence", profile("twitch", "FreezeRoom").totalMessages === frozenBefore);
check("frozen collects no new overlay evidence", s().r34lSessionProfile!.totalMessages === overlayBefore);
check("frozen never learns the new token", profile("twitch", "FreezeRoom").vocab["brand"] === undefined);
check("other profiles untouched while frozen", Object.keys(s().r34lProfiles).sort().join(",") === profileKeysBefore);

// Frozen data cannot be erased — reset is a no-op.
s().resetR34lChannelLearning();
check("frozen blocks the per-channel reset", profile("twitch", "FreezeRoom") !== undefined && profile("twitch", "FreezeRoom").totalMessages === frozenBefore);
check("frozen reset leaves the overlay intact", s().r34lSessionProfile !== null && s().r34lSessionProfile!.totalMessages === overlayBefore);

// The flag persists and round-trips through export/import.
const persistedFrozen = JSON.parse(storageMap.get("madchatter-storage") ?? "{}");
check("frozen flag persisted to storage", persistedFrozen.state?.r34lLearningFrozen === true);
check("export carries the frozen flag", JSON.parse(s().exportSettings()).r34lLearningFrozen === true);
s().importSettings(JSON.stringify({ r34lLearningFrozen: true }));
check("import restores the frozen flag", s().r34lLearningFrozen === true);

// Unfreeze: learning resumes from preserved state — nothing was erased.
s().setR34lLearningFrozen(false);
say("fznew0", "first message after unfreezing", { known: KNOWN });
check("unfreeze resumes learning from preserved state", profile("twitch", "FreezeRoom").totalMessages === frozenBefore + 1);
check("unfrozen reset works again", (s().resetR34lChannelLearning(), profile("twitch", "FreezeRoom") === undefined));

// ─── Scenario N: the canonical three-state contract ───────────────────────
// OFF = { enabled: false, frozen: false } — truly dormant for learning.
// FROZEN = { enabled: true, frozen: true } — apply-only.
// ON = { enabled: true, frozen: false } — apply + learn.
// The contradictory combination (enabled=false + frozen=true) must not be
// reachable through any setter.

console.log("\n[N] R34L three-state contract (OFF / FROZEN / ON)");
s().setPlatform("twitch");
s().updateStreamMetadata({ channelName: "TriStateRoom" });
s().setR34lEnabled(true);
s().setR34lLearningFrozen(false);
for (let i = 0; i < 80; i++) say(`ts${i % 25}`, "yo that was actually insane", { known: KNOWN });
const tsMessages = profile("twitch", "TriStateRoom").totalMessages;
check("ON state learns (enabled=true, frozen=false)", tsMessages === 80 && s().r34lEnabled && !s().r34lLearningFrozen);
check("ON state applies the learned style", resolveCurrentR34lAdaptation().applied === true);

// ON → OFF: no mutation whatsoever. Learned data is PRESERVED, not erased.
s().setR34lEnabled(false);
const overlayTsBefore = s().r34lSessionProfile!.totalMessages;
const tsVocabBefore = Object.keys(profile("twitch", "TriStateRoom").vocab).length;
say("tsnew0", "message that must not teach OFF state anything brand new", { known: KNOWN });
say("tsnew1", "KEKW KEKW KEKW", { known: KNOWN });
check("OFF (enabled=false) collects nothing new", profile("twitch", "TriStateRoom").totalMessages === tsMessages);
check("OFF adds no vocabulary", Object.keys(profile("twitch", "TriStateRoom").vocab).length === tsVocabBefore);
check("OFF writes no overlay evidence", s().r34lSessionProfile!.totalMessages === overlayTsBefore);
check("OFF keeps the learned profile stored (OFF is not erase)", profile("twitch", "TriStateRoom") !== undefined && profile("twitch", "TriStateRoom").totalMessages === tsMessages);
const offAdaptationTs = resolveCurrentR34lAdaptation();
check("OFF does not apply the learned style", offAdaptationTs.applied === false && offAdaptationTs.promptBlock === "");

// OFF + frozen must never collect either (defense-in-depth ordering).
useAppStore.setState({ r34lLearningFrozen: true, r34lEnabled: false });
say("tsnew2", "disabled-but-frozen contradiction message", { known: KNOWN });
check("OFF+frozen collects nothing", profile("twitch", "TriStateRoom").totalMessages === tsMessages);
useAppStore.setState({ r34lLearningFrozen: false });

// OFF → FROZEN via the canonical setters (Ctrl/Cmd+click semantics):
// entering Frozen enables R34L and seals learning.
s().setR34lLearningFrozen(true);
check("OFF → FROZEN implies enabled", s().r34lEnabled === true && s().r34lLearningFrozen === true);
const frozenTsAdaptation = resolveCurrentR34lAdaptation();
check("FROZEN applies the previously learned style", frozenTsAdaptation.applied === true && frozenTsAdaptation.promptBlock.length > 0);
say("tsnew3", "frozen room must not learn this phrase at all", { known: KNOWN });
check("FROZEN still records nothing new", profile("twitch", "TriStateRoom").totalMessages === tsMessages);

// FROZEN → ON: learning resumes from the preserved state.
s().setR34lLearningFrozen(false);
check("FROZEN → ON resumes learning", s().r34lEnabled === true && s().r34lLearningFrozen === false);
say("tsnew4", "learning resumes right after unfreezing here", { known: KNOWN });
check("ON learns again after FROZEN", profile("twitch", "TriStateRoom").totalMessages === tsMessages + 1);

// ON → OFF via setR34lEnabled(false): frozen must not survive the disable.
s().setR34lLearningFrozen(true);
s().setR34lEnabled(false);
check("ON → OFF clears the frozen flag", s().r34lEnabled === false && s().r34lLearningFrozen === false);
check("OFF still preserves learned data after the cycle", profile("twitch", "TriStateRoom").totalMessages === tsMessages + 1);

// Import sanitization: a hostile/hand-edited export can't create the
// contradictory "disabled but frozen" state.
s().setR34lEnabled(false);
s().importSettings(JSON.stringify({ r34lLearningFrozen: true }));
check("imported frozen implies enabled", s().r34lEnabled === true && s().r34lLearningFrozen === true);
s().importSettings(JSON.stringify({ r34lEnabled: false, r34lLearningFrozen: true }));
check("imported contradictory pair resolves to frozen (enabled wins back)", s().r34lEnabled === true && s().r34lLearningFrozen === true);
s().setR34lEnabled(true);

// Mobile tap-cycle parity: OFF → FROZEN → ON → OFF driven purely through the
// two setters must land in the canonical state after each step.
s().setR34lEnabled(false);
s().setR34lLearningFrozen(true);
check("tap cycle: OFF → FROZEN", s().r34lLearningFrozen === true && s().r34lEnabled === true);
s().setR34lLearningFrozen(false);
check("tap cycle: FROZEN → ON", s().r34lEnabled === true && s().r34lLearningFrozen === false);
s().setR34lEnabled(false);
check("tap cycle: ON → OFF", s().r34lEnabled === false && s().r34lLearningFrozen === false);

// ─── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
