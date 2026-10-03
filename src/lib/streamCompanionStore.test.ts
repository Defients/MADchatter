import assert from "node:assert/strict";
import { streamCompanion } from "./streamCompanion";
import { spokenCallouts } from "./spokenCallout";

const storage = new Map<string, string>();
const local = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } };
Object.assign(globalThis, { localStorage: local, window: Object.assign(new EventTarget(), { localStorage: local }) });
storage.set("madchatter-storage", JSON.stringify({ version: 35, state: { participationProfile: "stream_companion", autoForgeEnabled: false, autoForgeAutoCheckEnabled: false, r34lLearningFrozen: true } }));
const { useAppStore: store, partializeAppState, mergePersistedAppState } = await import("../store");
const { getCompanionReceipt, isCompanionHumanMessage } = await import("./streamCompanionRuntime");
const { createAutoForgeExecutionGuard } = await import("./sessionScope");
let passed = 0;
function scenario(name: string, run: () => void) { run(); passed++; console.log(`PASS ${name}`); }

scenario("v35 migration defaults Standard even if an older payload spoofed this new field", () => {
  assert.equal(store.getState().participationProfile, "standard");
  assert.equal(JSON.parse(storage.get("madchatter-storage")!).version, 36);
});
scenario("One setting preserves provider, persona, density, cadence, pause, AutoForge and limits", () => {
  const before = store.getState(); store.getState().setParticipationProfile("stream_companion");
  const after = store.getState();
  for (const key of ["autoForgeEnabled", "autoForgeAutoCheckEnabled", "autoForgeAutoCheckMode", "autoForgeAutoCheckIntervalMs", "interfaceMode", "config", "bots", "rateLimitConfig", "visionProvider", "participationManualMode", "r34lLearningFrozen"] as const) assert.deepEqual(after[key], before[key], key);
});
scenario("Partialize/export/import include only the profile, never permission or runtime revision", () => {
  const partial = partializeAppState(store.getState());
  assert.equal(partial.participationProfile, "stream_companion");
  assert.equal((partial as any).participationProfileRevision, undefined);
  const exported = JSON.parse(store.getState().exportSettings());
  assert.equal(exported.participationProfile, "stream_companion");
  assert.equal(exported.participationProfileRevision, undefined);
  store.getState().setParticipationProfile("standard");
  assert.equal(store.getState().importSettings(JSON.stringify(exported)), true);
  assert.equal(store.getState().participationProfile, "stream_companion");
  assert.equal((partial as any).companionOpportunities, undefined);
});
scenario("Older backups and invalid values normalize Standard on every import", () => {
  for (const value of [undefined, null, true, "COMPANION", {}, []]) {
    store.getState().setParticipationProfile("stream_companion");
    assert.equal(store.getState().importSettings(JSON.stringify(value === undefined ? {} : { participationProfile: value })), true);
    assert.equal(store.getState().participationProfile, "standard");
  }
  for (const json of ["null", "[]", "\"string\"", "{malformed"]) assert.equal(store.getState().importSettings(json), false);
});
scenario("Same-version malformed hydration cannot create a profile or restore runtime permission", () => {
  const merged = mergePersistedAppState({ participationProfile: "invalid", participationProfileRevision: 999 }, store.getState());
  assert.equal(merged.participationProfile, "standard");
  assert.equal(merged.participationProfileRevision, store.getState().participationProfileRevision);
});
scenario("Transcript buffer editing never creates evidence; live final ingestion does", () => {
  store.getState().updateStreamMetadata({ channelName: "alpha" });
  store.setState({ autoForgeEnabled: true, autoForgeAutoCheckEnabled: true, tmiReadState: "connected" });
  store.getState().setParticipationProfile("stream_companion");
  store.getState().setAudioTranscript("Old stored transcript being restored");
  assert.equal(getCompanionReceipt().eligible, false);
  store.getState().appendAudioTranscript("I keep taking this shortcut and it keeps killing me", "streamer");
  assert.equal(getCompanionReceipt().eligible, true);
  assert.equal(getCompanionReceipt().reason, "Following streamer speech");
});
scenario("Vision failure placeholders and raw frame previews never authorize a send", () => {
  streamCompanion.reset();
  for (const tags of ["Captured", "Captured - vision failed", "First frame - baseline", "Unchanged frame"]) {
    store.getState().setVisualSnapshot("data:local-fixture", [tags], "auto", 0.8);
    assert.equal(getCompanionReceipt().eligible, false, tags);
  }
  store.getState().setVisualSnapshot("data:preview", ["A new boss on the bridge"], "auto", 0.8, true);
  assert.equal(getCompanionReceipt().eligible, false);
  store.getState().setVisualSnapshot("data:analyzed", ["A new boss on the bridge"], "auto", 0.8);
  assert.equal(getCompanionReceipt().eligible, true);
  store.getState().clearActiveVisualContext();
  assert.equal(getCompanionReceipt().eligible, false);
});
scenario("TTS echo never becomes an external opportunity at the store chokepoint", () => {
  streamCompanion.reset();
  spokenCallouts.noteAgentSpeech({ text: "That shortcut has a loyalty program" });
  store.getState().appendAudioTranscript("That shortcut has a loyalty program", "streamer");
  assert.equal(getCompanionReceipt().eligible, false);
});
scenario("Mode OFF/ON invalidates in-flight generation and pending permission", () => {
  store.getState().appendAudioTranscript("The shield just reflected the entire fireball", "streamer");
  const guard = createAutoForgeExecutionGuard(() => true);
  assert.equal(guard.isCurrent(), true);
  store.getState().setParticipationProfile("standard");
  store.getState().setParticipationProfile("stream_companion");
  assert.equal(guard.isCurrent(), false);
  assert.equal(guard.signal.aborted, true);
  assert.equal(getCompanionReceipt().eligible, false);
  guard.dispose();
});
scenario("Channel round trips and context reset remove live permission immediately", () => {
  store.setState({ perceptionSummary: null });
  store.getState().appendAudioTranscript("This new map has five bridges and a hidden tunnel", "streamer");
  assert.equal(getCompanionReceipt().eligible, true);
  store.getState().updateStreamMetadata({ channelName: "beta" });
  store.getState().updateStreamMetadata({ channelName: "alpha" });
  assert.equal(getCompanionReceipt().eligible, false);
  store.getState().appendAudioTranscript("The next boss hides behind a completely different wall", "streamer");
  assert.equal(getCompanionReceipt().eligible, true);
  store.getState().clearAllContext();
  assert.equal(getCompanionReceipt().eligible, false);
});
scenario("Manual controls, STOP, disconnected truth and Auto-Check pause win", () => {
  store.getState().appendAudioTranscript("I found the secret entrance behind that waterfall", "streamer");
  const baseline = store.getState();
  for (const patch of [{ botsGlobalStop: true }, { participationManualMode: "quiet" as const }, { participationManualMode: "direct_only" as const }, { autoForgeAutoCheckEnabled: false }, { tmiReadState: "disconnected" as const }]) {
    store.setState(patch);
    assert.equal(getCompanionReceipt().eligible, false);
    store.setState(baseline);
  }
});
scenario("Synthetic and stale mentions cannot borrow direct-human priority", () => {
  store.setState({ bots: [{ id: "a", session: { username: "fixturebot" }, active: false } as any] });
  assert.equal(isCompanionHumanMessage({ user: "fixturebot", timestamp: Date.now() }), false);
  assert.equal(isCompanionHumanMessage({ user: "human", timestamp: Date.now() - 120_000 }), false);
  assert.equal(isCompanionHumanMessage({ user: "human", timestamp: Date.now() }), true);
});
scenario("Sensor stages veto stale output while the surviving lane stays useful", () => {
  streamCompanion.reset();
  store.setState({ perceptionSummary: null, chatLog: [], tmiReadState: "connected" });
  store.getState().appendAudioTranscript("The bridge broke right before I reached the treasure", "streamer");
  store.setState({ perceptionSummary: { lanes: {
    audio: { status: "live", stages: { transcription: { status: "stale" } } },
    vision: { status: "disabled" },
  } } as any });
  assert.equal(getCompanionReceipt().eligible, false);
  store.getState().setVisualSnapshot("data:local", ["A dragon carries the treasure over the collapsed bridge"], "auto", 0.1);
  store.setState({ perceptionSummary: { lanes: {
    audio: { status: "live", stages: { transcription: { status: "error" } } },
    vision: { status: "live", stages: { semantic: { status: "live" } } },
  } } as any });
  assert.equal(getCompanionReceipt().reason, "Reacting to a visual change");
  store.setState({ perceptionSummary: null, chatLog: [
    { user: "alice", text: "Where was that bridge?", timestamp: Date.now() },
    { user: "bob", text: "Behind the tower.", timestamp: Date.now() },
  ] as any });
  assert.equal(getCompanionReceipt().reason, "Leaving room for human conversation");
  assert.equal(store.getState().participationProfile, "stream_companion");
});
scenario("Uncertain mixed audio cannot train spoken engagement; attributable source can", () => {
  streamCompanion.reset(); spokenCallouts.reset("alpha");
  store.setState({ multiBotEnabled: false, bots: [], chatLog: [], perceptionSummary: null });
  (window as any).__twitchSession = { username: "fixturebot" };
  const sentAt = Date.now() - 1000;
  streamCompanion.note({ kind: "speech", text: "The shortcut keeps throwing me into the lava", at: sentAt, attribution: "streamer" });
  const controls = { enabled: true, paused: false, stopped: false, quiet: false, offline: false, eventFloor: false, humanConversation: false, minCooldownMs: 15_000 };
  const ticket = streamCompanion.inspect(controls, sentAt).ticket!;
  const reservation = streamCompanion.reserve(ticket, "That shortcut has a loyalty program", controls, sentAt)!;
  streamCompanion.complete(reservation, true, sentAt);
  store.getState().appendAudioTranscript("fixturebot, what do you think about the shortcut?", "uncertain");
  assert.equal(streamCompanion.getSpokenEngagement(sentAt, "legacy"), null);
  spokenCallouts.reset("alpha");
  store.getState().appendAudioTranscript("fixturebot, what do you think about the shortcut?", "streamer");
  assert.equal(streamCompanion.getSpokenEngagement(sentAt, "legacy")?.provenance, "confirmed_spoken_response");
});
scenario("UI's direct roster actions invalidate permission while retaining real usage", () => {
  store.getState().enableMultiBot();
  assert.equal(getCompanionReceipt().eligible, false);
  const controls = { enabled: true, paused: false, stopped: false, quiet: false, offline: false, eventFloor: false, humanConversation: false, minCooldownMs: 15_000 };
  assert.equal(streamCompanion.inspect(controls, Date.now()).contributionsLastHour, 1);
  store.getState().appendAudioTranscript("A new dragon just landed in the castle courtyard", "streamer");
  assert.equal(getCompanionReceipt().eligible, false); // retained real-send cooldown
  store.getState().disableMultiBot();
  assert.equal(streamCompanion.inspect(controls, Date.now() + 90_000).eligible, false);
  assert.equal(streamCompanion.inspect(controls, Date.now()).contributionsLastHour, 1);
});
console.log(`${passed} Stream Companion store/lifecycle scenarios passed (no provider/platform I/O).`);
