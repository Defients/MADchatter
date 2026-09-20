import assert from "node:assert/strict";
import { IntelligenceSynthesisBudget } from "./intelligenceSynthesisBudget";
import { SpokenCalloutEngine, getSpokenMentionLines, spokenCallouts } from "./spokenCallout";
import { participation, computeParticipationRisk, PARTICIPATION_LIMITS } from "./participationAwareness";
import { roomModel } from "./roomModel";
import { perception } from "./perceptionLiveness";
import { deriveRoomRead, stabilizeRoomRead } from "./roomRead";
import { EpisodicMemoryEngine, EPISODE_IDLE_CLOSE_MS } from "./episodicMemory";

const storage = new Map<string, string>();
const local = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
};
Object.assign(globalThis, { localStorage: local, window: Object.assign(new EventTarget(), { localStorage: local }) });
storage.set("madchatter-storage", JSON.stringify({
  version: 28,
  state: {
    roomModelSynthesisEnabled: false,
    ttsEnabled: false,
    // Legacy impossible state: migration must not leave background playback live.
    ttsBackgroundEnabled: true,
  },
}));
const { useAppStore: store } = await import("../store");
let passed = 0;
function scenario(name: string, run: () => void) {
  run(); passed++; console.log(`PASS ${name}`);
}
const identities = [{ botId: "gremlin", display: "Gremlin", names: ["gremlin"] }];

scenario("v28 migration preserves enrichment opt-out and seeds episodic preference", () => {
  assert.equal(store.getState().roomModelSynthesisEnabled, false);
  assert.equal(store.getState().episodicMemoryEnabled, true);
  assert.equal(store.getState().ttsEnabled, false);
  assert.equal(store.getState().ttsBackgroundEnabled, false);
});
scenario("both intelligence preferences survive persistence and export/import", () => {
  store.getState().setEpisodicMemoryEnabled(false);
  const persisted = JSON.parse(storage.get("madchatter-storage")!);
  assert.equal(persisted.version, 34);
  assert.equal(persisted.state.episodicMemoryEnabled, false);
  assert.equal(persisted.state.spokenCallout, undefined);
  const exported = store.getState().exportSettings();
  store.getState().setEpisodicMemoryEnabled(true);
  store.getState().setRoomModelSynthesisEnabled(true);
  assert.equal(store.getState().importSettings(exported), true);
  assert.equal(store.getState().episodicMemoryEnabled, false);
  assert.equal(store.getState().roomModelSynthesisEnabled, false);
});
scenario("one enrichment budget serializes requests, bounds cost, and shares turns", () => {
  const budget = new IntelligenceSynthesisBudget(100);
  const first = budget.acquire(0, "moment")!;
  assert.equal(typeof first, "function");
  assert.equal(budget.acquire(200, "episode"), null);
  first();
  assert.equal(budget.available(200, "moment"), false);
  const second = budget.acquire(200, "episode")!;
  first(); // stale cleanup cannot release a newer request
  assert.equal(budget.acquire(400, "moment"), null);
  second();
  assert.equal(budget.available(250, "moment"), false);
  const third = budget.acquire(300, "moment")!;
  assert.equal(typeof third, "function");
  third();
  budget.available(301, "episode");
  budget.cancel("episode");
  assert.equal(budget.available(400, "moment"), true);
});
scenario("unrelated speech cannot extend a spoken obligation indefinitely", () => {
  const engine = new SpokenCalloutEngine();
  const callout = engine.noteTranscriptLine({ channel: "alpha", identities, text: "Gremlin, what do you think?", now: 1000, isFinal: true })!.callout;
  const expires = callout.expiresAt;
  engine.noteTranscriptLine({ channel: "alpha", identities, text: "We are moving to the next level.", now: expires - 1, isFinal: true });
  assert.equal(callout.expiresAt, expires);
  assert.equal(engine.getActiveCallout(expires + 1), null);
  engine.reset("beta");
  assert.deepEqual(engine.getDiagnostics().log, []);
});
scenario("spoken obligations are scoped, consumed once, and reject negative instructions", () => {
  spokenCallouts.reset("alpha");
  spokenCallouts.noteTranscriptLine({ channel: "alpha", identities, text: "Gremlin, what do you think?", isFinal: true });
  assert.equal(getSpokenMentionLines("gremlin").length, 1);
  assert.equal(getSpokenMentionLines("another").length, 0);
  spokenCallouts.consumeForBot("gremlin");
  assert.deepEqual(getSpokenMentionLines("gremlin"), []);
  spokenCallouts.noteTranscriptLine({ channel: "alpha", identities, text: "Gremlin, stop talking.", isFinal: true });
  assert.deepEqual(getSpokenMentionLines("gremlin"), []);
});
scenario("legacy voice routing dispatches once and negative speech reaches restraint", () => {
  store.getState().updateStreamMetadata({ channelName: "alpha" });
  store.setState({ multiBotEnabled: false, autoForgeEnabled: true, botsGlobalStop: false });
  window.__twitchSession = { username: "gremlin" } as typeof window.__twitchSession;
  let dispatched = 0;
  const listener = () => { dispatched++; };
  window.addEventListener("autoforge-force-check", listener);
  store.getState().appendAudioTranscript("Gremlin, what do you think?");
  store.getState().appendAudioTranscript("Gremlin, what do you think?");
  assert.equal(dispatched, 1);
  store.getState().appendAudioTranscript("Gremlin, stop talking.");
  assert.equal(dispatched, 1);
  assert.ok(participation.getSnapshot().explicitQuietUntil! > Date.now());
  assert.deepEqual(getSpokenMentionLines(""), []);
  window.removeEventListener("autoforge-force-check", listener);
});
scenario("dry runs cannot create room evidence, restraint, or consume a callout", () => {
  store.getState().clearAllContext();
  store.getState().appendAudioTranscript("Gremlin, what do you think?");
  const before = JSON.stringify(roomModel.exportSnapshot());
  store.getState().addSentMessage({ message: "A simulated answer", channel: "alpha", timestamp: Date.now(), source: "autoforge", dryRun: true });
  assert.equal(JSON.stringify(roomModel.exportSnapshot()), before);
  assert.equal(participation.getSnapshot().risk.overall, 0);
  assert.equal(getSpokenMentionLines("").length, 1);
  assert.equal(store.getState().sentMessages.length, 1); // diagnostic history survives
});
scenario("same-name platform change and context clear reset engines synchronously", () => {
  perception.noteChatTransport("connected"); perception.noteChatInput();
  store.getState().setPlatform("kick");
  assert.equal(store.getState().spokenCallout, null);
  assert.deepEqual(store.getState().spokenCalloutLog, []);
  assert.equal(spokenCallouts.getActiveCallout(), null);
  assert.equal(participation.getSnapshot().explicitQuietUntil, null);
  assert.equal(perception.getSummary().lanes.chat.status === "live", false);
  roomModel.noteChat({ username: "human", text: "fresh" });
  store.getState().clearAllContext();
  assert.equal(roomModel.getChannel(), "alpha");
  assert.equal(store.getState().roomState, null);
  assert.deepEqual(roomModel.getMoments(), []);
});
scenario("old bot-only streaks age out even without another incoming message", () => {
  const timeline = [0, 1, 2, 3].map(t => ({ t, type: "bot" as const }));
  assert.equal(computeParticipationRisk(timeline, [], 4).dimensions.botLoopRisk, 1);
  assert.equal(computeParticipationRisk(timeline, [], PARTICIPATION_LIMITS.saturationWindowMs + 4).dimensions.botLoopRisk, 0);
});
scenario("Room Read changes spoken targets immediately and releases consumed anchors", () => {
  roomModel.reset("alpha");
  const now = Date.now();
  const input = { state: roomModel.getState(), moments: [], now };
  const first = stabilizeRoomRead(deriveRoomRead({ ...input, streamerCallout: { name: "Gremlin", text: "question", at: now } }), null, now);
  const next = stabilizeRoomRead(deriveRoomRead({ ...input, streamerCallout: { name: "Analyst", text: "question", at: now } }), first, now + 1);
  assert.match(next.headline, /Analyst/);
  assert.doesNotMatch(stabilizeRoomRead(deriveRoomRead(input), next, now + 2).headline, /called for/);
});
scenario("episode ingestion rejects a foreign channel before deduplication", () => {
  const engine = new EpisodicMemoryEngine();
  engine.reset("alpha");
  const now = Date.now();
  const moment = { id: "foreign", channel: "beta", startedAt: now, updatedAt: now + 10, endedAt: now + 10,
    status: "closed" as const, kind: "reaction" as const, significance: 0.9, confidence: 0.9,
    sources: ["chat" as const], signals: { chatActivity: { level: "active" as const, humanMessages: 5, botMessages: 0 } },
    evidenceRefs: [], evidenceLines: ["viewer: a shared event"], topicHints: [],
    provenance: { deterministic: true as const, aiSynthesized: false }, updateCount: 1 };
  engine.noteMoments([moment]); engine.tick(now + EPISODE_IDLE_CLOSE_MS + 100);
  assert.equal(engine.getEpisodes().length, 0);
  engine.noteMoments([{ ...moment, channel: "alpha" }]); engine.tick(now + EPISODE_IDLE_CLOSE_MS + 100);
  assert.equal(engine.getEpisodes().length, 1);
});
console.log(`${passed}/${passed} intelligence integration scenarios passed.`);
