import assert from "node:assert/strict";
import { EpisodicMemoryEngine, detectCallbackLanguage, retrieveEpisodes } from "./episodicMemory";

const engine = new EpisodicMemoryEngine();
engine.setChannel("TestChannel");
const record = {
  type: "self_sabotage_event" as const,
  eventId: "self_sabotage_1000_1",
  timestamp: 1_000,
  participants: ["Gremlin", "Deadpan"],
  instigatorId: "bot1",
  payloadFired: true,
  source: "developer" as const,
};

assert.equal(engine.recordSelfSabotage(record), true, "first receipt should persist");
assert.equal(engine.recordSelfSabotage(record), false, "same event id must be idempotent");
const episode = engine.getEpisodes()[0];
assert.equal(episode.eventData?.type, "self_sabotage_event");
assert.equal(episode.eventData?.payloadFired, true);
assert.deepEqual(episode.eventData?.participants, ["gremlin", "deadpan"]);
assert.equal(episode.retention, "persistent");
assert.equal(episode.provenance.aiSynthesized, false, "generated chat content must not become provenance");
assert.equal(detectCallbackLanguage("you literally admitted you were bots"), true, "natural incident references should count as callbacks");
const callbacks = retrieveEpisodes(engine.getEpisodes(), {
  channel: "testchannel",
  participants: [],
  topics: ["bot"],
  text: "you literally admitted you were bots",
  explicitCallback: true,
  now: 2_000,
}, engine.getSessionId());
assert.equal(callbacks[0]?.episode.id, episode.id, "a direct cover-failure callback should retrieve the episode");

const restored = new EpisodicMemoryEngine();
restored.restore("testchannel", engine.exportSnapshot());
assert.equal(restored.getEpisodes()[0]?.eventData?.eventId, record.eventId, "structured receipt should survive channel restore");

console.log("SELF-SAB-BOT-AGE episodic memory tests passed");
